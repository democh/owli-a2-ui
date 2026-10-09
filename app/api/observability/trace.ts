import { randomUUID } from "crypto";
import { env } from "../lib/env";

/**
 * 轻量分布式追踪(M6-3 OTEL,文档 §19.6)
 *
 * 零依赖 span 实现:traceId/spanId + 父子关系 + 内存环形缓冲;
 * env 配置 OTEL_EXPORTER_OTLP_ENDPOINT 后,按 OTLP/HTTP JSON(v1/traces)
 * 批量上报,失败静默重试下一批,绝不阻断主流程。
 *
 * 关键 span(文档 §19.4):agent.run / agent.intake / agent.planning /
 * llm.stream / ux.review / command.commit
 */

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number; // ms epoch
  endedAt?: number;
  durationMs?: number;
  status: "ok" | "error";
  attrs?: Record<string, unknown>;
  error?: string;
}

const RING_MAX = 500;
const ring: SpanRecord[] = [];

/** OTLP 上报缓冲(未配置 endpoint 时不积累) */
const otlpQueue: SpanRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function pushSpan(span: SpanRecord): void {
  ring.push(span);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  if (env.otlpEndpoint) {
    otlpQueue.push(span);
    scheduleFlush();
  }
}

export function recentSpans(limit = 50): SpanRecord[] {
  return ring.slice(-limit);
}

// ---------------------------------------------------------------------------
// span 工具
// ---------------------------------------------------------------------------

export interface SpanHandle {
  span: SpanRecord;
  end: (status?: SpanRecord["status"], error?: string) => void;
}

/** 手动管理生命周期的 span(同步/异步场景通用) */
export function startSpan(name: string, attrs?: Record<string, unknown>, parentSpanId?: string): SpanHandle {
  const span: SpanRecord = {
    traceId: randomUUID().replaceAll("-", ""),
    spanId: randomUUID().replaceAll("-", "").slice(0, 16),
    parentSpanId,
    name,
    startedAt: Date.now(),
    status: "ok",
    attrs,
  };
  return {
    span,
    end(status = "ok", error?: string) {
      if (span.endedAt) return;
      span.endedAt = Date.now();
      span.durationMs = span.endedAt - span.startedAt;
      span.status = status;
      if (error) span.error = error.slice(0, 300);
      pushSpan(span);
    },
  };
}

/** 包装 async 函数:成功/失败自动闭合 span */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (parentSpanId: string) => Promise<T>,
): Promise<T> {
  const h = startSpan(name, attrs);
  try {
    const out = await fn(h.span.spanId);
    h.end("ok");
    return out;
  } catch (e) {
    h.end("error", (e as Error).message);
    throw e;
  }
}

/** 包装同步函数 */
export function withSpanSync<T>(name: string, attrs: Record<string, unknown> | undefined, fn: () => T): T {
  const h = startSpan(name, attrs);
  try {
    const out = fn();
    h.end("ok");
    return out;
  } catch (e) {
    h.end("error", (e as Error).message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON exporter
// ---------------------------------------------------------------------------

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOtlp();
  }, 5_000);
}

const MS_TO_NS = 1_000_000;

function otlpAttributes(attrs?: Record<string, unknown>) {
  if (!attrs) return [];
  return Object.entries(attrs)
    .slice(0, 20)
    .map(([k, v]) => ({ key: k, value: { stringValue: typeof v === "string" ? v : JSON.stringify(v) } }));
}

function toOtlpPayload(spans: SpanRecord[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "owli-a2ui" } },
            { key: "service.version", value: { stringValue: "m6" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "a2ui.harness", version: "1.0" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1, // INTERNAL
              startTimeUnixNano: String(s.startedAt * MS_TO_NS),
              endTimeUnixNano: String((s.endedAt ?? s.startedAt) * MS_TO_NS),
              attributes: otlpAttributes({ ...s.attrs, status: s.status }),
              ...(s.error ? { events: [{ name: "exception", timeUnixNano: String(s.startedAt * MS_TO_NS), attributes: [{ key: "message", value: { stringValue: s.error } }] }] } : {}),
            })),
          },
        ],
      },
    ],
  };
}

async function flushOtlp(): Promise<void> {
  if (!env.otlpEndpoint || otlpQueue.length === 0) return;
  const batch = otlpQueue.splice(0, otlpQueue.length);
  try {
    await fetch(`${env.otlpEndpoint.replace(/\/+$/, "")}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toOtlpPayload(batch)),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // 上报失败静默丢弃(可观测性不应影响业务);endpoint 可用性由 collector 自行监控
  }
}
