import { z } from "zod";
import { loadPrompt, renderPrompt } from "../../llm/prompts/loader";
import {
  designBriefSchema,
  designPlanSchema,
  uxReviewReportSchema,
  type DesignBrief,
  type DesignPlan,
  type UXReviewReport,
} from "@contracts/agent";
import { clarificationRequestSchema, clarificationResponseTypeSchema, clarificationAffectsSchema, type ClarificationRequest, type ClarificationResponse, type NormalizedClarification } from "@contracts/clarification";
import { styleDirectionSchema, type StyleDirection } from "@contracts/style";
import { BUILTIN_SKILLS as BUILTIN_MANIFESTS } from "@contracts/skill";
import type { AgentContext } from "../context/ContextBuilder";
import type { LLMProvider, ModelProfile } from "../runtime/LLMProvider";

/**
 * 专家角色模块(文档 §4 / §11)
 *
 * 单 Orchestrator + 多专家 Prompt 模块:每个角色 = prompt 模板 + 结构化输出 zod 校验
 * + 一轮错误回灌修复。所有输出必须是结构化 JSON,不接受自由 Markdown。
 */

/** JSON 输出的通用提取与错误回灌修复(共 3 次调用:1 首轮 + 2 回灌;
 * v4-flash 实测一轮回灌后仍可能二次出错,两轮后剩余失败率已低,
 * 残余异常由编排层 expertStage 降级兜底) */
async function completeJson<T>(
  provider: LLMProvider,
  opts: { system: string; user: string; schema: z.ZodType<T>; profile: ModelProfile },
): Promise<T> {
  const parse = (text: string): T | string => {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < 0) return "输出中未找到 JSON 对象";
    try {
      const parsed = opts.schema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
      return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400);
    } catch (e) {
      return `JSON 解析失败: ${(e as Error).message.slice(0, 150)}`;
    }
  };
  let history: { role: "user" | "assistant"; content: string }[] = [];
  let userMsg = opts.user;
  let raw = await provider.complete({ system: opts.system, user: userMsg, profile: opts.profile, history });
  for (let round = 0; ; round++) {
    const outcome = parse(raw);
    if (typeof outcome !== "string") return outcome;
    if (round >= 2) throw new Error(`专家输出未通过 schema 校验: ${outcome.slice(0, 200)}`);
    // 错误回灌:上一轮输出并入 history,末条 user 换成修正指令(避免原问题重复注入)
    history = [...history, { role: "assistant", content: raw }];
    userMsg = `你的上一轮输出未通过 schema 校验,错误:${outcome}。请重新输出严格符合要求的 JSON,不要任何解释。`;
    raw = await provider.complete({ system: opts.system, user: userMsg, profile: opts.profile, history });
    history = [...history, { role: "user", content: userMsg }];
  }
}

// ---------------------------------------------------------------------------
// Intake Analyst
// ---------------------------------------------------------------------------

