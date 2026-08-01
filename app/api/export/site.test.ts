/**
 * 多页导航互通回归测试
 * 覆盖:linkResolver 命中规则(精确 / 去「页」后缀别名 / 未命中)
 *      三个导出目标(html / react-vite / vue-vite)的导航 href 重写
 * 背景:导出产物的 Navbar/Footer 链接曾是硬编码 href="#",部署站点页面间无法跳转
 */
import { describe, expect, it } from "vitest";
import type { ComponentNode, SurfaceDoc } from "@contracts/a2ui";
import { buildHtmlSite, buildReactProject, buildVueProject, linkResolver, type ExportPage, type PageEntry } from "./site";

const tokens = {
  primary: "#4f46e5", background: "#ffffff", surface: "#f4f4f5", text: "#09090b",
  mutedText: "#71717a", accent: "#4f46e5", radius: 10, font: "",
};

function doc(components: Record<string, ComponentNode>, root = "n1"): SurfaceDoc {
  return {
    version: "1.0",
    page: { id: "p", title: "", device: "desktop" },
    theme: { preset: "shadcn", tokens },
    components,
    root,
  };
}

const home: ExportPage = {
  title: "首页",
  surface: doc({
    n1: { type: "Col", props: {}, children: ["n2", "n3"] },
    n2: { type: "Navbar", props: { logo: "D", links: ["定价", "联系我们"] }, children: [] },
    n3: { type: "Footer", props: { logo: "D", groups: [{ title: "产品", links: ["定价"] }] }, children: [] },
  }),
};
const pricing: ExportPage = {
  title: "定价页",
  surface: doc({
    n1: { type: "Col", props: {}, children: ["n2"] },
    n2: { type: "Text", props: { text: "价格" }, children: [] },
  }),
};

describe("linkResolver", () => {
  const mk = (title: string, slug: string): PageEntry => ({ title, slug, surface: doc({}) });
  const resolve = linkResolver([mk("首页", "home"), mk("定价页", "pricing")], (e) => `${e.slug}.html`);

  it("精确命中页面标题", () => {
    expect(resolve("首页")).toBe("home.html");
    expect(resolve("定价页")).toBe("pricing.html");
  });

  it("去「页/页面」后缀别名命中(导航文案常省略「页」字)", () => {
    expect(resolve("定价")).toBe("pricing.html");
    expect(resolve(" 定价 ")).toBe("pricing.html");
  });

  it("未命中返回 undefined", () => {
    expect(resolve("功能")).toBeUndefined();
    expect(resolve("")).toBeUndefined();
  });
});

describe("buildHtmlSite 导航重写", () => {
  const files = buildHtmlSite("Demo", [home, pricing]);
  const homeHtml = files["首页.html"];

  it("Navbar 链接重写为目标页面文件", () => {
    expect(homeHtml).toContain('href="定价页.html"');
  });

  it("未命中链接保持 # 不变", () => {
    expect(homeHtml).toContain(">联系我们</a>");
    expect(homeHtml).toContain('href="#"');
  });

  it("底部悬浮导航仍按页面生成且当前页高亮", () => {
    expect(files["定价页.html"]).toContain('href="首页.html"');
    expect(files["定价页.html"]).toContain("font-weight:600");
  });
});

describe("react / vue 工程导航重写", () => {
  it("react 页面组件内导航指向路由路径", () => {
    const files = buildReactProject("Demo", [home, pricing]);
    const page = Object.values(files).find((c) => c.includes('href="/pricing"') || c.includes('href="/定价页"'));
    expect(page).toBeTruthy();
  });

  it("vue 页面组件内导航指向路由路径", () => {
    const files = buildVueProject("Demo", [home, pricing]);
    const page = Object.values(files).find((c) => c.includes('href="/pricing"') || c.includes('href="/定价页"'));
    expect(page).toBeTruthy();
  });
});
