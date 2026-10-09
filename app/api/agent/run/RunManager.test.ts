import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离测试库:必须在加载 connection 之前设置 DATABASE_URL
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui-runmanager-"));
process.env.DATABASE_URL = path.join(tmpDir, "test.db");

const { RunManager, RunCancelledError } = await import("./RunManager");
const { agentRunRequestSchema } = await import("@contracts/agent");
const { getDb } = await import("../../queries/connection");
const { conversations, projects, runEvents, users } = await import("@db/schema");
const { and, eq } = await import("drizzle-orm");

/** 建项目 + 会话,返回可用的 AgentRunRequest */
function makeRequest(projectId: number, conversationId: number, idem: string) {
  return agentRunRequestSchema.parse({
    projectId,
    conversationId,
    mode: "create_page",
    userMessage: "测试请求",
    baseRevision: 1,
    idempotencyKey: idem,
  });
}

function setupProject(): { projectId: number; conversationId: number } {
  const db = getDb();
  db.insert(users).values({ unionId: `rm_user_${Math.random().toString(36).slice(2, 8)}` }).onConflictDoNothing().run();
  const user = db.select().from(users).all().at(-1)!;
  const proj = db.insert(projects).values({ userId: user.id, name: "RM 测试项目" }).run();
  const projectId = Number(proj.lastInsertRowid);
  const conv = db.insert(conversations).values({ projectId }).run();
  return { projectId, conversationId: Number(conv.lastInsertRowid) };
}