export async function runIntake(provider: LLMProvider, ctx: AgentContext): Promise<DesignBrief> {
  const system = loadPrompt("agent/orchestrator.md")
    .replace("{{CATALOG_LINES}}", ctx.catalogDigest)
    .replace("{{PROJECT_SUMMARY}}", ctx.projectSummary);
  const user = [
    renderPrompt("agent/intake.md"),
    `\n用户消息:${ctx.request.userMessage}`,
    ctx.request.chips.length ? `画布选中上下文:${JSON.stringify(ctx.request.chips)}` : "",
    // §10.5 用户长期偏好(设置页管理,只读注入)
    ctx.memoryDigest ? `用户历史偏好(必须遵循,不得静默修改):\n${ctx.memoryDigest}` : "",
    ctx.history.length ? `近期会话:${ctx.history.map((h) => `${h.role}:${h.content.slice(0, 120)}`).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  return completeJson(provider, { system, user, schema: designBriefSchema, profile: "planning" });
}

// ---------------------------------------------------------------------------
// Clarification Planner / Normalizer
// ---------------------------------------------------------------------------

export async function planClarification(
  provider: LLMProvider,
  ctx: AgentContext,
  brief: DesignBrief,
  maxQuestions: number,
): Promise<ClarificationRequest | null> {
  if (!brief.clarificationNeeded && brief.confidence >= 0.65) return null;
  const system = loadPrompt("agent/clarification-planner.md").replace("{{MAX_QUESTIONS}}", String(maxQuestions));
  const user = [
    `用户消息:${ctx.request.userMessage}`,
    `DesignBrief:${JSON.stringify({ objective: brief.objective, unknowns: brief.unknowns, assumptions: brief.assumptions, confidence: brief.confidence })}`,
    `项目摘要:${ctx.projectSummary}`,
  ].join("\n\n");
  // 枚举字段放宽接收:v4-flash 偶发输出枚举外值(实测 affects.0 非法导致整轮失败),
  // 与 style 的 tokenOverrides/confidence 同思路——宽松接收后归一,不一次判死
  const schema = z.object({
    reason: z.string(),
    questions: z.array(
      clarificationRequestSchema.shape.questions.element.extend({
        responseType: z.string(),
        affects: z.array(z.string()).default([]),
      }),
    ),
  });
  const out = await completeJson(provider, { system, user, schema, profile: "planning" });
  if (!out.questions.length) return null;
  // 枚举归一:responseType 非法降级为 single_select;affects 过滤非法值(空则合法默认空数组)
  const RESPONSE_TYPES = new Set<string>(clarificationResponseTypeSchema.options);
  const AFFECTS = new Set<string>(clarificationAffectsSchema.options);
  const questions = out.questions.map((q) => ({
    ...q,
    responseType: (RESPONSE_TYPES.has(q.responseType) ? q.responseType : "single_select") as ClarificationRequest["questions"][number]["responseType"],
    affects: q.affects.filter((a): a is ClarificationRequest["questions"][number]["affects"][number] => AFFECTS.has(a)),
  }));
  return {
    requestId: `clar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    runId: ctx.request.idempotencyKey, // 占位;RunManager 发射时以真实 runId 为准
    reason: out.reason,
    questions,
    timeoutSeconds: 300,
    canSkipAll: ctx.request.clarificationPolicy.allowSkip,
    defaultStrategy: ctx.request.clarificationPolicy.useRecommendedDefaults ? "use_recommended_defaults" : "cancel_run",
  };
}

/** 回答归一化(纯函数,文档 §25.8):回答 → 标准化事实 + assumptions */
export function normalizeClarification(request: ClarificationRequest, response: ClarificationResponse): NormalizedClarification {
  const facts: NormalizedClarification["facts"] = {};
  const assumptions: string[] = [];
  const affects = new Set<NormalizedClarification["affects"][number]>();
  let skippedCount = 0;
  for (const q of request.questions) {
    const answer = response.answers.find((a) => a.questionId === q.questionId);
    q.affects.forEach((a) => affects.add(a));
    const useDefaults = !answer || answer.skipped;
    if (useDefaults) {
      skippedCount++;
      const labels = q.options
        .filter((o) => q.defaultOptionIds.includes(o.optionId))
        .map((o) => o.label);
      if (labels.length) {
        facts[q.questionId] = labels.join("、");
        assumptions.push(`${q.title}:未回答,采用推荐默认「${labels.join("、")}」`);
      }
      continue;
    }
    if (answer.customText) {
      facts[q.questionId] = answer.customText;
      continue;
    }
    if (answer.selectedOptionIds.length) {
      const labels = q.options
        .filter((o) => answer.selectedOptionIds.includes(o.optionId))
        .map((o) => o.label);
      facts[q.questionId] = labels.join("、");
    } else if (answer.rankedOptionIds?.length) {
      // §25.3 ranked_choice 归一化:"1.A 2.B 3.C"
      const labels = q.options
        .filter((o) => answer.rankedOptionIds.includes(o.optionId))
        .sort((a, b) => answer.rankedOptionIds.indexOf(a.optionId) - answer.rankedOptionIds.indexOf(b.optionId))
        .map((o) => o.label);
      facts[q.questionId] = labels.map((l, i) => `${i + 1}.${l}`).join(" ");
    } else if (answer.scaleValue !== undefined) {
      facts[q.questionId] = answer.scaleValue;
    } else if (answer.boolValue !== undefined) {
      facts[q.questionId] = answer.boolValue;
    }
  }
  return { facts, assumptions, affects: [...affects], skippedAll: skippedCount === request.questions.length };
}

// ---------------------------------------------------------------------------
// Style Direction Interpreter
// ---------------------------------------------------------------------------

