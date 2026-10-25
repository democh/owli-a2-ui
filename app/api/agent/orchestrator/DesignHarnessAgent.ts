import type { AgentEvent, AgentRunRequest, ApprovalAccept, DesignBrief, DesignPlan, PlanTask, StyleDirection, ToolCard, UXReviewReport, ValidationIssue } from "@contracts/agent";
import { designBriefSchema } from "@contracts/agent";
import type { ClarificationResponse } from "@contracts/clarification";
import type { IROperation, IRSurface, Frame } from "@contracts/design-ir";
import { DEVICES, applyOps, sitemapSchema, type DeviceId, type Sitemap, type SurfaceDoc, type SurfaceOp, type ThemeTokens, type ThemeVisual } from "@contracts/a2ui";
import { resolveStyleTheme, styleDirectiveText } from "@contracts/style";
import { env } from "../../lib/env";
import { loadHead, commitRunChanges } from "../../command/commandService";
import { RunManager, RunCancelledError } from "../run/RunManager";
import { buildContext, type AgentContext } from "../context/ContextBuilder";
import { LLMProvider, type LlmRequest } from "../runtime/LLMProvider";
import { checkRunTokenBudget, consumeToolCall, runTokensUsed, BudgetExceededError } from "../runtime/BudgetManager";
import { buildToolRegistry } from "../runtime/tools";
import type { ToolContext } from "../runtime/ToolRuntime";
import { startSpan, withSpan } from "../../observability/trace";
import { recordAlert } from "../../observability/alerts";
import { runIntake, planClarification, normalizeClarification, resolveStyleDirection, baseStyleDirection, selectSkills, skillFragments, runPlanning, runExplanation } from "../experts";
import { aggregateReviews } from "../experts/aggregate";
import { hasBlocking } from "../validation/ValidationPipeline";
import { evaluateCommitGate } from "../gates/CommitGate";
import {
  saveBrief,
  savePlan,
  saveStyle,
  saveSkills,
  saveProposal,
  saveReview,
  saveClarificationRequest,
  saveClarificationResponse,
  saveValidationIssues,
  saveDecision,
  saveAudit,
  markProposalStatus,
} from "../run/persist";
import {
  SURFACE_SYSTEM_PROMPT,
  OPS_SYSTEM_PROMPT,
  SITEMAP_SYSTEM_PROMPT,
  buildRedesignUserPrompt,
  buildSitemapUserPrompt,
  buildPageFromSitemapUserPrompt,
  buildOpsUserMessage,
  buildSelectedDesc,
  buildHistoryBlock,
  surfaceRepairMessage,
} from "../../llm/prompts";
import {
  extractFirstJsonObject,
  kimiGenerateOps,
  tryParseSurfaces,
  type KimiConfig,
} from "../../llm/kimi";
import { parsePartialOps, parsePartialPages } from "../../../src/lib/partialSurface";
import { getDb } from "../../queries/connection";
import { frames, messages, runs } from "@db/schema";
import { eq } from "drizzle-orm";

/**
 * Design Harness Agent Orchestrator(文档 §19.4)
 *
 * executeRun 按 Run 状态机编排完整专家管线:
 * intake → clarification → style → skills → plan → generate → validate
 * → review → repair(≤2) → policy → approval(HITL) → commit → explanation
 * 生成层复用既有 surface/ops 提示词与解析器(经生产验证),专家层叠加 Brief/Plan/评审/门禁。
 */

/** 运行时长预算(文档 §18.4):超限即中止,不自动继续 */
function checkBudget(startedAt: number, maxDurationMs?: number): void {
  const budget = maxDurationMs ?? 10 * 60 * 1000;
  if (Date.now() - startedAt > budget) {
    throw new Error("Run 已超过时长预算,已停止;请缩小范围或提高预算后重试");
  }
}

/**
 * §14.5/§16.2 执行过程工具卡:阶段开始发 running 卡,结束(成功/失败)补
 * 耗时 + token 增量;成功后经 describe 基于阶段产物补 outputSummary/inputRefs 等
 * 摘要字段(与 done 卡同帧 emit,前端过程 Tab 展开即有内容)。失败卡默认展开错误摘要。
 */
