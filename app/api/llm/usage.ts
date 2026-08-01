/**
 * LLM token 用量(各 provider 统一为 prompt/completion 二元组)
 * 每次 HTTP 请求(含流式)触发一次回调;pipeline 累加后落库 llm_calls
 */
export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export type UsageCallback = (u: LlmUsage) => void;

/** 合并超时与客户端中断信号:任一触发即中止 LLM fetch */
export function combinedSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([AbortSignal.timeout(timeoutMs), external]) : AbortSignal.timeout(timeoutMs);
}
