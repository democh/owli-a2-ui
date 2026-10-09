import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { GeneratedFile } from "./codegen/codegen";

/**
 * 完整构建门禁(M5-1):esbuild 语法层之上叠加
 *   临时工程 → tsc --noEmit → vite build(→ 可选 puppeteer smoke,默认关)
 *
 * 依赖策略:临时工程 symlink 宿主 node_modules(生成工程的依赖声明与宿主安装一致:
 * react/react-dom/typescript/vite/@vitejs/plugin-react/tailwind),避免每次导出都执行
 * 分钟级 npm install;离线环境同样可构建。smoke 需 puppeteer-core + 本地 Chrome,
 * 通过 env BUILD_GATE_SMOKE=1 与 CHROME_PATH 显式开启。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 宿主 app 根(含 node_modules):api/export/gate.ts → ../../ */
const APP_ROOT = path.resolve(__dirname, "..", "..");

export interface BuildGateIssue {
  code: string;
  severity: "error" | "warning";
  layer: "typecheck" | "build" | "smoke";
  path?: string;
  message: string;
}

export interface BuildGateStep {
  step: "typecheck" | "build" | "smoke";
  ok: boolean;
  durationMs: number;
  detail?: string;
}

export interface BuildGateResult {
  passed: boolean;
  issues: BuildGateIssue[];
  steps: BuildGateStep[];
  durationMs: number;
}

interface SpawnOutcome {
  ok: boolean;
  output: string;
}

/** 运行子进程(合并 stdout/stderr,超时强杀) */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env }, shell: false });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output += `\n[gate] 超时(${timeoutMs}ms)已终止`;
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

/** 安全写盘:拒绝绝对路径与路径穿越;逐级建目录 */
function safeWrite(root: string, relPath: string, content: string): void {
  const target = path.resolve(root, relPath);
  if (!target.startsWith(root + path.sep)) throw new Error(`非法产物路径:${relPath}`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

/** 解析宿主依赖里的可执行脚本(node 入口 js),跨平台不依赖 .bin shim */
function depEntry(pkg: string, entry: string): string {
  const p = path.join(APP_ROOT, "node_modules", pkg, entry);
  if (!existsSync(p)) throw new Error(`宿主缺少依赖 ${pkg}(完整构建门禁需要)`);
  return p;
}

/**
 * 执行完整构建门禁。调用方负责用 validateGeneratedFiles(语法层)先行快速校验;
 * 这里补齐 tsc 类型层与 vite build 产物层。
 */
export async function runBuildGate(
  files: GeneratedFile[],
  opts: { timeoutTypecheckMs?: number; timeoutBuildMs?: number; framework?: "react" | "vue" } = {},
): Promise<BuildGateResult> {
  const startedAt = Date.now();
  const issues: BuildGateIssue[] = [];
  const steps: BuildGateStep[] = [];
  // vue3(experimental):SFC 纯模板无类型面,跳过 tsc 层(experimental 档承诺)
  const skipTypecheck = opts.framework === "vue";

  const work = mkdtempSync(path.join(tmpdir(), "a2ui-gate-"));
  try {
    for (const f of files) safeWrite(work, f.path, f.content);
    // 依赖复用:_symlink 宿主 node_modules(vite/tsc 解析均沿目录向上查找)
    symlinkSync(path.join(APP_ROOT, "node_modules"), path.join(work, "node_modules"), "dir");

    // ① 类型层:tsc --noEmit(仅 src;vue3 跳过并记 warning)
    if (skipTypecheck) {
      steps.push({ step: "typecheck", ok: true, durationMs: 0, detail: "vue3 experimental:跳过 tsc" });
      issues.push({
        code: "build.typecheck_skipped",
        severity: "warning",
        layer: "typecheck",
        message: "Vue 3 工程为 experimental 档,跳过类型检查(vite build 仍强制通过)",
      });
    } else {
      const tscStart = Date.now();
      const tscJs = depEntry("typescript", path.join("lib", "tsc.js"));
      const tscOut = await run(process.execPath, [tscJs, "--noEmit"], work, opts.timeoutTypecheckMs ?? 120_000);
      steps.push({ step: "typecheck", ok: tscOut.ok, durationMs: Date.now() - tscStart });
      if (!tscOut.ok) {
        issues.push({
          code: "build.typecheck_failed",
          severity: "error",
          layer: "typecheck",
          message: tscOut.output.trim().slice(0, 2000) || "tsc --noEmit 失败",
        });
      }
    }

    // ② 产物层:vite build(React 路径要求 tsc 先通过;vue 直接构建)
    const reactTypecheckOk = !skipTypecheck && steps[0]?.ok !== false;
    if (skipTypecheck || reactTypecheckOk) {
      const viteStart = Date.now();
      const viteJs = depEntry("vite", path.join("bin", "vite.js"));
      const viteOut = await run(process.execPath, [viteJs, "build"], work, opts.timeoutBuildMs ?? 180_000);
      steps.push({ step: "build", ok: viteOut.ok, durationMs: Date.now() - viteStart });
      if (!viteOut.ok) {
        issues.push({
          code: "build.vite_failed",
          severity: "error",
          layer: "build",
          message: viteOut.output.trim().slice(0, 2000) || "vite build 失败",
        });
      }
    }

    // ③ smoke(可选,puppeteer 打开产物页收集 console error;默认关闭)
    if (process.env.BUILD_GATE_SMOKE === "1") {
      const smokeStart = Date.now();
      try {
        const { smokeTestDist } = await import("./smoke");
        const smoke = await smokeTestDist(work);
        steps.push({ step: "smoke", ok: smoke.ok, durationMs: Date.now() - smokeStart, detail: smoke.detail });
        if (!smoke.ok) {
          issues.push({ code: "build.smoke_failed", severity: "error", layer: "smoke", message: smoke.detail });
        }
      } catch (e) {
        steps.push({ step: "smoke", ok: false, durationMs: Date.now() - smokeStart, detail: (e as Error).message });
        // smoke 依赖本地 Chrome,环境缺失降级为 warning 不阻断
        issues.push({ code: "build.smoke_unavailable", severity: "warning", layer: "smoke", message: (e as Error).message });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  return {
    passed: issues.every((i) => i.severity !== "error"),
    issues,
    steps,
    durationMs: Date.now() - startedAt,
  };
}
