/**
 * OpenAI 兼容 Provider(默认指向 Kimi,可配置任意 OpenAI 兼容服务:DeepSeek / GPT / Qwen 等)
 * 系统提示词统一放在 ./prompts
 */
import type { ImageRef, SurfaceDoc, SurfaceOp } from "@contracts/a2ui";
import { applyOps, surfaceDocSchema, surfaceOpSchema, validateSurface } from "@contracts/a2ui";
import { z } from "zod";
import { combinedSignal, type UsageCallback } from "./usage";
import {
  OPS_SYSTEM_PROMPT,
  buildOpsUserMessage,
  buildSelectedDesc,
  opsJsonRepairMessage,
  opsRepairMessage,
} from "./prompts";

export interface KimiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 输出 token 上限(含推理模型的思考预算);缺省 16384 */
  maxTokens?: number;
  /** 客户端中断信号(可选,与内部超时合并) */
  signal?: AbortSignal;
}

/** 输出预算耗尽(finish_reason=length):推理模型思考占满 max_tokens 或正文被截断;应放大预算重试,而不是判定流式不可用或进入修复循环 */
export class BudgetExhaustedError extends Error {}

/** LLM 请求超时(随输出预算动态计算的超时上限被触发);直接上抛给用户,不重试(同预算重试大概率仍超时) */
export class LlmTimeoutError extends Error {}

/** LLM HTTP 状态错误(401/429/5xx 等):鉴权/限流/服务故障与流式可用性无关,直接上抛,不回退非流式、不拉黑流式 */
export class LlmApiError extends Error {}

/** 把 LLM HTTP 错误翻译为可操作的指引(状态码 → 用户下一步动作) */
function classifyHttpError(status: number, body: string): LlmApiError {
  const tail = body.trim() ? `:${body.replace(/\s+/g, " ").slice(0, 100)}` : "";
  if (status === 401 || status === 403) return new LlmApiError(`API Key 无效或已过期(HTTP ${status}),请在「设置」中检查 Key`);
  if (status === 402) return new LlmApiError(`模型服务余额不足(HTTP 402),请充值后重试`);
  if (status === 429) return new LlmApiError(`模型服务限流(HTTP 429),请稍后重试`);
  if (status === 400 && /context|too.?long|length|max.?tokens/i.test(body))
    return new LlmApiError(`请求超出模型上下文或参数限制(HTTP 400),请缩短需求描述或更换模型`);
  if (status >= 500) return new LlmApiError(`模型服务暂时不可用(HTTP ${status}),请稍后重试`);
  return new LlmApiError(`LLM API ${status}${tail}`);
}

/** OpenAI 兼容消息内容:纯文本或多模态分段(文本 + image_url) */
export type ChatContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

/** 附带参考图片时组装多模态 user 消息;无图片保持纯文本(向后兼容、不误伤纯文本模型) */
export function userContent(text: string, images?: ImageRef[]): ChatContent {
  if (!images?.length) return text;
  return [
    { type: "text", text },
    ...images.map((img) => ({ type: "image_url" as const, image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
  ];
}

/** 非流式 JSON 调用(Harness LLMProvider 复用) */
export async function callKimi(
  cfg: KimiConfig,
  messages: { role: string; content: ChatContent }[],
  onUsage?: UsageCallback,
  boost = 1,
): Promise<string> {
  const timeoutMs = requestTimeoutMs(cfg, boost);
  try {
    // 空内容偶发(端点波动/审核误拦,无截断信号):静默重试一次,成功即用;
    // 避免整条 Run 因一次偶发空响应失败(重跑整轮代价 8 分钟+)
    for (let attempt = 1; ; attempt++) {
      const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          // 完整页面 JSON 较长,给足输出预算,避免截断后修复循环也救不回来;
          // 推理模型(如 deepseek-reasoner)的思考过程也占用该预算,自动放大
          max_tokens: effectiveMaxTokens(cfg, boost),
          // 注意:kimi-for-coding 端点只允许 temperature=1,不传由服务端默认
          response_format: { type: "json_object" },
        }),
        signal: combinedSignal(timeoutMs, cfg.signal),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw classifyHttpError(resp.status, text);
      }
      const data = (await resp.json()) as {
        choices: { message: { content: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices[0];
      // finish_reason=length:输出被 max_tokens 截断(推理模型可能把预算全部用于思考而 content 为空);
      // 这种输出必定不完整,继续走解析/修复只是浪费一轮,直接抛预算耗尽让调用方放大预算重试
      if (choice?.finish_reason === "length") throw new BudgetExhaustedError("输出达到 max_tokens 上限被截断");
      const content = choice?.message?.content ?? "";
      // 空内容(无截断信号):重试最多 2 次(退避 3s/6s)仍为空才 fail-fast,
      // 避免把空 assistant 消息推进修复轮(部分端点会直接 400);
      // 空响应实测会连续出现(端点波动/审核误拦),退避过短(<10s)扛不住一次波动窗口
      if (!content) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 3000 * attempt));
          continue;
        }
        throw new Error("模型返回了空内容(重试 2 次仍为空,可能被安全策略拦截或端点异常),请调整需求后重试");
      }
      // usage 仅在成功返回内容时回调,避免重试路径重复计数
      if (data.usage) onUsage?.({ promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens });
      return content;
    }
  } catch (e) {
    throw normalizeRequestError(e, timeoutMs);
  }
}

