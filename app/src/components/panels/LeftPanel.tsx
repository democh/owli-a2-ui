/**
 * 左栏:页面列表 / 图层树 / 属性检查器
 */
import { useState } from "react";
import {
  Layers, ListTree, SlidersHorizontal, Monitor, Smartphone, Tablet, Laptop,
} from "lucide-react";
import { useWorkspace } from "@/stores/workspaceStore";
import { LayerTree } from "./LayerTree";
import { InspectorPanel } from "./InspectorPanel";

const DEVICE_ICON = { desktop: Monitor, laptop: Laptop, tablet: Tablet, mobile: Smartphone } as const;

type TabId = "pages" | "layers" | "props";

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
  ];

  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-neutral-200 bg-white">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-neutral-100 px-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium transition ${
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
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 页面列表(页面操作已移至画框悬浮工具条:设备切换/复制/删除)
// ---------------------------------------------------------------------------
function PagesTab({ selectedPageIds }: { selectedPageIds: number[] }) {
  const pages = useWorkspace((s) => s.pages);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        滚轮平移 · Ctrl+滚轮指针缩放 · 0 恢复 100% · 1 适应全部<br />
        双击标题栏聚焦页面 · 方向键微调 · Delete 删除选中 · 双击页面选取组件
      </div>
    </div>
  );
}
