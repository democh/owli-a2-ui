/**
 * 新表幂等 DDL 自举
 *
 * 与 connection.ts 中 llm_calls 的自举策略一致:drizzle-kit push 对既有库会误重建
 * unique index(工具 bug),因此 Harness Agent 新表统一用 CREATE TABLE IF NOT EXISTS
 * 自举,新老部署均可自愈。列结构以 @db/schema 为准,修改 schema 时同步维护此文件。
 */

export const HARNESS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS project_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    revision INTEGER NOT NULL,
    irDoc TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    runId TEXT,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_revisions_head ON project_revisions(projectId, revision DESC)`,
  `CREATE TABLE IF NOT EXISTS op_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batchId TEXT NOT NULL UNIQUE,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    baseRevision INTEGER NOT NULL,
    resultingRevision INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT '{}',
    ops TEXT NOT NULL,
    inverseOps TEXT NOT NULL DEFAULT '[]',
    provenance TEXT NOT NULL DEFAULT '{}',
    undone INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_op_batches_project ON op_batches(projectId, id DESC)`,
  `CREATE TABLE IF NOT EXISTS page_boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    posX INTEGER NOT NULL DEFAULT 0,
    posY INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pageBoardId INTEGER NOT NULL REFERENCES page_boards(id),
    surfaceId TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT 'desktop',
    width INTEGER NOT NULL DEFAULT 1440,
    height INTEGER NOT NULL DEFAULT 900,
    posX INTEGER NOT NULL DEFAULT 0,
    posY INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_frames_board ON frames(pageBoardId)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId TEXT NOT NULL UNIQUE,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    conversationId INTEGER NOT NULL REFERENCES conversations(id),
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    autonomyLevel TEXT NOT NULL DEFAULT 'guarded',
    userMessage TEXT NOT NULL DEFAULT '',
    styleDirection TEXT,
    skillIds TEXT NOT NULL DEFAULT '[]',
    baseRevision INTEGER NOT NULL DEFAULT 0,
    finalRevision INTEGER,
    model TEXT NOT NULL DEFAULT '',
    promptVersion TEXT NOT NULL DEFAULT '',
    promptTokens INTEGER NOT NULL DEFAULT 0,
    completionTokens INTEGER NOT NULL DEFAULT 0,
    toolCalls INTEGER NOT NULL DEFAULT 0,
    durationMs INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    idempotencyKey TEXT NOT NULL UNIQUE,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(projectId, id DESC)`,
  `CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_events_seq ON run_events(runId, seq)`,
  `CREATE TABLE IF NOT EXISTS design_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    briefId TEXT NOT NULL,
    runId TEXT NOT NULL,
    brief TEXT NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS design_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    planId TEXT NOT NULL,
    runId TEXT NOT NULL,
    plan TEXT NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS design_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposalId TEXT NOT NULL,
    runId TEXT NOT NULL,
    projectId INTEGER NOT NULL,
    baseRevision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    projectedOps TEXT NOT NULL DEFAULT '[]',
    rationale TEXT NOT NULL DEFAULT '',
    confidence INTEGER NOT NULL DEFAULT 80,
    changeSummary TEXT NOT NULL DEFAULT '{}',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS ux_review_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewId TEXT NOT NULL,
    proposalId TEXT NOT NULL,
    runId TEXT NOT NULL,
    score TEXT NOT NULL,
    issues TEXT NOT NULL DEFAULT '[]',
    strengths TEXT NOT NULL DEFAULT '[]',
    recommendations TEXT NOT NULL DEFAULT '[]',
    commitRecommendation TEXT NOT NULL DEFAULT 'commit',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS design_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decisionId TEXT NOT NULL,
    runId TEXT NOT NULL,
    proposalId TEXT,
    topic TEXT NOT NULL,
    chosen TEXT NOT NULL,
    alternatives TEXT NOT NULL DEFAULT '[]',
    rationale TEXT NOT NULL DEFAULT '',
    tradeoffs TEXT NOT NULL DEFAULT '[]',
    confidence INTEGER NOT NULL DEFAULT 80,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS clarification_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requestId TEXT NOT NULL UNIQUE,
    runId TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    questions TEXT NOT NULL,
    timeoutSeconds INTEGER NOT NULL DEFAULT 300,
    defaultStrategy TEXT NOT NULL DEFAULT 'use_recommended_defaults',
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS clarification_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requestId TEXT NOT NULL,
    runId TEXT NOT NULL,
    answers TEXT NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    label TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'auto',
    revision INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS style_directions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    styleDirectionId TEXT NOT NULL,
    runId TEXT,
    sd TEXT NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS design_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skillId TEXT NOT NULL UNIQUE,
    manifest TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS skill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId TEXT NOT NULL,
    skillId TEXT NOT NULL,
    version TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actorType TEXT NOT NULL,
    actorId TEXT NOT NULL DEFAULT '',
    projectId INTEGER,
    runId TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS outbox_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventType TEXT NOT NULL,
    projectId INTEGER NOT NULL,
    runId TEXT,
    payload TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
];

