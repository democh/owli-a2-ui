import { desc, eq, sql } from "drizzle-orm";
import { runs, projects, userSettings } from "@db/schema";
import { getDb } from "../../queries/connection";
import { env } from "../../lib/env";

/**
 * Budget Manager(M6-2,文档 §10.2 Token 预算 / §18.4 运行时长)
 *
 * 三层预算:
 * - maxTokens:单 Run 累计(输入+输出)上限,来源 run.constraints.maxTokens(未配置走 env 默认;0=不限)
 * - maxCostUsd:用户级累计成本上限(USD),来源 user_settings.budgetMaxCostUsd(0=走 env 默认)
 * - maxRepairRounds:修复轮次上限,已由 Orchestrator(≤2)实现
 *
 * 超限统一抛 BudgetExceededError,Orchestrator 捕获后以 run.failed(budget_exceeded) 终止,
 * 不自动继续(文档 §18.4:超预算即停止)。
 */

export class BudgetExceededError extends Error {
  readonly kind: "token_budget_exceeded" | "budget_exceeded" | "tool_call_budget_exceeded";
  constructor(message: string, kind: BudgetExceededError["kind"]) {
    super(message);
    this.name = "BudgetExceededError";
    this.kind = kind;
  }
}

/** 成本估算(USD):输入/输出单价按 env(USD / 百万 tokens) */
export function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens * env.priceInputPerMUsd + completionTokens * env.priceOutputPerMUsd) / 1_000_000;
}

/** 用户预算上限:user_settings.budgetMaxCostUsd 优先,0=走 env 默认 */
export function budgetMaxCostUsdOf(userId: number): number {
  const row = getDb()
    .select({ budgetMaxCostUsd: userSettings.budgetMaxCostUsd })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1)
    .get();
  const v = row?.budgetMaxCostUsd ?? 0;
  return v > 0 ? v : env.defaultBudgetMaxCostUsd;
}

/** 用户已用成本(USD):按 runs 表全量 token 聚合(join projects 归属用户) */
export function userCostUsd(userId: number): number {
  const row = getDb()
    .select({
      promptTokens: sql<number>`coalesce(sum(${runs.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${runs.completionTokens}), 0)`,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .get();
  return estimateCostUsd(row?.promptTokens ?? 0, row?.completionTokens ?? 0);
}

/** Run 已累计 token(输入+输出) */
export function runTokensUsed(runId: string): number {
  const row = getDb()
    .select({ promptTokens: runs.promptTokens, completionTokens: runs.completionTokens })
    .from(runs)
    .where(eq(runs.runId, runId))
    .limit(1)
    .get();
  if (!row) return 0;
  return (row.promptTokens ?? 0) + (row.completionTokens ?? 0);
}

/** Run 启动前检查:用户累计成本是否已超上限(超限拒绝发起新 Run) */
export function assertRunStartable(userId: number): void {
  const max = budgetMaxCostUsdOf(userId);
  if (max <= 0) return; // 0 = 不限
  const used = userCostUsd(userId);
  if (used >= max) {
    throw new BudgetExceededError(
      `[budget_exceeded] 已用成本 $${used.toFixed(2)} 达到预算上限 $${max.toFixed(2)},无法发起新任务;请提高预算上限后重试`,
      "budget_exceeded",
    );
  }
}

/** Run 进行中检查:累计 token 是否超 constraints.maxTokens(每轮 LLM 调用后调用) */
export function checkRunTokenBudget(runId: string, maxTokens?: number): void {
  const limit = maxTokens ?? env.defaultRunMaxTokens;
  if (!limit || limit <= 0) return; // 0/未配置 = 不限
  const used = runTokensUsed(runId);
  if (used > limit) {
    throw new BudgetExceededError(
      `[budget_exceeded] Run 累计 ${used} tokens 超过上限 ${limit};已停止,请缩小范围或提高 maxTokens 后重试`,
      "token_budget_exceeded",
    );
  }
}

/** Run 已累计工具/模型调用次数(§18.4) */
export function runToolCallsUsed(runId: string): number {
  const row = getDb()
    .select({ toolCalls: runs.toolCalls })
    .from(runs)
    .where(eq(runs.runId, runId))
    .limit(1)
    .get();
  return row?.toolCalls ?? 0;
}

/**
 * 消耗一次工具/模型调用(§18.4):每次 LLM 调用(expert/生成/评审/解释)前调用。
 * 先自增再检查,超限抛 BudgetExceededError(不可重试,需调整预算后重新发起)。
 */
export function consumeToolCall(runId: string, maxToolCalls?: number): void {
  const db = getDb();
  db.update(runs)
    .set({ toolCalls: sql`${runs.toolCalls} + 1` })
    .where(eq(runs.runId, runId))
    .run();
  const limit = maxToolCalls ?? env.defaultRunMaxToolCalls;
  if (!limit || limit <= 0) return; // 0/未配置 = 不限
  const used = runToolCallsUsed(runId);
  if (used > limit) {
    throw new BudgetExceededError(
      `[tool_call_budget_exceeded] Run 工具/模型调用 ${used} 次超过上限 ${limit};已停止,请缩小范围或提高 maxToolCalls 后重试`,
      "tool_call_budget_exceeded",
    );
  }
}

/** 用户用量快照(设置页展示) */
export function usageSnapshot(userId: number): {
  promptTokens: number;
  completionTokens: number;
  estCostUsd: number;
  budgetMaxCostUsd: number;
} {
  const row = getDb()
    .select({
      promptTokens: sql<number>`coalesce(sum(${runs.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${runs.completionTokens}), 0)`,
      runs: sql<number>`count(*)`,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .get();
  const promptTokens = row?.promptTokens ?? 0;
  const completionTokens = row?.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    estCostUsd: estimateCostUsd(promptTokens, completionTokens),
    budgetMaxCostUsd: budgetMaxCostUsdOf(userId),
  };
}

/** 最近一次 Run 的用量明细(设置页展示辅助,可选) */
export function lastRunUsage(userId: number) {
  const row = getDb()
    .select({
      runId: runs.runId,
      model: runs.model,
      promptTokens: runs.promptTokens,
      completionTokens: runs.completionTokens,
      status: runs.status,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .orderBy(desc(runs.id))
    .limit(1)
    .get();
  return row ?? null;
}