/**
 * 流式调用(SSE):逐 token 累积,onToken 收到的是"到目前为止的完整文本"
 * 用于画布渐进渲染草稿;传输层失败抛错由调用方回退非流式,
 * 预算耗尽抛 BudgetExhaustedError 由调用方放大 max_tokens 重试(不回退、不拉黑流式)
 */
/** 流式 JSON 调用(Harness LLMProvider 复用) */
export async function callKimiStream(
  cfg: KimiConfig,
  messages: { role: string; content: ChatContent }[],
  onToken: (acc: string) => void,
  onUsage?: UsageCallback,
  boost = 1,
): Promise<string> {
  const timeoutMs = requestTimeoutMs(cfg, boost);
  try {
    // 空流瞬态(端点波动/审核误拦,无截断信号):静默重开连接重试一次;
    // 空流时 onToken 未推送过任何增量(acc 为空),重试不会让调用方收到重复文本;
    // 重试仍空才抛错走回退非流式(实测一次空流后重开连接成功率高)。重试轮丢弃前轮 usage,宁可少计不多计
    for (let attempt = 1; ; attempt++) {
      const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: true,
          // 完整页面 JSON 较长,给足输出预算,避免截断后修复循环也救不回来
          max_tokens: effectiveMaxTokens(cfg, boost),
          // 流式末帧回传 token 用量
          stream_options: { include_usage: true },
          response_format: { type: "json_object" },
        }),
        signal: combinedSignal(timeoutMs, cfg.signal),
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        throw classifyHttpError(resp.status, text);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let buffer = "";
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      let finishReason: string | undefined;
      let sawReasoning = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (choice?.delta?.reasoning_content) sawReasoning = true;
            const delta = choice?.delta?.content;
            if (delta) {
              acc += delta;
              onToken(acc);
            }
          } catch { /* 半行 JSON,忽略 */ }
        }
      }
      // finish_reason=length:输出被 max_tokens 截断(或推理模型思考占满预算、正文为空),放大预算重试才有意义
      if (finishReason === "length")
        throw new BudgetExhaustedError(acc ? "输出达到 max_tokens 上限被截断" : "模型思考占满输出预算,未产出正文");
      // 无内容且无截断信号:传输层疑似异常(空 SSE 流),重试一次仍空才按流式失败处理
      if (!acc) {
        if (attempt < 2) continue;
        throw new Error(sawReasoning ? "流式响应为空(仅有思考输出)" : "流式响应为空");
      }
      if (usage) onUsage?.({ promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens });
      return acc;
    }
  } catch (e) {
    throw normalizeRequestError(e, timeoutMs);
  }
}

/** 引号感知的花括号配对:提取首个平衡的 JSON 对象(容忍 JSON 后尾随杂讯/重复输出的第二段对象) */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 未闭合(截断输出交给半截容错链路)
}

