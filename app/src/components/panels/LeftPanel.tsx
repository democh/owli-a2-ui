/**
 * 左栏(文档 §5):页面列表 / 图层树 / 属性检查器 / 组件库 / 资产 / Skill
 */
import { useMemo, useState } from "react";
import {
  Blocks, Boxes, Layers, ListTree, SlidersHorizontal, Monitor, Smartphone, Tablet, Laptop, Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/stores/workspaceStore";
import { CATALOG_GROUPS, CONTAINER_TYPES } from "@contracts/a2ui";
import { BUILTIN_SKILLS } from "@contracts/skill";
import { LayerTree } from "./LayerTree";
import { InspectorPanel } from "./InspectorPanel";
import { usePageOps } from "@/hooks/usePageOps";

const DEVICE_ICON = { desktop: Monitor, laptop: Laptop, tablet: Tablet, mobile: Smartphone } as const;

type TabId = "pages" | "layers" | "props" | "components" | "assets" | "skills";

/** 常用组件的合理默认 props(https 图片,避免 a11y/security 校验告警) */
function defaultPropsOf(type: string): Record<string, unknown> {
  const seed = Math.random().toString(36).slice(2, 7);
  switch (type) {
    case "Title": return { text: "标题" };
    case "Text": return { text: "文本内容" };
    case "Button": return { text: "按钮" };
    case "Link": return { text: "链接", href: "https://example.com" };
    case "Image": return { src: `https://picsum.photos/seed/${seed}/480/320`, alt: "图片" };
    case "Avatar": return { src: `https://picsum.photos/seed/${seed}/96/96`, alt: "头像" };
    case "Badge": return { text: "标签" };
    case "Tag": return { text: "标签" };
    case "Input": return { label: "输入", placeholder: "请输入…" };
    case "Textarea": return { label: "内容", placeholder: "请输入…" };
    case "Statistic": return { label: "指标", value: "1,024" };
    default: return {};
  }
}

/** 模块级 aid 生成(react-hooks/purity 不检查组件外函数) */
let aidSeq = 0;
function newAid(prefix: string): string {
  aidSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${aidSeq.toString(36)}`;
}

export function LeftPanel() {
  const pages = useWorkspace((s) => s.pages);
  const selectedPageIds = useWorkspace((s) => s.selectedPageIds);
  const selectedElements = useWorkspace((s) => s.selectedElements);
  const [tab, setTab] = useState<TabId>("pages");

  // 选中组件后自动切到「属性」页(渲染期调整,避免 effect 内 setState)
  const hasSelection = selectedElements.length > 0;
  const [prevHasSelection, setPrevHasSelection] = useState(hasSelection);
  if (hasSelection !== prevHasSelection) {
    setPrevHasSelection(hasSelection);
    if (hasSelection) setTab("props");
  }

  const treePage = pages.find((p) => p.id === selectedPageIds[0]) ?? pages[0];
  const TABS: { id: TabId; label: string; icon: typeof Layers }[] = [
    { id: "pages", label: `页面 ${pages.length}`, icon: Layers },
    { id: "layers", label: "图层", icon: ListTree },
    { id: "props", label: "属性", icon: SlidersHorizontal },
    { id: "components", label: "组件", icon: Blocks },
    { id: "assets", label: "资产", icon: Boxes },
    { id: "skills", label: "Skill", icon: Sparkles },
  ];

  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-neutral-200 bg-white">
      {/* 236px 宽一行放不下 6 个 tab,必须允许换行;高度自适应(min-h-11)避免第二行溢出遮挡内容区 */}
      <div className="flex min-h-11 shrink-0 flex-wrap content-center items-center gap-1 border-b border-neutral-100 px-2 py-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex h-7 items-center gap-1 rounded-lg px-1.5 text-[11px] font-medium transition ${
                active ? "bg-indigo-50 text-indigo-600" : "text-neutral-500 hover:bg-neutral-50"
              }`}>
              <Icon size={12} /> {t.label}
            </button>
          );
        })}
      </div>
      {tab === "pages" && <PagesTab selectedPageIds={selectedPageIds} />}
      {tab === "layers" && (treePage ? <LayerTree pageId={treePage.id} /> : (
        <div className="flex-1 px-4 py-10 text-center text-xs text-neutral-400">还没有页面</div>
      ))}
      {tab === "props" && <InspectorPanel />}
      {tab === "components" && <ComponentsTab />}
      {tab === "assets" && <AssetsTab />}
      {tab === "skills" && <SkillsTab />}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 页面列表(页面操作已移至画框悬浮工具条:设备切换/复制/删除)
