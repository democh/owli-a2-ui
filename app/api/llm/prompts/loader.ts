/**
 * Prompt 文件加载器
 * - 所有 prompt 以纯文本 .md 文件按模块维护在本目录下,运行时读取
 * - 支持两种粒度:
 *   1. 单文件:loadPrompt / renderPrompt("user/create.md", ...)
 *   2. 目录模块:loadModule / renderModule("surface", ...) —— 按文件名排序拼接目录下所有 .md,
 *      用数字前缀控制模块顺序(00-role → 01-contract → … → 99-catalog)
 * - 支持 {{VAR}} 占位符,由 render* 注入动态值;未提供的占位符原样保留,便于排查
 * - 路径基于 process.cwd()(dev / 生产 / Docker 均以项目根目录启动,与 data/deploys 的约定一致)
 */
import fs from "node:fs";
import path from "node:path";

const PROMPTS_DIR = path.resolve(process.cwd(), "api/llm/prompts");

const fileCache = new Map<string, string>();
const moduleCache = new Map<string, string>();

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => vars[key] ?? raw);
}

/** 读取单个 prompt 文件(带缓存,去掉首尾空白以统一拼接行为) */
export function loadPrompt(relPath: string): string {
  const cached = fileCache.get(relPath);
  if (cached !== undefined) return cached;
  const text = fs.readFileSync(path.join(PROMPTS_DIR, relPath), "utf-8").trim();
  fileCache.set(relPath, text);
  return text;
}

/** 按文件名排序拼接一个模块目录下的所有 .md(双换行分隔,带缓存) */
export function loadModule(dir: string): string {
  const cached = moduleCache.get(dir);
  if (cached !== undefined) return cached;
  const abs = path.join(PROMPTS_DIR, dir);
  const files = fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (!files.length) throw new Error(`prompt 模块目录为空: ${dir}`);
  const text = files.map((f) => loadPrompt(path.join(dir, f))).join("\n\n");
  moduleCache.set(dir, text);
  return text;
}

/** 读取单文件并用 {{VAR}} 占位符渲染 */
export function renderPrompt(relPath: string, vars: Record<string, string> = {}): string {
  return render(loadPrompt(relPath), vars);
}

/** 组合模块目录并用 {{VAR}} 占位符渲染 */
export function renderModule(dir: string, vars: Record<string, string> = {}): string {
  return render(loadModule(dir), vars);
}
