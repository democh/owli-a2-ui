/**
 * 对话生成 SSE 流式客户端
 * 连接 /api/chat/stream,实时回调 Agent 执行步骤,结束时返回完整结果
 */
import type {
  ChatGenerateResult,
  ChatStep,
  ContextChip,
  DeviceId,
  EditPlan,
  ImageRef,
  SurfaceDoc,
} from "@contracts/a2ui";

export interface StreamCallbacks {
  /** 每个执行步骤完成时实时触发 */
  onStep?: (step: ChatStep) => void;
  /** LLM 逐 token 生成时推送的增量文本(未校验,仅用于画布草稿预览;调用方自拼接) */
  onDraft?: (draft: DraftChunk) => void;
}

/** 流式草稿片段(与后端 pipeline.DraftChunk 对应) */
export interface DraftChunk {
  mode: "create" | "edit";
  pageId?: string;
  /** 自上次推送以来新增的文本(SSE 有序可靠,累加即得全量) */
  delta: string;
}

export interface StreamResult {
  result: ChatGenerateResult;
  plan: EditPlan | null;
  /** 本轮消息实际写入的会话 id */
  conversationId: number | null;
  appliedPages: {
    id: number;
    projectId: number;
    title: string;
    device: DeviceId;
    surface: SurfaceDoc;
    posX: number;
    posY: number;
    width: number;
    height: number;
    /** LLM 管线生成的临时 pageId,用于与 createPage action 精确对应 */
    clientPageId?: string;
  }[];
}

interface StreamEvent {
  type: "step" | "result" | "error" | "draft";
  step?: ChatStep;
  result?: ChatGenerateResult;
  plan?: EditPlan | null;
  appliedPages?: StreamResult["appliedPages"];
  conversationId?: number | null;
  message?: string;
  mode?: "create" | "edit";
  pageId?: string;
  delta?: string;
}

/**
 * 发起流式生成请求。
 * 返回 { promise, abort }:promise 在 result/error/流结束时 settle;abort 用于用户主动停止。
 */
export function streamChatGenerate(
  params: {
    projectId: number;
    prompt: string;
    chips: ContextChip[];
    conversationId?: number | null;
    /** 参考图片(仅模型支持图片对话时生效;最多 3 张) */
    images?: ImageRef[];
    /** 图片缩略 dataUrl,仅用于消息持久化回显 */
    imageThumbs?: string[];
  },
  callbacks: StreamCallbacks = {},
): { promise: Promise<StreamResult>; abort: () => void } {
  const controller = new AbortController();

  const promise = (async (): Promise<StreamResult> => {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw new Error(`流式请求失败 (${resp.status})${text ? `: ${text.slice(0, 120)}` : ""}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: StreamResult | null = null;
    let streamError: string | null = null;

    const handleEvent = (raw: string) => {
      if (!raw.trim()) return;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(raw) as StreamEvent;
      } catch {
        return;
      }
      if (ev.type === "step" && ev.step) {
        callbacks.onStep?.(ev.step);
      } else if (ev.type === "draft" && typeof ev.delta === "string") {
        callbacks.onDraft?.({ mode: ev.mode ?? "create", pageId: ev.pageId, delta: ev.delta });
      } else if (ev.type === "result" && ev.result) {
        final = { result: ev.result, plan: ev.plan ?? null, appliedPages: ev.appliedPages ?? [], conversationId: ev.conversationId ?? null };
      } else if (ev.type === "error") {
        streamError = ev.message ?? "生成失败";
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以 \n\n 分隔;data: 前缀
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
        }
      }
    }
    // 尾部没有 \n\n 的残余事件
    if (buffer.trim().startsWith("data:")) handleEvent(buffer.trim().slice(5).trim());

    if (streamError) throw new Error(streamError);
    if (!final) throw new Error("流式连接中断,未收到生成结果");
    return final;
  })();

  return { promise, abort: () => controller.abort() };
}
