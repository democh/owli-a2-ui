import type { UXReviewIssue, UXReviewReport } from "@contracts/agent";

/**
 * 并行专家评审聚合(M7:Critic×N 投票)
 *
 * N 个评审并行独立打分,聚合规则:
 *  - score:各维度取算术平均后四舍五入
 *  - issues:同category+message 视为同一问题合并投票;blocking 仅当"多数票"认可
 *    (避免单个 Critic 的误报直接阻断提交);issueId 重新编号
 *  - commitRecommendation:取最保守建议(reject > ask_user > repair > commit),
 *    与"门禁宁严勿松"原则一致
 *  - strengths/recommendations:按文本去重合并
 */

const RECO_RANK = { commit: 0, repair: 1, ask_user: 2, reject: 3 } as const;

export function aggregateReviews(reports: UXReviewReport[]): UXReviewReport {
  if (reports.length === 0) throw new Error("aggregateReviews: 空输入");
  const n = reports.length;
  const base = reports[0]!;

  // 1) 分数均值(total = 各维度均值之和,保持 100 分制口径)
  const keys = ["taskFit", "informationArchitecture", "visualHierarchy", "consistency", "interaction", "accessibility", "responsiveness", "feasibility"] as const;
  const avg = (pick: (r: UXReviewReport) => number) => Math.round(reports.reduce((s, r) => s + pick(r), 0) / n);
  const score = {
    total: 0,
    taskFit: avg((r) => r.score.taskFit),
    informationArchitecture: avg((r) => r.score.informationArchitecture),
    visualHierarchy: avg((r) => r.score.visualHierarchy),
    consistency: avg((r) => r.score.consistency),
    interaction: avg((r) => r.score.interaction),
    accessibility: avg((r) => r.score.accessibility),
    responsiveness: avg((r) => r.score.responsiveness),
    feasibility: avg((r) => r.score.feasibility),
  };
  score.total = keys.reduce((s, k) => s + score[k], 0);

  // 2) issues 投票合并:同 category+message 为同一问题;blocking 按认可票数多数决
  const votes = new Map<string, { issue: UXReviewIssue; blockingVotes: number }>();
  for (const r of reports) {
    for (const issue of r.issues) {
      const key = `${issue.category}::${issue.message}`;
      const v = votes.get(key);
      if (v) v.blockingVotes += issue.blocking ? 1 : 0;
      else votes.set(key, { issue, blockingVotes: issue.blocking ? 1 : 0 });
    }
  }
  const majority = Math.floor(n / 2) + 1;
  const issues: UXReviewIssue[] = [...votes.values()].map(({ issue, blockingVotes }, i) => ({
    ...issue,
    issueId: `agg_${i + 1}`,
    // 多数票才 blocking:单个 Critic 误报降级为提示
    blocking: blockingVotes >= majority,
    confidence: Math.min(1, issue.confidence + (blockingVotes >= majority ? 0.1 : 0)),
  }));

  // 3) 最保守提交建议
  const commitRecommendation = reports.reduce(
    (acc, r) => (RECO_RANK[r.commitRecommendation] > RECO_RANK[acc] ? r.commitRecommendation : acc),
    "commit" as UXReviewReport["commitRecommendation"],
  );

  // 4) strengths/recommendations 去重合并
  const strengths = [...new Set(reports.flatMap((r) => r.strengths))];
  const recommendations = [...new Set(reports.flatMap((r) => r.recommendations))];

  return {
    ...base,
    score,
    issues,
    strengths,
    recommendations,
    commitRecommendation,
  };
}
