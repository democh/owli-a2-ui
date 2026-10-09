import { desc, eq } from "drizzle-orm";
import { runEvalChecks, summarize, type EvalCaseResult } from "./checkers";
import { EVAL_CASES, type EvalCase } from "./cases";
import type { AgentRunRequest } from "@contracts/agent";
import { loadHead } from "../command/commandService";
import { RunManager } from "../agent/run/RunManager";
import { executeRun } from "../agent/orchestrator/DesignHarnessAgent";
import { assertRunStartable } from "../agent/runtime/BudgetManager";
import { getDb } from "../queries/connection";
import { opBatches, projects, runs as runsTable, userSettings, uxReviewReports } from "@db/schema";
import { env } from "../lib/env";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

/**
 * 评测执行器(M6-6):对每个用例跑完整 Harness Agent 管线并确定性判卷。
 *
 * 触发方式:EVALS_LLM=1 时由 api/evals/evals.llm.test.ts 驱动(需配置 LLM Key);
 * 报告落盘 data/evals/report-<ts>.json,安全违规(漏报)单独列出且必须为 0。
 */

interface EvalRunOptions {
  /** 评测项目(不传则自动创建独立项目,避免污染用户数据) */
  projectId?: number;
  /** 用例子集(默认全量 30 组) */
  caseIds?: string[];
  /** 单案超时 ms(默认 10 分钟) */
  perCaseTimeoutMs?: number;
}

function resolveLlm() {
  const db = getDb();
  const owner = db.select().from(userSettings).limit(1).get();
  return {
    apiKey: owner?.llmApiKey || env.kimiApiKey || null,
    baseUrl: owner?.llmBaseUrl || env.kimiBaseUrl,
    model: owner?.llmModel || env.kimiModel,
    maxTokens: env.llmMaxTokens,
  };
}

function ensureEvalProject(): number {
  const db = getDb();
  const r = db.insert(projects).values({ userId: 1, name: `评测集 ${new Date().toISOString().slice(0, 10)}` }).run();
  return Number(r.lastInsertRowid);
}

