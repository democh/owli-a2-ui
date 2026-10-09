import { describe, expect, it } from "vitest";
import { generateProject, validateGeneratedFiles, surfaceDocToTsx } from "./codegen";
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
    dataModels: {}, componentDefs: {},
  };
}

describe("codegen(M5)", () => {
  it("生成完整工程文件集且全部通过语法门禁", () => {
    const { files, unmapped } = generateProject({
      projectName: "运营数据平台",
      doc: doc(),
      pages: [{ surfaceId: "frame_home", title: "首页", device: "desktop" }],
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("index.html");
    expect(paths).toContain("src/App.tsx");
    expect(paths).toContain("src/main.tsx");
    expect(paths).toContain("src/pages/Page1.tsx");
    // 语法门禁零错误
    expect(validateGeneratedFiles(files)).toEqual([]);
    // 未映射组件被报告
    expect(unmapped.some((u) => u.type === "NotInCatalog")).toBe(true);
  });

  it("已知组件映射为语义标签并转义文本", () => {
    const tsx = surfaceDocToTsx({
      version: "1.0",
      page: { id: "s", title: "t", device: "desktop" },
      theme: { preset: "shadcn", tokens: {
        primary: "#000", background: "#fff", surface: "#eee",
        text: "#111", mutedText: "#666", accent: "#00f", radius: 8, font: "",
      } },
      components: {
        root: { type: "Section", props: {}, children: ["x"] },
        x: { type: "Title", props: { text: "标题<A>&{x}" }, children: [] },
      },
      root: "root",
    });
    expect(tsx).toContain("<h2");
    expect(tsx).toContain("标题&lt;A&gt;&amp;&#123;x&#125;");
    expect(tsx).not.toContain("<A>");
  });

  it("props 驱动映射:Button variant=outline / Image 白名单 URL", () => {
    const tsx = surfaceDocToTsx({
      version: "1.0",
      page: { id: "s", title: "t", device: "desktop" },
      theme: { preset: "shadcn", tokens: {
        primary: "#000", background: "#fff", surface: "#eee",
        text: "#111", mutedText: "#666", accent: "#00f", radius: 8, font: "",
      } },
      components: {
        root: { type: "Section", props: {}, children: ["b", "i"] },
        b: { type: "Button", props: { label: "提交", variant: "outline" }, children: [] },
        i: { type: "Image", props: { src: "https://example.com/a.png", alt: "配图" }, children: [] },
      },
      root: "root",
    });
    expect(tsx).toContain("border");
    expect(tsx).toContain('src="https://example.com/a.png"');
    expect(tsx).toContain('alt="配图"');
  });

  it("antd 运行时模板:真实组件 import + 映射渲染器 + 依赖合并(golden)", () => {
    const { files, unmapped } = generateProject({
      projectName: "运营数据平台",
      doc: doc(),
      pages: [{ surfaceId: "frame_home", title: "首页", device: "desktop" }],
      adapterId: "antd",
    });
    const page = files.find((f) => f.path === "src/pages/Page1.tsx")!;
    // 真实组件 import 与映射渲染(组件 import 按页聚合为单行)
    expect(page.content).toContain('import { Button, Typography } from "antd";');
    expect(page.content).toContain('<Typography.Title level={2}>运营看板</Typography.Title>');
    expect(page.content).toContain('<Button type="default">导出</Button>');
    // 布局类退化静态(Section → div),未映射仍报告
    expect(page.content).toContain('className="w-full px-6 py-10"');
    expect(unmapped.some((u) => u.type === "NotInCatalog")).toBe(true);
    // 依赖合并:antd 进入 package.json
    const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.antd).toBe("^6.5.2");
    // 语法门禁通过
    expect(validateGeneratedFiles(files)).toEqual([]);
  });

  it("shadcn-ui 运行时模板:生成 kit 包装层并 import(golden)", () => {
    const { files, unmapped } = generateProject({
      projectName: "运营数据平台",
      doc: doc(),
      pages: [{ surfaceId: "frame_home", title: "首页", device: "desktop" }],
      adapterId: "shadcn-ui",
    });
    // 模板注入包装层
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/ui/kit.tsx");
    const kit = files.find((f) => f.path === "src/ui/kit.tsx")!;
    expect(kit.content).toContain("export function Card");
    expect(kit.content).toContain("export function Button");
    // 页面 import 本地 kit 组件
    const page = files.find((f) => f.path === "src/pages/Page1.tsx")!;
    expect(page.content).toContain('import { Button } from "./ui/kit";');
    expect(page.content).toContain('<Button type="default">导出</Button>');
    expect(unmapped.some((u) => u.type === "NotInCatalog")).toBe(true);
    expect(validateGeneratedFiles(files)).toEqual([]);
  });

  it("默认 shadcn-tailwind:不受运行时模板影响(零回归)", () => {
    const { files } = generateProject({
      projectName: "运营数据平台",
      doc: doc(),
      pages: [{ surfaceId: "frame_home", title: "首页", device: "desktop" }],
      adapterId: "shadcn-tailwind",
    });
    const page = files.find((f) => f.path === "src/pages/Page1.tsx")!;
    expect(page.content).not.toContain("antd");
    expect(page.content).not.toContain("./ui/kit");
    expect(pathsContain(files, "src/ui/kit.tsx")).toBe(false);
  });
});

function pathsContain(files: { path: string }[], p: string): boolean {
  return files.some((f) => f.path === p);
}
