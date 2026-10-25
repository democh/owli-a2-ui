import { describe, expect, it } from "vitest";
import { applyIRops, invertIRops, resolveInstances, validateIR, type IRDocument, type IROperation } from "./design-ir";
import { DEFAULT_TOKENS, DEFAULT_VISUAL } from "./a2ui";

function sampleDoc(): IRDocument {
  return {
    revision: 3,
    theme: { preset: "shadcn", tokens: DEFAULT_TOKENS, visual: DEFAULT_VISUAL },
    surfaces: {
      frame_home: {
        id: "frame_home",
        title: "首页",
        root: "root",
        components: {
          root: { type: "Section", props: {}, children: ["title_1"] },
          title_1: { type: "Title", props: { text: "首页" }, children: [] },
        },
      },
    },
    dataModels: {}, componentDefs: {},
  };
}

describe("applyIRops", () => {
  it("addNode / removeNode / moveNode / replaceProps / setTokens", () => {
    let doc = sampleDoc();
    doc = applyIRops(doc, [
      { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "btn_1", node: { type: "Button", props: { label: "提交" }, children: [] }, extra: {} },
      { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "txt_1", node: { type: "Text", props: { text: "说明" }, children: [] }, extra: {} },
      { op: "moveNode", surfaceId: "frame_home", id: "btn_1", newParentId: "root", index: 0 },
      { op: "replaceProps", surfaceId: "frame_home", id: "title_1", props: { text: "新标题" } },
      { op: "setTokens", tokens: { primary: "#ff0000" } },
    ]);
    expect(doc.surfaces.frame_home.components.root.children).toEqual(["btn_1", "title_1", "txt_1"]);
    expect(doc.surfaces.frame_home.components.title_1.props.text).toBe("新标题");
    expect(doc.theme.tokens.primary).toBe("#ff0000");

    doc = applyIRops(doc, [{ op: "removeNode", surfaceId: "frame_home", id: "txt_1" }]);
    expect(doc.surfaces.frame_home.components.txt_1).toBeUndefined();
    expect(doc.surfaces.frame_home.components.root.children).not.toContain("txt_1");
  });

  it("removeNode 删除整个子树", () => {
    let doc = sampleDoc();
    doc = applyIRops(doc, [
      { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "card_1", node: { type: "Card", props: {}, children: ["inner_1"] }, extra: { inner_1: { type: "Text", props: {}, children: [] } } },
    ]);
    doc = applyIRops(doc, [{ op: "removeNode", surfaceId: "frame_home", id: "card_1" }]);
    expect(doc.surfaces.frame_home.components.card_1).toBeUndefined();
    expect(doc.surfaces.frame_home.components.inner_1).toBeUndefined();
  });
});

describe("invertIRops(撤销回滚)", () => {
  it("逆序列可将文档恢复到应用前状态", () => {
    const before = sampleDoc();
    const ops: IROperation[] = [
      { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "btn_1", node: { type: "Button", props: { label: "提交" }, children: [] }, extra: {} },
      { op: "replaceProps", surfaceId: "frame_home", id: "title_1", props: { text: "新标题" } },
      { op: "moveNode", surfaceId: "frame_home", id: "title_1", newParentId: "root", index: 0 },
      { op: "setTokens", tokens: { primary: "#ff0000", radius: 20 } },
    ];
    const after = applyIRops(before, ops);
    const inverses = invertIRops(before, ops);
    const restored = applyIRops(after, inverses);
    expect(restored.surfaces.frame_home).toEqual(before.surfaces.frame_home);
    expect(restored.theme.tokens).toEqual(before.theme.tokens);
  });

  it("setTokens 携带 visual 时,逆运算回滚视觉语言", () => {
    const before = sampleDoc();
    const ops: IROperation[] = [
      { op: "setTokens", tokens: { background: "#0b0b0f", text: "#f4f4f5" }, visual: { cardStyle: "glass", density: "compact", motion: "none" } },
    ];
    const after = applyIRops(before, ops);
    expect(after.theme.visual.cardStyle).toBe("glass");
    expect(after.theme.tokens.background).toBe("#0b0b0f");
    const restored = applyIRops(after, invertIRops(before, ops));
    expect(restored.theme.tokens).toEqual(before.theme.tokens);
    expect(restored.theme.visual).toEqual(before.theme.visual);
  });

  it("旧文档缺 theme.visual:setTokens(visual) 的正/逆运算不崩溃(回归:提交崩溃根因)", () => {
    // 模拟风格字段上线前存库的文档:theme 整体缺省 visual
    const legacy = sampleDoc() as IRDocument;
    delete (legacy.theme as { visual?: unknown }).visual;
    const ops: IROperation[] = [
      { op: "setTokens", tokens: {}, visual: { cardStyle: "clay" } },
    ];
    expect(() => applyIRops(legacy, ops)).not.toThrow();
    const after = applyIRops(legacy, ops);
    expect(after.theme.visual.cardStyle).toBe("clay");
    // invertIRops 在 cur.theme.visual=undefined 上取值时曾直接崩溃 → run.failed
    expect(() => invertIRops(legacy, ops)).not.toThrow();
  });

  it("removeNode 的逆操作带完整子树与位置", () => {
    const before = sampleDoc();
    const ops: IROperation[] = [
      { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "card_1", node: { type: "Card", props: {}, children: ["inner_1"] }, extra: { inner_1: { type: "Text", props: { text: "内" }, children: [] } } },
      { op: "removeNode", surfaceId: "frame_home", id: "card_1" },
    ];
    const after = applyIRops(before, ops);
    expect(after.surfaces.frame_home.components.card_1).toBeUndefined();
    const inverses = invertIRops(before, ops);
    const restored = applyIRops(after, inverses);
    expect(restored.surfaces.frame_home).toEqual(before.surfaces.frame_home);
  });
});

