import { describe, expect, it } from "vitest";
import { runBuildGate } from "./gate";
import type { GeneratedFile } from "./codegen/codegen";

/**
 * 完整构建门禁测试(M5-1):真实执行 tsc --noEmit → vite build。
 * 依赖复用宿主 node_modules,无需网络;总耗时约 20-40s(vitest 默认超时 5s,需放宽)。
 */

function minimalProject(mainTsx: string): GeneratedFile[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "a2ui-gate-test",
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: { build: "tsc --noEmit && vite build" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
        devDependencies: { typescript: "^5.6.3", vite: "^5.4.11" },
      }),
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      }),
    },
    {
      path: "vite.config.ts",
      content: `export default { build: { outDir: "dist" } };\n`,
    },
    {
      path: "index.html",
      content: `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`,
    },
    { path: "src/main.tsx", content: mainTsx },
  ];
}

describe("runBuildGate(完整构建门禁)", () => {
  it(
    "合法工程:tsc 与 vite build 全部通过",
    async () => {
      const result = await runBuildGate(
        minimalProject(`import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render("ok");\n`),
      );
      expect(result.steps.find((s) => s.step === "typecheck")?.ok).toBe(true);
      expect(result.steps.find((s) => s.step === "build")?.ok).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    },
    240_000,
  );

  it(
    "类型错误工程:typecheck 失败并输出结构化报告(不进入 vite build)",
    async () => {
      const result = await runBuildGate(
        minimalProject(`const n: number = "不是数字";\nexport default n;\n`),
      );
      expect(result.steps.find((s) => s.step === "typecheck")?.ok).toBe(false);
      expect(result.steps.find((s) => s.step === "build")).toBeUndefined();
      expect(result.passed).toBe(false);
      const err = result.issues.find((i) => i.code === "build.typecheck_failed");
      expect(err?.severity).toBe("error");
      expect(err?.layer).toBe("typecheck");
    },
    240_000,
  );
});
