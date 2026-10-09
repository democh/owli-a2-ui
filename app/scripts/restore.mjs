#!/usr/bin/env node
/**
 * 恢复脚本(M6-4,与 backup.mjs 配对)
 *
 * 用法:npm run restore [-- --from data/backups/backup-XXXX]
 * 行为:
 *  1. 校验备份目录完整性(app.db 存在)
 *  2. 将当前 data/app.db 与产物目录移入 data/backups/pre-restore-<ts>(还原前自动保底)
 *  3. 将备份内容恢复到 data/
 *
 * 注意:必须在服务停止后执行(SQLite 数据文件不可并发写);WAL/SHM 文件随备份一并处理。
 */
import { existsSync, mkdirSync, cpSync, rmSync, renameSync, readdirSync } from "fs";
import path from "path";
import process from "process";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const BACKUP_ROOT = path.join(DATA, "backups");

function resolveFrom() {
  const idx = process.argv.indexOf("--from");
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(ROOT, process.argv[idx + 1]);
  // 未指定:取最近一份备份
  const all = readdirSync(BACKUP_ROOT)
    .filter((n) => n.startsWith("backup-"))
    .sort();
  if (!all.length) {
    console.error("[restore] 未找到任何备份;可用 --from <备份目录> 指定");
    process.exit(1);
  }
  return path.join(BACKUP_ROOT, all.at(-1));
}

function moveIfExists(src, dest) {
  if (!existsSync(src)) return false;
  renameSync(src, dest);
  return true;
}

function main() {
  const from = resolveFrom();
  const dbBackup = path.join(from, "app.db");
  if (!existsSync(dbBackup)) {
    console.error(`[restore] 备份目录缺少 app.db:${from}`);
    process.exit(1);
  }

  // 0) 风险提示(非交互,直接执行;演练可先用 --from 指向临时备份验证)
  console.log(`[restore] 将从 ${from} 恢复到 ${DATA}(服务应已停止;原状态会先保底再覆盖)`);

  // 1) 当前状态保底:移入 pre-restore-<ts>
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const preDir = path.join(BACKUP_ROOT, `pre-restore-${stamp}`);
  mkdirSync(preDir, { recursive: true });
  let guarded = 0;
  guarded += moveIfExists(path.join(DATA, "app.db"), path.join(preDir, "app.db")) ? 1 : 0;
  guarded += moveIfExists(path.join(DATA, "app.db-wal"), path.join(preDir, "app.db-wal")) ? 1 : 0;
  guarded += moveIfExists(path.join(DATA, "app.db-shm"), path.join(preDir, "app.db-shm")) ? 1 : 0;
  if (existsSync(path.join(DATA, "deploys"))) {
    cpSync(path.join(DATA, "deploys"), path.join(preDir, "deploys"), { recursive: true });
    rmSync(path.join(DATA, "deploys"), { recursive: true, force: true });
  }
  if (existsSync(path.join(DATA, "exports"))) {
    cpSync(path.join(DATA, "exports"), path.join(preDir, "exports"), { recursive: true });
    rmSync(path.join(DATA, "exports"), { recursive: true, force: true });
  }

  // 2) 恢复
  cpSync(dbBackup, path.join(DATA, "app.db"));
  // WAL/SHM:若备份里存在则一并恢复,否则删除残留(陈旧 WAL 会破坏一致性)
  for (const suffix of ["app.db-wal", "app.db-shm"]) {
    const src = path.join(from, suffix);
    const dest = path.join(DATA, suffix);
    rmSync(dest, { force: true });
    if (existsSync(src)) cpSync(src, dest);
  }
  if (existsSync(path.join(from, "deploys"))) {
    cpSync(path.join(from, "deploys"), path.join(DATA, "deploys"), { recursive: true });
  }
  if (existsSync(path.join(from, "exports"))) {
    cpSync(path.join(from, "exports"), path.join(DATA, "exports"), { recursive: true });
  }

  console.log(`[restore] 完成。原状态已保底至 ${preDir}(guarded=${guarded} 个数据库文件)`);
  console.log("[restore] 启动服务后建议执行一次 npm run check 确认库结构自举正常。");
}

main();
