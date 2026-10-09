import { describe, expect, it } from "vitest";
import { generateVueProject, validateVueFiles } from "./vue-template";
import type { IRDocument } from "@contracts/design-ir";

function doc(): IRDocument {
  return {
    revision: 1,
    theme: {
      preset: "shadcn",
      tokens: {
        primary: "#18181b", background: "#ffffff", surface: "#f4f4f5",
        text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "",
      },
    },
    surfaces: {
      frame_home: {
        id: "frame_home",
        title: "首页",
        root: "root",
        components: {
          root: { type: "Section", props: {}, children: ["t1", "b1", "ghost_type"] },
          t1: { type: "Title", props: { text: "运营看板" }, children: [] },
          b1: { type: "Button", props: { label: "导出", variant: "outline" }, children: [] },
          ghost_type: { type: "NotInCatalog", props: {}, children: [] },
        },
      },
    },
    dataModels: {},
    componentDefs: {},
  };
}

describe("Vue 导出模板(M7 · experimental)", () => {
  it("生成 Vue 3 SFC 工程文件集:package.json/vite/入口/App.vue/页面 SFC", () => {
    const { files, unmapped } = generateVueProject({
      projectName: "运营数据平台",
      doc: doc(),
      pages: [{ surfaceId: "frame_home", title: "首页", device: "desktop" }],
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("vite.config.js");
    expect(paths).toContain("index.html");
    expect(paths).toContain("src/main.js");
    expect(paths).toContain("src/App.vue");
    expect(paths).toContain("src/pages/Page1.vue");

    const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
    expect(pkg.dependencies.vue).toBeTruthy();
    expect(pkg.devDependencies["@vitejs/plugin-vue"]).toBeTruthy();
    expect(pkg.scripts.build).toBe("vite build"); // experimental:不跑 tsc

    // SFC 结构:单 template 块 + script setup + 语义映射降级
    const page = files.find((f) => f.path === "src/pages/Page1.vue")!;
    expect(page.content).toContain("<script setup>");
    expect((page.content.match(/<template>/g) ?? []).length).toBe(1);
    expect(page.content).toContain("class=");
    expect(page.content).not.toContain("className=");
    expect(page.content).toContain('data-unknown="NotInCatalog"');
    expect(unmapped.some((u) => u.type === "NotInCatalog")).toBe(true);

    // 结构门禁零错误
    expect(validateVueFiles(files)).toEqual([]);
  });

  it("App.vue:hash 路由 v-if/v-else-if 链与导航链接", () => {
    const { files } = generateVueProject({
      projectName: "app",
      doc: doc(),
      pages: [
        { surfaceId: "frame_home", title: "首页", device: "desktop" },
        { surfaceId: "frame_list", title: "列表", device: "mobile" },
      ],
    });
    const app = files.find((f) => f.path === "src/App.vue")!;
    expect(app.content).toContain("v-if=");
    expect(app.content).toContain("v-else-if=");
    expect(app.content).toContain(`href="#/${encodeURIComponent("frame_home")}"`);
    expect(app.content).toContain("import Page2 from \"./pages/Page2.vue\";");
  });
});
