import type { AgentRunMode, UXReviewReport } from "@contracts/agent";

/**
 * Commit Gate(文档 §13.2)
 *
 * 默认门禁:协议/IR/安全错误=0(由 ValidationPipeline 保证),P0=P1=0,
 * 总分 ≥ 阈值(新建/重设计 85,局部修改 80),评审建议非 reject。
 * 结果三态:直接提交 / 进入修复 / 需要人工审批。
 */

export interface GateInput {
  mode: AgentRunMode;
  report?: UXReviewReport | null;
  /** ValidationPipeline error 级问题数 */
  blockingIssues: number;
  /** 已进行的修复轮次(0 起) */
  repairAttempts: number;
  /** §12.1 原型探索模式:分数门禁放宽至 70(P0/P1 仍阻断) */
  prototypeMode?: boolean;
}

export interface GateResult {
  allowed: boolean;
  needRepair: boolean;
  needApproval: boolean;
  reasons: string[];
}

function thresholdOf(mode: AgentRunMode, prototypeMode?: boolean): number | null {
  const base =
    mode === "create_page" || mode === "create_frame" || mode === "redesign_frame"
      ? 85
      : mode === "refine_selection" || mode === "repair_design" || mode === "interaction_design"
        ? 80
        : null;
  if (base === null) return null; // review/audit/export_prepare 等不产出设计修改,不设分数门禁
  return prototypeMode ? 70 : base; // §12.1 原型探索放宽档
}

export function evaluateCommitGate(input: GateInput): GateResult {
  const reasons: string[] = [];
  if (input.blockingIssues > 0) {
    if (input.repairAttempts < 2) {
      return { allowed: false, needRepair: true, needApproval: false, reasons: [`${input.blockingIssues} 个确定性校验阻断问题`] };
    }
    return { allowed: false, needRepair: false, needApproval: false, reasons: ["修复两轮后仍存在阻断问题,按门禁拒绝"] };
  }

  const report = input.report;
  if (!report) {
    // 评审不可用:确定性校验已通过,放行(降级策略,记录由调用方处理)
    return { allowed: true, needRepair: false, needApproval: false, reasons: [] };
  }
  if (report.commitRecommendation === "reject") {
    // reject 与低分同梯度:有余量先进修复,轮次用尽转人工——
    // 直接拒绝会让 Critic 的一次随机判断(实测 v4-flash 评审方差大)否决已通过确定性校验的成果,
    // 且违反本文件头部声明的三态设计(提交/修复/人工)
    if (input.repairAttempts < 2) {
      return { allowed: false, needRepair: true, needApproval: false, reasons: ["评审建议拒绝提交,进入修复"] };
    }
    return { allowed: false, needRepair: false, needApproval: true, reasons: ["评审仍建议拒绝提交,转人工决策"] };
  }

  const threshold = thresholdOf(input.mode, input.prototypeMode);
  const blocking = report.issues.filter((i) => i.blocking);
  if (blocking.length > 0) {
    if (input.repairAttempts < 2) {
      return {
        allowed: false,
        needRepair: true,
        needApproval: false,
        reasons: blocking.map((i) => `${i.severity}: ${i.message.slice(0, 60)}`),
      };
    }
    // 两轮修复仍未收敛:与低分分支同梯度转人工(用户可查看评审意见后自行取舍),不替用户判死
    return { allowed: false, needRepair: false, needApproval: true, reasons: ["评审阻断问题两轮修复未收敛,转人工决策"] };
  }

  if (threshold !== null && report.score.total < threshold) {
    reasons.push(`UX 总分 ${report.score.total} 低于门禁 ${threshold}`);
    if (input.prototypeMode) reasons.push("原型探索模式:门禁已放宽至 70,结果不建议直接生产导出");
    // 第一轮低分进修复;第二轮低分转人工(ask_user 语义)
    if (input.repairAttempts < 2) {
      return { allowed: false, needRepair: true, needApproval: false, reasons };
    }
    return { allowed: false, needRepair: false, needApproval: true, reasons };
  }

  if (report.commitRecommendation === "ask_user") {
    return { allowed: false, needRepair: false, needApproval: true, reasons: ["评审建议请求用户决策"] };
  }

  return { allowed: true, needRepair: false, needApproval: false, reasons };
}
