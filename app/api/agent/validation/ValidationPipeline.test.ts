import { describe, expect, it } from "vitest";
import { contrastRatio, validateProposal, hasBlocking } from "./ValidationPipeline";
import { irThemeSchema, type IRDocument, type IROperation } from "@contracts/design-ir";

/** 最小 IR 基座:一个 surface(root Section 下挂 Image 与 Button) */
function baseDoc(): IRDocument {
  return {
    revision: 1,
    theme: irThemeSchema.parse({}),
    surfaces: {
      s1: {
        id: "s1",
        title: "测试页",
        root: "root1",
        components: {
          root1: { type: "Section", props: {}, children: ["img1", "btn1"] },
          img1: { type: "Image", props: { src: "https://example.com/a.png" }, children: [] },
          btn1: { type: "Button", props: {}, children: [] },
        },
      },
    },
    dataModels: {},
    componentDefs: {},
  };
}

describe("ValidationPipeline 补层(§5.2.6 layout/a11y/data)", () => {
  it("Image 缺 alt → accessibility error 阻断;补 alt 后解除", () => {
    const issues = validateProposal({ baseDoc: baseDoc(), ops: [] });
    const alt = issues.find((i) => i.code === "a11y_image_missing_alt");
    expect(alt?.severity).toBe("error");
    expect(alt?.layer).toBe("accessibility");
    expect(hasBlocking(issues)).toBe(true);

    const fixed = validateProposal({
      baseDoc: baseDoc(),
      ops: [{ op: "replaceProps", surfaceId: "s1", id: "img1", props: { alt: "产品截图" } }],
    });
    expect(fixed.find((i) => i.code === "a11y_image_missing_alt")).toBeUndefined();
  });

  it("Button 无可访问名称 → warning(不阻断)", () => {
    const issues = validateProposal({ baseDoc: baseDoc(), ops: [] });
    const name = issues.find((i) => i.code === "a11y_control_missing_name");
    expect(name?.severity).toBe("warning");
    expect(hasBlocking(issues.filter((i) => i.code === "a11y_control_missing_name"))).toBe(false);
  });

  it("叶子组件声明 children → layout warning", () => {
    const op: IROperation = {
      op: "addNode",
      surfaceId: "s1",
      parentId: "root1",
      id: "leaf1",
      node: { type: "Text", props: { text: "hi" }, children: ["ghost1"] },
      extra: {},
    };
    const issues = validateProposal({ baseDoc: baseDoc(), ops: [op] });
    const layout = issues.find((i) => i.code === "layout_leaf_children");
    expect(layout?.severity).toBe("warning");
    expect(layout?.layer).toBe("layout");
  });

  it("容器组件含 children 不告警", () => {
    const op: IROperation = {
      op: "addNode",
      surfaceId: "s1",
      parentId: "root1",
      id: "row1",
      node: { type: "Row", props: {}, children: ["leaf2"] },
      extra: { leaf2: { type: "Text", props: { text: "x" }, children: [] } },
    };
    const issues = validateProposal({ baseDoc: baseDoc(), ops: [op] });
    expect(issues.find((i) => i.code === "layout_leaf_children")).toBeUndefined();
  });

  it("replaceProps 目标不存在 → data error(悬空引用)", () => {
    const op: IROperation = { op: "replaceProps", surfaceId: "s1", id: "nope", props: { text: "x" } };
    const issues = validateProposal({ baseDoc: baseDoc(), ops: [op] });
    const missing = issues.find((i) => i.code === "data_missing_target");
    expect(missing?.severity).toBe("error");
    expect(missing?.layer).toBe("data");
    expect(hasBlocking(issues)).toBe(true);
  });

  it("对比度检查:#999 on #fff → error(<3);#777 on #fff → warning(<4.5);#000 on #fff 放行", () => {
    const mk = (color: string) =>
      validateProposal({
        baseDoc: baseDoc(),
        ops: [{ op: "replaceProps", surfaceId: "s1", id: "btn1", props: { text: "提交", color, backgroundColor: "#ffffff" } }],
      });
    const fail = mk("#999999").find((i) => i.code === "a11y_contrast_fail");
    expect(fail?.severity).toBe("error");
    const low = mk("#777777").find((i) => i.code === "a11y_contrast_low");
    expect(low?.severity).toBe("warning");
    const ok = mk("#000000");
    expect(ok.find((i) => i.code === "a11y_contrast_fail")).toBeUndefined();
    expect(ok.find((i) => i.code === "a11y_contrast_low")).toBeUndefined();
  });

  it("数据绑定路径缺失 → data warning;路径存在 → 放行", () => {
    const doc = baseDoc();
    doc.surfaces.s1.dataModelId = "dm1";
    doc.dataModels.dm1 = {
      id: "dm1",
      name: "用户",
      schema: { name: "string" },
      initialValue: { user: { name: "张三" } },
      mockValue: undefined,
    };
    const miss = validateProposal({
      baseDoc: doc,
      ops: [{ op: "replaceProps", surfaceId: "s1", id: "btn1", props: { text: "{{/user/email}}" } }],
    });
    const warn = miss.find((i) => i.code === "data_binding_missing_path");
    expect(warn?.severity).toBe("warning");
    expect(warn?.layer).toBe("data");

    const hit = validateProposal({
      baseDoc: doc,
      ops: [{ op: "replaceProps", surfaceId: "s1", id: "btn1", props: { text: "{{/user/name}}" } }],
    });
    expect(hit.find((i) => i.code === "data_binding_missing_path")).toBeUndefined();
  });

  it("contrastRatio 数值正确性", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#999999", "#ffffff")).toBeLessThan(3);
    expect(contrastRatio("#777777", "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrastRatio("not-a-color", "#ffffff")).toBeNull();
  });
});
