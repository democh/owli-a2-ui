#!/usr/bin/env node
/**
 * 旧数据 → Harness Agent 新模型迁移(v2)
 *
 * 转换规则:
 * - 旧 projects.preset → IR theme.preset + 默认 tokens
 * - 旧 pages(每页一个 SurfaceDoc)→ page_boards + frames(surfaceId=frame_page_{id})+ 首个 IR revision
 * - 旧 pages.surface 的 components/root → IR surfaces[frame_page_{id}]
 * - 幂等:已存在 project_revisions 的项目跳过
 *
 * 用法:node scripts/migrate-v2.mjs [--db data/app.db] [--dry-run]
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const dryRun = args.includes("--dry-run");
const dbFile = path.resolve(process.cwd(), argOf("--db", "data/app.db"));

if (!fs.existsSync(dbFile)) {
  console.error(`数据库不存在: ${dbFile}`);
  process.exit(1);
}

// PRESET_TOKENS 与 contracts/a2ui.ts 保持一致
const PRESET_TOKENS = {
  shadcn: { primary: "#18181b", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "" },
  antd: { primary: "#1677ff", background: "#f5f5f5", surface: "#ffffff", text: "rgba(0,0,0,0.88)", mutedText: "rgba(0,0,0,0.45)", accent: "#1677ff", radius: 6, font: "" },
  element: { primary: "#409eff", background: "#f5f7fa", surface: "#ffffff", text: "#303133", mutedText: "#909399", accent: "#409eff", radius: 4, font: "" },
  custom: { primary: "#18181b", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "" },
};

const sqlite = new Database(dbFile);
sqlite.pragma("journal_mode = WAL");

// 自举新表(与 db/ddl.ts 逻辑一致;迁移脚本独立于 TS 构建,DDL 就地维护)
const now = "unixepoch() * 1000";
if (!dryRun) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS page_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  posX INTEGER NOT NULL DEFAULT 0,
  posY INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL DEFAULT (${now}),
  updatedAt INTEGER NOT NULL DEFAULT (${now})
)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pageBoardId INTEGER NOT NULL REFERENCES page_boards(id),
  surfaceId TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT 'desktop',
  width INTEGER NOT NULL DEFAULT 1440,
  height INTEGER NOT NULL DEFAULT 900,
  posX INTEGER NOT NULL DEFAULT 0,
  posY INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL DEFAULT (${now}),
  updatedAt INTEGER NOT NULL DEFAULT (${now})
)`);
try {
  sqlite.exec(`ALTER TABLE projects ADD COLUMN headRevision INTEGER NOT NULL DEFAULT 0`);
} catch {
  /* 列已存在 */
}
sqlite.exec(`CREATE TABLE IF NOT EXISTS project_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId INTEGER NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  irDoc TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  runId TEXT,
  createdAt INTEGER NOT NULL DEFAULT (${now})
)`);
}

const tableExists = (name) =>
  !!sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const hasRevisionsTable = tableExists("project_revisions");

const projects = sqlite.prepare(`SELECT id, preset FROM projects ORDER BY id`).all();
const migrated = [];
const skipped = [];

for (const project of projects) {
  const existing =
    hasRevisionsTable &&
    sqlite
      .prepare(`SELECT id FROM project_revisions WHERE projectId = ? LIMIT 1`)
      .get(project.id);
  if (existing) {
    skipped.push(project.id);
    continue;
  }

  const legacyPages = sqlite
    .prepare(`SELECT id, title, device, surface, posX, posY, width, height FROM pages WHERE projectId = ? ORDER BY id`)
    .all(project.id);

  const preset = ["shadcn", "antd", "element", "custom"].includes(project.preset) ? project.preset : "shadcn";
  const doc = {
    revision: 0,
    theme: { preset, tokens: { ...PRESET_TOKENS[preset] } },
    surfaces: {},
    dataModels: {},
  };
  const boards = [];

  for (const page of legacyPages) {
    const surfaceId = `frame_page_${page.id}`;
    let surface = null;
    try {
      const parsed = JSON.parse(page.surface);
      surface = {
        id: surfaceId,
        title: page.title,
        components: parsed.components ?? {},
        root: parsed.root ?? Object.keys(parsed.components ?? {})[0] ?? "root",
      };
      if (!surface.components[surface.root]) {
        // root 缺失时回退第一个组件
        surface.root = Object.keys(surface.components)[0] ?? "";
      }
      if (!surface.root) continue; // 空 surface 跳过
    } catch {
      console.warn(`  跳过无法解析的页面 ${page.id}(projectId=${project.id})`);
      continue;
    }
    doc.surfaces[surfaceId] = surface;

    const board = boards.find((b) => b.title === page.title);
    if (dryRun) {
      const boardId = board ? board.id : 900000 + boards.length + 1;
      if (!board) boards.push({ id: boardId, title: page.title });
      continue;
    }
    if (board) {
      sqlite
        .prepare(
          `INSERT INTO frames (pageBoardId, surfaceId, title, device, width, height, posX, posY)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(board.id, surfaceId, page.title, page.device ?? "desktop", page.width ?? 1440, page.height ?? 900, 0, 0);
    } else {
      const r = sqlite
        .prepare(`INSERT INTO page_boards (projectId, title, posX, posY) VALUES (?, ?, ?, ?)`)
        .run(project.id, page.title, page.posX ?? 0, page.posY ?? 0);
      const boardId = Number(r.lastInsertRowid);
      boards.push({ id: boardId, title: page.title });
      sqlite
        .prepare(
          `INSERT INTO frames (pageBoardId, surfaceId, title, device, width, height, posX, posY)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(boardId, surfaceId, page.title, page.device ?? "desktop", page.width ?? 1440, page.height ?? 900, 0, 0);
    }
  }

  if (!dryRun) {
    sqlite
      .prepare(`INSERT INTO project_revisions (projectId, revision, irDoc, source) VALUES (?, 0, ?, 'initial')`)
      .run(project.id, JSON.stringify(doc));
    sqlite.prepare(`UPDATE projects SET headRevision = 0 WHERE id = ?`).run(project.id);
  }
  migrated.push({ projectId: project.id, boards: boards.length, surfaces: Object.keys(doc.surfaces).length });
}

console.log(`[migrate-v2] ${dryRun ? "(dry-run) " : ""}完成`);
for (const m of migrated) console.log(`  项目 ${m.projectId}: ${m.boards} 个 PageBoard / ${m.surfaces} 个 surface → revision 0`);
if (skipped.length) console.log(`  跳过已有 revision 的项目: ${skipped.join(", ")}`);
sqlite.close();
