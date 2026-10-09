import { describe, expect, it } from "vitest";
import { tsxFilesToSurfaces } from "./tsx-importer";
import { generateProject, validateGeneratedFiles } from "../export/codegen/codegen";

/**
 * TSX Importer 测试(M5.3 退出标准:未映射项准确标记 + IR 往返可构建)
 */

const LOGIN_TSX = `export default function Login() {
  return (
    <section className="login-page">
      <h1>用户登录</h1>
      <p>欢迎回来,请输入账号信息</p>
      <input type="email" placeholder="邮箱" />
      <input type="password" placeholder="密码" />
      <label>
        <input type="checkbox" /> 记住我
      </label>
      <button className="btn-primary">登 录</button>
      <a href="#/reset">忘记密码</a>
      <img src="https://cdn.example.com/banner.png" alt="登录横幅" />
    </section>
  );
}`;

const DASH_TSX = `export default function Dash() {
  return (
    <main>
      <h2>运营看板</h2>
      <table><tbody><tr><td>1</td></tr></tbody></table>
      <StatCard value={42} />
    </main>
  );
}`;

describe("tsxFilesToSurfaces", () => {
  it("登录页:HTML 标签映射 Catalog + 文本入 props.text + 属性透传", () => {
    const { surfaces, report } = tsxFilesToSurfaces([{ name: "login.tsx", content: LOGIN_TSX }]);
    const s = surfaces[0]!;
    expect(s.id).toBe("import_login");
    const types = Object.values(s.components).map((n) => n.type);
    expect(types).toContain("Title");
    expect(types).toContain("Input");
    expect(types).toContain("Button");
    expect(types).toContain("Link");
    expect(types).toContain("Image");
    // 文本节点
    const title = Object.values(s.components).find((n) => n.type === "Title")!;
    expect(title.props.text).toBe("用户登录");
    expect(title.props.level).toBe(1);
    // 属性透传
    const input = Object.values(s.components).find((n) => n.type === "Input")!;
    expect(input.props.placeholder).toBe("邮箱");
    const link = Object.values(s.components).find((n) => n.type === "Link")!;
    expect(link.props.href).toBe("#/reset");
    const img = Object.values(s.components).find((n) => n.type === "Image")!;
    expect(img.props.alt).toBe("登录横幅");
    // className 保留
    expect(Object.values(s.components).some((n) => typeof n.props.className === "string")).toBe(true);
    // 报告:该文件全部映射成功
    expect(report.unmapped).toHaveLength(0);
    expect(report.files[0]?.nodeCount).toBeGreaterThan(5);
  });

  it("未映射项准确标记:自定义组件与未知标签降级 Col + data-unmapped", () => {
    const { surfaces, report } = tsxFilesToSurfaces([{ name: "dash.tsx", content: DASH_TSX }]);
    const s = surfaces[0]!;
    const degraded = Object.values(s.components).filter((n) => n.props["data-unmapped"] != null);
    const tags = degraded.map((n) => n.props["data-unmapped"] as string);
    // 自定义组件 StatCard、未知标签 tbody/tr/td 均被准确报告
    expect(tags).toContain("StatCard");
    expect(tags).toContain("tbody");
    expect(report.unmapped.some((u) => u.tag === "StatCard")).toBe(true);
    expect(report.unmapped.some((u) => u.tag === "td")).toBe(true);
    // h2 → Title level 2
    const title = Object.values(s.components).find((n) => n.type === "Title")!;
    expect(title.props.level).toBe(2);
  });

  it("表达式容器跳过并计数(静态快照语义)", () => {
    const { report } = tsxFilesToSurfaces([
      { name: "expr.tsx", content: "<div>{count + 1}</div>" },
    ]);
    expect(report.skippedExpressions).toBeGreaterThanOrEqual(1);
  });

  it("多文件导入:每个文件一个 surface,id 去重", () => {
    const { surfaces, report } = tsxFilesToSurfaces([
      { name: "login.tsx", content: LOGIN_TSX },
      { name: "login.tsx", content: LOGIN_TSX },
      { name: "dash.tsx", content: DASH_TSX },
    ]);
    expect(surfaces).toHaveLength(3);
    expect(new Set(surfaces.map((s) => s.id)).size).toBe(3);
    expect(report.files).toHaveLength(3);
  });

  it("顶层 Fragment 与多根节点:提升与 Section 包装", () => {
    const { surfaces } = tsxFilesToSurfaces([
      { name: "frag.tsx", content: "<><h1>标题</h1><p>说明</p></>" },
      { name: "multi.tsx", content: "<div /><div />" },
    ]);
    expect(surfaces[0]!.root).toBeTruthy();
    // multi.tsx 两个根 → 包 Section
    const s2 = surfaces[1]!;
    expect(Object.values(s2.components).filter((n) => n.type === "Section")).toHaveLength(1);
  });

  it("空内容与超限防护", () => {
    expect(() => tsxFilesToSurfaces([{ name: "empty.tsx", content: "const x = 1;" }])).toThrow(/没有可导入/);
    expect(() =>
      tsxFilesToSurfaces(Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.tsx`, content: "<div />" }))),
    ).toThrow(/文件数超限/);
  });

  it("往返冒烟:导入 IR → codegen 可构建工程且语法门禁通过", () => {
    const { surfaces } = tsxFilesToSurfaces([{ name: "login.tsx", content: LOGIN_TSX }]);
    const doc = {
      revision: 1,
      theme: {
        preset: "shadcn" as const,
        tokens: { primary: "#18181b", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "" },
      },
      surfaces: Object.fromEntries(surfaces.map((s) => [s.id, s])),
      dataModels: {}, componentDefs: {},
    };
    const { files } = generateProject({
      projectName: "imported",
      doc: doc,
      pages: surfaces.map((s) => ({ surfaceId: s.id, title: s.title, device: "desktop" as const })),
    });
    expect(validateGeneratedFiles(files)).toEqual([]);
  });
});
