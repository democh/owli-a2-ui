/**
 * 版本对比:快照(历史) vs 当前页面状态的纯函数 diff。
 * 页面级:新增 / 删除 / 修改(标题、主题令牌、组件增删、props/children 变化)。
 */
import type { SurfaceDoc } from "@contracts/a2ui";

export interface ComponentChange { aid: string; type: string; keys: string[] }

export interface SurfaceDiff {
  /** 变化的主题令牌 key */
  tokensChanged: string[];
  added: ComponentChange[];
  removed: ComponentChange[];
  /** props 变化(keys 为变化的 prop 名;结构/类型变化时含 "children"/"type") */
  changed: ComponentChange[];
}

export interface PageLike { id: number; title: string; surface: SurfaceDoc }

export interface PageDiffEntry {
  pageId: number;
  title: string;
  status: "added" | "removed" | "modified" | "same";
  diff?: SurfaceDiff | null;
  titleChanged?: { from: string; to: string };
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 单页 surface 对比;完全一致返回 null */
export function diffSurfaces(before: SurfaceDoc, after: SurfaceDoc): SurfaceDiff | null {
  const tokenKeys = new Set([...Object.keys(before.theme.tokens), ...Object.keys(after.theme.tokens)]);
  const tokensChanged = [...tokenKeys].filter(
    (k) => !eq(before.theme.tokens[k as keyof typeof before.theme.tokens], after.theme.tokens[k as keyof typeof after.theme.tokens]),
  );

  const added: ComponentChange[] = [];
  const removed: ComponentChange[] = [];
  const changed: ComponentChange[] = [];

  for (const [aid, node] of Object.entries(after.components)) {
    const prev = before.components[aid];
    if (!prev) {
      added.push({ aid, type: node.type, keys: [] });
      continue;
    }
    const keys = [...new Set([...Object.keys(prev.props), ...Object.keys(node.props)])]
      .filter((k) => !eq(prev.props[k], node.props[k]));
    if (!eq(prev.children, node.children)) keys.push("children");
    if (prev.type !== node.type) keys.push("type");
    if (keys.length) changed.push({ aid, type: node.type, keys });
  }
  for (const [aid, node] of Object.entries(before.components)) {
    if (!after.components[aid]) removed.push({ aid, type: node.type, keys: [] });
  }

  if (!tokensChanged.length && !added.length && !removed.length && !changed.length) return null;
  return { tokensChanged, added, removed, changed };
}

/** 页面数组按 id 对齐对比(before=快照,after=当前) */
export function diffPages(before: PageLike[], after: PageLike[]): PageDiffEntry[] {
  const entries: PageDiffEntry[] = [];
  const beforeMap = new Map(before.map((p) => [p.id, p]));
  const afterMap = new Map(after.map((p) => [p.id, p]));

  for (const p of after) {
    const prev = beforeMap.get(p.id);
    if (!prev) {
      entries.push({ pageId: p.id, title: p.title, status: "added" });
      continue;
    }
    const titleChanged = prev.title !== p.title ? { from: prev.title, to: p.title } : undefined;
    const diff = diffSurfaces(prev.surface, p.surface);
    entries.push({
      pageId: p.id,
      title: p.title,
      status: diff || titleChanged ? "modified" : "same",
      diff,
      titleChanged,
    });
  }
  for (const p of before) {
    if (!afterMap.has(p.id)) entries.push({ pageId: p.id, title: p.title, status: "removed" });
  }
  return entries;
}
