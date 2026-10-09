import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { alerts } from "@db/schema";
import { budgetMaxCostUsdOf, userCostUsd } from "../agent/runtime/BudgetManager";

/**
 * 站内告警(M6,文档 §17 可观测性的告警项)
 *
 * 规则评估点:
 *  - run.failed:Run 失败结束(DesignHarnessAgent catch)
 *  - budget.threshold:用户累计成本达预算上限 80%
 *  - run.rollback:Run 级回滚发生(runs.rollback)
 *  - expert.degraded:专家阶段异常降级继续(expertStage,非致命)
 *
 * 仅站内(前端铃铛 + 列表);不引入邮件/IM 等外部通知渠道。
 * 同 rule+message 5 分钟内去重,避免刷屏。
 */

export type AlertLevel = "info" | "warning" | "error";

export type AlertRule = "run.failed" | "budget.threshold" | "run.rollback" | "gate.repair_exhausted" | "expert.degraded";

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export function recordAlert(input: {
  projectId: number | null;
  level: AlertLevel;
  rule: AlertRule;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  const db = getDb();
  const since = Date.now() - DEDUP_WINDOW_MS;
  const dup = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.rule, input.rule), eq(alerts.message, input.message.slice(0, 400)), gt(alerts.createdAt, new Date(since))))
    .limit(1)
    .get();
  if (dup) return;
  db.insert(alerts)
    .values({
      projectId: input.projectId,
      level: input.level,
      rule: input.rule,
      message: input.message.slice(0, 400),
      meta: JSON.stringify(input.meta ?? {}),
    })
    .run();
}

/** 未读数(铃铛红点) */
export function unreadAlertCount(): number {
  return getDb()
    .select({ n: sql<number>`count(*)` })
    .from(alerts)
    .where(isNull(alerts.readAt))
    .get()?.n ?? 0;
}

/** 最近告警列表 */
export function listAlerts(limit = 30) {
  return getDb()
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      level: alerts.level,
      rule: alerts.rule,
      message: alerts.message,
      meta: alerts.meta,
      readAt: alerts.readAt,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .orderBy(desc(alerts.id))
    .limit(limit)
    .all();
}

export function ackAlert(id: number): void {
  getDb().update(alerts).set({ readAt: new Date() }).where(eq(alerts.id, id)).run();
}

export function ackAllAlerts(): void {
  getDb().update(alerts).set({ readAt: new Date() }).where(isNull(alerts.readAt)).run();
}

/** 预算阈值评估:达到上限 80% 记 warning(每 Run 启动后调用) */
export function evaluateBudgetThreshold(userId: number, projectId: number | null): void {
  const max = budgetMaxCostUsdOf(userId);
  if (max <= 0) return;
  const used = userCostUsd(userId);
  const pct = used / max;
  if (pct >= 0.8) {
    recordAlert({
      projectId,
      level: "warning",
      rule: "budget.threshold",
      message: `累计成本 $${used.toFixed(2)} 已达预算上限 $${max.toFixed(2)} 的 ${Math.round(pct * 100)}%;达到上限后将拒绝发起新任务`,
      meta: { usedUsd: Number(used.toFixed(4)), maxUsd: max },
    });
  }
}
