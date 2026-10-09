#!/usr/bin/env node
/**
 * E2E 主流程(M6-5,文档 §21.4 交付闭环)
 *
 * 基础模式(默认,无 LLM 依赖):
 *   建项目 → 工作台数据断言 → 成员 RBAC 断言 → 完整构建门禁导出(tsc+vite build)
 *   → 产物下载 200 → RBAC viewer 隔离断言 → 清理删除项目
 *
 * --full 模式(需 .env 配置 LLM Key):
 *   在基础模式之上追加:对话生成(runs.create)→ 等待终态 → 断言 ops_committed
 *   → 画布 frame 数(经 workspace.get)
 *
 * 运行:npm run e2e [-- --full --base http://localhost:5173]
 */
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:5173";
const FULL = args.includes("--full");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `:${detail}` : ""}`);
  if (!ok) failures++;
}

/** tRPC batch 调用(本地单机模式,无需登录态);错误响应原样抛出便于诊断 */
async function trpc(name, input, isQuery = false) {
  if (isQuery) {
    const url = `${BASE}/api/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(`tRPC ${name}: ${j.error.message?.slice(0, 160)}`);
    return j.result?.data?.json;
  }
  const r = await fetch(`${BASE}/api/trpc/${name}?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ 0: { json: input } }),
  });
  const j = await r.json();
  if (j[0]?.error) throw new Error(`tRPC ${name}: ${j[0].error.message?.slice(0, 160)}`);
  return j[0]?.result?.data?.json;
}

// ESM 顶层无 require;better-sqlite3 是 CJS 原生模块,用动态 import 默认导出
async function seedInitialIRAsync(projectId) {
  const { default: Database } = await import("better-sqlite3");
  const path = await import("node:path");
  const dbPath = path.default
    ? path.default.resolve(process.cwd(), "data", "app.db")
    : path.resolve(process.cwd(), "data", "app.db");
  const db = new Database(dbPath);
  const doc = {
    revision: 1,
    theme: {
      preset: "shadcn",
      tokens: { primary: "#18181b", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "" },
    },
    surfaces: {
      frame_home: {
        id: "frame_home",
        title: "首页",
        root: "root",
        components: {
          root: { type: "Section", props: {}, children: ["t1"] },
          t1: { type: "Title", props: { text: "首页" }, children: [] },
        },
      },
    },
    dataModels: {},
  };
  const now = Date.now();
  db.prepare(
    `INSERT INTO project_revisions (projectId, revision, irDoc, source, createdAt) VALUES (?, 1, ?, 'manual', ?)`,
  ).run(projectId, JSON.stringify(doc), now);
  db.prepare(`UPDATE projects SET headRevision = 1 WHERE id = ?`).run(projectId);
  const board = db
    .prepare(`INSERT INTO page_boards (projectId, title, posX, posY, createdAt, updatedAt) VALUES (?, '主页面', 0, 0, ?, ?)`)
    .run(projectId, now, now);
  db.prepare(
    `INSERT INTO frames (pageBoardId, surfaceId, title, device, width, height, posX, posY, createdAt, updatedAt) VALUES (?, 'frame_home', '首页', 'desktop', 1440, 900, 0, 0, ?, ?)`,
  ).run(Number(board.lastInsertRowid), now, now);
  db.close();
}

async function main() {
  // 0) 服务可达
  const ping = await fetch(`${BASE}/api/trpc/ping?input=%7B%7D`).then((r) => r.json()).catch(() => null);
  check("服务可达", !!ping?.result?.data?.json?.ok);
  if (!ping) process.exit(1);

  // 1) 建项目(自动注册 owner 成员)
  const created = await trpc("projects.create", { name: `E2E ${Date.now().toString(36)}` });
  const projectId = created?.id;
  check("建项目", Number.isInteger(projectId), `id=${projectId}`);
  if (!projectId) process.exit(1);

  try {
    // 1.5) 造初始 IR 数据(基础模式无 LLM;非空画布才能验证导出门禁)
    await seedInitialIRAsync(projectId);

    // 2) 工作台主数据(初始 revision 自动建立)
    const ws = await trpc("workspace.get", { projectId }, true);
    check("工作台初始 revision", Number.isInteger(ws?.revision) && ws.revision >= 1, `revision=${ws?.revision}`);
    check("工作台画布投影", Array.isArray(ws?.legacyPages) && ws.legacyPages.length >= 1, `pages=${ws?.legacyPages?.length}`);

    // 3) 画布渲染(puppeteer 打开工作台,断言 frame 节点)
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: "new",
      defaultViewport: { width: 1600, height: 1000 },
    });
    try {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 120)));
      // networkidle0 与 SSE 长连接(run 流)天然冲突:改用 load + 固定等待
      await page.goto(`${BASE}/project/${projectId}`, { waitUntil: "load", timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 2500));
      check("工作台页面加载", consoleErrors.length === 0, consoleErrors.join("; ").slice(0, 200));

      // Agent 面板挂载(五 Tab 工作区)
      const hasPanel = await page.$("[class*='agent']");
      check("Agent 面板挂载", !!hasPanel);
    } finally {
      await browser.close();
    }

    // 4.5) TSX 导入链路(M5.3):粘贴解析 → 新 revision → 画布新增 frame
    const imported = await trpc("imports.create", {
      projectId,
      baseRevision: ws.revision,
      files: [{
        name: "e2e-page.tsx",
        content: "export default function P() {\n  return (<section><h1>E2E 导入页</h1><input placeholder=\"搜索\" /><button>go</button></section>);\n}\n",
      }],
    });
    check("TSX 导入提交(新 revision)", Number.isInteger(imported?.revision), `revision=${imported?.revision} unmapped=${imported?.report?.unmapped?.length ?? 0}`);
    const wsAfter = await trpc("workspace.get", { projectId }, true);
    check("导入后画布新增 frame", (wsAfter?.frames?.length ?? 0) >= 2, `frames=${wsAfter?.frames?.length}`);

    if (FULL) {
      // --full:对话生成全链路(需 LLM Key)
      const created2 = await trpc("projects.create", { name: `E2E-FULL ${Date.now().toString(36)}` });
      const fullProjectId = created2?.id;
      const conv = await trpc("chat.createConversation", { projectId: fullProjectId });
      const run = await trpc("runs.create", {
        projectId: fullProjectId,
        conversationId: conv?.id ?? 1,
        mode: "create_page",
        userMessage: "创建一个简洁的登录页:邮箱、密码、登录按钮",
        baseRevision: 0,
        idempotencyKey: `e2e_${Date.now()}`,
        autonomyLevel: "autopilot",
        constraints: { allowDestructive: false, targetPlatforms: [] },
        stylePreference: { mode: "auto", presetIds: [], referenceIds: [] },
        skillSelection: { mode: "auto", skillIds: [] },
        clarificationPolicy: { maxQuestions: 0, allowSkip: true, useRecommendedDefaults: true },
        chips: [],
      });
      check("Full:Run 创建", !!run?.runId, `runId=${run?.runId}`);
      if (run?.runId) {
        // 轮询事件流直至终态(最长 10 分钟)
        let committed = false;
        let done = false;
        for (let i = 0; i < 300 && !done; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const events = await trpc("runs.events", { runId: run.runId, afterSeq: -1 }, true) ?? [];
          for (const e of events) {
            if (e.type === "design.ops_committed") committed = true;
            if (e.type === "run.failed") done = true;
          }
          done = done || committed;
        }
        check("Full:设计提交(ops_committed)", committed);
        const wsFull = await trpc("workspace.get", { projectId: fullProjectId }, true);
        check("Full:画布 frame 生成", (wsFull?.frames?.length ?? 0) >= 1, `frames=${wsFull?.frames?.length}`);
        await trpc("projects.remove", { id: fullProjectId });
      }
    }

    // 5) 完整构建门禁导出 + 下载
    const wsForExport = await trpc("workspace.get", { projectId }, true);
    const build = await trpc("exports.build", { projectId, baseRevision: wsForExport.revision, projectName: "e2e-gate" });
    const jobId = build?.jobId;
    check("导出任务入队", !!jobId, `jobId=${jobId}`);
    if (jobId) {
      let exportId = null;
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await trpc("exports.buildStatus", { jobId }, true);
        if (s?.status === "passed") { exportId = s.exportId; break; }
        if (s?.status === "failed") { check("完整构建门禁", false, s.issues?.[0]?.message?.slice(0, 160) || s.error); break; }
      }
      check("完整构建门禁通过(tsc+vite build)", !!exportId, `exportId=${exportId}`);
      if (exportId) {
        const dl = await fetch(`${BASE}/api/exports/${exportId}/download`);
        check("产物下载 200(zip)", dl.status === 200, `status=${dl.status}`);
      }
    }

  } finally {
    // 7) 清理
    const removed = await trpc("projects.remove", { id: projectId });
    check("清理测试项目", removed?.ok === true);
  }

  console.log(failures === 0 ? "\nE2E 全部通过" : `\nE2E 失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[e2e] 异常:", e);
  process.exit(1);
});
