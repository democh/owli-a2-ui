import {
  callKimi,
  callKimiStream,
  userContent,
  BudgetExhaustedError,
  LlmApiError,
  LlmTimeoutError,
  type ChatContent,
  type KimiConfig,
} from "../../llm/kimi";
import type { UsageCallback } from "../../llm/usage";
import type { ImageRef } from "@contracts/a2ui";
import { withSpan } from "../../observability/trace";

/**
 * LLM Provider Adapter(文档 §5.2 / §11.10)
 *
 * 复用 OpenAI 兼容 HTTP 层(kimi.ts:流式回退 / 预算放大 / 错误分类),
 * 按 modelProfile 提供调用语义。temperature 依赖端点策略
 * (kimi-for-coding 只允许默认值),因此不显式下发,由服务端默认。
 */

export type ModelProfile = "planning" | "generation" | "review" | "repair" | "explanation";

/** M7 多模型路由:按阶段覆盖主模型;未配置/空串回退 baseModel */
export function resolveProfileModel(
  baseModel: string,
  profileModels: Partial<Record<ModelProfile, string>> | undefined,
  profile: ModelProfile,
): string {
  const override = profileModels?.[profile]?.trim();
  return override || baseModel;
}

export interface LlmRequest {
  system: string;
  user: string;
  profile: ModelProfile;
  images?: ImageRef[];
  /** 多轮上下文(修复循环把上一轮错误回灌时使用) */
  history?: { role: "user" | "assistant"; content: string }[];
}

export type { BudgetExhaustedError, LlmApiError, LlmTimeoutError };

export class LLMProvider {
  readonly cfg: KimiConfig;
  /** M7 多模型路由:按阶段覆盖模型(planning/generation/review/repair/explanation) */
  readonly profileModels: Partial<Record<ModelProfile, string>> | undefined;
  /** §18.4 每 Run 工具/模型调用计数钩子(complete/stream 各计一次;stream 回退不再重复计) */
  private readonly onLlmCall?: () => void;
  constructor(
    cfg: KimiConfig,
    profileModels?: Partial<Record<ModelProfile, string>>,
    onLlmCall?: () => void,
  ) {
    this.cfg = cfg;
    this.profileModels = profileModels;
    this.onLlmCall = onLlmCall;
  }

  /** 按请求阶段解析生效配置(model 可被 profileModels 覆盖) */
  private cfgFor(req: LlmRequest): KimiConfig {
    return { ...this.cfg, model: resolveProfileModel(this.cfg.model, this.profileModels, req.profile) };
  }

  /** 非流式 JSON 调用(带预算耗尽自动放大重试) */
  async complete(req: LlmRequest, onUsage?: UsageCallback): Promise<string> {
    this.onLlmCall?.();
    return this.completeInternal(req, onUsage);
  }

  /** 内部非流式调用(不计入调用数;stream 回退复用,避免双计) */
  private async completeInternal(req: LlmRequest, onUsage?: UsageCallback): Promise<string> {
    const cfg = this.cfgFor(req);
    const messages: { role: string; content: ChatContent }[] = [
      { role: "system", content: req.system },
      ...(req.history ?? []).map((h) => ({ role: h.role, content: h.content as ChatContent })),
      { role: "user", content: userContent(req.user, req.images) },
    ];
    for (let e = 0; ; e++) {
      try {
        return await callKimi(cfg, messages, onUsage, 2 ** e);
      } catch (err) {
        if (err instanceof BudgetExhaustedError && e < 2) continue;
        throw err;
      }
    }
  }

  /** 流式调用(渐进预览);传输层失败回退非流式。llm.stream span 覆盖含回退的全过程 */
  async stream(
    req: LlmRequest,
    onToken: (acc: string) => void,
    onUsage?: UsageCallback,
    onFallback?: (reason: string) => void,
  ): Promise<string> {
    this.onLlmCall?.();
    const messages: { role: string; content: ChatContent }[] = [
      { role: "system", content: req.system },
      ...(req.history ?? []).map((h) => ({ role: h.role, content: h.content as ChatContent })),
      { role: "user", content: userContent(req.user, req.images) },
    ];
    return withSpan("llm.stream", { profile: req.profile, model: this.cfgFor(req).model }, async () => {
      try {
        return await callKimiStream(this.cfgFor(req), messages, onToken, onUsage);
      } catch (e) {
        if (e instanceof BudgetExhaustedError || e instanceof LlmTimeoutError || e instanceof LlmApiError) throw e;
        onFallback?.(`流式不可用,回退非流式:${(e as Error).message.slice(0, 80)}`);
        return this.completeInternal(req, onUsage);
      }
    });
  }
}
