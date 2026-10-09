import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// 隔离测试库:必须在加载 connection 之前设置 DATABASE_URL(审计落库断言用)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui-toolruntime-"));
process.env.DATABASE_URL = path.join(tmpDir, "test.db");

const { ToolRuntime, ToolPermissionError, ToolTimeoutError, defineTool } = await import("./ToolRuntime");
const { getDb } = await import("../../queries/connection");
const { auditLogs } = await import("@db/schema");
const { eq } = await import("drizzle-orm");

const baseCtx = { projectId: 1, actorId: "tester", actorRole: "orchestrator" as const };

/** 注册一组覆盖各失败路径的工具 */
function makeRuntime(): InstanceType<typeof ToolRuntime> {
  const rt = new ToolRuntime();
  rt.register(
    defineTool({
      name: "echo",
      description: "回显输入(权限矩阵/审计用)",
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ msg: z.string() }),
      execute: async (input) => ({ msg: input.msg }),
    }),
  );
  rt.register(
    defineTool({
      name: "readonly_tool",
      description: "viewer 即可调用",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requiredRole: "viewer",
      execute: async () => ({ ok: true }),
    }),
  );
  rt.register(
    defineTool({
      name: "commit_like",
      description: "仅 orchestrator 可调",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      orchestratorOnly: true,
      execute: async () => ({ ok: true }),
    }),
  );
  rt.register(
    defineTool({
      name: "slow_tool",
      description: "300ms 后才返回(超时用)",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      timeoutMs: 50,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return { ok: true };
      },
    }),
  );
  rt.register(
    defineTool({
      name: "big_output",
      description: "输出超限用",
      inputSchema: z.object({}),
      outputSchema: z.object({ blob: z.string() }),
      maxOutputBytes: 64,
      execute: async () => ({ blob: "x".repeat(256) }),
    }),
  );
  rt.register(
    defineTool({
      name: "big_input",
      description: "输入超限用",
      inputSchema: z.object({ blob: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      maxInputBytes: 64,
      execute: async () => ({ ok: true }),
    }),
  );
  return rt;
}

describe("ToolRuntime(文档 §9)", () => {
  it("正常执行:zod 校验通过并返回输出", async () => {
    const rt = makeRuntime();
    const out = await rt.runTyped<{ msg: string }>("echo", baseCtx, { msg: "hi" });
    expect(out.msg).toBe("hi");
  });

  it("权限矩阵:viewer 可调只读工具;orchestrator-only 对 editor 拒绝(§9.3)", async () => {
    const rt = makeRuntime();
    await expect(rt.run("readonly_tool", { ...baseCtx, actorRole: "viewer" }, {})).resolves.toEqual({ ok: true });
    await expect(rt.run("commit_like", { ...baseCtx, actorRole: "editor" }, {})).rejects.toThrow(ToolPermissionError);
    await expect(rt.run("commit_like", baseCtx, {})).resolves.toEqual({ ok: true });
  });

  it("超时:超过 timeoutMs 抛 ToolTimeoutError(§9.4)", async () => {
    const rt = makeRuntime();
    await expect(rt.run("slow_tool", baseCtx, {})).rejects.toThrow(ToolTimeoutError);
  });

  it("输入/输出字节上限:超限拒绝(§9.4)", async () => {
    const rt = makeRuntime();
    await expect(rt.run("big_input", baseCtx, { blob: "x".repeat(256) })).rejects.toThrow(/输入/);
    await expect(rt.run("big_output", baseCtx, {})).rejects.toThrow(/输出/);
  });

  it("zod 输入不合法:结构化报错(§9.4 inputSchema)", async () => {
    const rt = makeRuntime();
    await expect(rt.run("echo", baseCtx, { wrong: 1 })).rejects.toThrow(/输入不合法/);
  });

  it("审计:每次执行写入 audit_logs(§18.5)", async () => {
    const db = getDb();
    const before = db.select().from(auditLogs).where(eq(auditLogs.actorId, "tester")).all().length;
    const rt = makeRuntime();
    await rt.run("echo", baseCtx, { msg: "audit" });
    const rows = db.select().from(auditLogs).where(eq(auditLogs.actorId, "tester")).all();
    expect(rows.length).toBeGreaterThan(before);
    const last = rows.at(-1)!;
    expect(last.action).toBe("tool.echo");
    expect(JSON.parse(last.detail).sideEffect).toBe("none");
  });
});
