import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>>;

export function getDb() {
  if (!instance) {
    // SQLite 文件路径,默认 ./data/app.db(相对项目根),可用 DATABASE_URL 覆盖
    const dbPath = path.resolve(process.cwd(), env.databaseUrl || "data/app.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath);
    // WAL:读写不互斥,避免大快照同步写阻塞 SSE 流式推送;synchronous=NORMAL 在 WAL 下足够安全
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    // llm_calls 懒建表:drizzle-kit push 对既有库会误重建 unique index(工具 bug),
    // 新表改用幂等 DDL 自举,新老部署均可自愈
    sqlite.exec(`CREATE TABLE IF NOT EXISTS llm_calls (
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
    )`);
    instance = drizzle(sqlite, { schema: fullSchema });
  }
  return instance;
}
