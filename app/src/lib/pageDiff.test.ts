/**
 * 版本对比 diff 单测
 * 覆盖:diffSurfaces(令牌 / 组件增删改 / children 结构 / 完全一致)
 *      diffPages(页面增删 / 标题变化 / 状态归并)
 */
import { describe, expect, it } from "vitest";
import type { ComponentNode, SurfaceDoc } from "@contracts/a2ui";
import { diffPages, diffSurfaces } from "./pageDiff";

const tokens = {
  primary: "#4f46e5", background: "#ffffff", surface: "#f4f4f5", text: "#09090b",
  mutedText: "#71717a", accent: "#4f46e5", radius: 10, font: "",
};

function doc(components: Record<string, ComponentNode>, tokenPatch: Partial<typeof tokens> = {}): SurfaceDoc {
  return {
    version: "1.0",
    page: { id: "p", title: "页", device: "desktop" },
    theme: { preset: "shadcn", tokens: { ...tokens, ...tokenPatch } },
    components,
    root: "n1",
  };
}

const base = {
  n1: { type: "Col", props: { gap: 8 }, children: ["n2", "n3"] },
  n2: { type: "Title", props: { text: "标题", level: 2 }, children: [] },
  n3: { type: "Button", props: { label: "开始", variant: "primary" }, children: [] },
} satisfies Record<string, ComponentNode>;

describe("diffSurfaces", () => {
  it("完全一致返回 null", () => {
    expect(diffSurfaces(doc(base), doc(base))).toBeNull();
  });

  it("检测主题令牌变化", () => {
    const d = diffSurfaces(doc(base), doc(base, { primary: "#ff0000" }));
    expect(d?.tokensChanged).toEqual(["primary"]);
    expect(d?.changed).toEqual([]);
  });

  it("检测组件新增 / 删除", () => {
    const withNew = { ...base, n4: { type: "Text", props: { text: "新" }, children: [] } as ComponentNode };
    const d1 = diffSurfaces(doc(base), doc(withNew));
    expect(d1?.added).toEqual([{ aid: "n4", type: "Text", keys: [] }]);
    const d2 = diffSurfaces(doc(withNew), doc(base));
    expect(d2?.removed).toEqual([{ aid: "n4", type: "Text", keys: [] }]);
  });

  it("检测 props 变化(仅列出变化的 key)", () => {
    const after = { ...base, n2: { ...base.n2, props: { text: "改名", level: 2 } } };
    const d = diffSurfaces(doc(base), doc(after));
    expect(d?.changed).toEqual([{ aid: "n2", type: "Title", keys: ["text"] }]);
  });

  it("children 结构变化计入 changed", () => {
    const after = { ...base, n1: { ...base.n1, children: ["n3", "n2"] } };
    const d = diffSurfaces(doc(base), doc(after));
    expect(d?.changed).toEqual([{ aid: "n1", type: "Col", keys: ["children"] }]);
  });
});

describe("diffPages", () => {
  const p1 = { id: 1, title: "首页", surface: doc(base) };
  const p2 = { id: 2, title: "定价", surface: doc(base) };

  it("页面新增 / 删除 / 无变化", () => {
    const entries = diffPages([p1], [p1, p2]);
    expect(entries.map((e) => [e.pageId, e.status])).toEqual([[1, "same"], [2, "added"]]);
    const removed = diffPages([p1, p2], [p1]);
    expect(removed.find((e) => e.pageId === 2)?.status).toBe("removed");
  });

  it("标题变化归为 modified", () => {
    const entries = diffPages([p1], [{ ...p1, title: "新首页" }]);
    expect(entries[0].status).toBe("modified");
    expect(entries[0].titleChanged).toEqual({ from: "首页", to: "新首页" });
  });

  it("内容变化归为 modified 并携带 diff 明细", () => {
    const after = { ...p1, surface: doc({ ...base, n2: { ...base.n2, props: { text: "改", level: 2 } } }) };
    const entries = diffPages([p1], [after]);
    expect(entries[0].status).toBe("modified");
    expect(entries[0].diff?.changed[0].keys).toEqual(["text"]);
  });
});
