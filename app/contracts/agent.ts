import { z } from "zod";
import { designScopeSchema, irOperationSchema, type DesignScope, type IROperation } from "./design-ir";
import { clarificationRequestSchema, type ClarificationRequest, type ClarificationResponse } from "./clarification";
import { styleDirectionSchema, type StyleDirection } from "./style";

/**
 * Agent Run 核心契约(文档 §6/§7/§8)
 *
 * Run 是一次 Agent 任务的完整执行过程:有状态机、事件、成本、结果。
 * LLM 只产 Proposal;Proposal 经 Validation Pipeline + 专家评审 + Commit Gate 后,
 * 由 Command Service 原子提交到 Design IR。
 */

// ---------------------------------------------------------------------------
// Run 模式与自治级别
// ---------------------------------------------------------------------------

export const agentRunModeSchema = z.enum([
  "create_page",
  "create_frame",
  "refine_selection",
  "redesign_frame",
  "review_only",
  "accessibility_audit",
  "repair_design",
  "data_model_design",
  "interaction_design",
  "export_prepare",
  // 前端工作台 §14.4:问答/仅规划模式(不产生 Proposal,不修改 IR)
  "ask",
  "plan_only",
]);
export type AgentRunMode = z.infer<typeof agentRunModeSchema>;

export const autonomyLevelSchema = z.enum(["suggest", "review", "guarded", "autopilot"]);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

/** §14.8 部分接受:审批时按变更类别勾选(缺省 = 全部接受) */
export const approvalAcceptSchema = z.object({
  added: z.boolean().default(true),
  updated: z.boolean().default(true),
  deleted: z.boolean().default(true),
});
export type ApprovalAccept = z.infer<typeof approvalAcceptSchema>;

// ---------------------------------------------------------------------------
// Run 状态机(文档 §6.1,17 态)
// ---------------------------------------------------------------------------

export const runStatusSchema = z.enum([
  "queued",
  "intake",
  "resolving_style",
  "selecting_skills",
  "planning_clarification",
  "awaiting_clarification",
  "planning",
  "generating",
  "parsing",
  "protocol_validating",
  "ux_reviewing",
  "repairing",
  "policy_checking",
  "awaiting_approval",
  "awaiting_plan_approval",
  "committing",
  "completed",
  "cancelling",
  "cancelled",
  "failed",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** 前端展示归类(状态颜色) */
export function statusGroup(s: RunStatus): "idle" | "running" | "waiting_user" | "success" | "failed" | "cancelled" {
  if (s === "completed") return "success";
  if (s === "failed") return "failed";
  if (s === "cancelled" || s === "cancelling") return "cancelled";
  if (s === "awaiting_clarification" || s === "awaiting_approval") return "waiting_user";
  if (s === "queued") return "idle";
  return "running";
}

// ---------------------------------------------------------------------------
// AgentRunRequest(文档 §8.1)
// ---------------------------------------------------------------------------

export const agentRunRequestSchema = z.object({
  projectId: z.number().int(),
  conversationId: z.number().int(),
  mode: agentRunModeSchema,
  userMessage: z.string().min(1).max(8000),
  scope: designScopeSchema.default({}),
  baseRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  autonomyLevel: autonomyLevelSchema.default("guarded"),
  stylePreference: z
    .object({
      mode: z.enum(["preset", "custom", "reference", "skill", "mixed", "auto"]).default("auto"),
      presetIds: z.array(z.string()).default([]),
      customDescription: z.string().optional(),
      referenceIds: z.array(z.string()).default([]),
      uiLibraryId: z.string().optional(),
    })
    .prefault({}),
  skillSelection: z
    .object({
      mode: z.enum(["auto", "manual", "disabled"]).default("auto"),
      skillIds: z.array(z.string()).default([]),
    })
    .prefault({}),
  clarificationPolicy: z
    .object({
      maxQuestions: z.number().int().min(0).max(5).default(3),
      allowSkip: z.boolean().default(true),
      useRecommendedDefaults: z.boolean().default(true),
    })
    .prefault({}),
  constraints: z
    .object({
      maxTokens: z.number().int().optional(),
      maxDurationMs: z.number().int().optional(),
      /** §18.4 每 Run 最大工具/模型调用数(0/未配置走 env 默认) */
      maxToolCalls: z.number().int().min(0).optional(),
      /** §12.1 原型探索模式:分数门禁放宽至 70(仍阻断 P0/P1);键名避开 prototype(原型污染扫描误报) */
      prototypeMode: z.boolean().default(false),
      allowDestructive: z.boolean().default(false),
      targetPlatforms: z.array(z.enum(["desktop", "tablet", "mobile"])).default([]),
    })
    .prefault({}),
  /** 随消息附带的参考图片(vision 开启时生效) */
  images: z
    .array(z.object({ name: z.string(), mediaType: z.string(), data: z.string() }))
    .max(3)
    .optional(),
  /** 页面/元素上下文 chips(从画布选中对象注入) */
  chips: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("page"), pageId: z.string(), title: z.string() }),
        z.object({ kind: z.literal("element"), pageId: z.string(), surfaceId: z.string(), aid: z.string(), label: z.string() }),
      ]),
    )
    .default([]),
});
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