function tryParseSurface(raw: string): { doc?: SurfaceDoc; error?: string } {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) return { error: "输出中未找到 JSON 对象" };
  // 候选切片:首选首尾切片;若模型在完整 JSON 后重复输出第二段对象/尾随文本,
  // 首尾切片会把两个对象拼在一起必炸("Unexpected non-whitespace character after JSON",
  // 实测杀死过修复轮整条 Run),此时退回首个平衡对象再试
  const candidates = [cleaned.slice(start, end + 1)];
  const first = extractFirstJsonObject(cleaned);
  if (first && first !== candidates[0]) candidates.push(first);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // 切片不可解析,尝试下一候选
    }
    const result = surfaceDocSchema.safeParse(parsed);
    if (!result.success) return { error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) };
    const refErrors = validateSurface(result.data);
    if (refErrors.length) return { error: refErrors.join("; ") };
    return { doc: result.data };
  }
  return { error: `JSON 解析失败: 输出不是完整闭合的 JSON 对象(长度 ${cleaned.length})` };
}

/** 解析单页或多页({pages:[...]})输出,统一返回文档数组(Harness 编排复用) */
export function tryParseSurfaces(raw: string): { docs?: SurfaceDoc[]; error?: string } {
  const multi = raw.replace(/```json|```/g, "").trim();
  // 候选切片:整段首尾切片 + 首个平衡对象(容忍 JSON 后尾随的杂讯/重复输出)
  const slices = new Set<string>();
  const start = multi.indexOf("{");
  const end = multi.lastIndexOf("}");
  if (start >= 0 && end > start) slices.add(multi.slice(start, end + 1));
  const first = extractFirstJsonObject(multi);
  if (first) slices.add(first);
  for (const slice of slices) {
    try {
      const parsed = JSON.parse(slice) as Record<string, unknown>;
      if (Array.isArray(parsed?.pages) && parsed.pages.length) {
        const docs: SurfaceDoc[] = [];
        for (let i = 0; i < parsed.pages.length; i++) {
          const r = surfaceDocSchema.safeParse(parsed.pages[i]);
          if (!r.success)
            return { error: `pages[${i}] 校验失败: ${r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ").slice(0, 400)}` };
          const refErrors = validateSurface(r.data);
          if (refErrors.length) return { error: `pages[${i}] 引用错误: ${refErrors.join("; ")}` };
          docs.push(r.data);
        }
        return { docs };
      }
    } catch { /* 尝试下一候选/落入单页解析 */ }
  }
  const { doc, error } = tryParseSurface(raw);
  return doc ? { docs: [doc] } : { error };
}

/** 推理模型(deepseek-reasoner / o1 / r1 等)的 reasoning 会烧掉大量 token 预算,放大输出上限防 content 被挤占截断 */
const REASONING_MODEL = /reasoner|r1|o1|o3|thinking/i;
/**
 * 输出 token 上限:推理模型基础值放大;boost 为预算耗尽后的重试放大倍数(×2 递增)
 * 封顶防越界:普通模型 65536,推理模型 131072
 */
function effectiveMaxTokens(cfg: KimiConfig, boost = 1): number {
  const base = cfg.maxTokens ?? 16384;
  const reasoning = REASONING_MODEL.test(cfg.model);
  const scaled = Math.round((reasoning ? Math.max(base, 32768) : base) * boost);
  return Math.min(scaled, reasoning ? 131072 : 65536);
}

/**
 * 单次请求超时:随输出预算伸缩——按保守吞吐(约 40 tok/s)估算生成时长,
 * 加 60s 连接/排队余量,封顶 15 分钟;固定超时对放大的预算(尤其推理模型)必然误杀
 */
function requestTimeoutMs(cfg: KimiConfig, boost = 1): number {
  return Math.min(900_000, 60_000 + Math.round((effectiveMaxTokens(cfg, boost) / 40) * 1000));
}

/**
 * 请求异常归一化为可读错误:
 * - 内部超时(AbortSignal.timeout 的 TimeoutError) → LlmTimeoutError
 * - 网络层失败(DNS/连接拒绝,fetch 抛 TypeError) → 引导检查 Base URL
 * 用户主动中断(AbortError)与其余错误原样返回
 */
function normalizeRequestError(e: unknown, timeoutMs: number): unknown {
  const err = e as Error;
  if (err?.name === "TimeoutError")
    return new LlmTimeoutError(`模型响应超时(已等待 ${Math.round(timeoutMs / 60000)} 分钟仍无结果)`);
  if (err?.name === "TypeError" && /fetch failed/i.test(err?.message ?? ""))
    return new Error("无法连接模型服务,请检查「设置」中的 Base URL 与网络");
  return e;
}

