/**
 * A2UI LLM 提示词统一出口
 * prompt 文本按模块拆分为独立 .md 文件,运行时组合:
 * - surface/    页面生成系统提示词(角色 / 输出契约 / 结构规则 / 内部分析 / 多页 / 设计规范 / 蓝图 / 文案 / 组件目录 / 输出自检)
 * - ops/        元素编辑系统提示词(角色 / op 参考 / 编辑策略 / 规则 / 示例 / 组件目录)
 * - shared/     跨场景共享模块(props 速查,被 surface 的 08-catalog 与 ops 的 99-catalog 内嵌)
 * - user/       各场景 user 消息模板
 * 模块文件用数字前缀控制拼接顺序;这里只做加载、{{占位符}} 注入和动态部分的拼装。
 */
import type { DeviceId } from "@contracts/a2ui";
import { CATALOG_GROUPS } from "@contracts/a2ui";
import { loadPrompt, renderModule, renderPrompt } from "./loader";

/** 按分组拼接的组件目录行(由 contracts 中的组件注册表动态生成) */
const CATALOG_LINES = CATALOG_GROUPS.map((g) => `${g.group}: ${g.types.join(", ")}`).join("\n");

const PROPS_GUIDE = loadPrompt("shared/props-guide.md");
const SYSTEM_VARS = { CATALOG_LINES, PROPS_GUIDE };

// ---------------------------------------------------------------------------
// 系统提示词(由模块目录组合而成)
// ---------------------------------------------------------------------------

export const SURFACE_SYSTEM_PROMPT = renderModule("surface", SYSTEM_VARS);
export const OPS_SYSTEM_PROMPT = renderModule("ops", SYSTEM_VARS);
/** sitemap 规划用精简系统提示词(不含组件目录,避免无关上下文) */
export const SITEMAP_SYSTEM_PROMPT = loadPrompt("sitemap/system.md");

// ---------------------------------------------------------------------------
// 对话历史注入(多轮指代:「改回去」「再换一个」「刚才那个」)
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** 渲染历史块;无历史返回空串(模板占位符被替换为空,不留痕迹)。单条截断防超长 prompt */
export function buildHistoryBlock(history: ChatTurn[] | undefined, maxTurns = 6, maxChars = 300): string {
  if (!history?.length) return "";
  const lines = history
    .slice(-maxTurns)
    .map((t) => `- ${t.role === "user" ? "用户" : "助手"}:${t.content.replace(/\s+/g, " ").trim().slice(0, maxChars)}`)
    .join("\n");
  return renderPrompt("user/history.md", { lines });
}

// ---------------------------------------------------------------------------
// 页面生成 user 消息(pipeline)
// ---------------------------------------------------------------------------

/** 新建页面:用户原始需求 → 生成一页或多页 */
export function buildCreateUserPrompt(requirement: string, device: DeviceId, history?: string): string {
  return renderPrompt("user/create.md", { requirement, device, history: history ?? "" });
}

/** 整页重生成:保留页面 id,只替换组件树 */
export function buildRedesignUserPrompt(pageTitle: string, requirement: string, device: DeviceId, history?: string): string {
  return renderPrompt("user/redesign.md", { pageTitle, requirement, device, history: history ?? "" });
}

/** 两段式站点生成·阶段 1:需求 → sitemap(页面清单 + 全站导航) */
export function buildSitemapUserPrompt(requirement: string, device: DeviceId, history?: string): string {
  return renderPrompt("user/sitemap.md", { requirement, device, history: history ?? "" });
}

/** 两段式站点生成·阶段 2:按 sitemap 中的某一页生成单页文档(带全站统一约束) */
export function buildPageFromSitemapUserPrompt(input: {
  requirement: string;
  /** sitemap 的 JSON 字符串(全量,供模型对齐定位与风格) */
  sitemap: string;
  pageCount: number;
  /** 第几页(1 起) */
  index: number;
  pageTitle: string;
  pagePurpose: string;
  device: DeviceId;
  /** 全站导航文案(顿号或斜杠分隔均可,原样给模型) */
  nav: string;
  history?: string;
}): string {
  return renderPrompt("user/create-from-sitemap.md", {
    requirement: input.requirement,
    sitemap: input.sitemap,
    pageCount: String(input.pageCount),
    index: String(input.index),
    pageTitle: input.pageTitle,
    pagePurpose: input.pagePurpose,
    device: input.device,
    nav: input.nav,
    history: input.history ?? "",
  });
}

// ---------------------------------------------------------------------------
// 元素级编辑 ops user 消息(kimi.ts)
// ---------------------------------------------------------------------------

/** ops 生成的 user 消息:主题令牌 + 相关组件扁平表 + 选中说明 + 修改指令 + 可选对话历史 */
export function buildOpsUserMessage(input: {
  tokens: unknown;
  contextNodes: Record<string, unknown>;
  selectedDesc: string;
  instruction: string;
  history?: string;
}): string {
  return renderPrompt("user/ops-context.md", {
    tokens: JSON.stringify(input.tokens),
    contextNodes: JSON.stringify(input.contextNodes),
    selectedDesc: input.selectedDesc,
    instruction: input.instruction,
    history: input.history ?? "",
  });
}

/** 选中组件描述,如 "选中组件:n3(Button), n7(Card)";未选中时为空串 */
export function buildSelectedDesc(
  aids: string[] | undefined,
  typeOf: (aid: string) => string | undefined,
): string {
  if (!aids?.length) return "";
  const items = aids.map((a) => `${a}(${typeOf(a) ?? "未知"})`).join(", ");
  return renderPrompt("user/ops-selected.md", { items });
}

// ---------------------------------------------------------------------------
// 校验失败后的修复追问(两轮重试用)
// ---------------------------------------------------------------------------

/** 页面文档校验失败 */
export function surfaceRepairMessage(error: string): string {
  return renderPrompt("user/repair-surface.md", { error });
}

/** ops 补丁校验失败 */
export function opsRepairMessage(detail: string): string {
  return renderPrompt("user/repair-ops.md", { detail });
}

/** ops 输出 JSON 解析失败 */
export function opsJsonRepairMessage(detail: string): string {
  return renderPrompt("user/repair-json.md", { detail });
}