/** 旧表 DDL(新部署从零建库 / 测试隔离库自举用;列结构与 @db/schema 旧表一致) */
export const LEGACY_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unionId TEXT NOT NULL UNIQUE,
    name TEXT,
    email TEXT,
    avatar TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    lastSignInAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    preset TEXT NOT NULL DEFAULT 'shadcn',
    astryxTheme TEXT NOT NULL DEFAULT 'neutral',
    headRevision INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    device TEXT NOT NULL DEFAULT 'desktop',
    surface TEXT NOT NULL,
    posX INTEGER NOT NULL DEFAULT 0,
    posY INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 1440,
    height INTEGER NOT NULL DEFAULT 900,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL DEFAULT '新对话',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversationId INTEGER NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    label TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'auto',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS deploys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    pageCount INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL UNIQUE REFERENCES users(id),
    llmProvider TEXT NOT NULL DEFAULT 'kimi',
    llmApiKey TEXT,
    llmBaseUrl TEXT NOT NULL DEFAULT 'https://api.moonshot.cn/v1',
    llmModel TEXT NOT NULL DEFAULT 'kimi-k2.6',
    llmVision TEXT NOT NULL DEFAULT 'auto',
    budgetMaxCostUsd REAL NOT NULL DEFAULT 0,
    profileModels TEXT NOT NULL DEFAULT '{}',
    preferences TEXT NOT NULL DEFAULT '{}',
    updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    durationMs INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    promptTokens INTEGER NOT NULL DEFAULT 0,
    completionTokens INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

  // M5 导出产物登记
  `CREATE TABLE IF NOT EXISTS export_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exportId TEXT NOT NULL UNIQUE,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    revision INTEGER NOT NULL,
    adapterId TEXT NOT NULL DEFAULT 'shadcn-tailwind',
    fileCount INTEGER NOT NULL DEFAULT 0,
    unmapped TEXT NOT NULL DEFAULT '[]',
    zipPath TEXT NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

  // M6-1 RBAC:项目成员(projectId+userId 唯一;角色 owner|editor|viewer)
  `CREATE TABLE IF NOT EXISTS project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    userId INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'viewer',
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_members_project_user ON project_members(projectId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(userId)`,

  // M7 模板库(IR 模板市场)
  `CREATE TABLE IF NOT EXISTS ir_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    templateId TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '通用',
    tags TEXT NOT NULL DEFAULT '',
    doc TEXT NOT NULL,
    coverHtml TEXT NOT NULL DEFAULT '',
    sourceProjectId INTEGER,
    createdBy INTEGER NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ir_templates_category ON ir_templates(category)`,

  // M7 多人评论
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    surfaceId TEXT NOT NULL DEFAULT '',
    nodeId TEXT,
    parentId INTEGER,
    authorId INTEGER NOT NULL,
    body TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(projectId, surfaceId)`,

  // M6 站内告警(预算阈值/Run 失败/回滚事件)
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER,
    level TEXT NOT NULL DEFAULT 'info',
    rule TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    readAt INTEGER,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(createdAt)`,
];

/** projects.headRevision 增列(SQLite 无 ADD COLUMN IF NOT EXISTS,靠异常吞掉重复) */
function ensureHeadRevisionColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN headRevision INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // 列已存在
  }
}

/** user_settings.budgetMaxCostUsd 增列(M6-2 预算:用户级累计成本上限 USD) */
function ensureBudgetColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE user_settings ADD COLUMN budgetMaxCostUsd REAL NOT NULL DEFAULT 0`);
  } catch {
    // 列已存在
  }
}

/** user_settings.profileModels 增列(M7 多模型路由:按阶段覆盖模型 JSON) */
function ensureProfileModelsColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE user_settings ADD COLUMN profileModels TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // 列已存在
  }
}

/** 在 better-sqlite3 实例上自举全部表(旧表 + Harness 新表;幂等,可重复调用) */
export function bootstrapHarnessTables(sqlite: { exec: (sql: string) => void }): void {
  ensureHeadRevisionColumn(sqlite);
  for (const ddl of LEGACY_DDL) sqlite.exec(ddl);
  for (const ddl of HARNESS_DDL) sqlite.exec(ddl);
  // 增列必须放在建表之后:新建库由 DDL 直接建全列,ALTER 异常吞掉;老库在此补列
  ensureBudgetColumn(sqlite);
  ensureProfileModelsColumn(sqlite);
  ensurePreferencesColumn(sqlite);
  ensureSkillReviewColumns(sqlite);
  ensureTemplateCoverColumn(sqlite);
  ensureRunToolCallsColumn(sqlite);
  ensureProjectsMemoryColumn(sqlite);
  ensureCommentsParentColumn(sqlite);
}

/** comments.parentId 增列(演进项:评论讨论串回复) */
function ensureCommentsParentColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE comments ADD COLUMN parentId INTEGER`);
  } catch {
    // 列已存在
  }
}

/** runs.toolCalls 增列(§18.4 每 Run 工具/模型调用数预算) */
function ensureRunToolCallsColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE runs ADD COLUMN toolCalls INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // 列已存在
  }
}

/** projects.memory 增列(§10.5 项目记忆:JSON ProjectMemory) */
function ensureProjectsMemoryColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN memory TEXT`);
  } catch {
    // 列已存在
  }
}

/** ir_templates.coverHtml 增列(M7 模板封面缩略图;早期建表无此列的老库补列) */
function ensureTemplateCoverColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE ir_templates ADD COLUMN coverHtml TEXT NOT NULL DEFAULT ''`);
  } catch {
    // 列已存在
  }
}

/** user_settings.preferences 增列(§10.5 项目记忆:用户长期偏好 JSON) */
function ensurePreferencesColumn(sqlite: { exec: (sql: string) => void }): void {
  try {
    sqlite.exec(`ALTER TABLE user_settings ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // 列已存在
  }
}

/** design_skills 审核列(M7 Skill Marketplace:第三方提交 → 审核 → 启用) */
function ensureSkillReviewColumns(sqlite: { exec: (sql: string) => void }): void {
  for (const ddl of [
    `ALTER TABLE design_skills ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`,
    `ALTER TABLE design_skills ADD COLUMN createdBy INTEGER`,
  ]) {
    try {
      sqlite.exec(ddl);
    } catch {
      // 列已存在
    }
  }
}
