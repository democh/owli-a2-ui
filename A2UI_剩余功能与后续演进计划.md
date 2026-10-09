# A2UI 剩余功能与后续演进计划

> 版本：v1.7
> 日期：2026-09-05
> 前置：《A2UI 专家级 UI/UX Design Harness Agent 生产级设计实现方案》《A2UI 前端工作台详细设计》
> 状态：**全部计划功能与增强项交付完成**。M0-M6 + M5 全量 + M7 六项 + 全部体验增强 + 流式增强 + 收尾细化 + 演进项（presence SSE 推送/气泡点击交互/封面懒生成）；WebSocket 仅 Run 事件流保留 SSE 决策，presence 已用 SSE 推送

---

## 1. 当前基线（已交付）

| 里程碑 | 状态 |
|---|---|
| M0-M4（契约/Command/Harness Agent/工作台）+ P2 增强 | ✅ |
| M5 全量（Codegen MVP / M5-1 完整构建门禁 / M5-2 UI 库运行时模板 / M5.3 TSX Importer + 多文件拖拽上传） | ✅ |
| M6 全量（RBAC+成员 UI / 预算 / OTEL / 备份 / E2E / 评测集） | ✅ |
| M7-1 模板库（ir_templates 表 + templates 路由 save/list/applyToProject/remove + TemplatesDialog 保存/市场/一键应用） | ✅ |
| M7-2 组件定义/实例（IR 契约 componentDefs + instanceOf；defineComponent/removeComponentDef op 含逆运算；resolveInstances 展开引擎接入 workspace 投影与 codegen；测试 5 例） | ✅ |
| M7-3 多人评论（comments 表 + comments 路由 list/add/resolve/remove（viewer 读/editor 写/作者或 owner 治理）；前端面板待接） | ✅ 后端 |
| M7-4 多模型路由（user_settings.profileModels；resolveProfileModel 按 planning/generation/review 覆盖；设置页高级输入） | ✅ |
| M7-5 并行专家评审（REVIEW_CRITICS=Critic×N 并行 runReview + aggregateReviews 投票聚合（分数均值/blocking 多数决/最保守建议）；env 默认 1 行为不变；测试 4 例） | ✅ |
| M7-6 Skill Marketplace（design_skills 审核 status 列 + validateSkillManifest 沙箱校验（commitDesign/network 硬禁、id 白名单、资源上限）+ skills 路由 submit/list/reviewList/approve/reject；测试 6 例） | ✅ 后端 |
| 体验增强：InspectorDock 分割线拖拽（零依赖手写 row-resize，高度 localStorage 持久化 12-75%） | ✅ |
| 体验增强：TSX 导入多文件拖拽上传（拖拽区+多选+文件列表；粘贴式保留） | ✅ |
| 体验增强：画布逐节点持久 Diff 着色（IPC setDiff + workspaceStore.nodeDiffs + RendererRoot 注入 CSS：added 绿/updated 蓝/removed 红虚线，提交覆盖、重进画布保持） | ✅ |
| 体验增强：PageBoard 归组（保守方案：拖 frame 至其他底板成员包围盒内自动 moveFrameToBoard 变更归属，不重构 Moveable 嵌套 DOM） | ✅ |
| 流式增强：preview 增量化（delta 帧 upserts 差分 + mergePreviewDelta 前端累积，替代全量 payload）+ run.streamText 打字机（createTextStreamThrottle 批量增量文本，AgentPanel 原始输出实时显示，均不落库） | ✅ |
| M7 收尾：评论面板 UI（InspectorPanel 内按页面/元素挂评论流：list/add/resolve）+ 组件实例创建入口（InspectorPanel「定义为组件」+「插入实例」，designDefs 路由走 commitOpsBatch 可撤销链路）+ presence（心跳 20s/在线窗口 60s/状态栏在线数） | ✅ |
| 收尾细化：评论锚点可视化（渲染器内未解决评论按 nodeId 渲染 💬 气泡 + 点击评论定位高亮锚点组件）+ 模板封面缩略图（保存时以站点导出管线生成首页 HTML，cover 端点 + 列表 iframe 缩略）+ presence 心跳响应直接携带在线列表（免轮询） | ✅ |
| 演进项收官：presence 升级 SSE 推送（/api/presence/stream streamSSE + 订阅即推/变更广播/abort 清理，前端 EventSource 替代轮询）+ 气泡点击交互（commentClick → 选中锚点组件 + 打开检查器，多条聚合计数徽标）+ 模板封面懒生成（cover 端点对无封面老模板访问时补生成回写） | ✅ |
| 技术债：WebSocket | 决策保留 SSE（理由见 §2.2） |

**E2E 回归教训**：引入 react-resizable-panels v4 触发运行时双实例错误（hooks dispatcher null），已用零依赖手写分割替代并保持功能；E2E 页面加载断言成功拦截该回归。

