import { runStatusSchema, type RunStatus } from "@contracts/agent";

/**
 * Agent Run 状态机(文档 §6)
 *
 * 合法迁移表是唯一事实:任何非法迁移直接抛错,保证"取消不产生半状态"。
 * 可重试错误走 failed → queued 重入;不可恢复错误直接 failed 终态。
 */

// ---------------------------------------------------------------------------
// 迁移表(源状态 → 允许的目标状态集合)
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "cancelled", "failed"]);

export const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  // 边以 executeRun 实际编排顺序为准(§19.4:intake → clarification → style → skills → plan → generate → validate → review → policy → approval → commit)
  queued: ["intake", "cancelling", "failed"],
  intake: ["planning_clarification", "resolving_style", "cancelling", "failed"], // 澄清被策略跳过时直达风格解析
  resolving_style: ["selecting_skills", "cancelling", "failed"],
  selecting_skills: ["planning", "generating", "planning_clarification", "cancelling", "failed"], // 简单局部修改跳过 plan 直达生成
  planning_clarification: ["awaiting_clarification", "planning", "resolving_style", "cancelling", "failed"],
  awaiting_clarification: ["planning", "resolving_style", "cancelling", "cancelled"],
  planning: ["awaiting_plan_approval", "generating", "cancelling", "failed"],
  awaiting_plan_approval: ["generating", "cancelled", "cancelling"],
  generating: ["parsing", "cancelling", "failed"],
  parsing: ["protocol_validating", "repairing", "cancelling", "failed"],
  protocol_validating: ["ux_reviewing", "repairing", "cancelling", "failed"],
  ux_reviewing: ["repairing", "policy_checking", "awaiting_approval", "cancelling", "failed"],
  repairing: ["protocol_validating", "ux_reviewing", "policy_checking", "failed", "cancelling"],
  policy_checking: ["awaiting_approval", "committing", "cancelling", "failed"],
  awaiting_approval: ["committing", "completed", "cancelled", "cancelling"], // suggest 模式仅输出解释,不提交直接完成
  committing: ["completed", "failed"],
  completed: [],
  cancelling: ["cancelled"],
  cancelled: [],
  failed: [],
};

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/** 状态迁移;非法迁移抛错(带轨迹上下文由调用方补充) */
export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (from === to) return to; // 幂等重入(如重复下发同一状态)
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`非法状态迁移: ${from} → ${to}`);
  }
  return to;
}

/** 状态 → 用户可读标签(前端 Turn Card / Timeline 显示) */
export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排队中",
  intake: "需求理解",
  resolving_style: "风格解析",
  selecting_skills: "Skill 选择",
  planning_clarification: "澄清规划",
  awaiting_clarification: "等待确认",
  planning: "设计规划",
  awaiting_plan_approval: "等待计划确认",
  generating: "生成中",
  parsing: "解析",
  protocol_validating: "协议校验",
  ux_reviewing: "UX 评审中",
  repairing: "自动修复中",
  policy_checking: "安全检查",
  awaiting_approval: "等待审批",
  committing: "提交中",
  completed: "已完成",
  cancelling: "正在取消",
  cancelled: "已取消",
  failed: "失败",
};

/** 状态进度估算(Turn Card 的 64% 这类展示;粗粒度即可) */
export const STATUS_PROGRESS: Record<RunStatus, number> = {
  queued: 0,
  intake: 0.1,
  resolving_style: 0.2,
  selecting_skills: 0.25,
  planning_clarification: 0.3,
  awaiting_clarification: 0.3,
  planning: 0.4,
  awaiting_plan_approval: 0.45,
  generating: 0.55,
  parsing: 0.7,
  protocol_validating: 0.75,
  ux_reviewing: 0.8,
  repairing: 0.85,
  policy_checking: 0.9,
  awaiting_approval: 0.92,
  committing: 0.95,
  completed: 1,
  cancelling: 1,
  cancelled: 1,
  failed: 1,
};

export function assertRunStatus(raw: string): RunStatus {
  const parsed = runStatusSchema.safeParse(raw);
  if (!parsed.success) return "failed";
  return parsed.data;
}