async function withStepCard<T>(
  runId: string,
  tool: string,
  title: string,
  fn: () => Promise<T>,
  describe?: (out: T) => Partial<ToolCard>,
): Promise<T> {
  const card: ToolCard = {
    cardId: `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    tool,
    title,
    status: "running",
  };
  RunManager.emit(runId, { type: "run.step", runId, card });
  const startedAt = Date.now();
  const tokensBefore = runTokensUsed(runId);
  try {
    const out = await fn();
    card.status = "done";
    card.durationMs = Date.now() - startedAt;
    card.tokens = Math.max(0, runTokensUsed(runId) - tokensBefore);
    Object.assign(card, describe?.(out));
    RunManager.emit(runId, { type: "run.step", runId, card });
    return out;
  } catch (e) {
    card.status = "error";
    card.durationMs = Date.now() - startedAt;
    card.tokens = Math.max(0, runTokensUsed(runId) - tokensBefore);
    card.error = (e as Error).message.slice(0, 200);
    RunManager.emit(runId, { type: "run.step", runId, card });
    throw e;
  }
}

/** §14.8 部分接受:按变更类别过滤 ops(新增/修改/删除三类;move 归修改) */
function filterOpsByAccept(ops: IROperation[], accept: { added: boolean; updated: boolean; deleted: boolean }): IROperation[] {
  return ops.filter((op) => {
    switch (op.op) {
      case "addNode":
      case "addFrame":
      case "addPage":
      case "defineComponent":
        return accept.added;
      case "replaceProps":
      case "setTokens":
      case "setSurfaceTitle":
      case "updateFrame":
      case "updatePage":
      case "moveNode":
      case "upsertDataModel":
        return accept.updated;
      case "removeNode":
      case "removeFrame":
      case "removePage":
      case "removeComponentDef":
        return accept.deleted;
      default:
        return true;
    }
  });
}

/** 澄清服务端超时(文档 §15.3):超时按 defaultStrategy 走推荐默认(全部 skipped),不无限挂起 */
async function awaitClarificationWithTimeout(runId: string, clar: { timeoutSeconds: number; defaultStrategy: string } & Record<string, unknown>): Promise<ClarificationResponse> {
  const wait = RunManager.awaitClarification(runId, clar as never);
  wait.catch(() => {}); // 超时/取消后 resolve 已发生,避免悬挂 reject
  const timeoutMs = (clar.timeoutSeconds ?? 300) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ClarificationResponse>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[agent] 澄清超时(${runId}),按 ${clar.defaultStrategy} 继续`);
      resolve({ requestId: (clar as { requestId?: string }).requestId ?? "", runId, answers: [], submittedAt: new Date().toISOString() });
    }, timeoutMs);
  });
  try {
    return await Promise.race([wait, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 审批服务端超时(文档 §15.3):Approval 超时默认拒绝(Run 走 cancelled),任何审批不能被 Agent 绕过 */
async function awaitApprovalWithTimeout(runId: string, req: { timeoutSeconds: number } & Record<string, unknown>): Promise<{ approved: boolean; accept?: ApprovalAccept }> {
  const wait = RunManager.awaitApproval(runId, req as never);
  wait.catch(() => {});
  const timeoutMs = (req.timeoutSeconds ?? 600) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ approved: boolean }>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[agent] 审批超时(${runId}),默认拒绝`);
      resolve({ approved: false });
    }, timeoutMs);
  });
  try {
    return await Promise.race([wait, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** §14.2 Plan 确认超时:超时默认取消(与 Approval 同策略),不无限挂起 */
async function awaitPlanApprovalWithTimeout(runId: string, tasks: PlanTask[], timeoutSeconds: number): Promise<{ approved: boolean; tasks?: PlanTask[] }> {
  const wait = RunManager.awaitPlanApproval(runId, tasks);
  wait.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ approved: boolean }>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[agent] Plan 确认超时(${runId}),默认取消`);
      resolve({ approved: false });
    }, timeoutSeconds * 1000);
  });
  try {
    return await Promise.race([wait, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** §14.3 由 DesignPlan 生成可展示/可编辑的任务清单(信息架构逐项 + 管线固定三步) */
function planTasksOf(plan: DesignPlan): PlanTask[] {
  const tasks: PlanTask[] = plan.informationArchitecture.map((s, i) => ({
    taskId: `t${i + 1}`,
    title: s.title,
    description: s.purpose,
    status: "pending" as const,
    ownerRole: "UX Architect",
  }));
  tasks.push(
    { taskId: `t${tasks.length + 1}`, title: PIPELINE_TASK_TITLES.generate, status: "pending", ownerRole: "UI Designer" },
    { taskId: `t${tasks.length + 2}`, title: PIPELINE_TASK_TITLES.validate, status: "pending", ownerRole: "Design Critic" },
    { taskId: `t${tasks.length + 3}`, title: PIPELINE_TASK_TITLES.commit, status: "pending", ownerRole: "Orchestrator" },
  );
  return tasks;
}

/** 管线固定三步标题(generate/validate/commit 为门禁必需,不开放执行中跳过) */
const PIPELINE_TASK_TITLES = {
  generate: "生成 UI Proposal",
  validate: "协议校验与 UX 评审",
  commit: "生成 Diff 并等待提交",
} as const;

/** 按标题更新任务状态并返回新数组 */
function markTask(tasks: PlanTask[], title: string, status: PlanTask["status"], extra?: Partial<PlanTask>): PlanTask[] {
  return tasks.map((t) => (t.title === title ? { ...t, status, ...extra } : t));
}

/** §15.3 HITL 截止时间(ISO):断线重连后倒计时以服务端口径恢复 */
function expiresInSeconds(timeoutSeconds: number): string {
  return new Date(Date.now() + timeoutSeconds * 1000).toISOString();
}

/** design.proposal_created 概要(与审批 diffSummary 同口径;全量 ops 存 design_proposals 表) */
function summarizeOps(ops: IROperation[], newSurfaces: IRSurface[]) {
  return {
    added: ops.filter((o) => o.op === "addNode" || o.op === "addFrame" || o.op === "addPage").length,
    updated: ops.filter((o) => o.op === "replaceProps" || o.op === "setTokens").length,
    deleted: ops.filter((o) => o.op === "removeNode" || o.op === "removeFrame" || o.op === "removePage").length,
    moved: ops.filter((o) => o.op === "moveNode").length,
    affectedSurfaces: [
      ...new Set([
        ...newSurfaces.map((s) => s.id),
        ...ops.map((o) => ("surfaceId" in o ? (o as { surfaceId?: string }).surfaceId ?? "" : "")).filter(Boolean),
      ]),
    ],
  };
}

const NO_KEY_MESSAGE =
  "尚未配置大模型 API Key。请点击 Agent 面板右上角「设置」,填入 OpenAI 兼容服务的 API Key 后重试。";

/**
 * 专家阶段统一容错(§13.2 自愈思想覆盖分析类阶段):
 * completeJson 已内建两轮错误回灌;此处兑底回灌仍失败的残余异常——
 * 分析/规划类阶段(需求理解/澄清/风格/规划)失败降级继续,不让整轮 Run 失败
 * (实测:v4-flash 偶发枚举外值/空响应,逐字段打补丁不可持续,统一降级才是架构解)。
 * 降级发 warning 告警(最近告警面板可见)并落审计;无 Key/取消不属于可自愈范围,原样上抛。
 */
async function expertStage<T>(
  runId: string,
  projectId: number,
  stage: string,
  call: () => Promise<T>,
  fallback: () => T,
): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const status = RunManager.status(runId);
    if (e instanceof RunCancelledError || status === "cancelling" || status === "cancelled") throw e;
    const msg = (e as Error).message ?? String(e);
    if (msg.includes("尚未配置大模型 API Key")) throw e; // 无 Key 无法降级(后续阶段全依赖 LLM)
    recordAlert({ projectId, level: "warning", rule: "expert.degraded", message: `${stage}异常已降级继续:${msg.slice(0, 160)}`, meta: { runId, stage } });
    saveAudit("agent", "harness-agent", projectId, runId, "run.expert_degraded", { stage, error: msg.slice(0, 200) });
    return fallback();
  }
}

/** 需求理解降级值:直接以用户原话为目标继续管线(低置信度标记,后续阶段可感知质量降级) */
function fallbackBrief(request: AgentRunRequest): DesignBrief {
  return designBriefSchema.parse({
    objective: request.userMessage,
    confidence: 0.35,
    assumptions: ["需求理解阶段异常,已按原始需求继续"],
    unknowns: [],
  });
}

/** validate_ir 返回 { issues, blocking } 包装对象(非裸数组);统一解包,避免调用方误当数组使用 */
function unwrapValidateResult(out: unknown): { issues: ValidationIssue[]; blocking: boolean } {
  const o = out as { issues?: unknown; blocking?: unknown } | null;
  if (o && Array.isArray(o.issues)) {
    return { issues: o.issues as ValidationIssue[], blocking: o.blocking === true || hasBlocking(o.issues as ValidationIssue[]) };
  }
  if (Array.isArray(out)) return { issues: out as ValidationIssue[], blocking: hasBlocking(out as ValidationIssue[]) };
  throw new Error("validate_ir 返回结构不合法(缺少 issues 数组)");
}

export async function executeRun(runId: string): Promise<void> {
  const ctx0 = RunManager.context(runId);
  if (!ctx0) throw new Error(`Run ${runId} 未找到`);
  const request = ctx0.request;
  const signal = ctx0.abort.signal;
  const startedAt = Date.now();
  // M6-3 OTEL:总 span(子 span 以 parentSpanId 关联;在 try 外声明以便 catch 闭合)
  const runSpan = startSpan("agent.run", { runId, mode: request.mode, projectId: request.projectId });

  try {
    // LLM 配置(用户设置已在路由层解析注入;这里从 request 附属配置读取)
    const llmCfg = llmConfigOf(request);
    if (!llmCfg) throw new Error(NO_KEY_MESSAGE);
    // §18.4 工具/模型调用数预算:每次 LLM 调用(expert/生成/评审/解释)经回调计数,超限即止
    const provider = new LLMProvider({ ...llmCfg, signal }, llmCfg.profileModels, () =>
      consumeToolCall(runId, request.constraints.maxToolCalls),
    );
    // §9 工具系统:validate/review/commit 经具名工具统一执行(参数校验/权限/超时/审计)
    const tools = buildToolRegistry({ provider, userMessage: request.userMessage });
    const toolCtx: ToolContext = {
      runId,
      projectId: request.projectId,
      actorId: "harness-agent",
      actorRole: "orchestrator",
      scope: request.scope,
      abortSignal: signal,
    };

    const head = loadHead(request.projectId);
    if (!head) throw new Error("项目还没有初始 revision,请先迁移数据");
    const doc = head.doc;
    const context = buildContext(request, doc);
    void ctx0;

    // ① intake(降级:以用户原话为 brief 继续,不因理解阶段异常炸整轮;卡片真实置 error + 告警)
    RunManager.toStatus(runId, "intake");
    const brief = await expertStage(runId, request.projectId, "需求理解",
      () =>
        withStepCard(
          runId, "intake", "需求理解",
          () => withSpan("agent.intake", { runId }, () => runIntake(provider, context)),
          (b) => ({
            outputSummary: b.objective.slice(0, 160),
            inputRefs: b.assumptions.slice(0, 4).map((a) => `假设:${a.slice(0, 36)}`),
          }),
        ),
      () => fallbackBrief(request),
    );
    RunManager.emit(runId, { type: "design.brief_created", runId, brief });
    saveBrief(runId, brief);
    saveAudit("agent", "harness-agent", request.projectId, runId, "run.brief_created", { confidence: brief.confidence });
    checkBudget(startedAt, request.constraints.maxDurationMs);
    RunManager.recordUsage(runId, {}, llmCfg.model);
    checkRunTokenBudget(runId, request.constraints.maxTokens); // M6-2:token 预算

    // ② clarification(结构化澄清,HITL;卡片只计 LLM 规划耗时,不含用户等待;降级:null=跳过澄清,状态机有直达边)
    RunManager.toStatus(runId, "planning_clarification");
    const clar = await expertStage(runId, request.projectId, "澄清规划",
      () =>
        withStepCard(
          runId, "clarification", "澄清规划",
          () => planClarification(provider, context, brief, request.clarificationPolicy.maxQuestions),
          (c) => (c && c.questions.length
            ? {
                outputSummary: `提出 ${c.questions.length} 个澄清问题,等待用户确认后归一化`,
                inputRefs: c.questions.map((q) => q.title.slice(0, 40)),
              }
            : { outputSummary: "需求清晰,无需澄清,直接进入风格解析" }),
        ),
      () => null,
    );
    let briefFinal = brief;
    if (clar && clar.questions.length) {
      RunManager.toStatus(runId, "awaiting_clarification");
      RunManager.emit(runId, { type: "clarification.request", runId, request: { ...clar, runId, expiresAt: expiresInSeconds(clar.timeoutSeconds ?? 300) } });
      saveClarificationRequest(runId, { ...clar, runId });
      const response = await awaitClarificationWithTimeout(runId, clar);
      saveClarificationResponse(runId, response);
      const normalized = normalizeClarification(clar, response);
      briefFinal = {
        ...brief,
        assumptions: [...brief.assumptions, ...normalized.assumptions],
        confidence: normalized.skippedAll ? brief.confidence : Math.min(0.9, brief.confidence + 0.2),
      };
      // 澄清事实注入后续 prompt
      context.request = { ...context.request, userMessage: `${context.request.userMessage}\n(已确认:${Object.entries(normalized.facts).map(([k, v]) => `${k}=${v}`).join("; ")})` };
    }

    // ③ style(降级:确定性 preset 映射,无 LLM 增强)
    RunManager.toStatus(runId, "resolving_style");
    const style: StyleDirection = await expertStage(runId, request.projectId, "风格解析",
      () =>
        withStepCard(
          runId, "style", "风格解析",
          () => resolveStyleDirection(provider, context, briefFinal),
          (s) => ({
            outputSummary: `${s.visualKeywords.join("、") || "(无关键词)"} · 组件库 ${s.uiLibraryId}`,
            inputRefs: [`密度:${s.layoutPreferences.density}`, `圆角:${s.layoutPreferences.cornerRadius}`],
          }),
        ),
      () => baseStyleDirection(context),
    );
    RunManager.emit(runId, { type: "design.style_resolved", runId, styleDirection: style });
    saveStyle(runId, style);

    // ③' 风格 → 主题(确定性):
    // 此前 resolveStyleDirection 的 tokenOverrides 只进了提示词,项目 IR 永远用默认令牌,
    // 导致"选了暗色/玻璃风格却渲染成白底"。现由编排层求解后作为 setTokens 一并提交。
    const styleTheme = resolveStyleTheme(context.doc.theme, style);
    RunManager.emit(runId, {
      type: "run.step",
      runId,
      card: {
        cardId: `card_theme_${Date.now().toString(36)}`,
        tool: "style",
        title: "主题令牌求解",
        status: "done",
        durationMs: 0,
        tokens: 0,
        outputSummary: `${styleTheme.visual.cardStyle} · ${styleTheme.visual.density} · primary ${styleTheme.tokens.primary} · radius ${styleTheme.tokens.radius}px`,
        inputRefs: [`背景 ${styleTheme.tokens.background}`, `强调 ${styleTheme.tokens.accent}`],
      },
    });

    // ④ skills(同步路由,零 token;直接发完成卡)
    RunManager.toStatus(runId, "selecting_skills");
    const skills = selectSkills(context, briefFinal);
    RunManager.emit(runId, { type: "run.step", runId, card: {
      cardId: `card_skills_${Date.now().toString(36)}`,
      tool: "skills",
      title: "Skill 选择",
      status: "done",
      durationMs: 0,
      tokens: 0,
      outputSummary: skills.map((s) => `#${s.skillId}(${s.reason})`).join("、") || "未启用 Skill",
    } });
    RunManager.emit(runId, {
      type: "design.skills_selected",
      runId,
      contributions: skills.map((s) => ({ skillId: s.skillId, version: s.version, reason: s.reason })),
    });
    saveSkills(runId, skills);
    const skillContext = skillFragments(skills.map((s) => s.skillId));

    // ⑤ plan(简单局部修改可跳过;ask 模式不需要;降级:跳过规划直接生成,状态机有直达边)
    let plan: DesignPlan | undefined;
    let planTaskList: PlanTask[] = [];
    const needPlan = request.mode !== "ask" && (request.mode !== "refine_selection" || context.scopeSurfaces.length === 0);
    if (needPlan) {
      await RunManager.checkPause(runId); // §14.3 阶段闸门
      RunManager.toStatus(runId, "planning");
      plan = await expertStage(runId, request.projectId, "设计规划",
        () =>
          withStepCard(
            runId, "plan", "设计规划",
            () => withSpan("agent.planning", { runId }, () => runPlanning(provider, context, briefFinal, style)),
            (p) => ({
              outputSummary: p.rationale.slice(0, 160),
              inputRefs: p.informationArchitecture.map((s) => `${s.title}:${s.purpose.slice(0, 40)}`),
            }),
          ),
        () => undefined,
      );
      if (plan) {
        RunManager.emit(runId, { type: "design.plan_created", runId, plan });
        savePlan(runId, plan);
        // §14.3 任务清单:信息架构逐项 + 管线三步(Plan Tab 展示/编辑的数据源)
        const tasks = planTasksOf(plan);
        planTaskList = tasks;
        RunManager.emit(runId, { type: "run.plan", runId, tasks });

        // §14.2 awaiting_plan_approval:review/guarded 自治下,复杂任务先等用户确认/编辑计划
        if (request.autonomyLevel === "review" || request.autonomyLevel === "guarded") {
          RunManager.toStatus(runId, "awaiting_plan_approval");
          RunManager.emit(runId, { type: "run.plan_approval_required", runId, tasks, timeoutSeconds: 600, expiresAt: expiresInSeconds(600) });
          const planDecision = await awaitPlanApprovalWithTimeout(runId, tasks, 600);
          if (!planDecision.approved) {
            RunManager.toStatus(runId, "cancelled");
            RunManager.finish(runId);
            runSpan.end("ok"); // 用户取消计划确认,非错误
            return;
          }
          // §14.3 用户编辑/跳过后的任务清单注入生成上下文(真实影响生成,与澄清注入同模式)
          if (planDecision.tasks?.length) {
            planTaskList = planDecision.tasks;
            RunManager.emit(runId, { type: "run.plan", runId, tasks: planTaskList });
            const edited = planDecision.tasks.filter((t) => t.status !== "skipped");
            if (edited.length) {
              context.request = {
                ...context.request,
                userMessage: `${context.request.userMessage}\n(用户已确认并修订执行计划,请严格按以下任务生成:${edited.map((t, i) => `${i + 1}.${t.title}`).join(";")})`,
              };
            }
          }
        }
      }
    }

    // §14.4 Ask / Plan 模式:只产出解释,不生成 Proposal、不修改 IR
    if (request.mode === "ask" || request.mode === "plan_only") {
      const summary = request.mode === "ask"
        ? `用户问题:${context.request.userMessage}\n需求理解:${JSON.stringify({ objective: briefFinal.objective, assumptions: briefFinal.assumptions, unknowns: briefFinal.unknowns })}\n请直接回答用户的问题,不修改设计。`
        : plan
          ? `设计计划:${plan.rationale}\n信息架构:${JSON.stringify(plan.informationArchitecture)}\n组件策略:${JSON.stringify(plan.componentStrategy)}\n请向用户解释该设计计划、关键取舍与下一步。`
          : "暂无计划";
      RunManager.toStatus(runId, "completed");
      const explanation = await runExplanationSafe(provider, summary, request.baseRevision);
      RunManager.emit(runId, {
        type: "design.explanation",
        runId,
        markdown: explanation,
        changeSummary: {
          added: 0, updated: 0, deleted: 0, moved: 0,
          affectedSurfaces: [],
          designRationale: plan?.rationale ?? "",
          tradeoffs: [],
          nextSuggestions: [],
        },
      });
      RunManager.finish(runId);
      runSpan.end("ok"); // ask/plan_only 未修改设计,正常闭合
      persistAssistantMessage(request, explanation, runId, startedAt);
      return;
    }

    // ⑥ generate(§14.3 阶段闸门 + 执行中任务跳过消费)
    await RunManager.checkPause(runId);
    if (planTaskList.length) {
      const skippedNow = planTaskList.filter((t) => RunManager.isSkipped(runId, t.taskId) && t.status !== "skipped");
      if (skippedNow.length) {
        planTaskList = planTaskList.map((t) => (RunManager.isSkipped(runId, t.taskId) ? { ...t, status: "skipped" as const } : t));
        RunManager.emit(runId, { type: "run.plan", runId, tasks: planTaskList });
        context.request = {
          ...context.request,
          userMessage: `${context.request.userMessage}\n(用户已在执行中跳过以下任务,请勿生成相关内容:${skippedNow.map((t) => t.title).join(";")})`,
        };
      }
      planTaskList = markTask(planTaskList, PIPELINE_TASK_TITLES.generate, "running");
      RunManager.emit(runId, { type: "run.plan", runId, tasks: planTaskList });
    }
    RunManager.toStatus(runId, "generating");
    const generateOut = await withStepCard(
      runId, "generate", "站点生成",
      () => generateWithParseRetry(runId, context, provider, llmCfg, { plan, style, theme: styleTheme, skillContext, brief: briefFinal }),
      describeGenerateOut,
    );
    checkRunTokenBudget(runId, request.constraints.maxTokens); // M6-2:token 预算

    // ⑦ parsing + projecting(进入 生成→校验→评审→门禁 修复循环,≤2 轮)
    RunManager.toStatus(runId, "parsing");
    const first = assembleOps(context, generateOut, styleTheme);
    let finalOps = first.ops;
    let boards = first.boards;
    let framesSpec = first.framesSpec;
    let newSurfaces = first.newSurfaces;
    let proposalId = saveProposal(runId, request.projectId, request.baseRevision, finalOps, plan?.rationale ?? briefFinal.objective, briefFinal.confidence, { surfaces: newSurfaces.map((s) => s.id) });
    // §14.1 Proposal 产物事件(概要;前端 Turn Card 产物区展示)
    RunManager.emit(runId, {
      type: "design.proposal_created",
      runId,
      proposal: {
        proposalId,
        status: "draft",
        rationale: plan?.rationale ?? briefFinal.objective,
        confidence: briefFinal.confidence,
        changeSummary: summarizeOps(finalOps, newSurfaces),
      },
    });
    let report: UXReviewReport | null = null;
    let gate: ReturnType<typeof evaluateCommitGate> | null = null;
    let repairAttempts = 0;
    for (;;) {
      // ⑧ protocol_validating(经 validate_ir 工具:确定性校验 + 审计)
      RunManager.toStatus(runId, "protocol_validating");
      const { issues, blocking } = unwrapValidateResult(
        await withStepCard(
          runId, "validate", "协议校验",
          () =>
            tools.run("validate_ir", toolCtx, {
              baseDoc: doc,
              ops: finalOps,
              uiLibraryId: style.uiLibraryId,
            }),
          (raw) => {
            const r = unwrapValidateResult(raw);
            return {
              outputSummary: r.blocking
                ? `存在阻断问题,共 ${r.issues.length} 条,进入修复轮`
                : r.issues.length
                  ? `校验通过,${r.issues.length} 条非阻断提示`
                  : "校验全部通过",
              validation: r.issues.slice(0, 4).map((i) => ({
                label: `[${i.severity}] ${i.message.slice(0, 80)}`,
                ok: i.severity !== "error",
                detail: i.path,
              })),
            };
          },
        ),
      );
      if (blocking) {
        RunManager.emit(runId, { type: "design.validation_failed", runId, issues, attempt: repairAttempts + 1 });
        saveValidationIssues(runId, proposalId, issues, repairAttempts + 1);
      }

      // ⑨ ux_reviewing(确定性校验通过才进入;M7:Critic×N 并行评审 + 投票聚合)
      report = null;
      if (!blocking && request.mode !== "data_model_design") {
        RunManager.toStatus(runId, "ux_reviewing");
        try {
          const summary = buildSurfaceSummary(finalOps, newSurfaces);
          const critics = Math.max(1, env.reviewCritics);
          // 经 evaluate_ux 工具评审(单 Critic 或并行×N,聚合策略不变);卡片计评审耗时与 token
          const results = await withStepCard(
            runId, "review", critics > 1 ? `UX 评审(×${critics} 投票)` : "UX 评审",
            () =>
              Promise.all(
                Array.from({ length: critics }, () =>
                  withSpan("ux.review", { runId, attempt: repairAttempts + 1, critic: critics > 1 }, () =>
                    tools.runTyped<{ report: UXReviewReport }>("evaluate_ux", toolCtx, { surfaceSummary: summary, plan }),
                  ).catch(() => null),
                ),
              ),
            (rs) => {
              const reports = rs.filter((r): r is { report: UXReviewReport } => r != null).map((r) => r.report);
              if (!reports.length) return { outputSummary: "评审未产出结果(不阻断主流程)" };
              const avg = Math.round(reports.reduce((a, r) => a + r.score.total, 0) / reports.length);
              const p0 = reports.flatMap((r) => r.issues).filter((i) => i.severity === "P0").length;
              const p1 = reports.flatMap((r) => r.issues).filter((i) => i.severity === "P1").length;
              return { outputSummary: `均分 ${avg} · P0×${p0} · P1×${p1} · 建议 ${reports[0]?.commitRecommendation ?? "-"}` };
            },
          );
          const reviews = results.filter((r): r is { report: UXReviewReport } => r != null).map((r) => r.report);
          if (reviews.length) {
            report = critics > 1 ? { ...aggregateReviews(reviews), proposalId } : { ...reviews[0]!, proposalId };
            RunManager.emit(runId, { type: "design.review_completed", runId, report });
            saveReview(runId, report);
          }
        } catch {
          // 评审失败不阻断流程(确定性校验已通过),记录后继续
        }
      }

      // Commit Gate(文档 §13.2):分数门禁 + P0/P1 + 评审建议(prototype 模式放宽至 70)
      gate = evaluateCommitGate({ mode: request.mode, report, blockingIssues: blocking ? 1 : 0, repairAttempts, prototypeMode: request.constraints.prototypeMode });
      if (gate.needRepair && repairAttempts < 2) {
        repairAttempts++;
        RunManager.toStatus(runId, "repairing");
        await RunManager.checkPause(runId); // §14.3 修复轮次同样受暂停闸门约束
        const repairReasons = gate.reasons.join("; ").slice(0, 200); // 闭包外提取(gate 收窄不进异步闭包)
        // 错误回灌:把上一轮具体校验错误与评审 P0/P1 摘要拼进修复提示词,
        // 让模型针对性解决而非盲目重生成(实测:仅泛泛门禁描述时 2 轮修复均修不好引用悬空)
        const validationErrors = issues
          .filter((i) => i.severity === "error")
          .slice(0, 5)
          .map((i) => {
            const loc = i.path ? ` @${i.path}` : "";
            const fix = i.expected ? ` (期望 ${i.expected}${i.actual ? `,实际 ${i.actual}` : ""})` : "";
            return `- [${i.code}]${loc} ${i.message.slice(0, 140)}${fix}`;
          })
          .join("\n");
        const reviewIssues = (report?.issues ?? [])
          .filter((i) => i.severity === "P0" || i.severity === "P1")
          .slice(0, 3)
          .map((i) => `- [${i.severity}/${i.category}] ${i.message.slice(0, 140)}${i.recommendation ? ` 建议:${i.recommendation.slice(0, 80)}` : ""}`)
          .join("\n");
        // 工艺类 P2(P2 一般不阻断门禁,但正是“看起来像 AI 生成”的根因)
        const craftIssues = (report?.issues ?? [])
          .filter((i) => i.severity === "P2" && /视觉|排版|色彩|留白|层级|工艺|style|visual/i.test(`${i.category}${i.message}`))
          .slice(0, 3)
          .map((i) => `- [工艺] ${i.message.slice(0, 120)}${i.recommendation ? ` 建议:${i.recommendation.slice(0, 70)}` : ""}`)
          .join("\n");
        const errorDetail = [
          validationErrors ? `确定性校验错误(必须全部解决):\n${validationErrors}` : "",
          reviewIssues ? `评审问题(尽量解决):\n${reviewIssues}` : "",
          craftIssues ? `视觉工艺问题(用组件与样式修正,不要整体重写):\n${craftIssues}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        const retry = await withStepCard(runId, "repair", `修复生成(第 ${repairAttempts} 轮)`, () =>
          generateWithParseRetry(runId, context, provider, llmCfg, {
            plan,
            style,
            // 修复轮次同样携带已求解主题:否则预览/令牌回写会回退到旧主题
            theme: styleTheme,
            skillContext,
            brief: briefFinal,
            repairHint: `上一轮 Proposal 未通过门禁(${repairReasons})。${errorDetail ? `\n具体错误清单:\n${errorDetail}\n` : ""}请做最小修复:严格使用 Catalog 组件、https 图片地址,并针对性解决上述问题,不改变整体设计方向。`,
          }),
          describeGenerateOut,
        );
        const asm = assembleOps(context, retry, styleTheme);
        finalOps = asm.ops;
        boards = asm.boards;
        framesSpec = asm.framesSpec;
        newSurfaces = asm.newSurfaces;
        proposalId = saveProposal(runId, request.projectId, request.baseRevision, finalOps, plan?.rationale ?? briefFinal.objective, briefFinal.confidence, { attempt: repairAttempts, surfaces: newSurfaces.map((s) => s.id) });
        RunManager.emit(runId, {
          type: "design.proposal_created",
          runId,
          proposal: {
            proposalId,
            status: "draft",
            rationale: plan?.rationale ?? briefFinal.objective,
            confidence: briefFinal.confidence,
            changeSummary: summarizeOps(finalOps, newSurfaces),
          },
        });
        checkRunTokenBudget(runId, request.constraints.maxTokens); // M6-2:token 预算(修复轮次后同样生效)
        continue;
      }
      break;
    }
    // 门禁三态(§13.2):needRepair→修复轮;needApproval(ask_user/第二轮低分转人工)→继续走
    // policy→approval 挂起等待用户;仅「拒绝且不可修复且无需人工」在此 fail。
    // (此前 needApproval=true 也被拦在这里,转人工审批路径从未到达,run.approval_required 不会发出)
    if (gate && !gate.allowed && !gate.needRepair && !gate.needApproval) {
      throw new Error(`Proposal 未通过提交门禁: ${gate.reasons.join("; ").slice(0, 240) || "未知原因"}`);
    }
    // §14.3 任务状态同步:校验与评审完成
    if (planTaskList.length) {
      planTaskList = markTask(planTaskList, PIPELINE_TASK_TITLES.validate, "completed");
      RunManager.emit(runId, { type: "run.plan", runId, tasks: planTaskList });
    }

    // 评审 repairOps(Props 级修复)直接采纳(先经 validate_ir 复验)
    if (report) {
      const criticOps = report.issues.flatMap((i) => i.repairOps);
      if (criticOps.length) {
        const recheck = unwrapValidateResult(
          await tools.run("validate_ir", toolCtx, {
            baseDoc: doc,
            ops: [...finalOps, ...criticOps],
            uiLibraryId: style.uiLibraryId,
          }),
        );
        if (!recheck.blocking) finalOps = [...finalOps, ...criticOps];
      }
    }

    // ⑩ policy_checking(自治级别 + 高风险)
    RunManager.toStatus(runId, "policy_checking");
    const deletions = finalOps.filter((o) => o.op === "removeNode" || o.op === "removeFrame" || o.op === "removePage").length;
    const suggestOnly = request.autonomyLevel === "suggest";
    // autopilot 语义=免 HITL 直通:gate 需人工(ask_user/低分转人工)时自动接受,不挂起
    const needApproval =
      request.autonomyLevel !== "autopilot" &&
      (request.autonomyLevel === "review" ||
        (gate?.needApproval ?? false) ||
        (request.autonomyLevel === "guarded" &&
          (deletions > 0 || report?.commitRecommendation === "ask_user" || briefFinal.confidence < 0.5)));

    // ⑪ approval(HITL)
    if (needApproval || suggestOnly) {
      RunManager.toStatus(runId, "awaiting_approval");
      const approvalReq = {
        approvalId: `appr_${runId}`,
        runId,
        title: suggestOnly ? "本次仅生成建议(不修改设计)" : "提交设计变更",
        reason: deletions > 0 ? `包含 ${deletions} 项删除操作` : "按当前自治级别需要确认",
        affectedSurfaces: [
          ...new Set([
            ...newSurfaces.map((s) => s.id),
            ...finalOps
              .map((o) => ("surfaceId" in o ? (o as { surfaceId?: string }).surfaceId ?? "" : ""))
              .filter((s) => s.length > 0),
          ]),
        ],
        diffSummary: {
          added: finalOps.filter((o) => o.op === "addNode" || o.op === "addFrame" || o.op === "addPage").length,
          updated: finalOps.filter((o) => o.op === "replaceProps" || o.op === "setTokens").length,
          deleted: deletions,
          moved: finalOps.filter((o) => o.op === "moveNode").length,
        },
        riskLevel: (deletions > 0 ? "high" : "medium") as "high" | "medium",
        timeoutSeconds: 600,
        expiresAt: expiresInSeconds(600),
      };
      RunManager.emit(runId, { type: "run.approval_required", runId, request: approvalReq });
      const decision = await awaitApprovalWithTimeout(runId, approvalReq);
      if (!decision.approved) {
        RunManager.toStatus(runId, "cancelled");
        RunManager.finish(runId);
        return;
      }
      if (suggestOnly) {
        markProposalStatus(proposalId, "rejected");
        // suggest 模式:不提交,直接给解释
        const explanation = await runExplanationSafe(provider, buildSurfaceSummary(finalOps, newSurfaces), request.baseRevision);
        RunManager.emit(runId, {
          type: "design.explanation",
          runId,
          markdown: explanation,
          changeSummary: { added: 0, updated: 0, deleted: 0, moved: 0, affectedSurfaces: [], designRationale: "suggest 模式未修改设计", tradeoffs: [], nextSuggestions: [] },
        });
        RunManager.toStatus(runId, "completed");
        RunManager.finish(runId);
        runSpan.end("ok"); // suggest 模式未修改设计,正常闭合
        persistAssistantMessage(request, explanation, runId, startedAt);
        return;
      }
      // §14.8 部分接受:按用户勾选的变更类别过滤 ops;过滤后出现引用悬空则回退全量提交
      const acc = decision.accept;
      if (acc && !(acc.added && acc.updated && acc.deleted)) {
        const filtered = filterOpsByAccept(finalOps, acc);
        const post = unwrapValidateResult(
          await tools.run("validate_ir", toolCtx, {
            baseDoc: doc,
            ops: filtered,
            uiLibraryId: style.uiLibraryId,
          }),
        );
        if (post.blocking) {
          saveAudit("agent", "harness-agent", request.projectId, runId, "approval.partial_fallback", { reason: "过滤后校验存在阻断问题,回退全量提交" });
        } else {
          finalOps = filtered;
        }
      }
    }

    // ⑫ committing(经 commit_ops 工具:仅 orchestrator 角色,transaction 副作用 + 审计)
    RunManager.toStatus(runId, "committing");
    if (planTaskList.length) {
      planTaskList = markTask(planTaskList, PIPELINE_TASK_TITLES.commit, "running");
      RunManager.emit(runId, { type: "run.plan", runId, tasks: planTaskList });
    }
    const result = await withStepCard(runId, "commit", "提交变更", () =>
      withSpan(
        "command.commit",
        { runId, projectId: request.projectId, baseRevision: request.baseRevision, opCount: finalOps.length },
        async () =>
          tools.runTyped<ReturnType<typeof commitRunChanges>>("commit_ops", toolCtx, {
            projectId: request.projectId,
            baseRevision: request.baseRevision,
            ops: finalOps,
            scope: request.scope,
            provenance: {
              actorType: "agent",
              actorId: "harness-agent",
              runId,
              promptVersion: "agent-v1",
              model: llmCfg.model,
            },
            boards: boards.map((b) => ({ tempKey: b.tempKey, title: b.title, posX: b.posX, posY: b.posY })),
            frames: framesSpec,
          }),
      ),
      (r) => ({
        outputSummary: `Revision ${r.revision} · 新增 ${r.counts.added} / 更新 ${r.counts.updated} / 删除 ${r.counts.deleted} / 移动 ${r.counts.moved}`,
      }),
    );
    RunManager.setFinalRevision(runId, result.revision);
    markProposalStatus(proposalId, "committed");
    saveDecision(runId, proposalId, "整体设计方案", plan?.rationale || briefFinal.objective, plan?.rationale ?? "", briefFinal.confidence);
    // 逐节点变更(供画布定位/高亮)
    const changesMap = new Map<string, { added: string[]; updated: string[]; removed: string[] }>();
    const touch = (sid: string) => {
      let c = changesMap.get(sid);
      if (!c) {
        c = { added: [], updated: [], removed: [] };
        changesMap.set(sid, c);
      }
      return c;
    };
    for (const ns of newSurfaces) touch(ns.id).added.push(ns.root);
    for (const op of finalOps) {
      const sid = "surfaceId" in op ? (op as { surfaceId?: string }).surfaceId : undefined;
      if (!sid) continue;
      if (op.op === "addNode") touch(sid).added.push(op.id);
      else if (op.op === "removeNode") touch(sid).removed.push(op.id);
      else if (op.op === "replaceProps") touch(sid).updated.push(op.id);
    }
    RunManager.emit(runId, {
      type: "design.ops_committed",
      runId,
      revision: result.revision,
      batchId: result.batchId,
      summary: `新增 ${result.counts.added} / 更新 ${result.counts.updated} / 删除 ${result.counts.deleted} / 移动 ${result.counts.moved}`,
      changes: [...changesMap].map(([surfaceId, c]) => ({ surfaceId, ...c })),
    });
    // §14.3 任务状态同步:提交完成
    if (planTaskList.length) {
      planTaskList = markTask(planTaskList, PIPELINE_TASK_TITLES.commit, "completed");
      RunManager.emit(runId, { type: "run.plan", runId, tasks: planTaskList });
    }

    // ⑬ explanation
    RunManager.toStatus(runId, "completed");
    const explanation = await withStepCard(runId, "explanation", "生成说明", () =>
      runExplanationSafe(
        provider,
        `${buildSurfaceSummary(finalOps, newSurfaces)}\n已提交 Revision ${result.revision}。Brief:${JSON.stringify({ objective: briefFinal.objective, rationale: plan?.rationale })}`,
        request.baseRevision,
      ),
      (md) => ({ outputSummary: `说明文本 ${md.length} 字,已在「对话」展示` }),
    );
    RunManager.emit(runId, {
      type: "design.explanation",
      runId,
      markdown: explanation,
      changeSummary: {
        ...result.counts,
        affectedSurfaces: [...new Set(newSurfaces.map((s) => s.id))],
        designRationale: plan?.rationale ?? "",
        tradeoffs: [],
        nextSuggestions: report?.recommendations ?? [],
      },
    });
    RunManager.finish(runId);
    saveAudit("agent", "harness-agent", request.projectId, runId, "run.completed", { revision: RunManager.status(runId) === "completed" });
    runSpan.end("ok"); // M6-3:总 span 闭合
    persistAssistantMessage(request, explanation, runId, startedAt);
  } catch (e) {
    const err = e as Error;
    // 取消判定:显式 RunCancelledError 之外,LLM 流被 cancel abort 打断时抛的是
    // AbortError(非 RunCancelledError),若不识别会误入 failed 分支把 DB 终态覆盖为 failed
    const status = RunManager.status(runId);
    const cancelled = err instanceof RunCancelledError || status === "cancelling" || status === "cancelled";
    if (cancelled) {
      RunManager.emit(runId, { type: "run.cancelled", runId });
      RunManager.finish(runId, "cancelled"); // 显式终态,防内存态覆盖
      runSpan.end("ok"); // 用户主动取消,非错误
      return;
    }
    const db = getDb();
    db.update(runs)
      .set({ status: "failed", error: err.message.slice(0, 500), durationMs: Date.now() - startedAt })
      .where(eq(runs.runId, runId))
      .run();
    RunManager.emit(runId, {
      type: "run.failed",
      runId,
      message: err.message.slice(0, 300),
      // M6-2:预算超限不可重试,需用户调整预算/范围后重新发起
      retryable: !(err instanceof BudgetExceededError),
    });
    // M6 站内告警:Run 失败(§17 规则评估点)
    recordAlert({
      projectId: request.projectId,
      level: "error",
      rule: "run.failed",
      message: `Run ${runId} 失败(${request.mode}):${err.message.slice(0, 200)}`,
      meta: { runId, mode: request.mode, retryable: !(err instanceof BudgetExceededError) },
    });
    saveAudit("agent", "harness-agent", request.projectId, runId, "run.failed", { error: err.message.slice(0, 200) });
    // 显式落定 failed:早期失败(如 buildContext 抛错)时内存态仍是 queued,finish 不带终态会把 DB 的 failed 覆盖回 queued
    RunManager.finish(runId, "failed");
    runSpan.end("error", err.message); // M6-3:总 span 以错误闭合
  }
}

// ---------------------------------------------------------------------------
// 生成层:复用既有 surface/ops 提示词与解析器
// ---------------------------------------------------------------------------

interface GenerateOptions {
  plan?: DesignPlan;
  style?: StyleDirection;
  /** 风格求解后的主题(令牌 + 视觉语言):生成、预览、提交共用同一份,避免"提示词说暗色、画布还是白底" */
  theme?: { tokens: ThemeTokens; visual: ThemeVisual };
  skillContext?: string;
  brief?: DesignBrief;
  repairHint?: string;
}

interface GenerateOut {
  kind: "create" | "edit";
  /** create:完整 SurfaceDoc(s) */
  docs?: SurfaceDoc[];
  /** edit:SurfaceOp[](缺 surfaceId,由 assembleOps 注入) */
  rawOps?: { op: string; [k: string]: unknown }[];
  targetPageId?: string;
  targetSurfaceId?: string;
}

/** generate/repair 产物摘要(create 列页面标题;edit 列操作数),供过程卡展开展示 */
function describeGenerateOut(out: GenerateOut): Partial<ToolCard> {
  if (out.kind === "edit") {
    return { outputSummary: `对目标画框应用 ${(out.rawOps ?? []).length} 个变更操作` };
  }
  const titles = (out.docs ?? []).map((d) => d.page.title).join("、");
  return { outputSummary: `${out.docs?.length ?? 0} 个页面:${titles}`.slice(0, 200) };
}

function llmConfigOf(request: AgentRunRequest): Omit<KimiConfig, "signal"> & { profileModels?: Partial<Record<"planning" | "generation" | "review" | "repair" | "explanation", string>> } | null {
  const cfg = (request as AgentRunRequest & {
    __llm?: {
      apiKey: string | null;
      baseUrl: string;
      model: string;
      maxTokens?: number;
      profileModels?: Partial<Record<"planning" | "generation" | "review" | "repair" | "explanation", string>>;
    };
  }).__llm;
  if (!cfg?.apiKey) return null;
  return {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    maxTokens: cfg.maxTokens ?? env.llmMaxTokens,
    profileModels: cfg.profileModels,
  };
}

async function generate(
  runId: string,
  context: AgentContext,
  provider: LLMProvider,
  llmCfg: Omit<KimiConfig, "signal">,
  opts: GenerateOptions,
): Promise<GenerateOut> {
  const { request } = context;
  const historyBlock = buildHistoryBlock(context.history);
  // 块名带「单页参考」语义:多页拆分后此块会进入 sitemap 与逐页 prompt,
  // 必须声明它是单页(参考页)的内部分区,防止站点页面清单被首页 IA 收敛/带偏
  const planBlock = opts.plan
    ? `\n[设计规划·单页信息架构参考]\n信息架构:${opts.plan.informationArchitecture.map((s) => `${s.title}(${s.purpose})`).join(" → ")}\n布局:${opts.plan.layout.pattern};密度:${opts.plan.layout.density}\n${
        opts.plan.artDirection?.mood
          ? `艺术方向:${opts.plan.artDirection.mood};首屏原型 ${opts.plan.artDirection.heroArchetype};节奏 ${opts.plan.artDirection.sectionRhythm};字体 ${opts.plan.artDirection.typographyScale};色彩 ${opts.plan.artDirection.colorFocus};图像 ${opts.plan.artDirection.imageStrategy}\n`
          : ""
      }设计理由:${opts.plan.rationale}`
    : "";
  const styleBlock = opts.style
    ? `\n${styleDirectiveText(opts.style, opts.theme ?? { tokens: context.doc.theme.tokens, visual: context.doc.theme.visual })}`
    : "";
  const skillBlock = opts.skillContext ? `\n[启用的设计 Skill]\n${opts.skillContext}` : "";
  const assumptionBlock = opts.brief?.assumptions.length ? `\n[设计假设]\n${opts.brief.assumptions.map((a) => `- ${a}`).join("\n")}` : "";
  const repairBlock = opts.repairHint ? `\n[修复要求]\n${opts.repairHint}` : "";

  // 局部修改路径:有选中元素/指定 target surface → ops
  const db = getDb();
  const targetSurfaceId = context.scopeSurfaces[0]?.surfaceId;
  const editIntent = request.mode === "refine_selection" || request.mode === "repair_design" || request.mode === "interaction_design";
  // 缺陷 #13:编辑类模式拿不到目标 surface 时,此前静默降级为整页重建(addFrame),
  // 无视用户「不要新建页面」约束且成本放大;改为显式失败,提示先在画布选中目标
  if (editIntent && !targetSurfaceId) {
    throw new Error("Refine/Repair 类模式需要先在画布选中目标页面或元素:当前 scope 未命中任何 surface,请重新选择后再发送");
  }
  if ((editIntent || (request.scope.nodeIds?.length ?? 0) > 0) && targetSurfaceId) {
    const frameRow = db.select().from(frames).where(eq(frames.surfaceId, targetSurfaceId)).limit(1).get();
    const surface = context.doc.surfaces[targetSurfaceId];
    if (!surface) throw new Error("目标 surface 不存在");
    const nodeIds = context.scopeSurfaces[0]?.nodeIds ?? [];
    const contextNodes: Record<string, unknown> = {};
    if (nodeIds.length) {
      const collect = (id: string, depth: number) => {
        const n = surface.components[id];
        if (!n || depth > 2) return;
        contextNodes[id] = n;
        n.children.forEach((c) => collect(c, depth + 1));
      };
      nodeIds.forEach((id) => collect(id, 0));
    } else {
      Object.assign(contextNodes, surface.components);
    }
    const userMsg = [
      buildOpsUserMessage({
        tokens: opts.theme?.tokens ?? context.doc.theme.tokens,
        contextNodes,
        selectedDesc: buildSelectedDesc(nodeIds, (a) => surface.components[a]?.type),
        instruction: `${request.userMessage}${planBlock}${styleBlock}${skillBlock}${assumptionBlock}${repairBlock}`,
        history: historyBlock,
      }),
    ].join("\n");
    // edit 就地流式预览:节流回传累积串 → 半截 ops 容错应用到目标画框(不落库)
    const previewSurface = {
      ...(surface as unknown as SurfaceDoc),
      theme: {
        preset: context.doc.theme.preset,
        tokens: opts.theme?.tokens ?? context.doc.theme.tokens,
        visual: opts.theme?.visual ?? context.doc.theme.visual,
      },
    };
    const opsState = createPreviewDeltaState();
    const opsThrottle = createPreviewThrottle(
      (acc) => emitOpsPreview(runId, acc, previewSurface, targetSurfaceId, frameRow?.id ?? 0, opsState),
    );
    // §18.4:edit 路径直调 kimiGenerateOps(不经 LLMProvider),单独计入调用数
    consumeToolCall(runId, context.request.constraints.maxToolCalls);
    const ops = await kimiGenerateOps(
      { ...llmCfg, signal: RunManager.context(runId)?.abort.signal },
      userMsg,
      previewSurface,
      nodeIds,
      undefined,
      historyBlock,
      undefined,
      (acc) => opsThrottle.push(acc),
    );
    opsThrottle.flush();
    return { kind: "edit", rawOps: ops as unknown as { op: string }[], targetPageId: String(frameRow?.pageBoardId ?? ""), targetSurfaceId };
  }

  // create / redesign 路径
  const device = request.constraints.targetPlatforms[0] === "mobile" ? "mobile" : "desktop";
  const requirement = `${request.userMessage}${planBlock}${styleBlock}${skillBlock}${assumptionBlock}${repairBlock}`;
  // 预览主题:与最终提交保持同一份令牌,否则生成过程看到的是白底/默认令牌,提交后才变色
  const previewTheme = {
    preset: context.doc.theme.preset,
    tokens: opts.theme?.tokens ?? context.doc.theme.tokens,
    visual: opts.theme?.visual ?? context.doc.theme.visual,
  };

  // redesign:单页整页重生成(保留页面 id),流式渐进预览
  if (request.mode === "redesign_frame") {
    const userPrompt = buildRedesignUserPrompt(context.scopeSurfaces[0]?.surfaceId ?? "页面", requirement, device, historyBlock);
    const previewState = createPreviewDeltaState();
    const createThrottle = createPreviewThrottle((acc) => emitPreview(runId, acc, previewState, 0, previewTheme));
    const textThrottle = createTextStreamThrottle((delta) =>
      RunManager.emit(runId, { type: "run.streamText", runId, text: delta }, { persist: false }),
    );
    const raw = await provider.stream(
      { system: OPS_SYSTEM_PROMPT, user: userPrompt, profile: "generation" },
      (acc) => {
        createThrottle.push(acc);
        textThrottle.push(acc);
      },
      (usage) => RunManager.recordUsage(runId, usage, llmCfg.model),
    );
    createThrottle.flush(); // 尾帧:保证流结束后的完整预览
    textThrottle.flush();
    const { docs, error } = tryParseSurfaces(raw);
    if (!docs?.length) throw new Error(`页面生成失败:${error ?? "输出未通过校验"}`);
    return { kind: "create", docs };
  }

  // create:两段式站点生成(sitemap 契约,文档 §两段式)。
  // 动机:整站长 JSON(5 页 2000+ 节点)下模型引用一致性差,实测 5 轮 3 轮死于引用悬空;
  // 拆分后 sitemap 是 ≤6 页的小 JSON,每页独立生成输出短、components 自包含度高,
  // 且解析失败仅重试当前页,不再全盘报废。
  // 阶段 1:sitemap 规划(非流式;complete 自带预算放大重试;解析失败带错误回灌一轮)
  // 进度卡:complete 无流式输出,发卡让用户看到阶段推进
  const sitemapCardId = `card_${runId}_sitemap`;
  const sitemapStart = Date.now();
  RunManager.emit(runId, { type: "run.step", runId, card: { cardId: sitemapCardId, tool: "generate", title: "站点结构规划", status: "running" } });
  const sitemapReq: LlmRequest = {
    system: SITEMAP_SYSTEM_PROMPT,
    user: buildSitemapUserPrompt(requirement, device, historyBlock),
    profile: "planning",
  };
  let sitemap: Sitemap | null = null;
  let sitemapRaw = "";
  let sitemapError = "";
  for (let attempt = 0; attempt < 2 && !sitemap; attempt++) {
    sitemapRaw =
      attempt === 0
        ? await provider.complete(sitemapReq, (u) => RunManager.recordUsage(runId, u, llmCfg.model))
        : await provider.complete(
            {
              ...sitemapReq,
              history: [
                { role: "user", content: sitemapReq.user },
                { role: "assistant", content: sitemapRaw },
                { role: "user", content: `输出未通过校验:${sitemapError}。请只输出修正后的完整 JSON。` },
              ],
            },
            (u) => RunManager.recordUsage(runId, u, llmCfg.model),
          );
    const parsed = sitemapSchema.safeParse(parseJsonLoose(sitemapRaw));
    if (parsed.success) {
      sitemap = parsed.data;
    } else {
      sitemapError = parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ").slice(0, 300);
    }
  }
  if (!sitemap) {
    RunManager.emit(runId, { type: "run.step", runId, card: { cardId: sitemapCardId, tool: "generate", title: "站点结构规划", status: "error" } });
    throw new Error(`站点结构规划失败:${sitemapError || "输出未通过校验"}`);
  }
  RunManager.emit(runId, { type: "run.step", runId, card: { cardId: sitemapCardId, tool: "generate", title: "站点结构规划", status: "done", durationMs: Date.now() - sitemapStart, outputSummary: `${sitemap.pages.length} 个页面 · 导航 ${sitemap.nav.join(" / ").slice(0, 80)}` } });

  // 骨架幻影帧:站点结构一出即把「共 N 页」的空画框推上画布,消除 sitemap→首页首个组件闭合之间的
  // 预览死区(此前逐页首个组件闭合前画布全黑,用户误以为「不联动/无流式」)。surfaceId 与后续
  // 真实内容帧一致(preview_i),真实组件到达时原位升级(见 runStore design.preview 分支)。
  emitSkeletonPages(runId, sitemap.pages.map((p) => p.title), device, previewTheme);

  // 阶段 2:逐页流式生成(单页文档;tryParseSurfaces 兼容单页分支;解析失败仅重试当前页一次)
  const docs: SurfaceDoc[] = [];
  const pageCount = sitemap.pages.length;
  const navText = sitemap.nav.join(" / ");
  // 打字机跨页连续;预览差分按页重置(各页组件 id 空间独立,页边界必须清差分)
  const textThrottle = createTextStreamThrottle((delta) =>
    RunManager.emit(runId, { type: "run.streamText", runId, text: delta }, { persist: false }),
  );
  for (let i = 0; i < pageCount; i++) {
    const page = sitemap.pages[i];
    const pageReq: LlmRequest = {
      system: SURFACE_SYSTEM_PROMPT,
      user: buildPageFromSitemapUserPrompt({
        requirement,
        sitemap: JSON.stringify(sitemap),
        pageCount,
        index: i + 1,
        pageTitle: page.title,
        pagePurpose: page.purpose,
        device,
        nav: navText,
        history: historyBlock,
      }),
      profile: "generation",
    };
    const previewState = createPreviewDeltaState();
    // 传全局页序号:预览 surfaceId 跨页唯一,前端多页 ghost 并排(否则全部堆在 preview_0 互相覆盖)
    const createThrottle = createPreviewThrottle((acc) => emitPreview(runId, acc, previewState, i, previewTheme));
    // 逐页进度卡:每页一张,前端过程 Tab 可见推进(此前 5 页一卡到底,20 分钟无反馈)
    const pageCardId = `card_${runId}_page${i}`;
    const pageStart = Date.now();
    const pageTitle = `第 ${i + 1}/${pageCount} 页:${page.title}`;
    RunManager.emit(runId, { type: "run.step", runId, card: { cardId: pageCardId, tool: "generate", title: pageTitle, status: "running" } });
    const streamPage = (extraHistory?: LlmRequest["history"]) =>
      provider.stream(
        extraHistory ? { ...pageReq, history: extraHistory } : pageReq,
        (acc) => {
          createThrottle.push(acc);
          textThrottle.push(acc);
        },
        (usage) => RunManager.recordUsage(runId, usage, llmCfg.model),
      );
    let raw = await streamPage();
    createThrottle.flush(); // 页尾帧
    let parsed = tryParseSurfaces(raw);
    if (!parsed.docs?.length) {
      // 按页回灌重试一次:错误消息含字段级 path 与合法值列表,是最有效的修复指令
      raw = await streamPage([
        { role: "user", content: pageReq.user },
        { role: "assistant", content: raw },
        { role: "user", content: surfaceRepairMessage(parsed.error ?? "输出未通过校验") },
      ]);
      createThrottle.flush();
      parsed = tryParseSurfaces(raw);
      if (!parsed.docs?.length) {
        textThrottle.flush();
        RunManager.emit(runId, { type: "run.step", runId, card: { cardId: pageCardId, tool: "generate", title: pageTitle, status: "error" } });
        // 前缀区别于单页路径的「页面生成失败:」:页粒度已重试过,外层整体重跑(全站再来一遍)性价比极低,不再触发
        throw new Error(`站点页面生成失败:第 ${i + 1} 页「${page.title}」:${parsed.error ?? "输出未通过校验"}`);
      }
    }
    RunManager.emit(runId, { type: "run.step", runId, card: { cardId: pageCardId, tool: "generate", title: pageTitle, status: "done", durationMs: Date.now() - pageStart, outputSummary: `组件 ${parsed.docs.reduce((n, d) => n + Object.keys(d.components).length, 0)} 个` } });
    docs.push(...parsed.docs);
  }
  textThrottle.flush();
  return { kind: "create", docs };
}

/** 宽松 JSON 提取(sitemap 等小 JSON):剥离 markdown 代码块与首尾杂讯后解析;
 * 首尾切片不可解析时退回首个平衡对象(容忍 JSON 后尾随杂讯/重复输出的第二段对象) */
function parseJsonLoose(raw: string): unknown {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(raw.slice(s, e + 1));
  } catch {
    const first = extractFirstJsonObject(raw);
    if (!first) return null;
    try {
      return JSON.parse(first);
    } catch {
      return null;
    }
  }
}

/**
 * 生成 + 解析失败回灌重试(§13.2 修复思想前移到解析层):
 * LLM 输出的页面 JSON 未过 schema(非法组件 type/引用悬空等)时,解析器的字段级错误
 * 消息(含出错 path 与合法值列表)恰好是最有效的修复指令,回灌重生成一次;
 * 仅解析类错误重试,HTTP/预算/取消等错误原样上抛。外层 withStepCard 卡片保持 running,
 * 重试成功即 done,避免出现中间错误卡。
 */
async function generateWithParseRetry(
  runId: string,
  context: AgentContext,
  provider: LLMProvider,
  llmCfg: Omit<KimiConfig, "signal">,
  opts: GenerateOptions,
): Promise<GenerateOut> {
  try {
    return await generate(runId, context, provider, llmCfg, opts);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!msg.startsWith("页面生成失败:")) throw e;
    const detail = msg.replace(/^页面生成失败:/, "").slice(0, 600);
    return generate(runId, context, provider, llmCfg, {
      ...opts,
      // 除错误清单外给出行动规则:实测 v4-flash 仅看到错误清单仍会重复"引用未定义组件"
      repairHint: `${opts.repairHint ? `${opts.repairHint}\n` : ""}上一轮输出未通过页面 schema 校验,以下错误必须逐条修正:\n- ${detail}\n规则:每个页面的 components 必须包含该页 children 引用的全部组件定义;禁止引用其他页面、其他章节或未定义的组件 ID。`,
    });
  }
}

/** 流式预览增量状态:记录每 surface 上一帧已发送的组件,供 delta 差分 */
interface PreviewDeltaState {
  sent: Map<string, Record<string, unknown>>;
}

function createPreviewDeltaState(): PreviewDeltaState {
  return { sent: new Map() };
}

/**
 * 流式渐进预览:半截 JSON → 已闭合组件 → design.preview 事件(不落库,仅推送)。
 * M7 增量化:与上一帧差分,只携带新增/变化的组件(upserts),元信息进 meta;
 * 前端以 mergePreviewDelta 累积还原完整文档。
 * pageOffset:逐页生成时传当前页的全局序号——预览 surfaceId 必须跨页唯一,
 * 否则每页都发 preview_0,前端 ghost/previewDocs 逐页互相覆盖(实测:多页生成只见单页闪现)
 */
function emitPreview(
  runId: string,
  acc: string,
  state: PreviewDeltaState,
  pageOffset = 0,
  themeOverride?: { preset?: SurfaceDoc["theme"]["preset"]; tokens: ThemeTokens; visual: ThemeVisual },
): void {
  try {
    const pages = parsePartialPages(acc, { preset: "shadcn", device: "desktop" });
    for (let i = 0; i < pages.length; i++) {
      const doc = pages[i];
      if (!doc) continue;
      const sid = `preview_${pageOffset + i}`;
      const prev = state.sent.get(sid) ?? {};
      const upserts: Record<string, unknown> = {};
      let changed = false;
      for (const [aid, node] of Object.entries(doc.components)) {
        if (JSON.stringify(prev[aid]) !== JSON.stringify(node)) {
          upserts[aid] = node;
          changed = true;
        }
      }
      if (!changed) continue;
      state.sent.set(sid, doc.components);
      RunManager.emit(
        runId,
        {
          type: "design.preview",
          runId,
          surfaceId: sid,
          message: {
            kind: "updateComponents", surfaceId: sid, batchEnd: false, delta: true, upserts,
            meta: { root: doc.root, title: doc.page.title, device: doc.page.device, theme: themeOverride ?? doc.theme },
          } as unknown as Record<string, unknown>,
        },
        { persist: false },
      );
    }
  } catch {
    /* 半截 JSON 解析失败忽略 */
  }
}

/**
 * 骨架幻影帧:站点结构规划一出,把每个页面的空画框(仅标题/设备/主题)推上画布,
 * 消除 sitemap→首页首个组件闭合之间的预览死区。meta.skeleton=true 让前端保留空组件 ghost;
 * surfaceId 与后续真实内容帧(preview_i)一致,真实组件到达时原位升级(前端 mergePreviewDelta)。
 */
function emitSkeletonPages(
  runId: string,
  titles: string[],
  device: string,
  theme: { preset?: SurfaceDoc["theme"]["preset"]; tokens: ThemeTokens; visual: ThemeVisual },
): void {
  for (let i = 0; i < titles.length; i++) {
    const sid = `preview_${i}`;
    RunManager.emit(
      runId,
      {
        type: "design.preview",
        runId,
        surfaceId: sid,
        message: {
          kind: "updateComponents",
          surfaceId: sid,
          batchEnd: false,
          delta: true,
          upserts: {},
          meta: { skeleton: true, title: titles[i] || "生成中…", device, theme },
        } as unknown as Record<string, unknown>,
      },
      { persist: false },
    );
  }
}

/**
 * 流式预览节流器:LLM 每 token 触发一次全量解析与推送,数千 token 会造成
 * O(n²) 扫描与写放大;按 minIntervalMs 节流,flush() 保证流结束后的尾帧完整。
 */
export function createPreviewThrottle(emitFn: (acc: string) => void, minIntervalMs = 150) {
  let lastEmitted = 0;
  let pendingAcc: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = (acc: string) => {
    lastEmitted = Date.now();
    emitFn(acc);
  };
  return {
    push(acc: string) {
      pendingAcc = acc;
      if (timer) return;
      const wait = Math.max(0, minIntervalMs - (Date.now() - lastEmitted));
      timer = setTimeout(() => {
        timer = null;
        if (pendingAcc != null) emit(pendingAcc);
      }, wait);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pendingAcc != null) emit(pendingAcc);
      pendingAcc = null;
    },
  };
}

/**
 * 原始输出打字机节流器(M7):按"≥minChars 字符 或 minIntervalMs"批量发增量文本,
 * 兼顾实时感与事件频率;flush() 补发剩余尾部。
 */
export function createTextStreamThrottle(emitFn: (delta: string) => void, minChars = 24, minIntervalMs = 180) {
  let sent = 0;
  let latest = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushDelta = () => {
    timer = null;
    const delta = latest.slice(sent);
    if (delta) {
      sent = latest.length;
      emitFn(delta);
    }
  };
  return {
    push(acc: string) {
      latest = acc;
      if (acc.length - sent >= minChars) {
        // 达到字符阈值:立即发增量(并取消未触发的兜底定时器)
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flushDelta();
        return;
      }
      if (!timer) timer = setTimeout(flushDelta, minIntervalMs);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const delta = latest.slice(sent);
      if (delta) {
        sent = latest.length;
        emitFn(delta);
      }
    },
  };
}

/** edit(ops)流式预览:半截 ops 逐个容错应用到当前 surface → 就地渐进预览(不落库)。
 *  M7 增量化:与上一帧差分,只携带新增/变化的组件(upserts)+ meta(root/theme 沿用 base)。 */
function emitOpsPreview(
  runId: string,
  acc: string,
  baseSurface: SurfaceDoc,
  targetSurfaceId: string,
  targetPageId: number,
  state: PreviewDeltaState,
): void {
  try {
    const closedOps = parsePartialOps(acc) as unknown as SurfaceOp[];
    if (!closedOps.length) return;
    let surface = baseSurface;
    for (const op of closedOps) {
      try {
        surface = applyOps(surface, [op]);
      } catch {
        /* 半截/不完整 op:预览阶段跳过,最终结果仍走完整校验 */
      }
    }
    const prev = state.sent.get(targetSurfaceId) ?? {};
    const upserts: Record<string, unknown> = {};
    let changed = false;
    for (const [aid, node] of Object.entries(surface.components)) {
      if (JSON.stringify(prev[aid]) !== JSON.stringify(node)) {
        upserts[aid] = node;
        changed = true;
      }
    }
    if (!changed) return;
    state.sent.set(targetSurfaceId, surface.components);
    RunManager.emit(
      runId,
      {
        type: "design.preview",
        runId,
        surfaceId: targetSurfaceId,
        message: {
          kind: "updateComponents", surfaceId: targetSurfaceId, delta: true, upserts,
          targetPageId, meta: { root: surface.root, title: surface.page.title },
        } as unknown as Record<string, unknown>,
      },
      { persist: false },
    );
  } catch {
    /* 预览失败忽略,不影响主流程 */
  }
}

// ---------------------------------------------------------------------------
// Ops 装配
// ---------------------------------------------------------------------------

interface BoardSpec {
  tempKey: string;
  title: string;
  posX: number;
  posY: number;
}

function assembleOps(
  context: AgentContext,
  out: GenerateOut,
  theme?: { tokens: ThemeTokens; visual: ThemeVisual },
): { ops: IROperation[]; boards: BoardSpec[]; framesSpec: { tempKey: string; boardTempKey: string; surfaceId: string; title: string; device: string; width: number; height: number; posX: number; posY: number }[]; newSurfaces: IRSurface[] } {
  const ops: IROperation[] = [];
  const boards: BoardSpec[] = [];
  const framesSpec: { tempKey: string; boardTempKey: string; surfaceId: string; title: string; device: string; width: number; height: number; posX: number; posY: number }[] = [];
  const newSurfaces: IRSurface[] = [];

  /** 主题变更前置:同批 ops 内的新增页面与令牌一起提交,保证渲染与画布一致 */
  const prependThemeOp = () => {
    if (!theme) return;
    const changed =
      JSON.stringify(theme.tokens) !== JSON.stringify(context.doc.theme.tokens) ||
      JSON.stringify(theme.visual) !== JSON.stringify(context.doc.theme.visual);
    if (!changed) return;
    ops.unshift({ op: "setTokens", tokens: theme.tokens, visual: theme.visual } as IROperation);
  };

  if (out.kind === "edit") {
    for (const raw of out.rawOps ?? []) {
      ops.push({ ...raw, surfaceId: out.targetSurfaceId ?? "" } as unknown as IROperation);
    }
    prependThemeOp();
    return { ops, boards, framesSpec, newSurfaces };
  }

  // create:每个 SurfaceDoc → PageBoard + Frame + surface(自动网格排布)
  const existingBoards = context.request.projectId; // 占位;排布基于现有 board 数量
  void existingBoards;
  let col = 0;
  for (const surfaceDoc of out.docs ?? []) {
    // 唯一性消歧:LLM 的 page.id 可能与现有/同批 surface 撞名(多次 run 均输出 "page" 时都映射 frame_page),
    // addFrame 同名会在 applyIRops 直接覆盖既有页面 IR(数据丢失),此处递增后缀强制唯一。
    const taken = new Set([...Object.keys(context.doc.surfaces), ...newSurfaces.map((s) => s.id)]);
    const wanted = `frame_${surfaceDoc.page.id || `gen_${Date.now().toString(36)}_${col}`}`;
    let surfaceId = wanted;
    if (taken.has(surfaceId)) {
      let i = 2;
      while (taken.has(`${surfaceId}_${i}`)) i++;
      surfaceId = `${surfaceId}_${i}`;
    }
    const surface: IRSurface = {
      id: surfaceId,
      title: surfaceDoc.page.title,
      root: surfaceDoc.root,
      components: surfaceDoc.components,
    };
    newSurfaces.push(surface);
    const dev = surfaceDoc.page.device as DeviceId;
    const devDef = DEVICES[dev] ?? DEVICES.desktop;
    const tempKey = `board_${surfaceId}`;
    boards.push({ tempKey, title: surfaceDoc.page.title, posX: col * 520, posY: 0 });
    framesSpec.push({
      tempKey: `frame_${surfaceId}`,
      boardTempKey: tempKey,
      surfaceId,
      title: surfaceDoc.page.title,
      device: dev,
      width: devDef.width,
      height: devDef.height,
      posX: 0,
      posY: 0,
    });
    ops.push({
      op: "addFrame",
      frame: {
        id: 0,
        pageId: 0,
        surfaceId,
        title: surfaceDoc.page.title,
        device: dev,
        width: devDef.width,
        height: devDef.height,
        posX: 0,
        posY: 0,
      } as Frame,
      surface,
    });
    col++;
  }
  // 风格令牌覆盖
  if (context.request.stylePreference) {
    // 由 style 解释器产出的 tokens 已并入 theme;此处保留 setTokens 语义给纯令牌偏好
  }
  prependThemeOp();
  return { ops, boards, framesSpec, newSurfaces };
}

function buildSurfaceSummary(ops: IROperation[], newSurfaces: IRSurface[]): string {
  const parts: string[] = [];
  for (const s of newSurfaces) {
    const lines: string[] = [`surface ${s.id}(root=${s.root},组件 ${Object.keys(s.components).length} 个)`];
    const walk = (id: string, depth: number) => {
      const n = s.components[id];
      if (!n || depth > 4) return;
      const text = (n.props?.text ?? n.props?.label ?? "") as string;
      lines.push(`${"  ".repeat(depth)}- ${n.type}#${id}${text ? ` "${String(text).slice(0, 30)}"` : ""}`);
      n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(s.root, 1);
    parts.push(lines.join("\n"));
  }
  for (const op of ops.slice(0, 40)) {
    if (op.op === "replaceProps") parts.push(`修改 ${op.surfaceId}/${op.id}: ${JSON.stringify(op.props).slice(0, 100)}`);
    else if (op.op === "addNode") parts.push(`新增 ${op.node.type}#${op.id} → ${op.parentId}`);
    else if (op.op === "removeNode") parts.push(`删除 ${op.id}`);
    else if (op.op === "moveNode") parts.push(`移动 ${op.id} → ${op.newParentId}`);
  }
  return parts.join("\n");
}

async function runExplanationSafe(provider: LLMProvider, summary: string, revision: number): Promise<string> {
  try {
    return await runExplanation(provider, `${summary}\n(baseRevision=${revision})`);
  } catch {
    return "已完成本次设计任务。";
  }
}

function persistAssistantMessage(request: AgentRunRequest, content: string, runId: string, startedAt: number): void {
  const db = getDb();
  db.insert(messages)
    .values({
      conversationId: request.conversationId,
      role: "assistant",
      content,
      meta: JSON.stringify({ runId, durationMs: Date.now() - startedAt }),
    })
    .run();
}

export type { AgentEvent };