**数据一致性修复（v1.7 复查发现）**：画布手动编辑（检查器属性/内联文本/图层删除）此前仅落旧 pages 表、未写 Design IR——IR 有 frames 时刷新会被投影覆盖导致编辑丢失。已修复：usePageOps 双路持久化（pages.update 兜底 + workspace.commitPageOps 落 IR，commitOpsBatch 链路可撤销），手动编辑与 AI 编辑自此同源。

**质量基线（v1.7 全量验证）**：`eslint .` 0 error 0 warning；`npm run build`（前端 3.6s + API bundle）通过；**生产模式冒烟通过**（NODE_ENV=production 启动 → tRPC ping / 首页 200）。修复此前从未验证的生产构建阻断缺陷：esbuild banner 注入的 `createRequire` 与 bundle 内 yargs-parser 顶层 import 同名冲突（改为唯一命名 `__a2uiCreateRequire`）；CJS 依赖（typescript/yargs）裸引用 `__filename` 与顶层 await 并存触发 `ERR_AMBIGUOUS_MODULE_SYNTAX`（banner 补 `__filename/__dirname` shim）。README 已重写以反映 Harness Agent 架构与工程命令。

---

## 2. 剩余功能清单

### 2.1 按需演进（非缺口，无排期压力）

- 评论气泡展开讨论串（当前点击=选中锚点组件+打开检查器评论流，已满足主流程）
- 协作光标实时同步（需 WS 双向通道，与 §2.2 一并评估）
- 模板封面自定义（用户手动截图替换自动生成封面）

### 2.2 技术债

- **Run 事件流 WebSocket 化（决策：保留 SSE）**：Run 事件下行 + tRPC 命令上行已满足一致性（seq 去重/断线重放）；presence 已用 SSE 推送。若未来引入协作光标等强双向需求，再以 WS 作为补充通道挂 Hono upgrade，复用 RunManager listener。
- **PG/Redis**：生产化时按 §19.1 迁移；SQLite outbox 模式已预留

---

## 3. 排期

```
第 1-5 步（M5 全量 + M6 全量 + 体验增强/Import）                ✅ 已完成
M7 六项（模板库/组件实例/评论/多模型路由/并行评审/Skill 市场）  ✅ 已完成
演进项（presence SSE 推送/气泡点击交互/封面懒生成）             ✅ 已完成
剩余：均为非缺口的按需演进（见 §2.1），无排期压力
```

## 4. 验收基线

- 每 Phase 结束：`npm run check && npm test` 全绿（当前 **136 tests passed**）
- E2E 基础模式 14 项断言全通过（waitUntil=load，兼容 SSE 长连接）；评测集离线验证全通过（LLM 回归 `EVALS_LLM=1`，安全违规=0 硬门槛）
- 所有新增表沿用 DDL 自举（db/ddl.ts）+ drizzle schema 双写规范

---

## 5. 缺口收敛记录(2026-09,定版:仅本地 SQLite)

两份设计文档全量核对后的剩余缺口(G1–G8)已全部处置。存储定版:**仅使用本地 SQLite**,不做 PG/Redis 迁移与 monorepo 拆分;传输维持 SSE + tRPC 决策。

| 缺口 | 处置 | 说明 |
|---|---|---|
| G1 工具系统契约化(§9) | ✅ | `api/agent/runtime/ToolRuntime.ts` + `runtime/tools/`:15 个具名工具(6 只读/2 Proposal/3 校验评审/3 事务/1 工程),统一 zod 校验、权限矩阵(viewer/editor/owner/agent/orchestrator)、超时、输入输出字节上限、span 与审计;`commit_ops` orchestrator-only。Orchestrator 的 validate/evaluate/commit 已改经工具层,行为不变 |
| G2 模式库 + 项目记忆(§10.4/10.5) | ✅ | `contracts/patterns.ts` 内置设计模式库 + 检索注入规划提示词;`contracts/memory.ts` + `memory` 路由 + SettingsDialog 偏好卡(仅用户确认写入,可编辑/删除) |
| G3 内置 Skill 补齐(§24.4/24.8) | ✅ | 6 → **14 个**内置 Skill(补 landing-page-cro/shadcn-modern-saas/ant-design-enterprise/material-design/mobile-first/motion-design/data-visualization/design-token-audit);8 个 prompt 片段;`api/evals/skillCases.ts` 触发评测集(正例/负例/覆盖守卫,hitRate=1、误触发=0) |
| G4 Plan 任务操作(§14.3) | ✅ | `RunManager.pause/resume/skipTask/checkPause`(阶段闸门,abort 触发取消);`runs.pause/resume/skipTask` 路由;`run.paused` 事件;PlanTab 暂停/恢复 + 逐任务跳过(乐观更新,管线三步不开放跳过);跳过的 IA 任务注入"请勿生成"上下文 |
| G5 Vue 导出(M7) | ✅ | `codegen/templates/vue-template.ts`:Vue 3 SFC 工程(script setup + hash 路由,语义映射 className→class,零 UI 库运行时);exports create/build 与 jobs 队列按 `adapterId=vue3` 分支 |
| G6 存储形态(§19) | ✅ 定版 | 仅本地 SQLite;outbox_events 保留事务内事件留痕;assets/imports 不建独立表(资产=IR 扫描,导入直接落 revision) |
| G7 适配器矩阵(§23.3) | ✅ | UILIBRARY_ADAPTERS 与兼容矩阵注册 **mui/mantine(beta)** 与 **vue3(experimental)**;ExportMenu 六项下拉 + 矩阵 tooltip |
| G8 细节对齐 | ✅ | 缩放下限 10%(已有);原型探索门禁 70 分档(constraints.prototype + CommitGate);HITL 倒计时(澄清/审批/计划确认);`maxToolCalls` 每 Run 工具调用数预算(runs.toolCalls 列 + consumeToolCall,超限不可重试) |

