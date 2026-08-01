/**
 * LLM 生成管线编排(Harness Agent)
 * analyze:意图识别 + 上下文装配(快速,先回显)
 * generate:真实大模型生成 → 校验 → 动作输出,全程步骤计时
 *
 * 注意:本项目不内置模板引擎——所有页面内容都由真实大模型生成。
 * 仅支持 OpenAI 兼容协议(Kimi / DeepSeek / GPT 等,由 kimi.ts 承载)。
 * 未配置 API Key 时抛出引导错误,由前端提示用户去「设置」配置。
 */
import type {
  ChatAnalyzeResult,
  ChatGenerateResult,
  ChatStep,
  ContextChip,
  DeviceId,
  ImageRef,
  PresetId,
  Sitemap,
  SurfaceDoc,
  SurfaceOp,
} from "@contracts/a2ui";
import { DEFAULT_TOKENS, STYLE_PRESETS, engineDisplayName, validateSurface } from "@contracts/a2ui";
import { llmCalls } from "@db/schema";
import { getDb } from "../queries/connection";
import { kimiGenerateOps, kimiGenerateSitemap, kimiGenerateSurfaces } from "./kimi";
import {
  buildCreateUserPrompt,
  buildHistoryBlock,
  buildPageFromSitemapUserPrompt,
  buildRedesignUserPrompt,
  buildSitemapUserPrompt,
  type ChatTurn,
} from "./prompts";
import type { LlmUsage } from "./usage";

export interface PipelineInput {
  /** 统计落库用;缺省(如单测)则不记录 */
  projectId?: number;
  /** 客户端中断信号:联动中止 LLM fetch */
  signal?: AbortSignal;
  prompt: string;
  chips: ContextChip[];
  projectPreset: PresetId;
  pages: {
    id: number;
    title: string;
    device: string;
    posX: number;
    posY: number;
    width: number;
    height: number;
    surface: SurfaceDoc;
  }[];
  llm: { provider: string; apiKey: string | null; baseUrl: string; model: string; maxTokens?: number } | null;
  /** 最近几轮对话(由调用方从消息表加载),注入 user 消息供模型理解多轮指代 */
  history?: ChatTurn[];
  /** 图片对话能力(由调用方按设置+模型解析);false 时 images 一律不下发 */
  vision?: boolean;
  /** 随 prompt 附带的参考图片(仅 vision 开启时生效) */
  images?: ImageRef[];
}

const PRESET_ALIASES: [RegExp, PresetId][] = [
  [/ant[\s-]?design|antd|蚂蚁/i, "antd"],
  [/shadcn/i, "shadcn"],
  [/element[\s-]?(ui|plus)?|饿了么/i, "element"],
  [/自定义|ai 设计|赛博|custom/i, "custom"],
];

function detectPresetSwitch(prompt: string): PresetId | null {
  if (!/风格|预设|主题|皮肤/.test(prompt) && !PRESET_ALIASES.some(([re]) => re.test(prompt)))
    return null;
  for (const [re, preset] of PRESET_ALIASES) if (re.test(prompt)) return preset;
  return null;
}

// ---------------------------------------------------------------------------
// 轻量路由信号(只用于把请求路由到 create/edit,不参与内容生成)
// ---------------------------------------------------------------------------
/** 设备关键词提示:"生成手机版"等 */
function hintDevice(prompt: string): DeviceId | null {
  if (/手机|移动端|mobile|小程序/i.test(prompt)) return "mobile";
  if (/平板|tablet|ipad/i.test(prompt)) return "tablet";
  return null;
}

/** 编辑意图关键词:无选中页面时,据此判断是"改最后一页"还是"新建页面" */
function looksLikeEdit(prompt: string): boolean {
  return /改|删|换|添加|新增|去掉|移除|调整|优化|重写|重新设计/.test(prompt);
}

/** 多页站点信号:create 模式下据此启用两段式生成(先 sitemap 规划,再逐页生成) */
export function looksLikeSite(prompt: string): boolean {
  return /网站|站点|官网|一套|整套|多页|几页|\d+\s*[个张]?\s*页|页面.{0,6}(包括|包含|分别)|等(几)?个?页面?|页面?(还|都|均)?(没|未)有?(生成|创建|做)|(其他|其它|还有|还要|剩下|剩余|其余)[^。!?.]{0,12}页|[^\s,。,]{1,10}页\s*[+＋和与、,]\s*[^\s,。,]{1,10}页/i.test(prompt)
    // 顿号枚举多个页面名(「收入、支出、报表」)且提到「页」
    || (/(?:、[^、。,]{1,10}){2,}/.test(prompt) && /页/.test(prompt));
}

