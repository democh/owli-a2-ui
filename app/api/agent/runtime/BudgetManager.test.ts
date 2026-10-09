import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离测试库:必须在加载 connection/env 之前设置 DATABASE_URL
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui-budget-"));
process.env.DATABASE_URL = path.join(tmpDir, "test.db");
process.env.DEFAULT_RUN_MAX_TOKENS = "0"; // 默认不限,单测内显式传上限

const {
  BudgetExceededError,
  assertRunStartable,
  checkRunTokenBudget,
  consumeToolCall,
  estimateCostUsd,
  userCostUsd,
  budgetMaxCostUsdOf,
  runTokensUsed,
  runToolCallsUsed,
} = await import("./BudgetManager");
const { getDb } = await import("../../queries/connection");
const { runs, projects, userSettings, users, conversations } = await import("@db/schema");
const { eq } = await import("drizzle-orm");

/** 插入一条带 token 用量的 run 记录 */
function insertRun(userId: number, promptTokens: number, completionTokens: number): string {
  const db = getDb();
  const proj = db.select().from(projects).where(eq(projects.userId, userId)).get();
  let pid = proj?.id;
  if (!pid) {
    const r = db.insert(projects).values({ userId, name: "预算测试项目" }).run();
    pid = Number(r.lastInsertRowid);
  }
  // runs.conversationId 有外键约束,先保证会话存在
  const conv = db.select().from(conversations).where(eq(conversations.projectId, pid)).get();
  let cid = conv?.id;
  if (!cid) {
    const r = db.insert(conversations).values({ projectId: pid }).run();
    cid = Number(r.lastInsertRowid);
  }
  const runId = `run_budget_${Math.random().toString(36).slice(2, 10)}`;
  db.insert(runs)
    .values({
      runId,
      projectId: pid,
      conversationId: cid,
      mode: "create_page",
      status: "completed",
      promptTokens,
      completionTokens,
      idempotencyKey: `idem_${runId}`,
    })
    .run();
  return runId;
}

describe("BudgetManager", () => {
  let userId = 0;

  beforeAll(() => {
    const db = getDb();
    db.insert(users).values({ unionId: "budget_user", name: "预算用户" }).onConflictDoNothing().run();
    userId = db.select().from(users).where(eq(users.unionId, "budget_user")).get()!.id;
    db.insert(userSettings).values({ userId, budgetMaxCostUsd: 0 }).onConflictDoNothing().run();
  });

  it("成本估算按单价换算", () => {
    // 默认单价:input $0.6/M,output $2.5/M
    expect(estimateCostUsd(1_000_000, 0)).toBeCloseTo(0.6, 6);
    expect(estimateCostUsd(0, 1_000_000)).toBeCloseTo(2.5, 6);
    expect(estimateCostUsd(500_000, 100_000)).toBeCloseTo(0.3 + 0.25, 6);
  });

  it("预算上限:未设置时走 env 默认(>0);设为 0 视为不限", () => {
    expect(budgetMaxCostUsdOf(userId)).toBeGreaterThan(0);
    const db = getDb();
    db.update(userSettings).set({ budgetMaxCostUsd: 5 }).where(eq(userSettings.userId, userId)).run();
    expect(budgetMaxCostUsdOf(userId)).toBe(5);
    db.update(userSettings).set({ budgetMaxCostUsd: 0 }).where(eq(userSettings.userId, userId)).run();
  });

  it("Run 内 token 预算:未超限放行,超限抛 BudgetExceededError", () => {
    const runId = insertRun(userId, 100, 50);
    expect(runTokensUsed(runId)).toBe(150);
    expect(() => checkRunTokenBudget(runId, 200)).not.toThrow();
    expect(() => checkRunTokenBudget(runId, 100)).toThrow(BudgetExceededError);
    expect(() => checkRunTokenBudget(runId, 100)).toThrow(/budget_exceeded/);
    // 0 = 不限
    expect(() => checkRunTokenBudget(runId, 0)).not.toThrow();
  });

  it("§18.4 工具调用数预算:逐次消耗,超限抛 tool_call_budget_exceeded;0 = 不限", () => {
    const runId = insertRun(userId, 0, 0);
    expect(runToolCallsUsed(runId)).toBe(0);
    consumeToolCall(runId, 3);
    consumeToolCall(runId, 3);
    consumeToolCall(runId, 3);
    expect(runToolCallsUsed(runId)).toBe(3);
    // 超限的那次调用同样计入(先自增再检查)
    expect(() => consumeToolCall(runId, 3)).toThrow(BudgetExceededError);
    expect(() => consumeToolCall(runId, 3)).toThrow(/tool_call_budget_exceeded/);
    expect(runToolCallsUsed(runId)).toBe(5);
    // 0 = 不限:只计数不检查
    expect(() => consumeToolCall(runId, 0)).not.toThrow();
    expect(runToolCallsUsed(runId)).toBe(6);
  });

  it("用户级成本预算:未超限放行,达到上限拒绝发起新 Run", () => {
    const db = getDb();
    insertRun(userId, 1_000_000, 0); // 成本 $0.6
    insertRun(userId, 0, 1_000_000); // 累计成本 $3.1
    expect(userCostUsd(userId)).toBeCloseTo(3.1, 3); // 含前序用例零头 token

    db.update(userSettings).set({ budgetMaxCostUsd: 5 }).where(eq(userSettings.userId, userId)).run();
    expect(() => assertRunStartable(userId)).not.toThrow();

    insertRun(userId, 0, 1_000_000); // 累计 $5.6 ≥ 5
    expect(() => assertRunStartable(userId)).toThrow(BudgetExceededError);

    // 恢复不限,避免影响其他用例
    db.update(userSettings).set({ budgetMaxCostUsd: 0 }).where(eq(userSettings.userId, userId)).run();
  });
});