/** 内置 preset 的确定性风格映射(无需 LLM;风格解析降级时也用它兑底) */
const PRESET_STYLE_MAP: Record<string, Partial<StyleDirection>> = {
  clean_minimal: { visualKeywords: ["留白", "网格", "克制"] },
  calm_saas: { visualKeywords: ["冷静", "低干扰", "轻边框"] },
  enterprise_admin: { visualKeywords: ["高密度", "表格效率", "稳定"], tokenOverrides: { tokens: { primary: "#1677ff", radius: 6 } }, layoutPreferences: { density: "compact", cardStyle: "bordered", cornerRadius: "small", spacingScale: "tight", grid: "12-col", typographyScale: "1.25 modular" } },
  bento_grid: { visualKeywords: ["模块化", "卡片", "非对称"] },
  dark_pro: { visualKeywords: ["深色", "荧光强调"], tokenOverrides: { tokens: { background: "#0b0b0f", surface: "#16161d", text: "#f4f4f5", mutedText: "#8b8b96" } } },
  data_dense: { visualKeywords: ["信息效率", "异常优先"], layoutPreferences: { density: "compact", cardStyle: "bordered", cornerRadius: "small", spacingScale: "tight", grid: "12-col", typographyScale: "1.25 modular" } },
};

/** 风格方向确定性基础值(不经 LLM):LLM 解析失败时的降级值,保证管线不中断 */
export function baseStyleDirection(ctx: AgentContext): StyleDirection {
  const { stylePreference } = ctx.request;
  const sd: StyleDirection = styleDirectionSchema.parse({
    styleDirectionId: `sd_${Date.now().toString(36)}`,
    source: stylePreference.mode === "auto" ? "preset" : stylePreference.mode,
    presetIds: stylePreference.presetIds,
    customDescription: stylePreference.customDescription,
    uiLibraryId: stylePreference.uiLibraryId ?? "shadcn-tailwind",
  });
  const presetId = stylePreference.presetIds[0];
  if (presetId && PRESET_STYLE_MAP[presetId]) {
    return styleDirectionSchema.parse({ ...sd, ...PRESET_STYLE_MAP[presetId], confidence: 0.85 });
  }
  return styleDirectionSchema.parse({ ...sd, confidence: 0.6 });
}

export async function resolveStyleDirection(provider: LLMProvider, ctx: AgentContext, brief: DesignBrief): Promise<StyleDirection> {
  const { stylePreference } = ctx.request;
  const sp = styleDirectionSchema;
  const presetId = stylePreference.presetIds[0];
  const sd: StyleDirection = sp.parse({
    styleDirectionId: `sd_${Date.now().toString(36)}`,
    source: stylePreference.mode === "auto" ? "preset" : stylePreference.mode,
    presetIds: stylePreference.presetIds,
    customDescription: stylePreference.customDescription,
    uiLibraryId: stylePreference.uiLibraryId ?? "shadcn-tailwind",
  });

  // 用户显式选择预设且无自定义描述:使用确定性映射(不经 LLM,省一次调用)
  if (presetId && PRESET_STYLE_MAP[presetId] && !stylePreference.customDescription) {
    return baseStyleDirection(ctx);
  }

  const system = loadPrompt("agent/style-interpreter.md");
  const user = [
    `风格来源:${presetId ?? "无预设"};自定义描述:${stylePreference.customDescription ?? "(无)"}`,
    `DesignBrief:${JSON.stringify({ objective: brief.objective, density: brief.density, brandTone: brief.brandTone })}`,
  ].join("\n\n");
  const out = await completeJson(provider, {
    system,
    user,
    schema: z.object({
      designPhilosophy: z.array(z.string()).default([]),
      visualKeywords: z.array(z.string()).default([]),
      // 推理模型可能输出嵌套对象/布尔等非契约类型:此处按 unknown 接收,下游 sanitize 归一
      tokenOverrides: z.record(z.string(), z.unknown()).default({}),
      forbiddenPatterns: z.array(z.string()).default([]),
      confidence: z.number().default(0.8),
    }),
    profile: "planning",
  });
  // token 归一化:仅保留 string/number(契约 designTokenOverridesSchema 要求;非法键会被 applyTokens 忽略)
  const tokens: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(out.tokenOverrides)) {
    if (typeof v === "string" || typeof v === "number") tokens[k] = v;
  }
  // confidence 归一:模型可能输出 0-100 百分制(实测 v4-flash 随机),>1 视为百分制折算后再 clamp 到 [0,1]
  const confidence = Math.min(1, Math.max(0, out.confidence > 1 ? out.confidence / 100 : out.confidence));
  return styleDirectionSchema.parse({
    ...sd,
    designPhilosophy: out.designPhilosophy,
    visualKeywords: out.visualKeywords,
    tokenOverrides: { tokens },
    forbiddenPatterns: out.forbiddenPatterns,
    confidence,
  });
}

// ---------------------------------------------------------------------------
// Skill Router(确定性关键词触发;文档 §24.5)
// ---------------------------------------------------------------------------

export interface SkillMatch {
  skillId: string;
  version: string;
  reason: string;
}