interface Route {
  mode: "create" | "edit" | "preset";
  presetSwitch?: PresetId;
  device: DeviceId | null;
  target?: { id: number; title: string; device: string; surface: SurfaceDoc };
  /** 选中的组件(支持多选,可能跨页) */
  elementChips?: { pageId: string; aid: string; label: string }[];
}

function route(input: PipelineInput): Route {
  const { prompt, chips, pages } = input;
  const presetSwitch = detectPresetSwitch(prompt);
  const device = hintDevice(prompt);

  const elementChips = chips.filter((c) => c.kind === "element") as Route["elementChips"];
  const pageChipId =
    (chips.find((c) => c.kind === "page") as { pageId: string } | undefined)?.pageId ??
    elementChips?.[0]?.pageId;
  // 多页站点信号优先于编辑路由:画布选中页自动成为 chip 只是上下文,
  // 「再生成 N 个页面」应走新建——ops 协议没有创建页面的能力,误判进 edit 即死路
  const siteIntent = looksLikeSite(prompt) && !elementChips?.length;
  const target = siteIntent
    ? undefined
    : pages.find((p) => String(p.id) === pageChipId) ??
      (pages.length && (elementChips?.length || looksLikeEdit(prompt)) ? pages[pages.length - 1] : undefined);

  if (presetSwitch && presetSwitch !== input.projectPreset && !target && !elementChips?.length) {
    return { mode: "preset", presetSwitch, device };
  }
  if (target) {
    return { mode: "edit", device, target, elementChips: elementChips?.length ? elementChips : undefined };
  }
  return { mode: presetSwitch && presetSwitch !== input.projectPreset ? "preset" : "create", presetSwitch: presetSwitch ?? undefined, device };
}

type LlmEngine = "kimi";

function engineOf(input: PipelineInput): LlmEngine | null {
  return input.llm?.apiKey ? "kimi" : null;
}

const NO_KEY_MESSAGE =
  "尚未配置大模型 API Key。请点击 Agent 面板右上角「设置」,填入 OpenAI 兼容服务的 API Key 后重试。";

/** 生成内容必须有真实 LLM;未配置时抛出引导错误 */
function requireEngine(input: PipelineInput): LlmEngine {
  const engine = engineOf(input);
  if (!engine) throw new Error(NO_KEY_MESSAGE);
  return engine;
}

function engineLabel(engine: LlmEngine | null, llm?: PipelineInput["llm"]): string {
  if (!engine) return "未配置";
  return engineDisplayName(engine, llm?.model, llm?.baseUrl);
}

function llmConfig(input: PipelineInput) {
  return {
    apiKey: input.llm!.apiKey!,
    baseUrl: input.llm!.baseUrl,
    model: input.llm!.model,
    maxTokens: input.llm!.maxTokens,
    signal: input.signal,
  };
}

/** 流式草稿片段:LLM 逐 token 生成时向画布推送的增量文本(未校验,仅用于预览)
 *  传增量 delta 而非全量累积文本:生成后期全量文本可达数百 KB,逐条推送是线性浪费;
 *  SSE 有序可靠,客户端自拼接即可还原 */
export interface DraftChunk {
  mode: "create" | "edit";
  /** edit 模式:目标页面 id */
  pageId?: string;
  /** 自上次推送以来新增的文本 */
  delta: string;
}

/** 附带参考图片时追加给模型的说明(图片本身由 Provider 以多模态消息承载) */
function imageNote(images: ImageRef[] | undefined, kind: "page" | "ops"): string {
  if (!images?.length) return "";
  return kind === "page"
    ? `\n\n(用户附带了 ${images.length} 张参考图片:理解其版式结构、配色风格与信息层级,生成与之呼应的页面;不要在文案中提及图片本身。)`
    : `\n\n(用户附带了 ${images.length} 张参考图片,按图片中的效果执行上述修改指令。)`;
}

// ---------------------------------------------------------------------------
// LLM 调用统计(可观测性):每次 generate* 调用记录耗时 / token / 成败
// ---------------------------------------------------------------------------
/** 用量累加器:一轮生成可能含修复重试(多次 HTTP 请求),逐次累加 */
function usageCollector() {
  let promptTokens = 0;
  let completionTokens = 0;
  const add = (u: LlmUsage) => {
    promptTokens += u.promptTokens ?? 0;
    completionTokens += u.completionTokens ?? 0;
  };
  return { add, total: () => ({ promptTokens, completionTokens }) };
}