describe("validateIR", () => {
  it("合法文档零错误", () => {
    expect(validateIR(sampleDoc())).toEqual([]);
  });
  it("root 缺失 / 悬空引用 / 循环引用 / 数据模型缺失被捕获", () => {
    const doc = sampleDoc();
    doc.surfaces.frame_home.components.title_1.children.push("ghost");
    let errs = validateIR(doc);
    expect(errs.join(" ")).toContain("不存在");

    const cyc = sampleDoc();
    cyc.surfaces.frame_home.components.title_1.children.push("root");
    errs = validateIR(cyc);
    expect(errs.join(" ")).toContain("循环引用");

    const dm = sampleDoc();
    dm.surfaces.frame_home.dataModelId = "nope";
    errs = validateIR(dm);
    expect(errs.join(" ")).toContain("数据模型");
  });
});

describe("M7 组件定义/实例(defineComponent + resolveInstances)", () => {
  /** 构造带 Card 子树的文档:root → card_1 → price_1 */
  const docWithCard = () => {
    let d = sampleDoc();
    d = applyIRops(d, [
      { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "card_1", node: { type: "Card", props: { title: "卡片" }, children: ["price_1"] }, extra: { price_1: { type: "Text", props: { text: "¥99" }, children: [] } } },
    ]);
    return d;
  };

  it("defineComponent 从子树提取快照,removeComponentDef 删除", () => {
    let d = docWithCard();
    d = applyIRops(d, [{ op: "defineComponent", defId: "def_card", surfaceId: "frame_home", rootId: "card_1" }] as never);
    const def = d.componentDefs["def_card"]!;
    expect(def.root).toBe("card_1");
    expect(def.components["card_1"].children).toContain("price_1");
    d = applyIRops(d, [{ op: "removeComponentDef", defId: "def_card" }] as never);
    expect(d.componentDefs["def_card"]).toBeUndefined();
  });

  it("defineComponent 的逆运算恢复定义(undo 语义)", () => {
    let d = docWithCard();
    const defOp = { op: "defineComponent", defId: "def_card", surfaceId: "frame_home", rootId: "card_1" };
    const inverses = invertIRops(d, [defOp as never]);
    expect(inverses).toHaveLength(1);
    expect((inverses[0] as { op: string }).op).toBe("removeComponentDef");
    d = applyIRops(d, [defOp as never]);
    d = applyIRops(d, inverses);
    expect(d.componentDefs["def_card"]).toBeUndefined();
  });

  it("resolveInstances:实例节点展开为定义子树,id 重映射 + props 覆盖", () => {
    let d = docWithCard();
    d = applyIRops(d, [{ op: "defineComponent", defId: "def_card", surfaceId: "frame_home", rootId: "card_1" }] as never);
    d = applyIRops(d, [
      { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "inst_1", node: { type: "Card", props: { title: "实例标题" }, children: [], instanceOf: "def_card" }, extra: {} },
    ] as never);
    const resolved = resolveInstances(d);
    const s = resolved.surfaces["frame_home"];
    expect(s.components["inst_1"]!.props.title).toBe("实例标题");
    expect(s.components["inst_1"]!.children).toContain("inst_1__price_1");
    expect(s.components["inst_1__price_1"]!.type).toBe("Text");
    expect(s.components["card_1"]).toBeTruthy(); // 原子树保留
  });

  it("未定义引用的 instanceOf 节点原样保留(resolveInstances 容错)", () => {
    const d = sampleDoc();
    d.surfaces["frame_home"].components["ghost"] = { type: "Col", props: {}, children: [], instanceOf: "missing_def" };
    const resolved = resolveInstances(d);
    expect(resolved.surfaces["frame_home"].components["ghost"]!.instanceOf).toBe("missing_def");
  });
});