export function selectSkills(ctx: AgentContext, brief: DesignBrief): SkillMatch[] {
  if (ctx.request.skillSelection.mode === "disabled") return [];
  const text = `${ctx.request.userMessage} ${brief.objective}`;
  const manual = ctx.request.skillSelection.mode === "manual";
  const pool = manual
    ? ctx.request.skillSelection.skillIds
    : null;
  const matched: SkillMatch[] = [];
  for (const s of BUILTIN_MANIFESTS) {
    if (!s.enabled) continue;
    if (pool && !pool.includes(s.id)) continue;
    const kw = s.triggers.keywords.find((k) => text.includes(k));
    const intent = s.triggers.intents.includes(ctx.request.mode);
    if (manual ? true : kw || intent) {
      matched.push({
        skillId: s.id,
        version: s.version,
        reason: manual ? "用户手动指定" : kw ? `关键词命中「${kw}」` : `模式 ${ctx.request.mode} 适配`,
      });
    }
    if (matched.length >= 3) break; // 每 Run 最多 3 个
  }
  return matched;
}

/** Skill 贡献的 prompt 片段全文 */
export function skillFragments(skillIds: string[]): string {
  const frags: string[] = [];
  for (const id of skillIds) {
    try {
      frags.push(loadPrompt(`agent/skills/${id}.md`));
    } catch {
      /* 片段缺失忽略 */
    }
  }
  return frags.join("\n\n");
}

// ---------------------------------------------------------------------------
// UX Architect
// ---------------------------------------------------------------------------

export async function runPlanning(provider: LLMProvider, ctx: AgentContext, brief: DesignBrief, style: StyleDirection): Promise<DesignPlan> {
  const system = loadPrompt("agent/ux-architect.md")
    .replace("{{CATALOG_LINES}}", ctx.catalogDigest)
    .replace("{{PROJECT_SUMMARY}}", ctx.projectSummary);
  const user = [
    `用户消息:${ctx.request.userMessage}`,
    `DesignBrief:${JSON.stringify(brief)}`,
    `StyleDirection:${JSON.stringify({ visualKeywords: style.visualKeywords, density: style.layoutPreferences.density })}`,
    // §10.4 设计模式库:命中的结构骨架供参考取舍(不照搬)
    ctx.patterns.length ? `参考设计模式(按任务取舍,不照搬):\n${ctx.patternsDigest}` : "",
    ctx.request.mode === "refine_selection"
      ? `Scope(局部修改,只允许优化选中子树):${JSON.stringify(ctx.scopeSurfaces.map((s) => ({ surfaceId: s.surfaceId, nodeIds: s.nodeIds })))}`
      : `项目摘要:${ctx.projectSummary}`,
  ].filter(Boolean).join("\n\n");
  const schema = z.object({
    pageType: z.string().default("custom"),
    informationArchitecture: designPlanSchema.shape.informationArchitecture,
    layout: designPlanSchema.shape.layout,
    userFlows: designPlanSchema.shape.userFlows,
    componentStrategy: designPlanSchema.shape.componentStrategy,
    dataStrategy: designPlanSchema.shape.dataStrategy,
    interactionStrategy: designPlanSchema.shape.interactionStrategy,
    responsiveStrategy: designPlanSchema.shape.responsiveStrategy,
    accessibilityStrategy: z.array(z.string()).default([]),
    rationale: z.string().default(""),
  });
  const out = await completeJson(provider, { system, user, schema, profile: "planning" });
  return {
    ...out,
    styleDirectionId: style.styleDirectionId,
    uiLibraryId: style.uiLibraryId,
  } as DesignPlan;
}

// ---------------------------------------------------------------------------
// Design Critic
// ---------------------------------------------------------------------------

export async function runReview(
  provider: LLMProvider,
  ctx: AgentContext,
  surfaceSummary: string,
  plan: DesignPlan | undefined,
): Promise<UXReviewReport> {
  const system = loadPrompt("agent/design-critic.md");
  const user = [
    `用户需求:${ctx.request.userMessage}`,
    plan ? `DesignPlan:${JSON.stringify(plan)}` : "",
    `待评审的 Proposal(组件树摘要):${surfaceSummary.slice(0, 8000)}`,
  ].filter(Boolean).join("\n\n");
  return completeJson(provider, { system, user, schema: uxReviewReportSchema, profile: "review" });
}

// ---------------------------------------------------------------------------
// Explanation Builder
// ---------------------------------------------------------------------------

export async function runExplanation(provider: LLMProvider, summary: string): Promise<string> {
  const system = loadPrompt("agent/explanation-builder.md");
  const raw = await provider.complete({ system, user: summary, profile: "explanation" });
  return raw.replace(/```markdown|```/g, "").trim();
}