/** 统计写库失败绝不阻塞主流程 */
function recordLlmCall(
  input: PipelineInput,
  entry: {
    kind: "surface" | "ops";
    provider: "kimi";
    model: string;
    durationMs: number;
    success: boolean;
    error?: string;
    promptTokens?: number;
    completionTokens?: number;
  },
) {
  if (!input.projectId) return;
  try {
    getDb().insert(llmCalls).values({
      projectId: input.projectId,
      kind: entry.kind,
      provider: entry.provider,
      model: entry.model,
      durationMs: entry.durationMs,
      success: entry.success,
      error: entry.error ?? null,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
    }).run();
  } catch { /* 统计失败不影响生成 */ }
}

// ---------------------------------------------------------------------------
// analyze —— 快速回显:Agent 的"理解"阶段
// ---------------------------------------------------------------------------
export function runAnalyze(input: PipelineInput): ChatAnalyzeResult {
  const r = route(input);
  const engine = engineOf(input) ?? "kimi";
  const parts: string[] = [];
  if (r.elementChips?.length) parts.push(`${r.elementChips.length} 个组件`);
  if (r.target) parts.push(`页面「${r.target.title}」`);
  if (input.projectPreset) parts.push(`风格 ${STYLE_PRESETS[input.projectPreset].label}`);
  if (r.device) parts.push(`设备 ${r.device}`);

  if (r.mode === "preset") {
    return {
      mode: "preset",
      intentLabel: `切换风格 → ${STYLE_PRESETS[r.presetSwitch!].label}`,
      engine,
      contextSummary: parts.join(" · ") || "整个项目",
    };
  }
  return {
    mode: r.mode,
    intentLabel: r.mode === "edit" ? "编辑页面" : "生成新页面",
    targetTitle: r.target?.title,
    engine,
    contextSummary: parts.join(" · ") || (r.mode === "create" ? "新页面" : "当前项目"),
  };
}