describe("RunManager(文档 §5.2.1/§14.3)", () => {
  it("emit:seq 单调分配 + run_events 落库 + replay 按序恢复", () => {
    const { projectId, conversationId } = setupProject();
    const request = makeRequest(projectId, conversationId, `idem_${Date.now()}_${Math.random()}`);
    const { runId } = RunManager.create(request);
    RunManager.attach(runId, request);

    const e1 = RunManager.emit(runId, { type: "run.state", runId, status: "intake", label: "需求理解" });
    const e2 = RunManager.emit(runId, { type: "run.state", runId, status: "planning", label: "设计规划" });
    expect(e2.seq).toBe(e1.seq + 1);

    const replayed = RunManager.replay(runId);
    expect(replayed.length).toBeGreaterThanOrEqual(2);
    expect(replayed.map((e) => e.seq)).toEqual([...replayed.map((e) => e.seq)].sort((a, b) => a - b));
    const persisted = getDb().select().from(runEvents).where(eq(runEvents.runId, runId)).all();
    expect(persisted.length).toBe(replayed.length);

    RunManager.finish(runId);
  });

  it("emit persist=false:仅推送不落库(流式预览帧语义)", () => {
    const { projectId, conversationId } = setupProject();
    const request = makeRequest(projectId, conversationId, `idem_${Date.now()}_${Math.random()}`);
    const { runId } = RunManager.create(request);
    RunManager.attach(runId, request);
    const before = getDb().select().from(runEvents).where(eq(runEvents.runId, runId)).all().length;
    RunManager.emit(runId, { type: "run.streamText", runId, text: "预览帧" }, { persist: false });
    const after = getDb().select().from(runEvents).where(eq(runEvents.runId, runId)).all().length;
    expect(after).toBe(before);
    RunManager.finish(runId);
  });

  it("§14.3 暂停/恢复:checkPause 挂起执行流,resume 唤醒继续", async () => {
    const { projectId, conversationId } = setupProject();
    const request = makeRequest(projectId, conversationId, `idem_${Date.now()}_${Math.random()}`);
    const { runId } = RunManager.create(request);
    RunManager.attach(runId, request);

    expect(RunManager.pause(runId)).toBe(true);
    expect(RunManager.isPaused(runId)).toBe(true);

    let released = false;
    const gate = RunManager.checkPause(runId).then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(released).toBe(false); // 暂停期间挂起

    expect(RunManager.resume(runId)).toBe(true);
    await gate;
    expect(released).toBe(true);
    expect(RunManager.isPaused(runId)).toBe(false);
    RunManager.finish(runId);
  });

  it("§14.3 暂停中取消:checkPause 以 RunCancelledError 恢复执行流", async () => {
    const { projectId, conversationId } = setupProject();
    const request = makeRequest(projectId, conversationId, `idem_${Date.now()}_${Math.random()}`);
    const { runId } = RunManager.create(request);
    RunManager.attach(runId, request);

    RunManager.pause(runId);
    const gate = RunManager.checkPause(runId);
    await new Promise((r) => setTimeout(r, 30));
    RunManager.cancel(runId); // 取消 → abort → 挂起方收到取消
    await expect(gate).rejects.toThrow(RunCancelledError);
  });

  it("§14.3 跳过任务:skipTask → isSkipped;终态后拒绝", () => {
    const { projectId, conversationId } = setupProject();
    const request = makeRequest(projectId, conversationId, `idem_${Date.now()}_${Math.random()}`);
    const { runId } = RunManager.create(request);
    RunManager.attach(runId, request);

    expect(RunManager.skipTask(runId, "t1")).toBe(true);
    expect(RunManager.isSkipped(runId, "t1")).toBe(true);
    expect(RunManager.isSkipped(runId, "t2")).toBe(false);
    RunManager.cancel(runId); // 置终态
    expect(RunManager.skipTask(runId, "t3")).toBe(false); // 终态拒绝
  });

  it("§14.2 Plan 确认:awaitPlanApproval 挂起,resolvePlanApproval 唤醒(拒绝/批准+编辑)", async () => {
    const { projectId, conversationId } = setupProject();
    const request = makeRequest(projectId, conversationId, `idem_${Date.now()}_${Math.random()}`);
    const { runId } = RunManager.create(request);
    RunManager.attach(runId, request);

    const tasks = [
      { taskId: "t1", title: "信息架构", status: "pending" as const },
      { taskId: "t2", title: "生成 Proposal", status: "pending" as const },
    ];
    const waitP = RunManager.awaitPlanApproval(runId, tasks);
    void waitP.catch(() => {});
    // 先拒绝
    expect(RunManager.resolvePlanApproval(runId, false)).toBe(true);
    await expect(waitP).resolves.toEqual({ approved: false });

    // 二次等待 → 批准并携带编辑后的任务
    const waitP2 = RunManager.awaitPlanApproval(runId, tasks);
    void waitP2.catch(() => {});
    const edited = [{ taskId: "t1", title: "信息架构(修订)", status: "pending" as const }];
    expect(RunManager.resolvePlanApproval(runId, true, edited)).toBe(true);
    await expect(waitP2).resolves.toEqual({ approved: true, tasks: edited });

    // 非等待状态再 resolve → false
    expect(RunManager.resolvePlanApproval(runId, true)).toBe(false);
    RunManager.finish(runId);
  });

  it("幂等创建:相同 idempotencyKey 返回同一 runId(reused=true)", () => {
    const { projectId, conversationId } = setupProject();
    const idem = `idem_dup_${Date.now()}`;
    const a = RunManager.create(makeRequest(projectId, conversationId, idem));
    const b = RunManager.create(makeRequest(projectId, conversationId, idem));
    expect(b.runId).toBe(a.runId);
    expect(b.reused).toBe(true);
  });

  it("cancel:未附加等待时直接落 cancelled 终态", () => {
    const { projectId, conversationId } = setupProject();
    const request = makeRequest(projectId, conversationId, `idem_${Date.now()}_${Math.random()}`);
    const { runId } = RunManager.create(request);
    RunManager.attach(runId, request);
    RunManager.cancel(runId);
    expect(RunManager.status(runId)).toBe("cancelled");
    const row = getDb().select().from(runEvents).where(and(eq(runEvents.runId, runId), eq(runEvents.type, "run.cancelled"))).all();
    // cancel 走状态机不 emit run.cancelled 事件(事件由 Orchestrator catch 发出);此处仅断言终态
    void row;
  });
});
