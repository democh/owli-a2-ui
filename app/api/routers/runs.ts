import { z } from "zod";
import { authedQuery, createRouter } from "../middleware";
import { agentRunRequestSchema, approvalAcceptSchema, planTaskStatusSchema, type PlanTask } from "@contracts/agent";
import { clarificationResponseSchema } from "@contracts/clarification";
import { RunManager } from "../agent/run/RunManager";
import { executeRun } from "../agent/orchestrator/DesignHarnessAgent";
import { rollbackRun } from "../command/commandService";
import { requireProjectRole } from "../queries/projects";
import { recordAlert, evaluateBudgetThreshold } from "../observability/alerts";
import { getDb } from "../queries/connection";
import { conversations, messages, runs as runsTable, userSettings } from "@db/schema";
import { eq } from "drizzle-orm";
import { env } from "../lib/env";
import { assertRunStartable } from "../agent/runtime/BudgetManager";
import { TRPCError } from "@trpc/server";

/**
 * runs 路由:Agent Run 生命周期入口(文档 §8.1)
 * LLM 配置从用户设置读取(项目级默认 env 兜底),注入执行上下文(不落入请求 schema)。
 * RBAC:创建/取消/澄清/审批/回滚需 editor;列表与事件重放 viewer 可读。
 */

function resolveLlm(userId: number) {
  const db = getDb();
  const row = db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1).get();
  let profileModels: Record<string, string> = {};
  try {
    profileModels = JSON.parse(row?.profileModels ?? "{}") as Record<string, string>;
  } catch {
    /* 历史脏数据按未配置处理 */
  }
  // 配置一致性:Key 与 BaseURL/Model 必须同源。用户未填 Key 时整套回退 env,
  // 避免出现"env 的 Key + 用户设置的 BaseURL/Model"跨服务混搭(表现为 403 Key 无效)
  if (!row?.llmApiKey) {
    return {
      apiKey: env.kimiApiKey || null,
      baseUrl: env.kimiBaseUrl,
      model: env.kimiModel,
      maxTokens: env.llmMaxTokens,
      profileModels: {} as Record<string, string>, // 模型覆盖随用户配置,回退时一并丢弃
    };
  }
  return {
    apiKey: row.llmApiKey,
    baseUrl: row.llmBaseUrl || env.kimiBaseUrl,
    model: row.llmModel || env.kimiModel,
    maxTokens: env.llmMaxTokens,
    profileModels, // M7 多模型路由:按阶段覆盖模型
  };
}

/** 由 runId 解析 projectId(优先内存上下文,回退 DB);供无 projectId 入参的端点做 RBAC */
function projectOfRun(runId: string): number | null {
  const projectId = RunManager.request(runId)?.projectId;
  if (projectId != null) return projectId;
  const row = getDb().select({ projectId: runsTable.projectId }).from(runsTable).where(eq(runsTable.runId, runId)).limit(1).get();
  return row?.projectId ?? null;
}

/** Run 端点权限前置:解析 projectId → 校验角色;不存在的 run 一律 NOT_FOUND */
async function requireRunRole(userId: number, runId: string, minRole: "viewer" | "editor" = "editor") {
  const projectId = projectOfRun(runId);
  if (projectId == null) throw new TRPCError({ code: "NOT_FOUND", message: "Run 不存在" });
  await requireProjectRole(userId, projectId, minRole);
  return projectId;
}

