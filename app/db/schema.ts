import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

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