/**
 * 进程级流式不可用记忆(baseUrl+model 维度):某些端点对 stream 请求不兼容,记住后不再每次白失败一轮(双倍耗时且全程无草稿)
 * 只有连续 2 次传输层失败才拉黑——单次空响应/网络抖动多为瞬时故障,不误判;预算耗尽(BudgetExhaustedError)不参与计数
 */

/** 非流式调用 + 预算耗尽自动放大重试(sitemap / ops 等小 JSON 场景,最多放大 2 次) */
async function callKimiWithBudgetRetry(
  cfg: KimiConfig,
  messages: { role: string; content: ChatContent }[],
  onUsage?: UsageCallback,
): Promise<string> {
  for (let e = 0; ; e++) {
    try {
      return await callKimi(cfg, messages, onUsage, 2 ** e);
    } catch (err) {
      if (err instanceof BudgetExhaustedError && e < 2) {
        console.warn(`[llm] ${err.message},max_tokens 放大 ×${2 ** (e + 1)} 重试`);
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 元素级编辑:LLM 输出 ops 补丁
// ---------------------------------------------------------------------------

/** 流式版预算放大重试:与 callKimiWithBudgetRetry 同语义,token 经 onToken 透传 */
async function callKimiStreamWithBudgetRetry(
  cfg: KimiConfig,
  messages: { role: string; content: ChatContent }[],
  onToken: (acc: string) => void,
  onUsage?: UsageCallback,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callKimiStream(cfg, messages, onToken, onUsage);
    } catch (err) {
      if (err instanceof BudgetExhaustedError && attempt < 2) continue;
      throw err;
    }
  }
}

export async function kimiGenerateOps(
  cfg: KimiConfig,
  instruction: string,
  surface: SurfaceDoc,
  aids?: string[],
  onUsage?: UsageCallback,
  history?: string,
  images?: ImageRef[],
  /** 流式预览钩子:传则走 SSE 通道并逐 token 回传完整累积串;内部解析/修复循环不变 */
  onStreamAcc?: (acc: string) => void,
): Promise<SurfaceOp[]> {
  // 上下文策略:选中组件 → 子树(向下两层);未选中(整页编辑) → 全量组件表,
  // 保证 LLM 拿到完整结构,ops 只改它要改的部分、其余保持原样
  const contextNodes: Record<string, unknown> = {};
  if (aids?.length) {
    const collect = (id: string, depth: number) => {
      const n = surface.components[id];
      if (!n || depth > 2) return;
      contextNodes[id] = n;
      n.children.forEach((c) => collect(c, depth + 1));
    };
    aids.forEach((a) => collect(a, 0));
  } else {
    Object.assign(contextNodes, surface.components);
  }

  const selectedDesc = buildSelectedDesc(aids, (a) => surface.components[a]?.type);

  const messages: { role: string; content: ChatContent }[] = [
    { role: "system", content: OPS_SYSTEM_PROMPT },
    {
      role: "user",
      content: userContent(
        buildOpsUserMessage({
          tokens: surface.theme.tokens,
          contextNodes,
          selectedDesc,
          instruction,
          history,
        }),
        images,
      ),
    },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    // 流式钩子存在时走 SSE 通道(返回值仍是完整 raw,解析/修复逻辑不变);否则保持原非流式
    const raw = onStreamAcc
      ? await callKimiStreamWithBudgetRetry(cfg, messages, (acc) => onStreamAcc(acc), onUsage)
      : await callKimiWithBudgetRetry(cfg, messages, onUsage);
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
      const result = z.object({ ops: z.array(surfaceOpSchema) }).safeParse(parsed);
      if (result.success && result.data.ops.length) {
        // 二次校验:把补丁实际应用到页面上,确保应用后的组件树引用完整
        const refErrors = validateSurface(applyOps(surface, result.data.ops));
        if (!refErrors.length) return result.data.ops;
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: opsRepairMessage(`ops 应用后组件树引用不完整: ${refErrors.join(";").slice(0, 300)}`) });
        continue;
      }
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: opsRepairMessage(
          result.success ? "ops 为空" : result.error.issues.map((i) => i.message).join(";").slice(0, 300),
        ),
      });
    } catch (e) {
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: opsJsonRepairMessage((e as Error).message.slice(0, 150)) });
    }
  }
  throw new Error("模型两次 ops 输出均未通过校验");
}
