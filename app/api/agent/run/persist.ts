import { desc, eq } from "drizzle-orm";
import type { DesignBrief, DesignPlan, UXReviewReport, ValidationIssue } from "@contracts/agent";
import type { ClarificationRequest, ClarificationResponse } from "@contracts/clarification";
import type { StyleDirection } from "@contracts/style";
import { getDb } from "../../queries/connection";
import {
  auditLogs,
  clarificationRequests,
  clarificationResponses,
  designBriefs,
  designDecisions,
  designPlans,
  designProposals,
  runs,
  runEvents,
  skillRuns,
  styleDirections,
  uxReviewReports,
} from "@db/schema";

/**
 * Run 可观测性落库(文档 §17/§18.5/§19.5)
 *
 * 每个 Run 阶段的结构化产物持久化:brief/plan/proposal/review/style/skills/
 * clarification/decisions + 审计日志。失败静默(可观测性不应阻断主流程)。
 */

function safe(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[persist] ${label} 失败:`, (e as Error).message);
  }
}

export function saveBrief(runId: string, brief: DesignBrief): void {
  safe("brief", () =>
    getDb()
      .insert(designBriefs)
      .values({ briefId: `brief_${runId}`, runId, brief: JSON.stringify(brief) })
      .run(),
  );
}

export function savePlan(runId: string, plan: DesignPlan): void {
  safe("plan", () =>
    getDb()
      .insert(designPlans)
      .values({ planId: `plan_${runId}`, runId, plan: JSON.stringify(plan) })
      .run(),
  );
}

export function saveStyle(runId: string, sd: StyleDirection): void {
  safe("style", () => {
    const db = getDb();
    db.insert(styleDirections)
      .values({ styleDirectionId: sd.styleDirectionId, runId, sd: JSON.stringify(sd) })
      .run();
    db.update(runs).set({ styleDirection: JSON.stringify(sd) }).where(eq(runs.runId, runId)).run();
  });
}

export function saveSkills(runId: string, skills: { skillId: string; version: string; reason: string }[]): void {
  safe("skills", () => {
    const db = getDb();
    for (const s of skills) {
      db.insert(skillRuns).values({ runId, skillId: s.skillId, version: s.version, reason: s.reason }).run();
    }
    db.update(runs).set({ skillIds: JSON.stringify(skills.map((s) => s.skillId)) }).where(eq(runs.runId, runId)).run();
  });
}

export function saveProposal(
  runId: string,
  projectId: number,
  baseRevision: number,
  projectedOps: unknown[],
  rationale: string,
  confidence: number,
  changeSummary: Record<string, unknown>,
): string {
  const proposalId = `prop_${runId}`;
  safe("proposal", () =>
    getDb()
      .insert(designProposals)
      .values({
        proposalId,
        runId,
        projectId,
        baseRevision,
        status: "validating",
        projectedOps: JSON.stringify(projectedOps).slice(0, 2_000_000),
        rationale,
        confidence: Math.round(confidence * 100),
        changeSummary: JSON.stringify(changeSummary),
      })
      .run(),
  );
  return proposalId;
}

export function markProposalStatus(proposalId: string, status: "approved" | "rejected" | "committed"): void {
  safe("proposalStatus", () =>
    getDb().update(designProposals).set({ status }).where(eq(designProposals.proposalId, proposalId)).run(),
  );
}

export function saveReview(runId: string, report: UXReviewReport): void {
  safe("review", () =>
    getDb()
      .insert(uxReviewReports)
      .values({
        reviewId: report.reviewId,
        proposalId: report.proposalId,
        runId,
        score: JSON.stringify(report.score),
        issues: JSON.stringify(report.issues),
        strengths: JSON.stringify(report.strengths),
        recommendations: JSON.stringify(report.recommendations),
        commitRecommendation: report.commitRecommendation,
      })
      .run(),
  );
}

export function saveClarificationRequest(runId: string, request: ClarificationRequest): void {
  safe("clarReq", () =>
    getDb()
      .insert(clarificationRequests)
      .values({
        requestId: request.requestId,
        runId,
        reason: request.reason,
        questions: JSON.stringify(request.questions),
        timeoutSeconds: request.timeoutSeconds,
        defaultStrategy: request.defaultStrategy,
      })
      .run(),
  );
}

export function saveClarificationResponse(runId: string, response: ClarificationResponse): void {
  safe("clarResp", () => {
    const db = getDb();
    db.insert(clarificationResponses)
      .values({ requestId: response.requestId, runId, answers: JSON.stringify(response.answers) })
      .run();
    db.update(clarificationRequests)
      .set({ status: response.answers.every((a) => a.skipped) ? "skipped" : "answered" })
      .where(eq(clarificationRequests.requestId, response.requestId))
      .run();
  });
}

export function saveValidationIssues(runId: string, proposalId: string, issues: ValidationIssue[], attempt: number): void {
  safe("validation", () =>
    getDb()
      .insert(runEvents)
      .values({
        runId,
        seq: -1000 - attempt, // 诊断事件,不参与正常序(seq 负值仅存档)
        type: `design.validation_attempt_${attempt}`,
        payload: JSON.stringify({ proposalId, issues }),
      })
      .run(),
  );
}

export function saveDecision(
  runId: string,
  proposalId: string | undefined,
  topic: string,
  chosen: string,
  rationale: string,
  confidence: number,
): void {
  safe("decision", () =>
    getDb()
      .insert(designDecisions)
      .values({
        decisionId: `dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        runId,
        proposalId: proposalId ?? null,
        topic,
        chosen,
        rationale,
        confidence: Math.round(confidence * 100),
      })
      .run(),
  );
}

export function saveAudit(
  actorType: "user" | "agent" | "system",
  actorId: string,
  projectId: number | null,
  runId: string | null,
  action: string,
  detail: Record<string, unknown>,
): void {
  safe("audit", () =>
    getDb()
      .insert(auditLogs)
      .values({ actorType, actorId, projectId, runId, action, detail: JSON.stringify(detail) })
      .run(),
  );
}

/** 最近决策(供 ContextBuilder 复用;当前直接查表,此处保留统一出口) */
export function recentDecisions(limit = 5) {
  return getDb().select().from(designDecisions).orderBy(desc(designDecisions.id)).limit(limit).all();
}
