import { describe, expect, it } from "vitest";
import { extractFirstJsonObject, tryParseSurfaces } from "./kimi";

/** 最小合法单页文档(通过 surfaceDocSchema + validateSurface) */
const pageDoc = (id: string) => ({
  version: "1.0",
  page: { id, title: `页面 ${id}`, device: "desktop" },
  theme: { preset: "shadcn" },
  components: { root: { type: "Section", props: {}, children: [] } },
  root: "root",
});
const json = (v: unknown) => JSON.stringify(v);

describe("tryParseSurfaces 解析容错", () => {
  it("干净单页输出", () => {
    const { docs, error } = tryParseSurfaces(json(pageDoc("p1")));
    expect(error).toBeUndefined();
    expect(docs?.length).toBe(1);
    expect(docs?.[0].page.id).toBe("p1");
  });

  it("markdown 代码块包裹", () => {
    const { docs } = tryParseSurfaces("```json\n" + json(pageDoc("p1")) + "\n```");
    expect(docs?.length).toBe(1);
  });

  it("JSON 后尾随无括号文本", () => {
    const { docs } = tryParseSurfaces(json(pageDoc("p1")) + "\n以上是生成的页面。");
    expect(docs?.length).toBe(1);
  });

  it("JSON 后重复输出第二段对象(实测杀死修复轮的失败形态)", () => {
    const raw = json(pageDoc("p1")) + "\n" + json(pageDoc("p1"));
    const { docs } = tryParseSurfaces(raw);
    expect(docs?.length).toBe(1);
    expect(docs?.[0].page.id).toBe("p1");
  });

  it("pages 数组包裹的多页输出", () => {
    const raw = json({ version: "1.0", pages: [pageDoc("a"), pageDoc("b")] });
    const { docs } = tryParseSurfaces(raw);
    expect(docs?.map((d) => d.page.id)).toEqual(["a", "b"]);
  });

  it("pages 数组后尾随第二段对象", () => {
    const wrapper = json({ version: "1.0", pages: [pageDoc("a")] });
    const { docs } = tryParseSurfaces(wrapper + json(pageDoc("b")));
    expect(docs?.length).toBe(1);
    expect(docs?.[0].page.id).toBe("a");
  });

  it("截断输出:返回错误而非崩溃", () => {
    const raw = json(pageDoc("p1")).slice(0, -20);
    const { docs, error } = tryParseSurfaces(raw);
    expect(docs).toBeUndefined();
    expect(error).toBeTruthy();
  });
});

describe("extractFirstJsonObject", () => {
  it("引号内的花括号不参与配对", () => {
    const text = '{"a":"包含 } 与 { 的字符串"} 尾随';
    expect(extractFirstJsonObject(text)).toBe('{"a":"包含 } 与 { 的字符串"}');
  });

  it("转义引号不终止字符串", () => {
    const text = '{"a":"说 \\"hi\\" }"}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it("未闭合返回 null", () => {
    expect(extractFirstJsonObject('{"a":')).toBeNull();
  });
});
