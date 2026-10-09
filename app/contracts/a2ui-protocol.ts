import { z } from "zod";

/**
 * A2UI v0.9.1 协议契约(共享)
 *
 * 边界(文档 §3.2):
 * - A2UI 是 Agent 与客户端之间的声明式 UI 协议层,不是事实源
 * - 服务端 → 客户端:createSurface / updateComponents / updateDataModel / deleteSurface
 * - 客户端 → 服务端:action / error
 * - 所有消息必须包裹在 Transport Envelope 中传输
 * - 自定义设计事件(design.* / run.* / clarification.*)使用独立类型,不进 A2UI payload
 */

export const A2UI_PROTOCOL_VERSION = "v0.9.1" as const;
export const TRANSPORT_VERSION = "transport/1" as const;

// ---------------------------------------------------------------------------
// 消息 payload
// ---------------------------------------------------------------------------

/** 扁平邻接表组件(v0.9.1):updateComponents 内为 upsert 列表,按 componentId last-write-wins */
export const a2uiComponentSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  /** 组件属性;数据绑定值形如 { "$bind": "/data/xxx" }(合法 JSON Pointer) */
  props: z.record(z.string(), z.unknown()).default({}),
  /** 子节点 id 引用,可在后续消息补齐,最终 Proposal 必须闭合 */
  children: z.array(z.string()).default([]),
});
export type A2UIComponent = z.infer<typeof a2uiComponentSchema>;

export const a2uiPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("createSurface"),
    surfaceId: z.string().min(1),
    root: z.string().min(1).optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("updateComponents"),
    surfaceId: z.string().min(1),
    components: z.array(a2uiComponentSchema).min(1),
    /** 批次边界标记:Proposal Buffer flush 的显式触发条件之一 */
    batchEnd: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("updateDataModel"),
    surfaceId: z.string().min(1),
    modelId: z.string().min(1),
    /** 完整 upsert 值;path 存在时为 JSON Pointer 局部 patch */
    value: z.unknown(),
    path: z.string().optional(),
  }),
  z.object({ kind: z.literal("deleteSurface"), surfaceId: z.string().min(1) }),
  z.object({
    kind: z.literal("action"),
    surfaceId: z.string().min(1),
    componentId: z.string().min(1),
    actionName: z.string().min(1),
    context: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("error"),
    surfaceId: z.string().optional(),
    code: z.string().default("client_error"),
    message: z.string().min(1),
  }),
]);
export type A2UIPayload = z.infer<typeof a2uiPayloadSchema>;
export type A2UIServerPayload = Extract<A2UIPayload, { kind: "createSurface" | "updateComponents" | "updateDataModel" | "deleteSurface" }>;
export type A2UIClientPayload = Extract<A2UIPayload, { kind: "action" | "error" }>;

// ---------------------------------------------------------------------------
// Transport Envelope
// ---------------------------------------------------------------------------

export const transportEnvelopeSchema = z.object({
  type: z.literal("a2ui.message"),
  transportVersion: z.literal(TRANSPORT_VERSION),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  /** 会话内单调递增,客户端按 (runId, seq) 去重并按序应用 */
  seq: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  payload: z.object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    message: a2uiPayloadSchema,
  }),
  meta: z
    .object({
      traceId: z.string().optional(),
      idempotencyKey: z.string().optional(),
    })
    .default({}),
});
export type TransportEnvelope = z.infer<typeof transportEnvelopeSchema>;

/** 服务端构造 A2UI 信封 */
export function createEnvelope(input: {
  projectId: string;
  sessionId: string;
  runId: string;
  seq: number;
  message: A2UIServerPayload | A2UIClientPayload;
  traceId?: string;
  idempotencyKey?: string;
  timestamp?: string;
}): TransportEnvelope {
  return transportEnvelopeSchema.parse({
    type: "a2ui.message",
    transportVersion: TRANSPORT_VERSION,
    projectId: input.projectId,
    sessionId: input.sessionId,
    runId: input.runId,
    seq: input.seq,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: { version: A2UI_PROTOCOL_VERSION, message: input.message },
    meta: { traceId: input.traceId, idempotencyKey: input.idempotencyKey },
  });
}

/** 校验外部传入的信封(非法消息一律拒绝) */
export function parseEnvelope(raw: unknown): TransportEnvelope {
  return transportEnvelopeSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// 安全白名单(确定性校验层使用;文档 §18.1)
// ---------------------------------------------------------------------------

/** URL 仅允许 https: 与受控 data:image */
export function isAllowedUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  if (url.startsWith("https://")) return true;
  if (url.startsWith("data:image/")) {
    // 只允许 png/jpeg/webp/gif 位图,拒绝 data:image/svg+xml(可携带脚本)
    return /^data:image\/(png|jpeg|webp|gif);/.test(url);
  }
  return false;
}

/** 客户端 action 名称白名单(渲染器可触发的语义动作) */
export const ALLOWED_ACTIONS = new Set([
  "navigate",
  "submit",
  "openDialog",
  "closeDialog",
  "select",
  "sort",
  "filter",
  "page",
  "toggle",
]);

export function isAllowedAction(name: string): boolean {
  return ALLOWED_ACTIONS.has(name);
}