// ---------------------------------------------------------------------------
function PagesTab({ selectedPageIds }: { selectedPageIds: number[] }) {
  const pages = useWorkspace((s) => s.pages);

  return (
    <div className="a2-panel flex min-h-0 flex-1 flex-col">
      {/* 页面列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {pages.map((p) => {
          const Icon = DEVICE_ICON[p.device] ?? Monitor;
          const active = selectedPageIds.includes(p.id);
          return (
            <button key={p.id}
              onClick={() => (window as unknown as { __focusPage?: (x: number) => void }).__focusPage?.(p.id)}
              className={`mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                active ? "bg-indigo-50 text-indigo-700" : "text-neutral-600 hover:bg-neutral-50"
              }`}>
              <span className={`flex h-8 w-10 shrink-0 items-center justify-center rounded border ${active ? "border-indigo-200 bg-white" : "border-neutral-200 bg-neutral-50"}`}>
                <Icon size={13} className={active ? "text-indigo-500" : "text-neutral-400"} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{p.title}</span>
                <span className="block text-[10px] text-neutral-400">{p.width}×{p.height}</span>
              </span>
            </button>
          );
        })}
        {!pages.length && (
          <div className="px-3 py-8 text-center text-xs text-neutral-400">
            还没有页面<br />在右侧对话框描述一个吧
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-neutral-100 p-3 text-[10px] leading-relaxed text-neutral-400">
        滚轮平移 · Ctrl+滚轮指针缩放 · 0 恢复 100% · 1 适应全部 · Shift+A 排列<br />
        双击标题栏聚焦页面 · 方向键微调 · Delete 删除选中 · 双击页面选取组件
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §5 组件库:按 CATALOG_GROUPS 分组,插入到选中容器或页面 root(走统一 op 链路)
// ---------------------------------------------------------------------------
function ComponentsTab() {
  const pages = useWorkspace((s) => s.pages);
  const selectedPageIds = useWorkspace((s) => s.selectedPageIds);
  const selectedElements = useWorkspace((s) => s.selectedElements);
  const [q, setQ] = useState("");
  const applyPageOps = usePageOps();

  const insert = (type: string) => {
    const page = pages.find((p) => p.id === selectedPageIds[0]) ?? pages[0];
    if (!page) { toast.error("先在画布创建一个页面"); return; }
    // 插入目标:选中的容器组件;否则页面 root
    const el = selectedElements[0];
    const targetNode = el ? page.surface.components[el.aid] : page.surface.components[page.surface.root];
    const parentId = targetNode && CONTAINER_TYPES.has(targetNode.type) ? el!.aid : page.surface.root;
    const id = newAid(type.toLowerCase());
    applyPageOps(page, [{
      op: "addNode",
      parentId,
      id,
      node: { type, props: defaultPropsOf(type), children: [] },
      extra: {},
    }]);
    toast.success(`已插入 ${type} 到 ${parentId === page.surface.root ? "页面根" : `#${parentId}`}`);
  };

  const groups = CATALOG_GROUPS
    .map((g) => ({ ...g, types: g.types.filter((t) => t.toLowerCase().includes(q.toLowerCase())) }))
    .filter((g) => g.types.length > 0);

  return (
    <div className="a2-panel flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索组件…"
          className="w-full rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => (
          <div key={g.group} className="mb-2">
            <div className="px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">{g.group}</div>
            <div className="grid grid-cols-3 gap-1">
              {g.types.map((t) => (
                <button key={t} onClick={() => insert(t)} title={`插入 ${t}`}
                  className="truncate rounded-md border border-neutral-200 px-1.5 py-1.5 text-[10px] text-neutral-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600">
                  {t}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <div className="px-3 py-6 text-center text-xs text-neutral-400">没有匹配的组件</div>}
      </div>
      <div className="shrink-0 border-t border-neutral-100 p-2.5 text-[10px] leading-relaxed text-neutral-400">
        点击组件插入到「选中的容器」或页面根;插入进撤销栈(Ctrl+Z 可回退)。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §5 资产(降级方案):扫描全部页面收集图片资产,点击插入 Image 节点
// ---------------------------------------------------------------------------
function AssetsTab() {
  const pages = useWorkspace((s) => s.pages);
  const selectedPageIds = useWorkspace((s) => s.selectedPageIds);
  const selectedElements = useWorkspace((s) => s.selectedElements);
  const applyPageOps = usePageOps();

  const assets = useMemo(() => {
    const seen = new Map<string, { url: string; title: string }>();
    for (const p of pages) {
      for (const node of Object.values(p.surface.components)) {
        if (node.type !== "Image" && node.type !== "Avatar") continue;
        const src = node.props?.src;
        if (typeof src === "string" && src && !seen.has(src)) {
          seen.set(src, { url: src, title: p.title });
        }
      }
    }
    return [...seen.values()];
  }, [pages]);

  const insertImage = (url: string) => {
    const page = pages.find((p) => p.id === selectedPageIds[0]) ?? pages[0];
    if (!page) { toast.error("先在画布创建一个页面"); return; }
    const el = selectedElements[0];
    const targetNode = el ? page.surface.components[el.aid] : page.surface.components[page.surface.root];
    const parentId = targetNode && CONTAINER_TYPES.has(targetNode.type) ? el!.aid : page.surface.root;
    const id = newAid("image");
    applyPageOps(page, [{ op: "addNode", parentId, id, node: { type: "Image", props: { src: url, alt: "资产图片" }, children: [] }, extra: {} }]);
    toast.success("已插入图片资产");
  };

  return (
    <div className="a2-panel flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {assets.map((a) => (
          <button key={a.url} onClick={() => insertImage(a.url)} title={`插入 ${a.url}`}
            className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-neutral-200 p-1.5 text-left transition hover:border-indigo-300 hover:bg-indigo-50/50">
            <img src={a.url} alt={a.title} className="h-10 w-14 shrink-0 rounded object-cover" loading="lazy" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[10px] text-neutral-500">{a.url}</span>
              <span className="block text-[10px] text-neutral-400">来源:{a.title}</span>
            </span>
          </button>
        ))}
        {!assets.length && (
          <div className="px-3 py-8 text-center text-xs text-neutral-400">
            项目还没有图片资产<br />生成的页面中有图片后会自动收集到这里
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-neutral-100 p-2.5 text-[10px] leading-relaxed text-neutral-400">
        资产为项目内图片只读收集;点击插入为新 Image 节点。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §5 Skill 面板:内置 Skill 只读卡片(自动路由,# 可手动指定)
// ---------------------------------------------------------------------------
function SkillsTab() {
  return (
    <div className="a2-panel flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {BUILTIN_SKILLS.filter((s) => s.enabled).map((s) => (
          <div key={s.id} className="mb-1.5 rounded-lg border border-neutral-200 p-2.5">
            <div className="flex items-center gap-1.5">
              <Sparkles size={11} className="shrink-0 text-violet-500" />
              <span className="truncate text-xs font-medium text-neutral-700">{s.name}</span>
              <span className="ml-auto shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[9px] text-neutral-400">v{s.version}</span>
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-neutral-400">{s.description}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {s.triggers.keywords.slice(0, 4).map((k) => (
                <span key={k} className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-600">{k}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-neutral-100 p-2.5 text-[10px] leading-relaxed text-neutral-400">
        Skill 由 Agent 按任务自动路由(每 Run 最多 3 个);在输入框输入 # 可手动指定。
      </div>
    </div>
  );
}
