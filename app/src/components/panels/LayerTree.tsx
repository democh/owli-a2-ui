/**
 * 图层树:选中页面的组件层级导航。
 * 点击行 → 选中组件(属性检查器联动)+ 请求 iframe 闪烁高亮。
 * 拖拽行 → moveNode 排序/换父(上 1/4 插到行前,下 1/4 插到行后,中间放入容器);
 * 拖到列表底部空白 → 移到根容器末尾。防环:禁止拖入自身或后代。
 */
import { useState, type DragEvent } from "react";
import { TEXT_EDITABLE_PROPS } from "@contracts/a2ui";
import { useWorkspace } from "@/stores/workspaceStore";
import { usePageOps } from "@/hooks/usePageOps";

/** 取组件的代表性文本,作为树行摘要 */
function snippetOf(type: string, props: Record<string, unknown>): string {
  const keys = [TEXT_EDITABLE_PROPS[type], "title", "logo", "name", "placeholder", "alt", "cta", "value"].filter(Boolean) as string[];
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").slice(0, 14);
  }
  return "";
}

/** 渲染器会渲染 children 的容器类型(仅这些允许「放入」) */
const CAN_PARENT = new Set(["Col", "Row", "Grid", "Card", "Section", "Container", "List", "SidebarLayout"]);

interface Row { aid: string; type: string; depth: number; snippet: string; parentAid: string | null; index: number }
type Zone = "before" | "into" | "after";