/** 跑单条用例:创建 Run → 等待终态 → 收集 IR/ops → 判卷 */
export async function runEvalCase(c: EvalCase, opts: Required<Pick<EvalRunOptions, "projectId" | "perCaseTimeoutMs">>): Promise<EvalCaseResult> {
  const startedAt = Date.now();
  const head = loadHead(opts.projectId);
  if (!head) throw new Error(`评测项目 ${opts.projectId} 缺少初始 revision`);

  const request: AgentRunRequest = {
    projectId: opts.projectId,
    conversationId: await ensureConversation(opts.projectId),
    mode: c.mode,
    userMessage: c.prompt,
    scope: {},
    baseRevision: head.revision,
    idempotencyKey: `eval_${c.id}_${Date.now()}`,
    autonomyLevel: "autopilot", // L3:预算内自动提交,仍受 P0/P1 门禁;避免 HITL 挂起
    stylePreference: { mode: "auto", presetIds: [], referenceIds: [] },
    skillSelection: { mode: "auto", skillIds: [] },
    clarificationPolicy: { maxQuestions: 0, allowSkip: true, useRecommendedDefaults: true },
    constraints: { prototypeMode: false, allowDestructive: false, targetPlatforms: c.mode === "create_frame" ? ["mobile"] : [] },
    chips: [],
  };

  const { runId } = RunManager.create(request);
  RunManager.attach(runId, request);
  (RunManager.request(runId) as Record<string, unknown>).__llm = resolveLlm();
  const runPromise = executeRun(runId).catch(() => {});

  // 等待终态
  const deadline = Date.now() + opts.perCaseTimeoutMs;
  while (Date.now() < deadline) {
    const s = RunManager.status(runId);
    if (s === "completed" || s === "failed" || s === "cancelled") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await runPromise;

  const status = RunManager.status(runId);
  const db = getDb();
  const finalRevision = db.select({ finalRevision: runsTable.finalRevision }).from(runsTable).where(eq(runsTable.runId, runId)).limit(1).get()?.finalRevision;

  // 从 op_batches 提取本 run 的提交记录(provenance.runId 匹配)
  const allBatches = db.select().from(opBatches).orderBy(desc(opBatches.id)).limit(50).all();
  const batch = allBatches.find((b) => {
    try {
      return (JSON.parse(b.provenance) as { runId?: string }).runId === runId;
    } catch {
      return false;
    }
  });
  const ops = batch ? (JSON.parse(batch.ops) as AgentRunRequest["scope"] extends never ? never[] : unknown[]) : [];
  type OpLike = { op: string; surfaceId?: string; frame?: { device?: string }; surface?: { id: string; title: string; root: string; components: Record<string, { type: string; props?: Record<string, unknown>; children: string[] }> } };
  const opList = ops as OpLike[];

  // 组装判卷对象:新增 surface(addFrame op 内)或 head 中出现的 surface
  const surfaces = opList
    .filter((o) => o.op === "addFrame" && o.surface)
    .map((o) => o.surface!);
  const devices = opList.filter((o) => o.op === "addFrame").map((o) => o.frame?.device ?? "desktop");
  const headDoc = finalRevision != null ? loadHead(opts.projectId)?.doc : head.doc;
  const surfaceList = surfaces.length
    ? surfaces
    : headDoc
      ? Object.values(headDoc.surfaces)
      : [];

  const results = runEvalChecks(
    c.checks,
    { surfaces: surfaceList as never, ops: opList as never, devices },
  );
  const failures = results.filter((r) => !r.ok);
  return {
    caseId: c.id,
    domain: c.domain,
    runId,
    passed: status === "completed" && failures.length === 0,
    failures: failures.map((f) => `${f.kind}: ${f.detail}`),
    securityViolations: failures.filter((f) => f.kind.startsWith("no_")).map((f) => `${f.kind}: ${f.detail}`),
    durationMs: Date.now() - startedAt,
  };
}

async function ensureConversation(projectId: number): Promise<number> {
  const { conversations } = await import("@db/schema");
  const db = getDb();
  const r = db.insert(conversations).values({ projectId, title: "评测会话" }).run();
  return Number(r.lastInsertRowid);
}

/** 全量评测:串行执行 + 报告落盘;返回汇总 */
export async function runEvals(opts: EvalRunOptions = {}): Promise<ReturnType<typeof summarize>> {
  const projectId = opts.projectId ?? ensureEvalProject();
  assertRunStartable(1); // 本地单机用户
  const cases = EVAL_CASES.filter((c) => !opts.caseIds || opts.caseIds.includes(c.id));
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    try {
      results.push(await runEvalCase(c, { projectId, perCaseTimeoutMs: opts.perCaseTimeoutMs ?? 10 * 60_000 }));
    } catch (e) {
      results.push({ caseId: c.id, domain: c.domain, passed: false, failures: [`执行异常:${(e as Error).message}`], securityViolations: [] });
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    projectId,
    results,
    summary: summarize(results),
    // §17.4 评审校准留痕:LLM Critic 结论 vs 确定性判卷的差异清单(供人工复核,不自动调参)
    reviewCalibration: buildReviewCalibration(results),
  };
  const dir = path.resolve(process.cwd(), "data", "evals");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `report-${Date.now()}.json`), JSON.stringify(report, null, 2), "utf8");
  return report.summary;
}

/**
 * §17.4 LLM 评审校准(最小可用):按用例的 runId 取 Critic 报告,
 * 与确定性判卷对照归类:
 *  - 漏报:Critic 放行(commit 建议)但确定性判卷失败
 *  - 误报:Critic 阻断(reject/ask_user)但确定性判卷全通过
 * 差异清单写入报告,人工每周复核并调整评审 Prompt(不自动改参数)。
 */
export function buildReviewCalibration(results: EvalCaseResult[]): {
  underReported: { caseId: string; runId?: string; criticScore: number; criticRecommendation: string; deterministicFailures: string[] }[];
  overReported: { caseId: string; runId?: string; criticScore: number; criticRecommendation: string }[];
} {
  const underReported: ReturnType<typeof buildReviewCalibration>["underReported"] = [];
  const overReported: ReturnType<typeof buildReviewCalibration>["overReported"] = [];
  const db = getDb();
  for (const r of results) {
    if (!r.runId) continue;
    const row = db
      .select({ score: uxReviewReports.score, commitRecommendation: uxReviewReports.commitRecommendation })
      .from(uxReviewReports)
      .where(eq(uxReviewReports.runId, r.runId))
      .orderBy(desc(uxReviewReports.id))
      .limit(1)
      .get();
    if (!row) continue;
    const criticScore = (JSON.parse(row.score) as { total?: number }).total ?? 0;
    const blocked = row.commitRecommendation === "reject" || row.commitRecommendation === "ask_user";
    if (r.failures.length > 0 && !blocked) {
      underReported.push({ caseId: r.caseId, runId: r.runId, criticScore, criticRecommendation: row.commitRecommendation, deterministicFailures: r.failures });
    } else if (r.failures.length === 0 && blocked) {
      overReported.push({ caseId: r.caseId, runId: r.runId, criticScore, criticRecommendation: row.commitRecommendation });
    }
  }
  return { underReported, overReported };
}
