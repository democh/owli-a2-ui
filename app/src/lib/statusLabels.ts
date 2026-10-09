import type { RunStatus } from "@contracts/agent";

/** Run 状态 → 中文标签(前端展示;与服务端 RunStateMachine.STATUS_LABELS 保持一致) */
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