// ---------------------------------------------------------------------------
// generate —— 生成 + 校验 + 动作,全程步骤计时
// ---------------------------------------------------------------------------
export async function runPipeline(
  input: PipelineInput,
  onStep?: (s: ChatStep) => void,
  onDraft?: (d: DraftChunk) => void,
): Promise<ChatGenerateResult> {
  const steps: ChatStep[] = [];
  const push = (s: ChatStep): void => {
    // 带 id 的步骤原位更新(running → done/error),保证 result.steps 与流式视图一致(最终覆盖时不出现重复行)
    const idx = s.id ? steps.findIndex((x) => x.id === s.id) : -1;
    if (idx >= 0) steps[idx] = s; else steps.push(s);
    onStep?.(s);
  };
  const step = (key: ChatStep["key"], label: string, fn: () => string | undefined): void => {
    const t0 = Date.now();
    const detail = fn();
    push({ key, label, status: "done", detail, durationMs: Date.now() - t0 });
  };

  /** 生成步骤完成详情:展示输出 token 量(成本可观测;无用量数据时不显示) */
  const tokenDetail = (usage: ReturnType<typeof usageCollector>) => (): string | undefined => {
    const { completionTokens } = usage.total();
    return completionTokens ? `输出 ${(completionTokens / 1000).toFixed(1)}k tokens` : undefined;
  };

  /** 草稿节流(150ms):LLM token 回调 → SSE 草稿事件,只推送增量 delta */
  const draftEmitter = (meta: { mode: "create" | "edit"; pageId?: string }) => {
    if (!onDraft) return undefined;
    let last = 0;
    let sentLen = 0;
    return (text: string) => {
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      const delta = text.slice(sentLen);
      if (!delta) return;
      sentLen = text.length;
      onDraft({ ...meta, delta });
    };
  };

  /** LLM 调用失败统一处理:记录错误步骤后抛出(不再有模板兜底) */
  const fail = (key: ChatStep["key"], label: string, e: unknown): never => {
    const err = e as Error;
    push({ key, label, status: "error", detail: err.message.slice(0, 120) });
    throw err;
  };

  const engine = engineOf(input);
  const r = route(input);
  /** 多轮对话历史块(空串 = 首轮对话);三种生成模式统一注入 user 消息 */
  const historyBlock = buildHistoryBlock(input.history);
  /** 管线级保险:vision 关闭时即使上游误传也绝不下发图片 */
  const images = input.vision === false ? undefined : input.images;

  step("understand", "理解需求", () =>
    r.mode === "preset"
      ? `切换风格 → ${STYLE_PRESETS[r.presetSwitch!].label}`
      : r.mode === "edit"
        ? `编辑「${r.target!.title}」${r.elementChips?.length ? ` · ${r.elementChips.length} 个组件` : ""}`
        : `新建页面${r.device ? `(${r.device})` : ""}${looksLikeSite(input.prompt) ? " · 站点规划" : ""}`,
  );

  step("context", "装配上下文", () => {
    const parts = [`风格 ${STYLE_PRESETS[input.projectPreset].label}`, `引擎 ${engineLabel(engine, input.llm)}`];
    if (r.target) parts.push(`目标「${r.target.title}」`);
    if (r.elementChips?.length) parts.push(`选中 ${r.elementChips.length} 个组件`);
    if (images?.length) parts.push(`参考图 ×${images.length}`);
    return parts.join(" · ");
  });

  // ---------- 换风格(不需要 LLM,未配置 Key 也可用) ----------
  if (r.mode === "preset" && r.presetSwitch) {
    step("apply", "应用变更", () => `setPreset → ${STYLE_PRESETS[r.presetSwitch!].label}`);
    return {
      assistantText: `好的，已将项目风格切换为 **${STYLE_PRESETS[r.presetSwitch].label}**。所有页面会自动用新风格重新渲染——这正是 A2UI 的魔力：组件树不变，渲染器即换即得。`,
      actions: [{ type: "setPreset", preset: r.presetSwitch }],
      engine: engine ?? "kimi",
      model: input.llm?.model ?? "",
      steps,
    };
  }

  // ---------- 编辑 ----------
  if (r.mode === "edit" && r.target) {
    const target = r.target;
    // 1. 元素级 ops(LLM 补丁,支持多选、跨页分组)
    if (r.elementChips?.length) {
      const byPage = new Map<string, string[]>();
      for (const c of r.elementChips) {
        byPage.set(c.pageId, [...(byPage.get(c.pageId) ?? []), c.aid]);
      }
      const actions: ChatGenerateResult["actions"] = [];
      try {
        const eng = requireEngine(input);
        for (const [pageId, aids] of byPage) {
          const page = input.pages.find((p) => String(p.id) === pageId) ?? target;
          const usage = usageCollector();
          const t0 = Date.now();
          let ops: SurfaceOp[];
          try {
            ops = await timeIt(push, "generate", `${engineLabel(eng, input.llm)} 生成 ops`, () =>
              kimiGenerateOps(llmConfig(input), input.prompt + imageNote(images, "ops"), page.surface, aids, usage.add, historyBlock, images),
            tokenDetail(usage));
            recordLlmCall(input, {
              kind: "ops", provider: eng, model: llmConfig(input).model,
              durationMs: Date.now() - t0, success: true, ...usage.total(),
            });
          } catch (e) {
            recordLlmCall(input, {
              kind: "ops", provider: eng, model: llmConfig(input).model,
              durationMs: Date.now() - t0, success: false,
              error: (e as Error).message.slice(0, 200), ...usage.total(),
            });
            throw e;
          }
          step("validate", "校验 ops", () => `${ops.length} 条补丁通过 zod 校验`);
          actions.push({ type: "ops", pageId, ops, summary: input.prompt.slice(0, 30) });
        }
      } catch (e) {
        fail("generate", "生成 ops", e);
      }
      step("apply", "应用变更", () => `ops → ${byPage.size > 1 ? `${byPage.size} 个页面` : `「${target.title}」`}`);
      return {
        assistantText: `已按「${input.prompt.slice(0, 40)}」修改选中的 ${r.elementChips.length} 个组件${byPage.size > 1 ? `(分布在 ${byPage.size} 个页面)` : ""}。`,
        actions,
        engine: engine!,
        model: input.llm?.model ?? "",
        steps,
      };
    }
    // 2. 整页编辑:默认 ops 增量补丁(快、省 token、未提及的内容零回归);
    //    仅当用户明确要推倒重做时才整页重生成
    const wantsRedesign = /重新设计|重做|重画|推倒|重新生成|redesign/i.test(input.prompt);
    if (!wantsRedesign) {
      let ops: SurfaceOp[];
      try {
        const eng = requireEngine(input);
        const usage = usageCollector();
        const t0 = Date.now();
        try {
          ops = await timeIt(push, "generate", `${engineLabel(eng, input.llm)} 生成 ops`, () =>
            kimiGenerateOps(llmConfig(input), input.prompt + imageNote(images, "ops"), target.surface, undefined, usage.add, historyBlock, images),
          tokenDetail(usage));
          recordLlmCall(input, {
            kind: "ops", provider: eng, model: llmConfig(input).model,
            durationMs: Date.now() - t0, success: true, ...usage.total(),
          });
        } catch (e) {
          recordLlmCall(input, {
            kind: "ops", provider: eng, model: llmConfig(input).model,
            durationMs: Date.now() - t0, success: false,
            error: (e as Error).message.slice(0, 200), ...usage.total(),
          });
          throw e;
        }
      } catch (e) {
        fail("generate", "生成 ops", e);
      }
      step("validate", "校验 ops", () => `${ops!.length} 条补丁通过 zod 校验`);
      step("apply", "应用变更", () => `增量补丁 → 「${target.title}」`);
      return {
        assistantText: `已按「${input.prompt.slice(0, 40)}」修改「${target.title}」,未提及的内容保持原样。想要推倒重做的话,对我说「重新设计这个页面」。`,
        actions: [{ type: "ops", pageId: String(target.id), ops: ops!, summary: input.prompt.slice(0, 30) }],
        engine: engine!,
        model: input.llm?.model ?? "",
        steps,
      };
    }
    // 3. 整页重生成(LLM)
    const device = r.device ?? (target.device as DeviceId);
    let surface: SurfaceDoc;
    try {
      const eng = requireEngine(input);
      const usage = usageCollector();
      const t0 = Date.now();
      try {
        const redesignLabel = `${engineLabel(eng, input.llm)} 重新生成`;
        const redesignStepId = `generate:${redesignLabel}`;
        surface = (await timeIt(push, "generate", redesignLabel, () =>
          kimiGenerateSurfaces(
            llmConfig(input),
            buildRedesignUserPrompt(target.title, input.prompt, device, historyBlock) + imageNote(images, "page"),
            draftEmitter({ mode: "edit", pageId: String(target.id) }),
            usage.add,
            images,
            (reason) => push({ id: redesignStepId, key: "generate", label: redesignLabel, status: "running", detail: reason }),
          ),
        tokenDetail(usage)))[0];
        if (!surface) throw new Error("模型未返回页面文档");
        recordLlmCall(input, {
          kind: "surface", provider: eng, model: llmConfig(input).model,
          durationMs: Date.now() - t0, success: true, ...usage.total(),
        });
      } catch (e) {
        recordLlmCall(input, {
          kind: "surface", provider: eng, model: llmConfig(input).model,
          durationMs: Date.now() - t0, success: false,
          error: (e as Error).message.slice(0, 200), ...usage.total(),
        });
        throw e;
      }
    } catch (e) {
      fail("generate", `${engineLabel(engine, input.llm)} 重新生成`, e);
    }
    surface!.page.id = target.surface.page.id;
    step("validate", "校验组件树", () => {
      const errs = validateSurface(surface!);
      return errs.length ? errs.join(";") : `${Object.keys(surface!.components).length} 个组件 · 引用完整`;
    });
    step("apply", "应用变更", () => `整树替换 → 「${target.title}」`);
    return {
      assistantText: `已根据「${input.prompt.slice(0, 40)}」重新设计了「${target.title}」。`,
      actions: [{ type: "updateSurface", pageId: String(target.id), surface: surface! }],
      engine: engine!,
      model: input.llm?.model ?? "",
      steps,
    };
  }

  // ---------- 新建页面(LLM,支持一次多页) ----------
  const device: DeviceId = r.device ?? "desktop";

  /** 单段式:一次调用让模型直接输出一页或 {pages:[...]} 多页 */
  const singleShot = async (eng: LlmEngine): Promise<SurfaceDoc[]> => {
    const usage = usageCollector();
    const t0 = Date.now();
    const label = `${engineLabel(eng, input.llm)} 生成页面`;
    const stepId = `generate:${label}`;
    const emitDraft = draftEmitter({ mode: "create" });
    // token 进度(节流 500ms):页面出现在画布前的明确存活信号
    let lastTick = 0;
    const onTok = (acc: string) => {
      emitDraft?.(acc);
      const now = Date.now();
      if (now - lastTick < 500) return;
      lastTick = now;
      push({ id: stepId, key: "generate", label, status: "running", detail: `已生成 ${(acc.length / 1000).toFixed(1)}k 字符` });
    };
    try {
      const result = await timeIt(push, "generate", label, () =>
        kimiGenerateSurfaces(
          llmConfig(input),
          buildCreateUserPrompt(input.prompt, device, historyBlock) + imageNote(images, "page"),
          onTok,
          usage.add,
          images,
          (reason) => push({ id: stepId, key: "generate", label, status: "running", detail: reason }),
        ),
      tokenDetail(usage));
      recordLlmCall(input, {
        kind: "surface", provider: eng, model: llmConfig(input).model,
        durationMs: Date.now() - t0, success: true, ...usage.total(),
      });
      return result;
    } catch (e) {
      recordLlmCall(input, {
        kind: "surface", provider: eng, model: llmConfig(input).model,
        durationMs: Date.now() - t0, success: false,
        error: (e as Error).message.slice(0, 200), ...usage.total(),
      });
      throw e;
    }
  };

  /**
   * 两段式站点生成:阶段 1 先出 sitemap(页面清单 + 全站导航,小 JSON 快),
   * 阶段 2 逐页生成(每页 prompt 携带全站结构,品牌/导航/令牌天然一致;
   * 且每页 JSON 更小,降低截断率)。草稿流被包装成单个 {pages:[...]} 文本,
   * 前端多页渐进渲染零改动。规划失败或不足两页 → 返回 null 回退单段式。
   * 阶段 2 容忍单页失败:成功页正常交付,失败页在结论中明示(不拖垮整批);
   * 用户主动中止(AbortError)或全部失败时仍整体抛错。
   */
  const twoPhaseSite = async (eng: LlmEngine): Promise<{ docs: SurfaceDoc[]; failedTitles: string[] } | null> => {
    // 阶段 1:sitemap(sitemap 调用与 surface 生成同属 surface 类统计)
    let sitemap: Sitemap;
    const planUsage = usageCollector();
    const tp = Date.now();
    try {
      sitemap = await timeIt(push, "plan", "规划站点结构", () =>
        kimiGenerateSitemap(llmConfig(input), buildSitemapUserPrompt(input.prompt, device, historyBlock), planUsage.add),
      tokenDetail(planUsage));
      recordLlmCall(input, {
        kind: "surface", provider: eng, model: llmConfig(input).model,
        durationMs: Date.now() - tp, success: true, ...planUsage.total(),
      });
    } catch (e) {
      recordLlmCall(input, {
        kind: "surface", provider: eng, model: llmConfig(input).model,
        durationMs: Date.now() - tp, success: false,
        error: (e as Error).message.slice(0, 200), ...planUsage.total(),
      });
      return null;
    }
    if (sitemap.pages.length < 2) return null;
    push({
      key: "plan",
      label: "站点结构",
      status: "done",
      detail: sitemap.pages.map((p) => p.title).join("、"),
    });

    // 阶段 2:并行生成各页(并发 3,慢模型下总时长 ≈ 单页时长而非页数 × 单页)。
    // 草稿协议 {pages:[...]} 需有序文本:有序流式转发器按页序转发 token ——
    // 当前页实时流出(前端组件级渐进渲染),后续页并行生成、轮到时若已完成则整页秒出;
    // 生成期间 running 步骤 detail 展示 token 进度,作为画布出现页面前的存活信号。
    const emit = onDraft ? (delta: string) => onDraft({ mode: "create", delta }) : null;
    emit?.(`{"version":"1","pages":[`);
    const nav = sitemap.nav.join(" / ");
    const sitemapJson = JSON.stringify(sitemap);
    interface PageStream { acc: string; sent: number; done: boolean; fallbackText: string | null }
    const streams: PageStream[] = sitemap.pages.map(() => ({ acc: "", sent: 0, done: false, fallbackText: null }));
    let cur = 0;
    const flush = (): void => {
      if (!emit) return;
      while (cur < streams.length) {
        const s = streams[cur];
        if (s.acc.length > s.sent) { emit(s.acc.slice(s.sent)); s.sent = s.acc.length; }
        if (!s.done) return; // 当前转发页未完成,后续页文本排队等待
        if (s.sent === 0 && s.fallbackText) { emit(s.fallbackText); s.sent = 1; } // 非流式重试成功:整页补发权威文本
        cur++;
        if (cur < streams.length) emit(",");
      }
    };
    let lastFlush = 0;
    /** 单页结果:成功交付文档;失败保留标题与原因(部分成功,不拖垮整批) */
    type PageOutcome = { doc: SurfaceDoc } | { error: Error; title: string };
    const genPage = async (i: number): Promise<PageOutcome> => {
      const pg = sitemap.pages[i];
      const label = `生成「${pg.title}」(${i + 1}/${sitemap.pages.length})`;
      const stepId = `generate:${label}`;
      let lastTick = 0;
      const onTok = (acc: string) => {
        streams[i].acc = acc;
        const now = Date.now();
        if (now - lastTick >= 500) { // token 进度 detail(节流 500ms)
          lastTick = now;
          push({ id: stepId, key: "generate", label, status: "running", detail: `已生成 ${(acc.length / 1000).toFixed(1)}k 字符` });
        }
        if (now - lastFlush < 150) return; // 草稿转发节流 150ms
        lastFlush = now;
        flush();
      };
      const pageUsage = usageCollector();
      const t0 = Date.now();
      try {
        const pageDocs = await timeIt(push, "generate", label, () =>
          kimiGenerateSurfaces(
            llmConfig(input),
            buildPageFromSitemapUserPrompt({
              requirement: input.prompt,
              sitemap: sitemapJson,
              pageCount: sitemap.pages.length,
              index: i + 1,
              pageTitle: pg.title,
              pagePurpose: pg.purpose,
              device,
              nav,
              history: historyBlock,
            }) + imageNote(images, "page"),
            onTok,
            pageUsage.add,
            images,
            (reason) => push({ id: stepId, key: "generate", label, status: "running", detail: reason }),
          ),
        tokenDetail(pageUsage));
        recordLlmCall(input, {
          kind: "surface", provider: eng, model: llmConfig(input).model,
          durationMs: Date.now() - t0, success: true, ...pageUsage.total(),
        });
        const doc = pageDocs[0];
        if (!doc) throw new Error("模型未返回页面文档");
        doc.page.title = pg.title; // 以 sitemap 标题为准(外层仍会统一 uniqueTitle)
        const s = streams[i];
        s.done = true;
        s.fallbackText = JSON.stringify(doc);
        flush(); // 无条件 flush:补发当前页流尾部,并连带转发后续已完成页
        return { doc };
      } catch (e) {
        recordLlmCall(input, {
          kind: "surface", provider: eng, model: llmConfig(input).model,
          durationMs: Date.now() - t0, success: false,
          error: (e as Error).message.slice(0, 200), ...pageUsage.total(),
        });
        // 用户主动停止:整批中止,不做部分交付
        if ((e as Error).name === "AbortError") throw e;
        // 单页失败:草稿槽位补一张失败占位卡(让有序转发器继续),成功页照常交付
        const err = e as Error;
        const placeholder: SurfaceDoc = {
          version: "1.0",
          page: { id: "failed", title: `「${pg.title}」生成失败`, device },
          theme: { preset: input.projectPreset, tokens: DEFAULT_TOKENS },
          components: {
            n1: { type: "Alert", props: { kind: "error", title: "本页生成失败", text: err.message.slice(0, 80) }, children: [] },
          },
          root: "n1",
        };
        const s = streams[i];
        s.done = true;
        if (!s.fallbackText) s.fallbackText = JSON.stringify(placeholder);
        flush();
        return { error: err, title: pg.title };
      }
    };
    const outcomes = await runPool(sitemap.pages.length, 3, genPage);
    flush();
    emit?.("]}");
    const docs = outcomes.filter((o): o is { doc: SurfaceDoc } => "doc" in o).map((o) => o.doc);
    const failedTitles = outcomes.filter((o): o is { error: Error; title: string } => "error" in o).map((o) => o.title);
    // 全部失败 → 整体抛错(与单段式行为一致,进入统一失败处理)
    if (!docs.length) throw outcomes.find((o): o is { error: Error; title: string } => "error" in o)?.error ?? new Error("全部页面生成失败");
    return { docs, failedTitles };
  };

  let docs: SurfaceDoc[];
  /** 两段式中生成失败的页面标题(部分成功时在结论中明示) */
  let failedTitles: string[] = [];
  try {
    const eng = requireEngine(input);
    if (looksLikeSite(input.prompt)) {
      const site = await twoPhaseSite(eng);
      if (site) {
        docs = site.docs;
        failedTitles = site.failedTitles;
      } else {
        docs = await singleShot(eng);
      }
    } else {
      docs = await singleShot(eng);
    }
    if (!docs.length) throw new Error("模型未返回页面文档");
  } catch (e) {
    fail("generate", `${engineLabel(engine, input.llm)} 生成页面`, e);
  }

  const totalComponents = docs!.reduce((sum, d) => sum + Object.keys(d.components).length, 0);
  step("validate", "校验组件树", () => {
    const errs = docs!.flatMap((d, i) => validateSurface(d).map((e) => `页${i + 1}:${e}`));
    return errs.length
      ? errs.join(";")
      : docs!.length > 1
        ? `${docs!.length} 个页面 · 共 ${totalComponents} 个组件 · 引用完整`
        : `${totalComponents} 个组件 · 引用完整`;
  });

  // 每页标题去重;设备以用户要求为准
  const usedTitles = input.pages.map((p) => p.title);
  const actions: ChatGenerateResult["actions"] = docs!.map((doc, i) => {
    if (device !== doc.page.device) doc.page.device = device;
    const title = uniqueTitle(doc.page.title || `新页面 ${i + 1}`, usedTitles);
    doc.page.title = title;
    usedTitles.push(title);
    return {
      type: "createPage" as const,
      pageId: `${Date.now()}-${i}`,
      title,
      device: doc.page.device,
      surface: doc,
    };
  });

  const titles = actions.map((a) => (a.type === "createPage" ? a.title : "")).filter(Boolean);
  step("apply", "应用变更", () =>
    titles.length > 1 ? `新建 ${titles.length} 个画框:${titles.join("、")}` : `新建画框「${titles[0]}」并写入项目`,
  );
  const failureNote = failedTitles.length
    ? `\n\n⚠️ ${failedTitles.map((t) => `「${t}」`).join("、")} 生成失败,其余页面已保留;可以对我说「重试生成${failedTitles[0]}」补建。`
    : "";
  return {
    assistantText:
      titles.length > 1
        ? `已生成 ${titles.length} 个页面:${titles.map((t) => `**${t}**`).join("、")}(${device === "mobile" ? "移动端" : device === "tablet" ? "平板" : "桌面端"})。各页面品牌与设计令牌统一。${failureNote}\n\n可以接着对我说:\n- 「把定价页改成三档对比」「关于页加上团队介绍」\n- 「生成手机版整套」\n- 「换成 Ant Design 风格」`
        : `已生成「${titles[0]}」(${device === "mobile" ? "移动端" : device === "tablet" ? "平板" : "桌面端"})。\n\n可以接着对我说:\n- 双击页面里的组件选中它,说「把标题改成 XXX」「删除这个组件」\n- 「再生成一个定价页」「生成落地页+定价页+关于我们,一套」\n- 「换成 Ant Design 风格」`,
    actions,
    engine: engine!,
    model: input.llm?.model ?? "",
    steps,
  };
}