**简化决策(记录在案)**:「从失败步骤重试」由 retryable + 重新发起覆盖(Proposal 已隔离,不做 Run 内断点续跑);Vue 门禁跳过 tsc(experimental,SFC 纯模板);模式库以代码内置常量交付(扩展运营化时再迁表)。

**收敛后基线**:`tsc -b` 0 错误;ESLint 0 告警;vitest **23 文件 / 158 passed + 1 skipped**;E2E 14 项全通过(含完整 tsc+vite build 门禁与产物下载);视觉回归 4 基线 0.00% 差异。

---

## 6. 体验完善记录(2026-09 第二轮)

| 项 | 处置 | 说明 |
|---|---|---|
| §14.5/§16.2 执行过程工具卡 | ✅ 补齐 | 发现 `run.step` 事件此前从未被发射(Timeline/工具卡数据源为空)。Orchestrator 新增 `withStepCard`:需求理解/澄清规划/风格解析/Skill 选择/设计规划/页面生成/修复生成(N 轮)/协议校验/UX 评审(×N 投票)/提交变更/生成说明 十一类卡片,含耗时 + **token 增量**(`ToolCard.tokens`);失败卡默认展开错误摘要;澄清卡只计 LLM 规划耗时、不含用户等待 |
| §14.3 执行控制质量闭环 | ✅ | 新增 `RunManager.test.ts`(8 项:seq 单调/落库/replay、persist=false、暂停恢复、**暂停中取消以 RunCancelledError 恢复**、跳过/终态拒绝、Plan 审批挂起唤醒、幂等创建、cancel 终态)。修复真实 bug:**cancel 未唤醒暂停挂起的执行流**(pauseWaiters 现已随 abort 唤醒) |
| §2.1 演进项:模板封面自定义 | ✅ | `templates.setCover` 路由(仅创建者;png/jpeg/webp/gif base64 ≤512KB,存 coverHtml data URL)+ TemplatesDialog 创建者「替换封面」上传按钮 |
| §14.6.1 引用 Chip 定位闭环 | ✅ | 发现 `__locateRef` 桥从未注册——全部引用 Chip 点击均为 no-op。AgentPanelV2 注册分发:@page/@frame/@node → 画布定位(node 自动反查宿主 surface);@proposal → 切 Diff Tab;#skill → 加入手选;@revision → 版本指引。七类 Chip 全部可点击联动 |

**第二轮基线**:`tsc -b` 0 错误;ESLint 0 告警;vitest **24 文件 / 166 passed + 1 skipped**;E2E 14 项全通过;视觉回归 4 基线 0.00% 差异。

---

## 7. 第三轮完善(2026-09):死契约接线与讨论串

| 项 | 处置 | 说明 |
|---|---|---|
| `design.proposal_created` 死契约 | ✅ 接线 | 此前仅契约声明、从未发射(与 run.step 同类静默缺口)。Orchestrator 在首轮与修复轮 saveProposal 后发射概要事件(proposalId/status/rationale/confidence/changeSummary,全量 ops 仍存 design_proposals 表,事件流不携带大载荷);runStore 消费写入 turn.proposal,TurnCard 展开区新增「📦 产物」卡(+a ~u -d ↻m · 置信度) |
| §15.3 HITL 倒计时精确化 | ✅ | clarification.request / run.approval_required / run.plan_approval_required 事件携带服务端 `expiresAt`(ISO);Countdown 组件与 ClarificationCard 优先以 expiresAt 计算,断线重连(replay 恢复)后倒计时不重置,与服务端超时判定同口径 |
| §2.1 演进项:评论讨论串 | ✅ | comments 表加 `parentId`(DDL 自举);add 支持 parentId(校验父存在 + 同页面);list 返回 parentId;InspectorPanel 评论流组树——顶级卡「回复」按钮 + 回复态横幅 +「N 条回复」展开/收起(回复缩进虚线卡、继承父 nodeId);画布气泡经既有 nodeId 聚合天然统计讨论总数 |

**第三轮基线**:`tsc -b` 0 错误;ESLint 0 告警;vitest 24 文件 / **166 passed + 1 skipped**;E2E 14 项全通过;视觉回归 4 基线 0.00% 差异。

**至此剩余为零**:v1 范围无功能缺口、无死契约、无已知 UI no-op;仅存 §2.1 协作光标(WS 决策绑定)与文档明示的 v1 非目标。