export const runsRouter = createRouter({
  /** 创建 Run(幂等键防重)并立即异步启动编排 */
  create: authedQuery
    .input(agentRunRequestSchema)
    .mutation(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 才能发起设计变更
      // 会话归属校验(#15):跨项目的 conversationId 会产生 projectId 与会话错位的 Run 行,
      // 阻塞相关项目的删除且污染对话流;前端切项目时序漏洞由此紏底兜住
      const convRow = getDb()
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1)
        .get();
      if (!convRow) throw new TRPCError({ code: "NOT_FOUND", message: "会话不存在,请刷新页面后重试" });
      if (convRow.projectId !== input.projectId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "会话与项目不匹配,请刷新页面后重新发送" });
      }
      try {
        assertRunStartable(ctx.user.id); // M6-2:用户级成本预算,超限拒绝发起新 Run
      } catch (e) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: (e as Error).message });
      }
      const { runId, reused } = RunManager.create(input);
      if (!reused) {
        RunManager.attach(runId, input);
        // 注入 LLM 配置(私有字段,不进入契约)
        (RunManager.request(runId) as Record<string, unknown>).__llm = resolveLlm(ctx.user.id);
        // 用户消息持久化(对话流连续性)
        getDb()
          .insert(messages)
          .values({
            conversationId: input.conversationId,
            role: "user",
            content: input.userMessage,
            meta: JSON.stringify({ runId, chips: input.chips }),
          })
          .run();
        // 异步执行:SSE 端点通过事件订阅观察进度
        void executeRun(runId).catch(() => {});
        // M6 站内告警:预算阈值评估(≥80% 记 warning)
        evaluateBudgetThreshold(ctx.user.id, input.projectId);
      }
      return { runId };
    }),

  cancel: authedQuery
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId);
      RunManager.cancel(input.runId);
      return { ok: true };
    }),

  /** §14.3 暂停:执行流在下一个阶段边界挂起(可恢复) */
  pause: authedQuery
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId);
      const ok = RunManager.pause(input.runId);
      if (!ok) throw new TRPCError({ code: "CONFLICT", message: "该 Run 已结束,无法暂停" });
      return { ok: true };
    }),

  /** §14.3 恢复:唤醒暂停的执行流 */
  resume: authedQuery
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId);
      const ok = RunManager.resume(input.runId);
      if (!ok) throw new TRPCError({ code: "CONFLICT", message: "该 Run 不在暂停状态" });
      return { ok: true };
    }),

  /** §14.3 跳过任务:阶段边界消费;IA 任务跳过会注入生成上下文 */
  skipTask: authedQuery
    .input(z.object({ runId: z.string(), taskId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId);
      const ok = RunManager.skipTask(input.runId, input.taskId);
      if (!ok) throw new TRPCError({ code: "CONFLICT", message: "该 Run 已结束,无法跳过任务" });
      return { ok: true };
    }),

  /** 提交结构化澄清回答 → 恢复 Run */
  clarify: authedQuery
    .input(clarificationResponseSchema)
    .mutation(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId);
      const ok = RunManager.submitClarification(input.runId, input);
      if (!ok) throw new TRPCError({ code: "CONFLICT", message: "该 Run 不在等待澄清状态" });
      return { ok: true };
    }),

  approve: authedQuery
    .input(z.object({
      runId: z.string(),
      approved: z.boolean(),
      // §14.8 部分接受:按变更类别勾选(缺省=全部接受)
      accept: approvalAcceptSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId);
      const ok = RunManager.resolveApproval(input.runId, input.approved, input.accept);
      if (!ok) throw new TRPCError({ code: "CONFLICT", message: "该 Run 不在等待审批状态" });
      return { ok: true };
    }),

  /** §14.2/§14.3 Plan 确认:approved 可携带用户编辑/跳过后的任务清单(影响后续生成) */
  planApprove: authedQuery
    .input(
      z.object({
        runId: z.string(),
        approved: z.boolean(),
        tasks: z
          .array(
            z.object({
              taskId: z.string(),
              title: z.string().min(1).max(120),
              description: z.string().max(400).optional(),
              status: planTaskStatusSchema.default("pending"),
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId);
      const ok = RunManager.resolvePlanApproval(input.runId, input.approved, input.tasks as PlanTask[] | undefined);
      if (!ok) throw new TRPCError({ code: "CONFLICT", message: "该 Run 不在等待计划确认状态" });
      return { ok: true };
    }),

  list: authedQuery
    .input(z.object({ projectId: z.number(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读 Run 历史
      return RunManager.listProject(input.projectId, input.limit);
    }),

  /** 事件重放(断线恢复;实时流走 SSE /api/runs/:runId/stream) */
  events: authedQuery
    .input(z.object({ runId: z.string(), afterSeq: z.number().int().default(-1) }))
    .query(async ({ ctx, input }) => {
      await requireRunRole(ctx.user.id, input.runId, "viewer");
      const all = RunManager.replay(input.runId);
      return all.filter((e) => e.seq > input.afterSeq);
    }),

  rollback: authedQuery
    .input(z.object({ projectId: z.number(), runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 需确认 / owner 可回滚
      try {
        const result = rollbackRun(input.projectId, input.runId);
        // M6 站内告警:回滚事件(§17 规则评估点)
        recordAlert({
          projectId: input.projectId,
          level: "info",
          rule: "run.rollback",
          message: `Run ${input.runId} 的全部修改已被回滚(新 revision ${result.revision})`,
          meta: { runId: input.runId, revision: result.revision },
        });
        return result;
      } catch (e) {
        throw new TRPCError({ code: "CONFLICT", message: (e as Error).message });
      }
    }),
});