export function LayerTree({ pageId }: { pageId: number }) {
  const pages = useWorkspace((s) => s.pages);
  const selectedElements = useWorkspace((s) => s.selectedElements);
  const setSelectedPages = useWorkspace((s) => s.setSelectedPages);
  const setSelectedElements = useWorkspace((s) => s.setSelectedElements);
  const requestHighlight = useWorkspace((s) => s.requestHighlight);
  const applyPageOps = usePageOps();

  const [dragAid, setDragAid] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ aid: string; zone: Zone } | null>(null);

  const page = pages.find((p) => p.id === pageId);
  if (!page) {
    return <div className="flex-1 px-4 py-10 text-center text-xs text-neutral-400">请先选择一个页面</div>;
  }

  const comps = page.surface.components;
  const rootAid = page.surface.root;

  // 扁平表 → 递归展开为带缩进的行(visited 防环)
  const rows: Row[] = [];
  const walk = (aid: string, depth: number, seen: Set<string>, parentAid: string | null, index: number) => {
    if (seen.has(aid)) return;
    seen.add(aid);
    const node = comps[aid];
    if (!node) return;
    rows.push({ aid, type: node.type, depth, snippet: snippetOf(node.type, node.props), parentAid, index });
    node.children.forEach((c, i) => walk(c, depth + 1, seen, aid, i));
  };
  walk(rootAid, 0, new Set(), null, 0);

  const select = (row: Row) => {
    setSelectedPages([page.id]); // 注意:会清空 selectedElements,须先调
    setSelectedElements([{ pageId: page.id, aid: row.aid, componentType: row.type }]);
    requestHighlight(page.id, row.aid);
  };

  // -------------------------------------------------------------------------
  // 拖拽排序 / 换父
  // -------------------------------------------------------------------------
  /** maybe 是否为 ancestor 的后代(含自身,用于防环) */
  const isWithin = (ancestor: string, maybe: string): boolean => {
    const seen = new Set<string>();
    const dfs = (id: string): boolean =>
      id === maybe || (!seen.has(id) && (seen.add(id), (comps[id]?.children ?? []).some(dfs)));
    return dfs(ancestor);
  };

  const dragRow = () => rows.find((r) => r.aid === dragAid);

  /** 该放置是否不产生任何变化(同父相邻位置 / 已在容器末尾) */
  const isNoOp = (row: Row, zone: Zone): boolean => {
    const dr = dragRow();
    if (!dr || !dr.parentAid) return false;
    const cur = comps[dr.parentAid]?.children.indexOf(dr.aid) ?? -1;
    if (zone === "into") {
      return row.aid === dr.parentAid && cur === (comps[row.aid]?.children.length ?? 0) - 1;
    }
    if (row.parentAid !== dr.parentAid) return false;
    const t = zone === "before" ? row.index : row.index + 1; // 移除前坐标的插入点
    return t === cur || t === cur + 1;
  };

  const resetDrag = () => { setDragAid(null); setDropHint(null); };

  const onDragOverRow = (e: DragEvent<HTMLButtonElement>, row: Row) => {
    if (!dragAid || row.aid === rootAid) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const zone: Zone = ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : CAN_PARENT.has(row.type) ? "into" : ratio < 0.5 ? "before" : "after";
    const newParentAid = zone === "into" ? row.aid : row.parentAid;
    // 非法/无变化目标:不 preventDefault → 浏览器显示禁止光标;
    // 同时 stopPropagation,防止冒泡到容器被误当作「移到根容器末尾」
    if (!newParentAid || dragAid === row.aid || isWithin(dragAid, newParentAid) || isNoOp(row, zone)) {
      e.stopPropagation();
      setDropHint(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropHint({ aid: row.aid, zone });
  };

  const onDropRow = (e: DragEvent<HTMLButtonElement>, row: Row) => {
    e.preventDefault();
    e.stopPropagation();
    // hint 必须属于当前行(防止 dragover 状态滞后导致按错误参数提交)
    if (!dragAid || !dropHint || dropHint.aid !== row.aid) return resetDrag();
    const dr = dragRow();
    if (!dr?.parentAid || (!row.parentAid && dropHint.zone !== "into")) return resetDrag();
    let newParentId: string;
    let index: number | undefined;
    if (dropHint.zone === "into") {
      newParentId = row.aid;
      index = undefined; // 容器末尾
    } else {
      newParentId = row.parentAid!;
      const t = dropHint.zone === "before" ? row.index : row.index + 1;
      // applyOps 先移除再 splice:同父且插入点在旧位置之后时需 -1 换算
      const cur = comps[dr.parentAid]?.children.indexOf(dragAid) ?? -1;
      index = row.parentAid === dr.parentAid && t > cur ? t - 1 : t;
    }
    applyPageOps(page, [{ op: "moveNode", id: dragAid, newParentId, ...(index != null ? { index } : {}) }]);
    requestHighlight(page.id, dragAid);
    resetDrag();
  };

  /** 列表底部空白:移到根容器末尾 */
  const rootKids = comps[rootAid]?.children ?? [];
  const canDropToEnd = !!dragAid && !(dragRow()?.parentAid === rootAid && rootKids[rootKids.length - 1] === dragAid);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onDragOver={(e) => {
          if (!canDropToEnd) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropHint({ aid: "__end__", zone: "after" });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragAid && canDropToEnd) {
            applyPageOps(page, [{ op: "moveNode", id: dragAid, newParentId: rootAid }]);
            requestHighlight(page.id, dragAid);
          }
          resetDrag();
        }}>
        {rows.map((r) => {
          const active = selectedElements.some((el) => el.pageId === page.id && el.aid === r.aid);
          const hint = dropHint?.aid === r.aid ? dropHint.zone : null;
          return (
            <button
              key={r.aid}
              draggable={r.aid !== rootAid}
              onClick={() => select(r)}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", r.aid);
                e.dataTransfer.effectAllowed = "move";
                setDragAid(r.aid);
              }}
              onDragEnd={resetDrag}
              onDragOver={(e) => onDragOverRow(e, r)}
              onDrop={(e) => onDropRow(e, r)}
              className={`relative flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition ${
                active ? "bg-indigo-50 text-indigo-700" : "text-neutral-600 hover:bg-neutral-50"
              } ${dragAid === r.aid ? "opacity-40" : ""} ${hint === "into" ? "ring-1 ring-indigo-400 ring-inset" : ""}`}
              style={{ paddingLeft: 8 + r.depth * 12 }}>
              {hint === "before" && <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-indigo-500" />}
              {hint === "after" && <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-indigo-500" />}
              <span className={`shrink-0 text-[11px] font-medium ${active ? "text-indigo-600" : "text-neutral-700"}`}>
                {r.type}
              </span>
              {r.snippet && (
                <span className={`min-w-0 flex-1 truncate text-[10px] ${active ? "text-indigo-400" : "text-neutral-400"}`}>
                  {r.snippet}
                </span>
              )}
            </button>
          );
        })}
        {!rows.length && (
          <div className="px-3 py-8 text-center text-xs text-neutral-400">页面还没有组件</div>
        )}
        {/* 底部空白 drop 区:移到根容器末尾 */}
        <div className="relative mt-1 h-6">
          {dropHint?.aid === "__end__" && (
            <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-indigo-500" />
          )}
          {dragAid && <div className="pt-1 text-center text-[10px] text-neutral-300">拖到此处移至顶层末尾</div>}
        </div>
      </div>
    </div>
  );
}
