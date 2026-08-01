/**
 * 流式草稿容错解析器单元测试
 * 覆盖:完整文档 / 截断文档 / markdown 围栏 / root 回退 / children 悬空引用 / 非法组件
 */
import { describe, expect, it } from "vitest";
import { parsePartialPages, parsePartialSurface } from "./partialSurface";

const OPTS = { preset: "shadcn" as const, device: "desktop" as const };

const FULL = JSON.stringify({
  version: "1.0",
  page: { id: "page", title: "落地页", device: "mobile" },
  theme: { preset: "shadcn", tokens: { primary: "#ff0000", radius: 8 } },
  components: {
    n1: { type: "Hero", props: { title: "你好 \"世界\"" }, children: ["n2"] },
    n2: { type: "Button", props: { label: "开始" }, children: [] },
  },
  root: "n1",
});

describe("parsePartialSurface", () => {
  it("解析完整文档", () => {
    const doc = parsePartialSurface(FULL, OPTS);
    expect(doc).not.toBeNull();
    expect(doc!.page.title).toBe("落地页");
    expect(doc!.page.device).toBe("mobile");
    expect(doc!.theme.tokens.primary).toBe("#ff0000");
    expect(doc!.theme.tokens.radius).toBe(8);
    // 未提供的 token 用默认值
    expect(doc!.theme.tokens.background).toBe("#ffffff");
    expect(doc!.root).toBe("n1");
    expect(Object.keys(doc!.components)).toEqual(["n1", "n2"]);
  });

  it("markdown 围栏不影响解析", () => {
    const doc = parsePartialSurface(`\`\`\`json\n${FULL}\n\`\`\``, OPTS);
    expect(doc?.root).toBe("n1");
  });

  it("截断在第二个组件中间:只保留完整闭合的 n1", () => {
    const cut = FULL.indexOf('"n2"');
    const doc = parsePartialSurface(FULL.slice(0, cut + 20), OPTS);
    expect(doc).not.toBeNull();
    expect(Object.keys(doc!.components)).toEqual(["n1"]);
    // n1 的 children 引用 n2,但 n2 未闭合 → 悬空引用被剔除
    expect(doc!.components.n1.children).toEqual([]);
    // root 字段尚未输出 → 回退第一个组件
    expect(doc!.root).toBe("n1");
  });

  it("page/theme 未闭合时用默认值", () => {
    const head = FULL.slice(0, FULL.indexOf('"components"') + 40);
    const doc = parsePartialSurface(head, OPTS);
    // components 尚未有完整条目 → null
    expect(doc).toBeNull();
  });

  it("一个组件都未闭合时返回 null", () => {
    expect(parsePartialSurface('{"version":"1.0","page":{"id":"page"', OPTS)).toBeNull();
    expect(parsePartialSurface("", OPTS)).toBeNull();
    expect(parsePartialSurface("正在思考...", OPTS)).toBeNull();
  });

  it("非法组件类型被丢弃,但其余组件保留", () => {
    const text = JSON.stringify({
      components: {
        n1: { type: "NotAComponent", props: {}, children: [] },
        n2: { type: "Hero", props: {}, children: [] },
      },
      root: "n1",
    });
    const doc = parsePartialSurface(text, OPTS);
    expect(Object.keys(doc!.components)).toEqual(["n2"]);
    // root 指向被丢弃的 n1 → 回退第一个可用组件
    expect(doc!.root).toBe("n2");
  });

  it("props 中含嵌套对象与转义引号时配平正确", () => {
    const doc = parsePartialSurface(FULL, OPTS);
    expect(doc!.components.n1.props.title).toBe('你好 "世界"');
  });

  it("root 引用不存在的组件时回退", () => {
    const text = JSON.stringify({
      components: { n1: { type: "Hero", props: {}, children: [] } },
      root: "ghost",
    });
    const doc = parsePartialSurface(text, OPTS);
    expect(doc!.root).toBe("n1");
  });

  it("非法 token 值被过滤", () => {
    const text = JSON.stringify({
      components: { n1: { type: "Hero", props: {}, children: [] } },
      theme: { tokens: { primary: "not-a-color", radius: 999, accent: "#123456" } },
      root: "n1",
    });
    const doc = parsePartialSurface(text, OPTS);
    expect(doc!.theme.tokens.primary).toBe("#18181b"); // 默认
    expect(doc!.theme.tokens.radius).toBe(10); // 默认
    expect(doc!.theme.tokens.accent).toBe("#123456"); // 合法保留
  });

  it("device 非法时回退到 opts.device", () => {
    const text = JSON.stringify({
      page: { id: "p", title: "t", device: "watch" },
      components: { n1: { type: "Hero", props: {}, children: [] } },
      root: "n1",
    });
    const doc = parsePartialSurface(text, OPTS);
    expect(doc!.page.device).toBe("desktop");
  });
});

// ---------------------------------------------------------------------------
// 多页流式草稿:{pages:[...]} 逐页渐进解析
// ---------------------------------------------------------------------------

const PAGE_A = {
  version: "1.0",
  page: { id: "a", title: "首页", device: "desktop" },
  components: { n1: { type: "Hero", props: { title: "A" }, children: [] } },
  root: "n1",
};
const PAGE_B = {
  version: "1.0",
  page: { id: "b", title: "定价页", device: "desktop" },
  components: { m1: { type: "PricingTable", props: {}, children: [] } },
  root: "m1",
};
const MULTI_FULL = JSON.stringify({ pages: [PAGE_A, PAGE_B] });

describe("parsePartialPages", () => {
  it("单页输出退化为单元素数组", () => {
    const docs = parsePartialPages(FULL, OPTS);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.page.title).toBe("落地页");
  });

  it("解析完整的多页文档", () => {
    const docs = parsePartialPages(MULTI_FULL, OPTS);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.page.title).toBe("首页");
    expect(docs[1]?.page.title).toBe("定价页");
    expect(docs[0]?.root).toBe("n1");
    expect(docs[1]?.root).toBe("m1");
  });

  it("第一页闭合、第二页未闭合:第一页完整,第二页渐进", () => {
    // 截断在第二页 components 中间
    const cut = MULTI_FULL.indexOf('"m1"') + 30;
    const docs = parsePartialPages(MULTI_FULL.slice(0, cut), OPTS);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.page.title).toBe("首页");
    // 第二页组件未闭合 → 该页为 null(前端显示骨架屏)
    expect(docs[1]).toBeNull();
  });

  it("第二页组件部分闭合:返回部分文档", () => {
    // 截断在第二页 m1 闭合之后、root 之前
    const m1End = MULTI_FULL.indexOf('"root":"m1"');
    const docs = parsePartialPages(MULTI_FULL.slice(0, m1End), OPTS);
    expect(docs).toHaveLength(2);
    expect(docs[1]?.root).toBe("m1"); // root 未输出 → 回退第一个组件
    expect(docs[1]?.page.title).toBe("定价页");
  });

  it("只有 pages 数组开头时返回空数组", () => {
    expect(parsePartialPages('{"pages": [', OPTS)).toEqual([]);
    expect(parsePartialPages('{"pages": []', OPTS)).toEqual([]);
    expect(parsePartialPages("", OPTS)).toEqual([]);
  });

  it("version 字段在 pages 之前也能识别为多页", () => {
    const docs = parsePartialPages(JSON.stringify({ version: "1.0", pages: [PAGE_A] }), OPTS);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.page.title).toBe("首页");
  });
});
