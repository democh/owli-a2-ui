#!/usr/bin/env node
/**
 * 备份脚本(M6-4,文档 §19.7 备份恢复)
 *
 * 内容:
 *  1. SQLite 在线备份(better-sqlite3 backup API,支持 WAL 热备,无需停服)
 *  2. 部署产物目录 data/deploys 与导出产物 data/exports
 *
 * 用法:npm run backup [-- --keep 7]
 * 产物:data/backups/backup-YYYYMMDD-HHMMSS/{app.db, deploys/, exports/}
 * 清理:默认保留最近 7 份(BACKUP_KEEP 环境变量或 --keep 覆盖)
 */
import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import path from "path";
import process from "process";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const DB_PATH = process.env.DATABASE_URL
  ? path.resolve(ROOT, process.env.DATABASE_URL)
  : path.join(DATA, "app.db");
const BACKUP_ROOT = path.join(DATA, "backups");

function parseKeep() {
  const argIdx = process.argv.indexOf("--keep");
  if (argIdx !== -1 && process.argv[argIdx + 1]) return Number(process.argv[argIdx + 1]) || 7;
  return Number(process.env.BACKUP_KEEP) || 7;
}

function copyDirIfExists(src, dest) {
  if (!existsSync(src)) return 0;
  cpSync(src, dest, { recursive: true });
  return readdirSync(src).length;
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`[backup] 数据库不存在:${DB_PATH}`);
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const destDir = path.join(BACKUP_ROOT, `backup-${stamp}`);
  mkdirSync(destDir, { recursive: true });

  // 1) SQLite 在线备份(一致性快照;热备不阻塞读写)
  const startedAt = Date.now();
  const db = new Database(DB_PATH, { readonly: true });
  await db.backup(path.join(destDir, "app.db"));
  db.close();

  // 2) 产物目录
  const deploysCount = copyDirIfExists(path.join(DATA, "deploys"), path.join(destDir, "deploys"));
  const exportsCount = copyDirIfExists(path.join(DATA, "exports"), path.join(destDir, "exports"));

  // 3) 保留策略:按名称倒序保留最近 keep 份
  const keep = parseKeep();
  const all = readdirSync(BACKUP_ROOT)
    .filter((n) => n.startsWith("backup-") && statSync(path.join(BACKUP_ROOT, n)).isDirectory())
    .sort()
    .reverse();
  let removed = 0;
  for (const name of all.slice(keep)) {
    rmSync(path.join(BACKUP_ROOT, name), { recursive: true, force: true });
    removed++;
  }

  console.log(`[backup] 完成:${destDir}`);
  console.log(`[backup] db=app.db(${Date.now() - startedAt}ms) deploys=${deploysCount} exports=${exportsCount}`);
  if (removed) console.log(`[backup] 清理旧备份 ${removed} 份(保留最近 ${keep} 份)`);
}

main().catch((e) => {
  console.error("[backup] 失败:", e);
  process.exit(1);
});
