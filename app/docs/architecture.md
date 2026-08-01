# Owli A2UI 实现原理

> A2UI = AI to UI。用户与 AI 对话生成网站页面，页面以声明式 DSL（SurfaceDoc）描述，
> 在无限画布上以 iframe 隔离渲染，支持点选元素、可视化编辑、流式渐进预览。
> 本文档重点讲清两件事：**无限画布怎么渲染**、**元素怎么被选中**。

## 目录

1. [整体架构](#1-整体架构)
2. [数据模型：A2UI DSL（SurfaceDoc）](#2-数据模型a2ui-dlsurfacedoc)
3. [无限画布渲染原理（重点）](#3-无限画布渲染原理重点)
4. [元素选中机制（重点）](#4-元素选中机制重点)
5. [统一编辑链路：ops + 撤销/重做 + 持久化](#5-统一编辑链路ops--撤销重做--持久化)
6. [流式生成的渐进渲染](#6-流式生成的渐进渲染)
7. [关键文件索引](#7-关键文件索引)

---

## 1. 整体架构

```
┌─────────────────────────── 浏览器（React 19 + Vite）──────────────────────────┐
│                                                                              │
│  Workspace 页（/workspace/:id）                                               │
│  ┌──────────┬───────────────────────────────────────┬───────────┐            │
│  │ LeftPanel │  CanvasStage（无限画布）              │ AgentPanel│            │
│  │ 页面/图层 │  ┌─────────┐  ┌─────────┐            │ AI 对话   │            │
│  │ 属性检查器│  │FrameView│  │FrameView│  …N 个画框  │           │            │
│  │          │  │ iframe ─┼─►│RendererRoot(/render) │           │            │
│  │          │  └─────────┘  └─────────┘            │           │            │
│  └──────────┴───────────────────────────────────────┴───────────┘            │
│         ▲ zustand(workspaceStore) 单一数据源        ▲ postMessage(IPC)        │
├─────────┴───────────────────────────────────────────┴────────────────────────┤
│  Hono + tRPC 后端（api/）→ Drizzle ORM → SQLite(better-sqlite3)               │
│  LLM 管线（api/llm/）→ Kimi(OpenAI 兼容) / Anthropic                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**技术栈**

| 层 | 选型 |
| --- | --- |
| 画布交互 | `react-infinite-viewer`（平移/缩放）+ `react-moveable`（拖拽/缩放/吸附）+ `react-selecto`（框选） |
| 页面渲染 | 每个画框一个 `<iframe src="/render">`，内部是独立的 React 应用（RendererRoot） |
| 状态管理 | zustand（`workspaceStore`），surface 全程**不可变更新** |
| 协议 | 前后端共享的 zod 契约（`contracts/a2ui.ts`）；iframe 间 `postMessage`（`a2ui-ipc.ts`） |
| 服务端 | Hono + tRPC + Drizzle + SQLite |

**为什么画布内容用 iframe 而不是直接渲染？**

1. **样式/行为隔离**：AI 生成的页面有自己的主题令牌与潜在的全局样式，iframe 天然沙箱（`sandbox="allow-scripts allow-same-origin"`），不会污染工作台 UI，反之亦然。
2. **多预设共存**：shadcn / antd / element / custom 四套渲染器体积差异大，iframe 内按需加载（antd ~1MB 仅 antd 预设的 iframe 才动态 import），每个 iframe 独立承担自己的解析成本。
3. **崩溃隔离**：单个页面渲染抛错由 iframe 内的 `RenderErrorBoundary` 兜底，不会拖垮整个工作台。

代价是跨文档通信——用一套严格的 `postMessage` 协议解决（见 §4.3）。

---

## 2. 数据模型：A2UI DSL（SurfaceDoc）

定义于 `contracts/a2ui.ts`，前后端 + LLM 提示词共用同一份 zod 契约。

```ts
SurfaceDoc {
  version: "1.0"
  page:  { id, title, device }            // desktop/laptop/tablet/mobile
  theme: { preset, tokens }               // 风格预设 + 设计令牌(主色/背景/圆角…)
  components: Record<aid, ComponentNode>  // ★ 扁平组件表
  root: string                            // 根组件 aid
}
ComponentNode { type, props, children: aid[] }   // children 是邻接表(存 id 不存节点)
```

设计要点：

- **扁平表 + 邻接表**：组件以 `aid`（原子 id）为键平铺存储。这让 LLM 流式输出 JSON 时可以"逐个组件闭合"，也让增量 patch 只需按 id 定位，不必处理深层路径。
- **类型与风格解耦**：`type` 来自固定组件目录（约 40 种：布局/排版/表单/数据/导航/反馈/媒体/营销组合）。同一份 SurfaceDoc 交给不同预设的渲染器注册表，得到完全不同的视觉。
- **修改走 ops（JSON Patch 风格），不重生成整页**：

| op | 语义 |
| --- | --- |
| `replaceProps` | 合并更新某组件 props |
| `addNode` | 在 parent 的指定 index 插入新节点（可携带子孙 extra） |
| `removeNode` | 删除节点及其整个子树 |
| `moveNode` | 换父/排序 |
| `setTokens` / `setTitle` | 更新主题令牌 / 页面标题 |

`applyOps(doc, ops)` 深拷贝后顺序应用，返回**新引用**——这是后续"引用比对优化"和"快照撤销"的基础。

---

## 3. 无限画布渲染原理（重点）

核心文件：`src/components/canvas/CanvasStage.tsx`、`FrameView.tsx`。

### 3.1 三库分工

```
InfiniteViewer  → 视口：平移（滚轮/左键拖空白）+ 缩放（Ctrl+滚轮/捏合）
Moveable        → 对象操纵：选中 frame 的拖拽/缩放/多选成组/元素吸附对齐
Selecto         → 框选：Shift+左键拖出选框，命中 .a2-frame
```

三者的手势冲突通过**条件拦截**解决：

- InfiniteViewer 的 `onDragStart` 里：按住 Shift、目标在 `.a2-frame` 内、或在 `.moveable-control-box` 手柄上 → `return false` 放行给 Selecto/Moveable；
- Selecto 的 `dragCondition` 要求必须按住 Shift 才启动框选；
- 单击空白 vs 拖拽平移：`mousedown` 记录坐标，`click` 时位移 `< 4px` 才视为"单击清空选择"。

### 3.2 "无限"的本质：有限大容器 + 滚动缩放视口

```
┌─ 容器(overflow:hidden, 点阵背景) ─────────────────┐
│  ┌─ InfiniteViewer(viewport, 滚动+缩放) ────────┐ │
│  │  ┌─ 内容层 20000×20000 relative ──────────┐ │ │
│  │  │  FrameView(abs left=posX top=posY)      │ │ │
│  │  │  FrameView  … ghost FrameView(生成中)   │ │ │
│  │  │  Moveable(控制框, zoom=zoom)            │ │ │
│  │  └──────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────┘ │
│  Selecto(挂在 window 上, 命中 .a2-frame)           │
│  缩放控制条(右下角, data-no-deselect)              │
└────────────────────────────────────────────────────┘
```

- 内容层是一个 `20000 × 20000` 的相对定位 div，`rangeX/Y: [-2000, 20000]` 限制滚动范围，`margin: 400` 提供边缘缓冲。用户感知是"无限画布"，实现上是"足够大的有限平面"。
- 每个页面画框（FrameView）以 `position:absolute; left:posX; top:posY; width:width; height:height+34` 放置在内容层上（+34 是标题栏高度）。**frame 的几何（posX/posY/width/height）是页面数据的一部分，会持久化到数据库**。
- 缩放范围 `0.1 ~ 2.5`，初始 0.45。

### 3.3 以指针为中心的缩放

InfiniteViewer 默认绕视口中心缩放，体验不好。CanvasStage 用捕获阶段的 wheel 监听覆盖默认行为：

```
内容坐标 cx = (scrollLeft + 指针x) / 旧zoom      // 先算出指针指着"内容里的哪一点"
setZoom(新zoom)
scrollTo(cx * 新zoom - 指针x, …)                 // 再让这一点回到指针下方
```

`Math.exp(-deltaY * 0.0022)` 把滚轮增量转成平滑的指数缩放因子；触控板双指捏合走 InfiniteViewer 的 `onPinch`。

### 3.4 60fps 的关键：拖拽只写 DOM，松手才同步状态

这是画布性能设计中最重要的一条。**拖拽过程中完全不触发 React 状态更新**：

```ts
// Moveable 拖拽中：直接改 DOM style，绕过 React
onDrag={({ target, left, top }) => {
  target.style.left = `${left}px`;
  target.style.top = `${top}px`;
}}
// 松手时：读回 DOM 几何 → 更新 store → 去抖持久化
onDragEnd={({ target }) => commitGeometry(target)}
```

`commitGeometry` 从 `el.style` 读回 left/top/width/height（高度减 34 标题栏），与 store 中的值比对，有变化才 `updatePageLocal`（zustand）+ `persistPage`（600ms 去抖后走 tRPC 落库）。缩放（resize）同理，且 resize 时还要同步改写内部 `iframe` 的宽高。

如果拖拽中每帧都 setState，整个 React 树（画布 + 所有 iframe 宿主 div）每帧重渲染，帧率会雪崩。"DOM 先行、状态后补"保证了拖拽期间零 React 开销。

### 3.5 Moveable 与缩放画布的坐标对齐

画布被 zoom 后，Moveable 控制框必须跟着缩放才能套住目标：

- `<Moveable zoom={zoom}>`：告知当前画布缩放比，控制框/手柄的屏幕尺寸与拖拽增量自动换算；
- `snapThreshold={8 / zoom}`：吸附阈值按 zoom 反比换算，保证任何缩放级别下都是"屏幕上的 8px"；
- `elementGuidelines`：把所有其他 frame 的 CSS 选择器（`.a2-frame[data-page-id="N"]`）作为吸附参考线，实现 frame 间边缘/中心对齐；
- `renderDirections={["e","s","se"]}`：只保留右、下、右下三个缩放手柄（左上角缩会改变 posX/posY 语义，刻意简化）。

选中页 id → DOM 的映射在提交后执行：`viewportEl.querySelector('.a2-frame[data-page-id="id"]')`，结果作为 Moveable 的 `target`。

### 3.6 视口持久化与恢复

- 滚动/缩放后 400ms 去抖写入 `localStorage["a2.viewport.{projectId}"] = {zoom, left, top}`；
- 挂载时优先恢复；没有历史则 zoom=0.45 并居中第一个页面；
- `restoredViewportRef` 保证"恢复过视口就不再自动居中"。

### 3.7 FrameView 的内部结构

```
.a2-frame (absolute, data-page-id)            ← Selecto/Moveable 的钩子
├─ 标题栏 h-[34px]（设备图标/标题/尺寸/操作按钮）   ← 双击聚焦适配
└─ [data-frame-body]（白底圆角卡片, width×height）
   ├─ <iframe src="/render">                  ← 真正的页面内容
   ├─ inspect 提示条 / 内联文本编辑 textarea
   └─ 交互 overlay（非 inspect 时盖在 iframe 上）   ← 关键!
```

**交互 overlay 的作用**：iframe 会"吃掉"所有鼠标事件，宿主永远收不到。所以非 inspect 状态下盖一层透明 div 拦截事件——frame 的单击选中、拖拽（Moveable 要求目标元素可接收事件）、双击进入 inspect 都发生在这层 overlay 上；进入 inspect 模式后移除 overlay，事件才得以穿透到 iframe 内部去点选组件。

### 3.8 iframe 渲染器（RendererRoot）

`/render` 是一个**裸路由**（无工作台 UI），每个 iframe 里是独立的 React 应用实例：

```
host: setSurface(doc, preset)  ──►  iframe: setDoc/setPreset
                                        │
                        registry = REGISTRIES[preset]   (antd 动态 import)
                                        │
                        renderNode(rootId) 递归:
                          node = doc.components[id]
                          content = registry[node.type](node, {render, tokens})
                          return <div data-aid={id} style={{display:"contents"}}>
                                   {content}
                                 </div>
```

- **预设 → 注册表**：`registry[type]` 返回该组件的渲染函数；`custom` 复用 shadcn（token 驱动），`antd` 按需动态加载（含 `ConfigProvider` 主题映射）。未知类型渲染红色占位块而非崩溃。
- **主题令牌**：tokens 注入为 CSS 变量（`--a2-primary` 等），渲染器统一消费。
- **`data-aid` 标记层是选中机制的基石**：每个组件节点外面包一个 `display:contents` 的 div。`display:contents` 让这层 div **不产生任何布局盒**（子元素直接参与父布局，视觉零影响），但它在 DOM 里真实存在，于是任意事件目标都能 `closest("[data-aid]")` 找到所属组件 id，也能 `querySelector('[data-aid="x"]')` 反查元素量测位置。
- **引用比对优化**：surface 全程不可变更新 → host 侧 `lastSentRef` 记录上次下发的引用，`surface === last.surface && preset 不变` 就直接跳过 postMessage，不必对整棵树做 JSON.stringify 深比较。
- **ready 握手**：iframe 挂载完成先 `postToHost({type:"ready"})`，host 收到后才下发 surface/inspect 状态，避免消息早于监听器注册。
- **错误边界**：`RenderErrorBoundary` 以 `resetKey={doc}` 包裹组件树——渲染崩了显示友好提示，新文档到达时自动重置重试。

---

## 4. 元素选中机制（重点）

选中有**两个层级**，分别对应两组 store 状态：

| 层级 | store 字段 | 选中什么 | 干什么用 |
| --- | --- | --- | --- |
| 页面级 | `selectedPageIds: number[]` | 画布上的整个画框 | 拖拽/缩放/删除页面、Moveable target、AI 上下文 |
| 元素级 | `selectedElements: {pageId, aid, componentType}[]` | 页面内部的单个组件 | 属性检查器、内联文本编辑、图层树联动、AI 元素上下文 |

### 4.1 页面级选中

- **单击 frame**（overlay 上）：位移 < 4px 判定为单击；Shift+单击切换多选；
- **Shift+拖框选**（Selecto）：`selectableTargets: [".a2-frame"]`，`hitRate: 0` 表示完全落入选框才命中；`toggleContinueSelect: "shift"` 支持累加选择；
- **单击空白**：清空两级选择；
- 选中页 → Moveable target（DOM 查询在 `useEffect` 提交后执行），同时标题栏/边框变 indigo 高亮。

### 4.2 元素级选中：inspect 模式

因为组件在 iframe 里，宿主摸不到它们，整个元素选中是**"iframe 内感知 + postMessage 回传"**的协作：

```
进入 inspect 的三条路径:
  ① 双击 frame 的交互 overlay          → setInspectMode(true)
  ② 标题栏「选取组件」按钮(选中页时显示)  → setInspectMode(true)
  ③ Esc                                → setInspectMode(false)

host: setInspect(on = inspectMode && 本页被选中)  ──►  本 frame 的 iframe
      (注意:只有"当前选中页"的 iframe 会进入 inspect,其他 frame 不受影响)
```

iframe 内（inspect 开启时，全部用**捕获阶段**监听以保证先于页面内元素拿到事件）：

| 事件 | 行为 |
| --- | --- |
| `mousemove` | `closest("[data-aid]")` 找组件 → `getBoundingClientRect` 量测 → 画**靛蓝虚线 hover 框** |
| `click` | `preventDefault + stopPropagation`（阻止页面内链接/按钮真实触发）→ 切换该 aid 的多选状态 → `postToHost({type:"select", items})` |
| `dblclick` | 若组件类型在 `TEXT_EDITABLE_PROPS`（Title/Text/Button/Link/Badge/Tag）→ 回传 `{type:"textEdit", aid, prop, value, rect}` |

高亮框的画法：iframe 根节点是 `relative` 容器，高亮是 `absolute + pointer-events-none` 的 div，样式为 `outline: 2px solid/dashed + color-mix(6% 底色)`，`transition-all duration-75` 让框在元素间移动时有轻微跟手感。所有量测都在 `useEffect`（渲染提交后）进行，符合 React 19 的 ref 访问规范。

host 收到 `select` 消息后：

```ts
setSelectedPages([page.id]);        // 该页成为唯一选中页(同时会清空旧元素选择)
setSelectedElements(items);         // 写入元素级多选
```

**选中实线框的维持**：iframe 侧用 `selectedAids` 状态持有，doc 变化（AI/手动编辑）后重新量测（`querySelector('[data-aid="…"]')`，`CSS.escape` 防特殊字符）；`setSurface` 会清空 iframe 内的选择，但新的编辑结果到达前 host 侧 selectedElements 仍在，检查器不闪烁。

### 4.3 反向选中：图层树 / 检查器 → 画布高亮

选中不仅"从画布来"，还能"到画布去"：

```
LayerTree 点击行 / Inspector 点击「在画布中高亮」
  → store.requestHighlight(pageId, aid)   // 带自增 seq,重复点同一组件也触发
  → FrameView 监听 highlightReq(匹配本页)
  → postToIframe({type:"highlight", aid})
  → iframe: flashAid → 量测画实线框, 1.6s 后自动消失
```

图层树本身是从扁平表递归展开的（`walk(root, depth)`，`seen` 集合防环），行内容 = 组件类型 + 代表文本摘要（`snippetOf` 按 TEXT_EDITABLE_PROPS/title/logo 等优先级取）。树行还支持**拖拽排序/换父**：鼠标落点上 28% 插到目标前、下 28% 插到目标后、中间且目标为容器类型（Col/Row/Grid/Card/Section/Container/List/SidebarLayout）则"放入"；`isWithin` DFS 防环（禁止拖入自身后代）；同父且插入点在旧位置之后时索引 -1 换算；最终产出一条 `moveNode` op。

### 4.4 选中之后：检查器与内联编辑

- **单选** → `InspectorPanel` 把该组件的 props 逐字段渲染成表单：已知枚举 prop（`PROP_ENUMS`，如 Button.variant、Chart.kind）渲染下拉，其余按值类型通用渲染；头部提供"画布高亮"与"删除组件"（root 不可删）。
- **多选** → `MultiInspector` 取所有选中组件 props 的**交集**，值一致的显示原值、不一致的显示"多个值"（`MIXED` Symbol）；提交时按页分组、每个组件一条 `replaceProps`，整个批量共享**一次** undo 快照（`applyPageOps.multi`）。
- **双击文本** → host 在 frame 上方按回传的 `rect` 定位一个 `<textarea>`（自动聚焦、Enter/失焦提交、Esc 取消、位置钳制在页面内），提交同样是一条 `replaceProps` op。
- **AI 上下文**：`store.chips()` 把选中元素转成对话上下文 chips（`页面 · 组件类型#aid`），下一条对话消息会带着这些组件的精确身份去请求 LLM。

---

## 5. 统一编辑链路：ops + 撤销/重做 + 持久化

无论修改来自哪里——AI 生成、检查器表单、内联文本编辑、图层树拖拽——**全部走同一条 op 链路**（`usePageOps`）：

```
snapshotForUndo()                 // ① 快照入 past 栈(最多 30 条, 同时清空 future)
applyOps(page.surface, ops)       // ② 不可变应用, 得到新 surface(新引用)
updatePageLocal(id, {surface})    // ③ 更新 zustand → FrameView 引用比对失败 → 重新下发 iframe
trpc.pages.update.mutate(...)     // ④ 服务端持久化(失败 toast)
```

撤销/重做（`Ctrl/⌘+Z`、`Ctrl/⌘+Shift+Z`、`Ctrl/⌘+Y`）：快照粒度是 `{pages, preset}` 整体（含页面几何），undo 时 past 弹栈、当前状态入 future，互换 30 条上限。

frame 几何的拖拽/缩放不走 op（它不是 surface 的一部分），但同样遵循"松手才更新 store + 600ms 去抖落库"的节奏。

---

## 6. 流式生成的渐进渲染

LLM 逐 token 输出 JSON 期间，用户就能在画布上看到页面"长出来"：

1. **增量解析**（`src/lib/partialSurface.ts`）：对流式累积的半截 JSON 做**字符串感知的括号配平**，只提取"已完整闭合"的组件条目；`page/theme` 未闭合时用默认值；`root` 缺失时回退到第一个组件；`children` 只保留已存在的引用。输出一个合法的草稿 SurfaceDoc。
2. **草稿状态**（`StreamDraft`）：
   - **create 模式** → `ghosts`：幻影画框（负 id，class 为 `.a2-ghost` 而非 `.a2-frame`），不参与 Selecto 框选/Moveable 拖拽/单击选中；还没有任何闭合组件时显示骨架屏（Navbar/Hero/卡片行占位）。
   - **edit 模式** → `targetPageId + surface`：在目标画框内**就地**渐进预览（`liveSurface = draftSurface ?? page.surface`，不污染真实数据）；等首个组件闭合期间盖一层微光遮罩。
3. **自动聚焦**：草稿出现时画布自动缩放平移过去（每轮生成只聚焦一次，之后不打扰用户手动操作）。
4. **完成替换**：生成结束后草稿丢弃，真实页面数据落库并替换幻影画框。

---

## 7. 关键文件索引

| 主题 | 文件 |
| --- | --- |
| 无限画布舞台（三库编排/缩放/快捷键/视口持久化） | `src/components/canvas/CanvasStage.tsx` |
| 单个画框（iframe 宿主/inspect 切换/内联编辑/生成态 UI） | `src/components/canvas/FrameView.tsx` |
| iframe 渲染器（递归渲染/选中感知/高亮/错误边界/antd 懒加载） | `src/components/renderer/RendererRoot.tsx` |
| 渲染器注册表与共享工具 | `src/components/renderer/registry.ts`、`shared.tsx`、`shadcnRenderer.tsx`、`antdRenderer.tsx`、`elementRenderer.tsx` |
| host ↔ iframe postMessage 协议 | `src/lib/a2ui-ipc.ts` |
| DSL 契约（SurfaceDoc/ops/组件目录/设备与预设） | `contracts/a2ui.ts` |
| 全局状态（选中/草稿/快照撤销） | `src/stores/workspaceStore.ts` |
| 统一 op 提交链路 | `src/hooks/usePageOps.ts` |
| 属性检查器（单选/多选批量编辑） | `src/components/panels/InspectorPanel.tsx` |
| 图层树（层级导航/拖拽换序） | `src/components/panels/LayerTree.tsx` |
| 流式草稿容错解析 | `src/lib/partialSurface.ts` |
| 画布行为 e2e 验证脚本（puppeteer） | `scripts/canvas-verify.mjs`、`scripts/canvas-probe.mjs` |
| 工作台页面骨架 | `src/pages/Workspace.tsx` |
| 导出静态站点（SurfaceDoc → HTML zip） | `api/export/`（`ir.ts`、`serialize.ts`、`site.ts`、`zip.ts`） |

---

### 一页速记

- **画布** = InfiniteViewer（20000² 内容层滚动缩放）+ Moveable（拖拽中只写 DOM、松手同步 store）+ Selecto（Shift 框选 `.a2-frame`）。
- **选中元素** = iframe 内给每个组件包 `display:contents` 的 `data-aid` 标记层 → 捕获阶段监听 `closest("[data-aid]")` → postMessage 回传宿主写入 `selectedElements` → 检查器/图层树/AI 上下文联动；反向高亮走 `highlight` 消息闪烁 1.6s。
- **一切编辑皆 op**：AI 与手动编辑共用 `快照 → applyOps(不可变) → store → 持久化`，天然可撤销。
