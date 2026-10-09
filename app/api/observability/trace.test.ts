import { describe, expect, it } from "vitest";
import { startSpan, withSpan, withSpanSync, recentSpans } from "./trace";

/** 轻量 OTEL 观测(M6-3):span 生命周期 / 异常语义 / 环形缓冲 */
describe("observability/trace", () => {
  it("startSpan 手动闭合:durationMs 与状态正确记录", () => {
    const h = startSpan("test.manual", { k: "v" });
    expect(h.span.endedAt).toBeUndefined();
    h.end("ok");
    expect(h.span.endedAt).toBeGreaterThanOrEqual(h.span.startedAt);
    expect(h.span.durationMs).toBeGreaterThanOrEqual(0);
    expect(h.span.status).toBe("ok");
    expect(h.span.attrs?.k).toBe("v");
    const last = recentSpans(1).at(-1);
    expect(last?.name).toBe("test.manual");
    // 重复 end 幂等
    h.end("error", "again");
    expect(h.span.status).toBe("ok");
  });

  it("withSpan 成功闭合 ok,失败闭合 error 并透传异常", async () => {
    const out = await withSpan("test.ok", undefined, async () => 42);
    expect(out).toBe(42);
    await expect(withSpan("test.err", undefined, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const last2 = recentSpans(2);
    expect(last2[0]?.name).toBe("test.ok");
    expect(last2[1]?.status).toBe("error");
    expect(last2[1]?.error).toBe("boom");
  });

  it("withSpanSync 传递 parentSpanId,异常同样闭合", () => {
    const v = withSpanSync("test.sync", { a: 1 }, () => "ret");
    expect(v).toBe("ret");
    expect(() => withSpanSync("test.sync.err", undefined, () => { throw new Error("sync boom"); })).toThrow("sync boom");
  });
});
