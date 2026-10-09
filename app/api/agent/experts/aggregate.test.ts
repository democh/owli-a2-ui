import { describe, expect, it } from "vitest";
import { aggregateReviews } from "./aggregate";
import type { UXReviewReport } from "@contracts/agent";

function report(over: Partial<UXReviewReport>): UXReviewReport {
  return {
    reviewId: `rev_${Math.random().toString(36).slice(2, 8)}`,
    proposalId: "p1",
    score: { total: 80, taskFit: 16, informationArchitecture: 12, visualHierarchy: 12, consistency: 8, interaction: 12, accessibility: 12, responsiveness: 4, feasibility: 4 },
    issues: [],
    strengths: [],
    recommendations: [],
    commitRecommendation: "commit",
    ...over,
  };
}

describe("aggregateReviews(Critic×N 投票聚合)", () => {
  it("分数取均值,total 为各维度均值之和", () => {
    const a = report({ score: { total: 80, taskFit: 16, informationArchitecture: 12, visualHierarchy: 12, consistency: 8, interaction: 12, accessibility: 12, responsiveness: 4, feasibility: 4 } });
    const b = report({ score: { total: 90, taskFit: 18, informationArchitecture: 14, visualHierarchy: 12, consistency: 9, interaction: 13, accessibility: 13, responsiveness: 5, feasibility: 6 } });
    const agg = aggregateReviews([a, b]);
    expect(agg.score.taskFit).toBe(17);
    expect(agg.score.informationArchitecture).toBe(13);
    expect(agg.score.total).toBe(agg.score.taskFit + agg.score.informationArchitecture + agg.score.visualHierarchy + agg.score.consistency + agg.score.interaction + agg.score.accessibility + agg.score.responsiveness + agg.score.feasibility);
  });

  it("blocking 需要多数票:单个 Critic 的 blocking 误报被降级", () => {
    const issue = (blocking: boolean) => ({ issueId: "x", severity: "P1" as const, category: "a11y", message: "对比度不足", rationale: "", affectedNodeIds: [], recommendation: "", blocking, confidence: 0.8, repairOps: [] });
    const majority = aggregateReviews([
      report({ issues: [issue(true)] }),
      report({ issues: [issue(true)] }),
      report({ issues: [issue(false)] }),
    ]);
    expect(majority.issues[0]?.blocking).toBe(true); // 2/3 多数 → 保持 blocking
    const minority = aggregateReviews([
      report({ issues: [issue(true)] }),
      report({ issues: [issue(false)] }),
      report({ issues: [issue(false)] }),
    ]);
    expect(minority.issues[0]?.blocking).toBe(false); // 1/3 少数 → 降级
    expect(minority.issues[0]?.issueId).toBe("agg_1"); // 重新编号
  });

  it("commitRecommendation 取最保守(reject > ask_user > repair > commit)", () => {
    const agg = aggregateReviews([
      report({ commitRecommendation: "commit" }),
      report({ commitRecommendation: "repair" }),
      report({ commitRecommendation: "ask_user" }),
    ]);
    expect(agg.commitRecommendation).toBe("ask_user");
    const worst = aggregateReviews([
      report({ commitRecommendation: "commit" }),
      report({ commitRecommendation: "reject" }),
    ]);
    expect(worst.commitRecommendation).toBe("reject");
  });

  it("strengths/recommendations 去重合并,issues 同文合并票数", () => {
    const issue = (blocking: boolean) => ({ issueId: `i${blocking}`, severity: "P2" as const, category: "layout", message: "留白不均", rationale: "", affectedNodeIds: [], recommendation: "", blocking, confidence: 0.8, repairOps: [] });
    const agg = aggregateReviews([
      report({ strengths: ["层次清晰"], recommendations: ["加大字号"], issues: [issue(true)] }),
      report({ strengths: ["层次清晰", "配色统一"], recommendations: ["加大字号", "补充空态"], issues: [issue(false)] }),
    ]);
    expect(agg.strengths).toEqual(["层次清晰", "配色统一"]);
    expect(agg.recommendations).toEqual(["加大字号", "补充空态"]);
    expect(agg.issues).toHaveLength(1); // 同 category+message 合并
  });
});