/** 简易并发池:对 0..count-1 以 limit 路并发执行 worker,结果按索引保序 */
async function runPool<T>(count: number, limit: number, worker: (i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(count);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, count) }, async () => {
    while (cursor < count) {
      const i = cursor++;
      results[i] = await worker(i);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * 计时步骤:先推 running(长时间 LLM 调用期间前端有明确的进行中指示),
 * 完成后推同 id 的 done/error 原位更新,避免「以为卡死」;
 * detail 可选,由结果动态生成完成详情(如输出 token 量)
 */
async function timeIt<T>(
  push: (s: ChatStep) => void,
  key: ChatStep["key"],
  label: string,
  fn: () => Promise<T>,
  detail?: (r: T) => string | undefined,
): Promise<T> {
  const id = `${key}:${label}`;
  push({ id, key, label, status: "running" });
  const t0 = Date.now();
  try {
    const result = await fn();
    push({ id, key, label, status: "done", detail: detail?.(result), durationMs: Date.now() - t0 });
    return result;
  } catch (e) {
    // error 步骤同样携带原因(截断对齐 fail()):步骤条上失败行可直接看到报错,不必翻到结论
    push({ id, key, label, status: "error", detail: (e as Error).message?.slice(0, 120), durationMs: Date.now() - t0 });
    throw e;
  }
}

function uniqueTitle(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}