// ---------------------------------------------------------------------------
// Design Brief / Plan / InteractionSpec(文档 §7)
// ---------------------------------------------------------------------------

export const designBriefSchema = z.object({
  objective: z.string(),
  targetUsers: z.array(z.string()).default([]),
  primaryTasks: z.array(z.string()).default([]),
  secondaryTasks: z.array(z.string()).default([]),
  businessGoals: z.array(z.string()).default([]),
  contentRequirements: z.array(z.string()).default([]),
  functionalRequirements: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  brandTone: z.string().optional(),
  density: z.enum(["compact", "comfortable", "spacious"]).default("comfortable"),
  styleDirectionId: z.string().optional(),
  uiLibraryId: z.string().optional(),
  requestedSkillIds: z.array(z.string()).default([]),
  platforms: z.array(z.enum(["desktop", "tablet", "mobile"])).default(["desktop"]),
  unknowns: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.8),
  /** Intake Analyst 附加输出 */
  clarificationNeeded: z.boolean().default(false),
  summary: z.string().default(""),
});
export type DesignBrief = z.infer<typeof designBriefSchema>;

export const designPlanSchema = z.object({
  pageType: z.string().default("custom"),
  styleDirectionId: z.string().optional(),
  uiLibraryId: z.string().optional(),
  selectedSkillIds: z.array(z.string()).default([]),
  informationArchitecture: z
    .array(
      z.object({
        sectionId: z.string(),
        title: z.string(),
        purpose: z.string(),
        priority: z.number().int(),
        content: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  layout: z
    .object({
      pattern: z.enum(["single-column", "two-column", "grid", "dashboard", "form", "detail", "custom"]),
      grid: z.string().default("12-col"),
      spacingScale: z.string().default("base"),
      density: z.enum(["compact", "comfortable", "spacious"]).default("comfortable"),
    })
    .default({ pattern: "dashboard", grid: "12-col", spacingScale: "base", density: "comfortable" }),
  userFlows: z
    .array(
      z.object({
        name: z.string(),
        steps: z.array(z.string()),
        successState: z.string(),
        failureState: z.string().optional(),
      }),
    )
    .default([]),
  componentStrategy: z
    .array(z.object({ component: z.string(), reason: z.string(), priority: z.number().int() }))
    .default([]),
  dataStrategy: z
    .object({
      entities: z.array(z.string()).default([]),
      requiredFields: z.array(z.string()).default([]),
      mockDataNeeded: z.boolean().default(true),
    })
    .prefault({}),
  interactionStrategy: z
    .object({
      primaryActions: z.array(z.string()).default([]),
      secondaryActions: z.array(z.string()).default([]),
      destructiveActions: z.array(z.string()).default([]),
      feedback: z.array(z.string()).default([]),
    })
    .prefault({}),
  responsiveStrategy: z
    .object({ desktop: z.string().default(""), tablet: z.string().optional(), mobile: z.string().optional() })
    .prefault({}),
  accessibilityStrategy: z.array(z.string()).default([]),
  rationale: z.string().default(""),
});
export type DesignPlan = z.infer<typeof designPlanSchema>;

export const interactionSpecSchema = z.object({
  states: z
    .array(z.enum(["default", "hover", "focus", "disabled", "loading", "empty", "error", "success"]))
    .default([]),
  actions: z
    .array(
      z.object({
        name: z.string(),
        trigger: z.string(),
        feedback: z.string(),
        confirmationRequired: z.boolean().default(false),
        failureHandling: z.string().default(""),
      }),
    )
    .default([]),
  keyboard: z
    .object({
      focusOrder: z.array(z.string()).default([]),
      shortcuts: z.array(z.string()).default([]),
    })
    .optional(),
});
export type InteractionSpec = z.infer<typeof interactionSpecSchema>;

// ---------------------------------------------------------------------------
// Proposal(文档 §8.2)
// ---------------------------------------------------------------------------

export const proposalStatusSchema = z.enum([
  "draft",
  "validating",
  "repairing",
  "approved",
  "rejected",
  "committed",
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const designProposalSchema = z.object({
  proposalId: z.string().min(1),
  runId: z.string().min(1),
  projectId: z.number().int(),
  baseRevision: z.number().int().nonnegative(),
  scope: designScopeSchema.default({}),
  briefId: z.string().optional(),
  planId: z.string().optional(),
  /** 投影出的原子 IR 修改(由 A2UI 消息或 propose_design_ops 转换) */
  projectedOps: z.array(irOperationSchema).default([]),
  interactionSpec: interactionSpecSchema.optional(),
  rationale: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.8),
  status: proposalStatusSchema.default("draft"),
  /** 变更摘要(提交前供审批卡/前端渲染) */
  changeSummary: z
    .object({
      added: z.number().int().default(0),
      updated: z.number().int().default(0),
      deleted: z.number().int().default(0),
      moved: z.number().int().default(0),
      affectedSurfaces: z.array(z.string()).default([]),
      labels: z.array(z.string()).default([]),
    })
    .prefault({}),
});
export type DesignProposal = z.infer<typeof designProposalSchema>;

// ---------------------------------------------------------------------------
// 校验与评审(文档 §8.3/8.4/8.6)
// ---------------------------------------------------------------------------

export const validationIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  layer: z.enum([
    "json",
    "a2ui",
    "catalog",
    "ir",
    "layout",
    "data",
    "accessibility",
    "security",
    "codegen",
  ]),
  path: z.string().optional(),
  surfaceId: z.string().optional(),
  nodeId: z.string().optional(),
  message: z.string(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  repairHint: z.string().optional(),
  /** 可自动修复时给出的最小修复 ops */
  repairOps: z.array(irOperationSchema).default([]),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const designScoreSchema = z.object({
  total: z.number().min(0).max(100),
  taskFit: z.number().min(0).max(20),
  informationArchitecture: z.number().min(0).max(15),
  visualHierarchy: z.number().min(0).max(15),
  consistency: z.number().min(0).max(10),
  interaction: z.number().min(0).max(15),
  accessibility: z.number().min(0).max(15),
  responsiveness: z.number().min(0).max(5),
  feasibility: z.number().min(0).max(5),
});
export type DesignScore = z.infer<typeof designScoreSchema>;

export const uxReviewIssueSchema = z.object({
  issueId: z.string(),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  category: z.string(),
  message: z.string(),
  rationale: z.string().default(""),
  affectedNodeIds: z.array(z.string()).default([]),
  surfaceId: z.string().optional(),
  evidence: z.string().optional(),
  recommendation: z.string().default(""),
  repairOps: z.array(irOperationSchema).default([]),
  blocking: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.8),
});
export type UXReviewIssue = z.infer<typeof uxReviewIssueSchema>;

export const uxReviewReportSchema = z.object({
  reviewId: z.string(),
  proposalId: z.string(),
  score: designScoreSchema,
  issues: z.array(uxReviewIssueSchema).default([]),
  strengths: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
  commitRecommendation: z.enum(["commit", "repair", "ask_user", "reject"]),
});
export type UXReviewReport = z.infer<typeof uxReviewReportSchema>;

// ---------------------------------------------------------------------------
// HITL 审批(文档 §15)
// ---------------------------------------------------------------------------

export const approvalRequestSchema = z.object({
  approvalId: z.string(),
  runId: z.string(),
  title: z.string(),
  reason: z.string().default(""),
  affectedSurfaces: z.array(z.string()).default([]),
  diffSummary: z
    .object({
      added: z.number().int(),
      updated: z.number().int(),
      deleted: z.number().int(),
      moved: z.number().int(),
    }),
  riskLevel: z.enum(["medium", "high"]),
  proposalId: z.string().optional(),
  timeoutSeconds: z.number().int().default(600),
  /** §15.3 断线恢复:服务端截止时间(ISO);前端倒计时以此为准,重连不重置 */
  expiresAt: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

// ---------------------------------------------------------------------------
// 设计决策日志与变更摘要(文档 §8.7 / §7.7)
// ---------------------------------------------------------------------------

export const designDecisionSchema = z.object({
  decisionId: z.string(),
  runId: z.string(),
  proposalId: z.string().optional(),
  topic: z.string(),
  chosen: z.string(),
  alternatives: z.array(z.string()).default([]),
  rationale: z.string().default(""),
  tradeoffs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.8),
});
export type DesignDecision = z.infer<typeof designDecisionSchema>;

export interface DesignChangeSummary {
  added: number;
  updated: number;
  deleted: number;
  moved: number;
  affectedSurfaces: string[];
  designRationale: string;
  tradeoffs: string[];
  nextSuggestions: string[];
}

// ---------------------------------------------------------------------------
// Plan 任务与工具卡(前端 Turn Card 数据源)
// ---------------------------------------------------------------------------

export const planTaskStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "waiting_user",
  "completed",
  "skipped",
  "failed",
  "canceled",
]);
export type PlanTaskStatus = z.infer<typeof planTaskStatusSchema>;

export interface PlanTask {
  taskId: string;
  title: string;
  description?: string;
  status: PlanTaskStatus;
  ownerRole?: string;
  inputRefs?: string[];
  outputRefs?: string[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  output?: string;
  error?: string;
  canSkip?: boolean;
  canRetry?: boolean;
}

/** 执行过程工具卡(默认折叠,失败展开) */
export interface ToolCard {
  cardId: string;
  tool: string;
  title: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  /** 本阶段消耗的 token 增量(§16.2 时间线节点含 token 成本) */
  tokens?: number;
  inputRefs?: string[];
  outputSummary?: string;
  validation?: Array<{ label: string; ok: boolean; detail?: string }>;
  rawJson?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// AgentEvent —— Run 事件流(SSE 按序下发;A2UI 消息独立类型不混入设计事件)
// ---------------------------------------------------------------------------

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.state"),
    runId: z.string(),
    seq: z.number().int(),
    status: runStatusSchema,
    label: z.string().default(""),
    progress: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal("run.step"),
    runId: z.string(),
    seq: z.number().int(),
    card: z.custom<ToolCard>((v) => typeof v === "object" && v !== null),
  }),
  z.object({
    type: z.literal("run.plan"),
    runId: z.string(),
    seq: z.number().int(),
    tasks: z.array(z.custom<PlanTask>((v) => typeof v === "object" && v !== null)),
  }),
  z.object({
    type: z.literal("run.failed"),
    runId: z.string(),
    seq: z.number().int(),
    message: z.string(),
    retryable: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("run.cancelled"),
    runId: z.string(),
    seq: z.number().int(),
  }),
  z.object({
    type: z.literal("run.streamText"),
    runId: z.string(),
    seq: z.number().int(),
    /** 生成原始输出的增量文本(打字机显示;不落库,仅推送) */
    text: z.string(),
  }),
  z.object({
    type: z.literal("design.brief_created"),
    runId: z.string(),
    seq: z.number().int(),
    brief: designBriefSchema,
  }),
  z.object({
    type: z.literal("design.plan_created"),
    runId: z.string(),
    seq: z.number().int(),
    plan: designPlanSchema,
  }),
  z.object({
    type: z.literal("design.style_resolved"),
    runId: z.string(),
    seq: z.number().int(),
    styleDirection: styleDirectionSchema,
  }),
  z.object({
    type: z.literal("design.skills_selected"),
    runId: z.string(),
    seq: z.number().int(),
    contributions: z.array(
      z.object({
        skillId: z.string(),
        version: z.string(),
        reason: z.string(),
      }),
    ),
  }),
  z.object({
    type: z.literal("design.proposal_created"),
    runId: z.string(),
    seq: z.number().int(),
    /** Proposal 概要(全量 ops 存 design_proposals 表;事件流只携带 UI 所需) */
    proposal: z.object({
      proposalId: z.string(),
      status: proposalStatusSchema,
      rationale: z.string().default(""),
      confidence: z.number().min(0).max(1).default(0.8),
      changeSummary: z
        .object({
          added: z.number().int().default(0),
          updated: z.number().int().default(0),
          deleted: z.number().int().default(0),
          moved: z.number().int().default(0),
          affectedSurfaces: z.array(z.string()).default([]),
        })
        .prefault({}),
    }),
  }),
  z.object({
    type: z.literal("design.validation_failed"),
    runId: z.string(),
    seq: z.number().int(),
    issues: z.array(validationIssueSchema),
    attempt: z.number().int(),
  }),
  z.object({
    type: z.literal("design.review_completed"),
    runId: z.string(),
    seq: z.number().int(),
    report: uxReviewReportSchema,
  }),
  z.object({
    type: z.literal("design.preview"),
    runId: z.string(),
    seq: z.number().int(),
    /** 部分合法内容的临时预览(不写 IR):A2UI 流式消息,前端渐进渲染 */
    surfaceId: z.string(),
    message: z.custom<Record<string, unknown>>((v) => typeof v === "object" && v !== null),
  }),
  z.object({
    type: z.literal("design.ops_committed"),
    runId: z.string(),
    seq: z.number().int(),
    revision: z.number().int(),
    batchId: z.string(),
    proposalId: z.string().optional(),
    summary: z.string().default(""),
    /** 逐节点变更(画布定位/高亮消费):surfaceId → 增/改/删的组件 id */
    changes: z
      .array(
        z.object({
          surfaceId: z.string(),
          added: z.array(z.string()).default([]),
          updated: z.array(z.string()).default([]),
          removed: z.array(z.string()).default([]),
        }),
      )
      .default([]),
  }),
  z.object({
    type: z.literal("clarification.request"),
    runId: z.string(),
    seq: z.number().int(),
    request: clarificationRequestSchema,
  }),
  z.object({
    type: z.literal("clarification.accepted"),
    runId: z.string(),
    seq: z.number().int(),
    requestId: z.string(),
    normalized: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal("run.approval_required"),
    runId: z.string(),
    seq: z.number().int(),
    request: approvalRequestSchema,
  }),
  z.object({
    // §14.2 awaiting_plan_approval:复杂任务先出 Plan 等确认;§14.3 支持编辑后提交
    type: z.literal("run.plan_approval_required"),
    runId: z.string(),
    seq: z.number().int(),
    tasks: z.array(z.custom<PlanTask>((v) => typeof v === "object" && v !== null)),
    timeoutSeconds: z.number().int().default(600),
    /** §15.3 断线恢复:服务端截止时间(ISO) */
    expiresAt: z.string().optional(),
  }),
  z.object({
    // §14.3 执行暂停/恢复闸门(状态机不变,仅执行流挂起;Plan Tab 展示与操作)
    type: z.literal("run.paused"),
    runId: z.string(),
    seq: z.number().int(),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal("design.explanation"),
    runId: z.string(),
    seq: z.number().int(),
    markdown: z.string(),
    changeSummary: z.custom<DesignChangeSummary>((v) => typeof v === "object" && v !== null),
  }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** 便捷构造:补充 seq 由 RunManager 统一分配,这里允许 seq=0 占位 */
export function makeEvent<E extends AgentEvent>(event: Omit<E, "seq"> & { seq?: number }): AgentEvent {
  return { ...event, seq: event.seq ?? 0 } as AgentEvent;
}

export type { ClarificationRequest, ClarificationResponse, DesignScope, IROperation, StyleDirection };
