import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  unionId: text("unionId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  avatar: text("avatar"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: integer("lastSignInAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ---------------------------------------------------------------------------
// RBAC:项目成员(文档 §9.3 工具权限矩阵 / M6-1)
// owner(项目归属人,全权)| editor(设计变更)| viewer(只读)
// ---------------------------------------------------------------------------

export const projectMembers = sqliteTable("project_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  userId: integer("userId", { mode: "number" })
    .notNull()
    .references(() => users.id),
  role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull().default("viewer"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type ProjectMember = typeof projectMembers.$inferSelect;

// ---------------------------------------------------------------------------
// A2UI Studio 业务表
// ---------------------------------------------------------------------------

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId", { mode: "number" })
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  preset: text("preset").notNull().default("shadcn"),
  /** @deprecated 已下线的 Astryx 主题字段,保留列避免迁移;新代码不再读写 */
  astryxTheme: text("astryxTheme").notNull().default("neutral"),
  /** Harness Agent 事实源:当前 head revision(命令服务维护) */
  headRevision: integer("headRevision").notNull().default(0),
  /** §10.5 项目记忆(JSON ProjectMemory;仅经用户确认写入) */
  memory: text("memory"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type Project = typeof projects.$inferSelect;

export const pages = sqliteTable("pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  device: text("device").notNull().default("desktop"),
  /** A2UI SurfaceDoc JSON */
  surface: text("surface").notNull(),
  posX: integer("posX").notNull().default(0),
  posY: integer("posY").notNull().default(0),
  width: integer("width").notNull().default(1440),
  height: integer("height").notNull().default(900),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type Page = typeof pages.$inferSelect;

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull().default("新对话"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type Conversation = typeof conversations.$inferSelect;

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversationId", { mode: "number" })
    .notNull()
    .references(() => conversations.id),
  role: text("role").notNull(), // user | assistant | system
  content: text("content").notNull(),
  /** 上下文 chips / 动作摘要等 */
  meta: text("meta"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type Message = typeof messages.$inferSelect;

export const versions = sqliteTable("versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  label: text("label").notNull(),
  /** { pages: Page[] } 全量快照 */
  snapshot: text("snapshot").notNull(),
  /** auto(AI 生成/回滚前自动快照,有保留上限) | manual(用户手动保存,永久保留) */
  kind: text("kind", { enum: ["auto", "manual"] }).notNull().default("auto"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type Version = typeof versions.$inferSelect;

export const deploys = sqliteTable("deploys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  /** 部署产物目录名(含版本) */
  slug: text("slug").notNull(),
  status: text("status", { enum: ["ready", "failed"] }).notNull().default("ready"),
  pageCount: integer("pageCount").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type Deploy = typeof deploys.$inferSelect;

export const userSettings = sqliteTable("user_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId", { mode: "number" })
    .notNull()
    .unique()
    .references(() => users.id),
  llmProvider: text("llmProvider").notNull().default("kimi"),
  llmApiKey: text("llmApiKey"),
  llmBaseUrl: text("llmBaseUrl")
    .notNull()
    .default("https://api.moonshot.cn/v1"),
  llmModel: text("llmModel").notNull().default("kimi-k2.6"),
  /** 图片对话能力:auto=按模型名自动判定 / on=强制开启 / off=关闭(对话不使用图片) */
  llmVision: text("llmVision", { enum: ["auto", "on", "off"] }).notNull().default("auto"),
  /** M6-2 预算:用户级累计成本上限(USD,含输入+输出);0=使用系统默认上限 */
  budgetMaxCostUsd: real("budgetMaxCostUsd").notNull().default(0),
  /** M7 多模型路由:按阶段覆盖模型(JSON:{planning?,generation?,review?,repair?,explanation?});空串=用主模型 */
  profileModels: text("profileModels").notNull().default("{}"),
  /** §10.5 项目记忆:用户长期偏好(JSON ProjectMemory);Agent 注入上下文,不静默修改 */
  preferences: text("preferences").notNull().default("{}"),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type UserSetting = typeof userSettings.$inferSelect;

// ---------------------------------------------------------------------------
// LLM 调用统计(可观测性:耗时 / token / 失败率)
// ---------------------------------------------------------------------------
export const llmCalls = sqliteTable("llm_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  /** surface(整页生成) | ops(元素补丁) */
  kind: text("kind", { enum: ["surface", "ops"] }).notNull(),
  provider: text("provider", { enum: ["kimi", "anthropic"] }).notNull(),
  model: text("model").notNull().default(""),
  durationMs: integer("durationMs").notNull().default(0),
  success: integer("success", { mode: "boolean" }).notNull().default(true),
  error: text("error"),
  promptTokens: integer("promptTokens").notNull().default(0),
  completionTokens: integer("completionTokens").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type LlmCall = typeof llmCalls.$inferSelect;

// ---------------------------------------------------------------------------
// Design Harness Agent —— 事实源与 Run 可观测性表
// (文档 §19.5;SQLite 落地:JSON 一律 text 列,时间戳 timestamp_ms)
// ---------------------------------------------------------------------------

/** 不可变 IR 快照:每个 revision 一行,doc 为完整 IRDocument JSON */
export const projectRevisions = sqliteTable("project_revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  revision: integer("revision").notNull(),
  irDoc: text("irDoc").notNull(),
  /** 产生该 revision 的来源:initial | manual | run | import | rollback */
  source: text("source").notNull().default("manual"),
  runId: text("runId"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type ProjectRevision = typeof projectRevisions.$inferSelect;

/** 差分修改:OpsBatch 持久化(含 inverseOps,用于 Undo / Run 回滚) */
export const opBatches = sqliteTable("op_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: text("batchId").notNull().unique(),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  baseRevision: integer("baseRevision").notNull(),
  resultingRevision: integer("resultingRevision").notNull(),
  scope: text("scope").notNull().default("{}"),
  ops: text("ops").notNull(),
  inverseOps: text("inverseOps").notNull().default("[]"),
  /** provenance JSON:{actorType,actorId,runId?,proposalId?,promptVersion?,model?} */
  provenance: text("provenance").notNull().default("{}"),
  undone: integer("undone", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type OpBatchRow = typeof opBatches.$inferSelect;

/** 页面板(PageBoard):分组多个 Frame;旧 pages 表为遗留数据,由迁移脚本转换 */
export const pageBoards = sqliteTable("page_boards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  posX: integer("posX").notNull().default(0),
  posY: integer("posY").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type PageBoardRow = typeof pageBoards.$inferSelect;

/** 画框:Frame ↔ A2UI surfaceId 一一映射 */
export const frames = sqliteTable("frames", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pageBoardId: integer("pageBoardId", { mode: "number" })
    .notNull()
    .references(() => pageBoards.id),
  surfaceId: text("surfaceId").notNull(),
  title: text("title").notNull().default(""),
  device: text("device").notNull().default("desktop"),
  width: integer("width").notNull().default(1440),
  height: integer("height").notNull().default(900),
  posX: integer("posX").notNull().default(0),
  posY: integer("posY").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type FrameRow = typeof frames.$inferSelect;

/** Agent Run 状态(文档 §6;幂等键防重复创建) */
export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("runId").notNull().unique(),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  conversationId: integer("conversationId", { mode: "number" })
    .notNull()
    .references(() => conversations.id),
  mode: text("mode").notNull(),
  status: text("status").notNull().default("queued"),
  autonomyLevel: text("autonomyLevel").notNull().default("guarded"),
  userMessage: text("userMessage").notNull().default(""),
  styleDirection: text("styleDirection"),
  skillIds: text("skillIds").notNull().default("[]"),
  baseRevision: integer("baseRevision").notNull().default(0),
  finalRevision: integer("finalRevision"),
  model: text("model").notNull().default(""),
  promptVersion: text("promptVersion").notNull().default(""),
  promptTokens: integer("promptTokens").notNull().default(0),
  completionTokens: integer("completionTokens").notNull().default(0),
  /** §18.4 工具/模型调用计数(每 Run 预算用) */
  toolCalls: integer("toolCalls").notNull().default(0),
  durationMs: integer("durationMs").notNull().default(0),
  error: text("error"),
  idempotencyKey: text("idempotencyKey").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export type RunRow = typeof runs.$inferSelect;

/** Run 事件流(SSE 下发与断线重放按 (runId, seq) 排序) */
export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("runId").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type RunEventRow = typeof runEvents.$inferSelect;

export const designBriefs = sqliteTable("design_briefs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  briefId: text("briefId").notNull(),
  runId: text("runId").notNull(),
  brief: text("brief").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export const designPlans = sqliteTable("design_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planId: text("planId").notNull(),
  runId: text("runId").notNull(),
  plan: text("plan").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export const designProposals = sqliteTable("design_proposals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  proposalId: text("proposalId").notNull(),
  runId: text("runId").notNull(),
  projectId: integer("projectId", { mode: "number" }).notNull(),
  baseRevision: integer("baseRevision").notNull(),
  status: text("status").notNull().default("draft"),
  projectedOps: text("projectedOps").notNull().default("[]"),
  rationale: text("rationale").notNull().default(""),
  confidence: integer("confidence").notNull().default(80),
  changeSummary: text("changeSummary").notNull().default("{}"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type ProposalRow = typeof designProposals.$inferSelect;

export const uxReviewReports = sqliteTable("ux_review_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: text("reviewId").notNull(),
  proposalId: text("proposalId").notNull(),
  runId: text("runId").notNull(),
  score: text("score").notNull(),
  issues: text("issues").notNull().default("[]"),
  strengths: text("strengths").notNull().default("[]"),
  recommendations: text("recommendations").notNull().default("[]"),
  commitRecommendation: text("commitRecommendation").notNull().default("commit"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type ReviewRow = typeof uxReviewReports.$inferSelect;

export const designDecisions = sqliteTable("design_decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  decisionId: text("decisionId").notNull(),
  runId: text("runId").notNull(),
  proposalId: text("proposalId"),
  topic: text("topic").notNull(),
  chosen: text("chosen").notNull(),
  alternatives: text("alternatives").notNull().default("[]"),
  rationale: text("rationale").notNull().default(""),
  tradeoffs: text("tradeoffs").notNull().default("[]"),
  confidence: integer("confidence").notNull().default(80),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export const clarificationRequests = sqliteTable("clarification_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("requestId").notNull().unique(),
  runId: text("runId").notNull(),
  reason: text("reason").notNull().default(""),
  questions: text("questions").notNull(),
  timeoutSeconds: integer("timeoutSeconds").notNull().default(300),
  defaultStrategy: text("defaultStrategy").notNull().default("use_recommended_defaults"),
  /** pending | answered | skipped | expired */
  status: text("status").notNull().default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type ClarificationRequestRow = typeof clarificationRequests.$inferSelect;

export const clarificationResponses = sqliteTable("clarification_responses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("requestId").notNull(),
  runId: text("runId").notNull(),
  answers: text("answers").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

/** 命名快照(= versions 改造;绑定 revision,可恢复) */
export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  label: text("label").notNull(),
  kind: text("kind", { enum: ["auto", "manual"] }).notNull().default("auto"),
  revision: integer("revision").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type SnapshotRow = typeof snapshots.$inferSelect;

export const styleDirections = sqliteTable("style_directions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  styleDirectionId: text("styleDirectionId").notNull(),
  runId: text("runId"),
  sd: text("sd").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export const designSkills = sqliteTable("design_skills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skillId: text("skillId").notNull().unique(),
  manifest: text("manifest").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** M7 Skill Marketplace:approved(默认,内置)| submitted | rejected */
  status: text("status", { enum: ["approved", "submitted", "rejected"] }).notNull().default("approved"),
  createdBy: integer("createdBy"),
});

export const skillRuns = sqliteTable("skill_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("runId").notNull(),
  skillId: text("skillId").notNull(),
  version: text("version").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorType: text("actorType").notNull(),
  actorId: text("actorId").notNull().default(""),
  projectId: integer("projectId", { mode: "number" }),
  runId: text("runId"),
  action: text("action").notNull(),
  detail: text("detail").notNull().default("{}"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

/** 事务外事件投递(Command Service 同事务写入;单进程下由 SSE 直推 + 此表留痕) */
export const outboxEvents = sqliteTable("outbox_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("eventType").notNull(),
  projectId: integer("projectId", { mode: "number" }).notNull(),
  runId: text("runId"),
  payload: text("payload").notNull(),
  delivered: integer("delivered", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

/** M5 导出产物登记(文档 §19.5 exports) */
export const exportFiles = sqliteTable("export_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  exportId: text("exportId").notNull().unique(),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  revision: integer("revision").notNull(),
  adapterId: text("adapterId").notNull().default("shadcn-tailwind"),
  fileCount: integer("fileCount").notNull().default(0),
  unmapped: text("unmapped").notNull().default("[]"),
  zipPath: text("zipPath").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type ExportFileRow = typeof exportFiles.$inferSelect;

// ---------------------------------------------------------------------------
// M7 高级能力:模板库 / 协作评论
// ---------------------------------------------------------------------------

/** IR 模板(M7 模板库):保存的完整 Design IR 文档快照,可应用到任意项目 */
export const irTemplates = sqliteTable("ir_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  templateId: text("templateId").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** 市场分类(如 登录页/Dashboard/表单) */
  category: text("category").notNull().default("通用"),
  /** 逗号分隔标签 */
  tags: text("tags").notNull().default(""),
  /** 完整 IR 文档 JSON(theme + surfaces) */
  doc: text("doc").notNull(),
  /** 首页封面 HTML(保存时由静态站点导出生成;列表缩略图) */
  coverHtml: text("coverHtml").notNull().default(""),
  sourceProjectId: integer("sourceProjectId"),
  createdBy: integer("createdBy").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type IrTemplate = typeof irTemplates.$inferSelect;

/** 页面元素评论(M7 多人协作):viewer 可读,editor 可写 */
export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId", { mode: "number" })
    .notNull()
    .references(() => projects.id),
  surfaceId: text("surfaceId").notNull().default(""),
  /** 可选:锚定的组件 id;空 = 页面级评论 */
  nodeId: text("nodeId"),
  /** 可选:父评论 id(讨论串回复;空 = 顶级) */
  parentId: integer("parentId", { mode: "number" }),
  authorId: integer("authorId").notNull(),
  body: text("body").notNull(),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type Comment = typeof comments.$inferSelect;

/** M6 站内告警(预算阈值/Run 失败/回滚事件) */
export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("projectId"),
  /** info | warning | error */
  level: text("level").notNull().default("info"),
  /** 规则 id:run.failed / budget.threshold / run.rollback … */
  rule: text("rule").notNull(),
  message: text("message").notNull(),
  meta: text("meta").notNull().default("{}"),
  readAt: integer("readAt", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});
export type AlertRow = typeof alerts.$inferSelect;
