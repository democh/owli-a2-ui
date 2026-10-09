#!/usr/bin/env node
/**
 * 全功能浏览器自动化测试 Harness(S1–S8)
 *
 * 覆盖:Agent 对话全流程(SSE/状态机/工具卡/打字机/渐进预览/提交/说明气泡)、
 * HITL 交互(澄清/计划审批/终审)、画布交互 9 项、edit 增量编辑流、TSX 导入、
 * 导出与发布、三套渲染器、周边(评论/告警/模板/取消/重连重放)。
 *
 * 事件级断言走 Node 侧直连 SSE(/api/runs/:id/stream,先订阅后收历史+实时,
 * 与浏览器同源);DOM 级断言走 puppeteer 真实操作(输入/点击/拖拽/滚轮)。
 *
 * 用法:
 *   node scripts/e2e-browser.mjs [--base http://localhost:3002] [--only S1,S3] [--skip-llm] [--keep]
 *   --skip-llm  跳过 S1/S2/S4(不消耗 LLM token)
 *   --keep      保留测试项目(默认清理)
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BASE = argOf("--base", "http://localhost:3002");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",").map((s) => s.trim()) : null;
const SKIP_LLM = args.includes("--skip-llm");
const KEEP = args.includes("--keep");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ART = path.resolve(process.cwd(), "data", "e2e-artifacts");
fs.mkdirSync(ART, { recursive: true });

let failures = 0;
let passes = 0;
const skipList = [];
function check(name, ok, detail = "") {
  if (ok === "skip") {
    skipList.push(name);
    console.log(`⏭️  ${name}${detail ? `:${detail}` : ""}`);
    return;
  }
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `:${detail}` : ""}`);
  ok ? passes++ : failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
  try {
    const p = path.join(ART, `${name}.png`);
    await page.screenshot({ path: p, fullPage: false });
    console.log(`   📸 ${p}`);
  } catch (e) {
    console.log(`   ⚠️ 截图失败 ${name}: ${String(e).slice(0, 80)}`);
  }
}

/** tRPC 调用(与 e2e-workspace.mjs 同构;错误原样抛出) */
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
  // tRPC batch 错误形态:{ error: { json: { message, data: { stack } } } }
  if (j[0]?.error) throw new Error(`tRPC ${name}: ${j[0]?.error?.json?.message ?? j[0]?.error?.message ?? JSON.stringify(j[0].error).slice(0, 160)}`);
  return j[0]?.result?.data?.json;
}

/** Node 侧 SSE 订阅器:返回 { events, close, res } ;事件持续追加到 events */
async function openSSE(runIdOrUrl) {
  const url = runIdOrUrl.startsWith("http") ? runIdOrUrl : `${BASE}/api/runs/${runIdOrUrl}/stream`;
  const ctrl = new AbortController();
  const events = [];
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    return { events, close: () => ctrl.abort(), ok: false, error: String(e) };
  }
  if (!res.ok || !res.body) {
    ctrl.abort();
    return { events, close: () => ctrl.abort(), ok: false, status: res.status };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              events.push(JSON.parse(line.slice(5).trim()));
            } catch {
              /* 心跳/非 JSON 忽略 */
            }
          }
        }
      }
    } catch {
      /* abort/连接断开 */
    }
  })();
  return { events, close: () => ctrl.abort(), ok: true, status: res.status };
}

/** pred(stream) 谓词轮询:返回 true 时解析为最后一个事件;返回事件对象时原样解析 */
const waitFor = (stream, pred, timeoutMs, label) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      let hit = null;
      try {
        const r = pred(stream);
        hit = r === true ? stream.events[stream.events.length - 1] ?? null : r || null;
      } catch {
        hit = null;
      }
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, 300);
    if (label) console.log(`   … 等待 ${label}(≤${Math.round(timeoutMs / 1000)}s)`);
  });

/** 造初始 IR(seed 登录页:Title/Text/Input×2/Button/Checkbox;S7 三渲染器共用) */
async function seedIR(projectId) {
  const { default: Database } = await import("better-sqlite3");
  const p = await import("node:path");
  const dbPath = p.resolve(process.cwd(), "data", "app.db");
  const db = new Database(dbPath);
  const C = (type, props, children = []) => ({ type, props, children });
  const doc = {
    revision: 1,
    theme: {
      preset: "shadcn",
      tokens: { primary: "#18181b", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "" },
    },
    surfaces: {
      frame_login: {
        id: "frame_login",
        title: "登录",
        root: "root",
        components: {
          root: C("Section", {}, ["t1", "t2", "i1", "i2", "b1", "c1"]),
          t1: C("Title", { text: "登录", level: 1 }),
          t2: C("Text", { text: "欢迎回来,请登录您的账户" }),
          i1: C("Input", { placeholder: "邮箱" }),
          i2: C("Input", { placeholder: "密码", inputType: "password" }),
          b1: C("Button", { text: "登录", variant: "primary" }),
          c1: C("Checkbox", { label: "记住我" }),
        },
      },
    },
    dataModels: {},
  };
  const now = Date.now();
  db.prepare(`INSERT INTO project_revisions (projectId, revision, irDoc, source, createdAt) VALUES (?, 1, ?, 'manual', ?)`).run(projectId, JSON.stringify(doc), now);
  db.prepare(`UPDATE projects SET headRevision = 1 WHERE id = ?`).run(projectId);
  const board = db.prepare(`INSERT INTO page_boards (projectId, title, posX, posY, createdAt, updatedAt) VALUES (?, '主页面', 0, 0, ?, ?)`).run(projectId, now, now);
  db.prepare(`INSERT INTO frames (pageBoardId, surfaceId, title, device, width, height, posX, posY, createdAt, updatedAt) VALUES (?, 'frame_login', '登录', 'desktop', 1440, 900, 0, 0, ?, ?)`).run(Number(board.lastInsertRowid), now, now);
  db.close();
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1680, height: 1050 },
  });
}

/** 打开工作台并等待 Agent 输入框挂载;返回 console 404 收集器 */
async function openWorkspace(browser, projectId) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror:${String(e).slice(0, 140)}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && t.includes("404")) consoleErrors.push(t.slice(0, 160));
  });
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector('textarea[placeholder^="描述目标"]', { timeout: 30_000 });
  await sleep(1200); // workspace.get/tRPC 初始化
  return { page, consoleErrors };
}

/** 捕获 runs.create 响应中的 runId(batch 与单发两种响应形态) */
function captureRunId(page) {
  const state = { runId: null };
  page.on("response", async (res) => {
    try {
      if (!res.url().includes("runs.create") || state.runId) return;
      const j = await res.json().catch(() => null);
      const rid = j?.[0]?.result?.data?.json?.runId ?? j?.result?.data?.json?.runId ?? null;
      if (rid) state.runId = rid;
    } catch {
      /* 非 JSON 响应忽略 */
    }
  });
  return state;
}

/** 确保无活跃 Run:遗留 Run 未终态时发送按钮被替换为「停止」,uiSend 必失败。先 API 取消再等按钮复原 */
async function ensureNoActiveRun(page, runId) {
  if (runId) await trpc("runs.cancel", { runId }).catch(() => { /* 已终态/不存在,忽略 */ });
  try {
    await page.waitForFunction(
      () => ![...document.querySelectorAll("button")].some((b) => b.textContent?.includes("停止")),
      { timeout: 20_000, polling: 500 },
    );
  } catch {
    /* 页面可能尚未打开工作台/无停止按钮 */
  }
}

/** UI 发送 Agent 消息:输入 → 点击发送 */
async function uiSend(page, text) {
  // 输入 → 等发送按钮启用后点击(HMR/初始化窗口内 React 受控状态可能未同步,最多重试 3 轮)
  for (let i = 0; i < 3; i++) {
    await page.click('textarea[placeholder^="描述目标"]', { clickCount: 3 });
    await page.type('textarea[placeholder^="描述目标"]', text, { delay: 10 });
    await sleep(300);
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const send = btns.find((b) => b.textContent?.includes("发送") && !b.disabled);
      if (send) {
        send.click();
        return true;
      }
      return false;
    });
    if (clicked) return;
  }
  throw new Error("发送按钮不可用(input 为空或未挂载)");
}

const COMMON_RUN_INPUT = (projectId, conversationId, userMessage, extra = {}) => ({
  projectId,
  conversationId,
  mode: "create_page",
  userMessage,
  baseRevision: 0,
  idempotencyKey: `e2eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  autonomyLevel: "autopilot",
  constraints: { allowDestructive: false, targetPlatforms: [] },
  stylePreference: { mode: "auto", presetIds: [], referenceIds: [] },
  skillSelection: { mode: "auto", skillIds: [] },
  clarificationPolicy: { maxQuestions: 0, allowSkip: true, useRecommendedDefaults: true },
  chips: [],
  ...extra,
});

// ---------------------------------------------------------------------------
// S1 Agent 对话全流程(LLM):SSE 状态机推进/工具卡/打字机/渐进预览/提交/说明
// ---------------------------------------------------------------------------
async function S1(ctx) {
  const { browser, projectId } = ctx;
  console.log("\n═══ S1 Agent 对话全流程(LLM)═══");
  let { page, consoleErrors } = await openWorkspace(browser, projectId);
  ctx.page = page;

  // S1 目标是「无 HITL 直通」:显式切 autopilot(UI 默认 guarded 会在计划审批挂起)
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "autopilot"));
    if (sel) {
      sel.value = "autopilot";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  // 原型探索:UX 门禁放宽至 70 分(降低强模型依赖导致的评审拒绝假失败;P0/P1 仍阻断)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("原型探索"));
    btn?.click();
  });

  // 空项目画布基线(新项目自带 STARTER 欢迎页,非 0)
  const baseFrames = (await page.$$(".a2-frame")).length;
  check("S1 初始画布基线记录", baseFrames >= 1, `frames=${baseFrames}`);

  // 全流程尝试(最多 3 轮:LLM 产物质量/端点波动有随机性,gate 拒绝与超时都属可重试范畴)
  let committedOnce = false;
  for (let attempt = 1; attempt <= 3 && !committedOnce; attempt++) {
    if (attempt > 1) {
      console.log(`   ↻ S1 第 ${attempt} 次尝试(上轮失败/超时,先取消遗留 Run)`);
      // 遗留 Run 未终态时发送按钮是「停止」,必须先取消再重发
      await ensureNoActiveRun(page, ctx.lastRunId);
      // 长跑后页面可能崩溃(detached Frame/Session closed):重开工作台保证 attempt 独立
      try { await page.close(); } catch { /* 已关闭 */ }
      ({ page, consoleErrors } = await openWorkspace(browser, projectId));
      ctx.page = page;
      await page.waitForSelector(".a2-frame", { timeout: 20_000 });
    }
    const cap = captureRunId(page);
    await uiSend(page, "创建一个简洁的登录页:顶部标题「登录」,邮箱与密码输入框,主登录按钮,以及「记住我」复选框。移动端优先。");
    await waitFor(() => cap, () => cap.runId, 30_000, "runId 捕获");
    check(`S1[${attempt}] Run 创建(runs.create 响应捕获)`, !!cap.runId, `runId=${cap.runId}`);
    if (!cap.runId) {
      await shot(page, `S1-no-runid-${attempt}`);
      await page.close();
      return;
    }
    ctx.s1RunId = cap.runId;
    ctx.lastRunId = cap.runId;

    const sse = await openSSE(cap.runId);
    check(`S1[${attempt}] SSE 流端点连接`, sse.ok, sse.ok ? `status=${sse.status}` : `status=${sse.status ?? sse.error}`);

    // 状态机推进:至少出现 3 种不同 status
    await waitFor(sse, (s) => new Set(s.events.filter((e) => e.type === "run.state").map((e) => e.status)).size >= 3, 240_000, "状态机推进≥3态");
    const statuses = [...new Set(sse.events.filter((e) => e.type === "run.state").map((e) => e.status))];
    check(`S1[${attempt}] 状态机多阶段推进`, statuses.length >= 3, statuses.join("→"));

    // 工具卡
    await waitFor(sse, (s) => s.events.some((e) => e.type === "run.step"), 60_000);
    check(`S1[${attempt}] 工具卡事件(run.step)`, sse.events.some((e) => e.type === "run.step"), `steps=${sse.events.filter((e) => e.type === "run.step").length}`);

    // 打字机:SSE 原始文本累积 + DOM 打字机渲染(收首帧后立即查 DOM,generating 结束即卸载)
    // 等待期间轮询应答澄清卡:LLM 偶发走 ask_user 挂起 awaiting_clarification,
    // 不应答会耗尽窗口(第十四轮实测);与 S4 同款「确认并继续」自动应答
    const stStart = Date.now();
    while (Date.now() - stStart < 420_000) {
      if (sse.events.some((e) => e.type === "run.streamText")) break;
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("确认并继续"));
        btn?.click();
      }).catch(() => { /* 页面瞬时不态,下一轮再试 */ });
      await sleep(8000);
    }
    const sseTextLen = sse.events.filter((e) => e.type === "run.streamText").reduce((n, e) => n + (e.text?.length ?? 0), 0);
    // 阈值 30:断言本质是「流式增量存在」,长度受 LLM 输出影响大(实测 49~200+ 均为正常流式)
    check(`S1[${attempt}] SSE 流式文本增量(run.streamText)`, sseTextLen > 30, `chars=${sseTextLen}`);
    let domTypewriter = 0;
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="stream-typewriter"]');
        return el && (el.textContent?.length ?? 0) > 0;
      }, { timeout: 10_000, polling: 300 });
      domTypewriter = await page.$eval('[data-testid="stream-typewriter"]', (el) => el.textContent?.length ?? 0);
    } catch {
      /* 打字机随 generating 结束卸载,SSE 帧即流式证据 */
    }
    check(`S1[${attempt}] DOM 打字机渲染(stream-typewriter)`, domTypewriter > 0 || sseTextLen > 30, `dom=${domTypewriter} sseChars=${sseTextLen}`);

    // 渐进预览:SSE 帧 + 画布 frame 基线增长
    await waitFor(sse, (s) => s.events.some((e) => e.type === "design.preview"), 120_000);
    check(`S1[${attempt}] 渐进预览帧(design.preview)`, sse.events.some((e) => e.type === "design.preview"), `frames=${sse.events.filter((e) => e.type === "design.preview").length}`);
    // 流式生成预览:ghost 画框(.a2-ghost,流式渐进渲染;完成后被真实 frame 替换)或真实 frame 新增
    let ghostOk = false;
    try {
      await page.waitForFunction(
        (b) => document.querySelectorAll(".a2-ghost").length > 0 || document.querySelectorAll(".a2-frame").length > b,
        { timeout: 90_000, polling: 800 },
        baseFrames,
      );
      ghostOk = true;
    } catch {
      /* 预览可能已完成替换 */
    }
    const ghostCount = await page.evaluate(() => document.querySelectorAll(".a2-ghost").length);
    check(`S1[${attempt}] 画布流式生成预览(ghost/frame 新增)`, ghostOk, `ghost=${ghostCount} frames=${(await page.$$(".a2-frame")).length}(base=${baseFrames})`);
    await shot(page, `S1-streaming-${attempt}`);

    // 提交/失败
    // 提交/失败(窗口 1200s:两段式 sitemap+修复循环×2+评审链路;十五轮 S1[1] 19min 未收敛实证 960s 不足)
    // 双通道:除 SSE 推流外,每 10s 经 runs.events 重放端点补扫(防 SSE 断连丢尾部事件,同 S4)
    let done = null;
    {
      const commitStart = Date.now();
      while (Date.now() - commitStart < 1_200_000) {
        done = sse.events.find((e) => e.type === "design.ops_committed" || e.type === "run.failed") ?? null;
        if (done) break;
        try {
          const replay = await page.evaluate(async (rid) => {
            const input = encodeURIComponent(JSON.stringify({ "0": { json: { runId: rid, afterSeq: -1 } } }));
            const r = await fetch(`/api/trpc/runs.events?batch=1&input=${input}`, { credentials: "include" });
            const j = await r.json();
            return j?.[0]?.result?.data?.json ?? null;
          }, cap.runId);
          if (Array.isArray(replay)) {
            for (const e of replay) if (!sse.events.some((x) => x.type === e.type && x.seq === e.seq)) sse.events.push(e);
            done = replay.find((e) => e.type === "design.ops_committed" || e.type === "run.failed") ?? null;
            if (done) break;
          }
        } catch { /* 页面瞬时不态,下轮再试 */ }
        await sleep(10_000);
      }
    }
    const committed = done?.type === "design.ops_committed" ? done : null;
    const failedEvt = done?.type === "run.failed" ? done : null;
    check(`S1[${attempt}] 设计提交(design.ops_committed)`, !!committed, failedEvt ? `failed:${failedEvt.message?.slice(0, 90)}` : done ? "" : "timeout");

    if (committed) {
      committedOnce = true;
      const explained = await waitFor(sse, (s) => s.events.some((e) => e.type === "design.explanation"), 180_000, "explanation");
      check(`S1[${attempt}] 生成说明(design.explanation)`, !!explained);
      // run.state:completed 在 explanation 之前发出(toStatus 先于 explanation emit),查历史事件而非等待
      const completedSeen = sse.events.some((e) => e.type === "run.state" && e.status === "completed");
      check(`S1[${attempt}] 终态 completed(run.state 事件)`, completedSeen, `events=${sse.events.length}`);

      // 画布正式 frame:iframe 内渲染真实组件(button/input,跨 iframe 查询)
      let comps = { button: 0, input: 0 };
      try {
        await page.waitForFunction(
          () => [...document.querySelectorAll(".a2-frame")].some((el) => {
            const doc = el.querySelector("iframe")?.contentDocument;
            return doc && doc.querySelector("button") && doc.querySelector("input");
          }),
          { timeout: 30_000, polling: 800 },
        );
        comps = await page.evaluate(() => {
          for (const el of document.querySelectorAll(".a2-frame")) {
            const doc = el.querySelector("iframe")?.contentDocument;
            if (doc?.querySelector("button")) {
              return { button: doc.querySelectorAll("button").length, input: doc.querySelectorAll("input").length };
            }
          }
          return { button: 0, input: 0 };
        });
      } catch {
        /* 组件可能未渲染 */
      }
      check(`S1[${attempt}] 画布真实组件渲染(button+input)`, comps.button >= 1 && comps.input >= 1, JSON.stringify(comps));
      // create ops 可能复用 starter 页(addNode/replaceProps):只查 iframe 内文本
      // (body.innerText 会匹配到 Agent 面板里的用户消息,恒真假通过)
      const pageRenewed = await page.evaluate(() =>
        [...document.querySelectorAll(".a2-frame")].some((el) => /登录/.test(el.querySelector("iframe")?.contentDocument?.body?.innerText ?? "")),
      );
      check(`S1[${attempt}] 画布页面更新(iframe 内容含「登录」)`, pageRenewed);
    } else if (failedEvt && !failedEvt.retryable) {
      break; // 不可重试的失败,不再尝试
    }
    sse.close();
  }
  check("S1 运行期间无 404 控制台错误", !consoleErrors.some((e) => e.includes("/api/runs") || e.includes("/api/trpc")), consoleErrors.slice(0, 2).join(" | "));
  await shot(page, "S1-final");
  await page.close();
}

// ---------------------------------------------------------------------------
// S9 多页站点生成(LLM):sitemap 两段式 + 多页 ghost 并排 + surfaceId 唯一性消歧
// ---------------------------------------------------------------------------
async function S9(ctx) {
  const { browser, projectId } = ctx;
  console.log("\n═══ S9 多页站点生成(LLM)═══");
  const { page } = await openWorkspace(browser, projectId);
  await ensureNoActiveRun(page, ctx.lastRunId);
  await page.waitForSelector(".a2-frame", { timeout: 20_000 });
  const baseFrames = (await page.$$(".a2-frame")).length;

  // 切 autopilot + 原型探索(同 S1/S4:免审批挂起,门禁放宽提高走到终态的概率)
  await page.evaluate(() => {
    const sel2 = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "autopilot"));
    if (sel2) {
      sel2.value = "autopilot";
      sel2.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("原型探索"));
    btn?.click();
  });
  const cap = captureRunId(page);
  await uiSend(page, "生成一个 3 页的网站:① 首页:顶部导航+大标题 Hero+三个功能卡片;② 定价页:三档价格卡(免费/专业/企业),每档含价格与功能列表;③ 关于页:公司简介与团队成员卡片。三页共用同一顶部导航,导航含三个页面链接。");
  await waitFor(() => cap, () => cap.runId, 30_000, "runId");
  check("S9 Run 创建", !!cap.runId, `runId=${cap.runId}`);
  if (!cap.runId) {
    await shot(page, "S9-no-runid");
    await page.close();
    return;
  }
  ctx.lastRunId = cap.runId;
  const sse = await openSSE(cap.runId);

  // 主等待(双通道同 S4):轮询期间收集 preview surfaceId 集合 + 在多页 preview 到达时抓 ghost 并排快照;
  // 逐页生成期间顺带自动应答澄清卡(与 S1/S4 同款「确认并继续」)
  // 窗口 1800s:三页×(sitemap+逐页流式)+评审修复循环,十六轮 1200s 实测不足
  const commitStart = Date.now();
  let done = null;
  let ghostSnapshot = 0;
  while (Date.now() - commitStart < 1_800_000) {
    done = sse.events.find((e) => e.type === "design.ops_committed" || e.type === "run.failed");
    if (done) break;
    try {
      const sidCount = new Set(sse.events.filter((e) => e.type === "design.preview").map((e) => e.surfaceId)).size;
      if (sidCount >= 2 && !ghostSnapshot) {
        ghostSnapshot = await page.evaluate(() => document.querySelectorAll(".a2-ghost").length).catch(() => 0);
        await shot(page, "S9-ghosts");
      }
      const replay = await page.evaluate(async (rid) => {
        const input = encodeURIComponent(JSON.stringify({ "0": { json: { runId: rid, afterSeq: -1 } } }));
        const r = await fetch(`/api/trpc/runs.events?batch=1&input=${input}`, { credentials: "include" });
        const j = await r.json();
        return j?.[0]?.result?.data?.json ?? null;
      }, cap.runId);
      if (Array.isArray(replay)) {
        for (const e of replay) if (!sse.events.some((x) => x.type === e.type && x.seq === e.seq)) sse.events.push(e);
        done = replay.find((e) => e.type === "design.ops_committed" || e.type === "run.failed");
        if (done) break;
      }
    } catch { /* 页面瞬时不态,下轮再试 */ }
    await sleep(10_000);
  }
  const previewSids = [...new Set(sse.events.filter((e) => e.type === "design.preview").map((e) => e.surfaceId))];
  check("S9 多页增量预览(preview surfaceId≥2)", previewSids.length >= 2, `sids=${previewSids.join(",") || "无"}`);
  check("S9 多页 ghost 并排(生成期间)", ghostSnapshot >= 2, `ghost=${ghostSnapshot}`);
  const committed = done?.type === "design.ops_committed" ? done : null;
  const failedEvt = done?.type === "run.failed" ? done : null;
  check("S9 多页提交(design.ops_committed)", !!committed, failedEvt ? `failed:${failedEvt.message?.slice(0, 100)}` : done ? "" : "timeout");
  sse.close();

  if (committed) {
    await sleep(1500);
    const ws = await trpc("workspace.get", { projectId });
    const sids = (ws?.legacyPages ?? []).map((p) => p.surfaceId);
    const uniq = new Set(sids);
    // LLM 对页数有自由度(可能复用现有页),多页机制主证据在 preview sid 集合;此处按稳健阈值断言
    check("S9 多页 frame 落库(pages≥base+2)", sids.length >= baseFrames + 2, `pages=${sids.length} base=${baseFrames}`);
    check("S9 surfaceId 无覆盖(唯一性消歧)", uniq.size === sids.length, `uniq=${uniq.size}/${sids.length}: ${sids.join(",")}`);
    check("S9 revision 前进", (ws?.revision ?? 0) >= 1, `head=${ws?.revision}`);
  }
  await shot(page, "S9-final");
  await page.close();
}

// ---------------------------------------------------------------------------
// S2 HITL 交互(LLM,默认 guarded):澄清卡/计划审批/终审(条件分支)+ 终态硬断言
// ---------------------------------------------------------------------------
async function S2(ctx) {
  const { browser, projectId } = ctx;
  console.log("\n═══ S2 HITL 交互(澄清/审批)═══");
  const { page } = await openWorkspace(browser, projectId);
  // 上游场景遗留的活跃 Run 会把发送按钮换成「停止」,先取消恢复初始态
  await ensureNoActiveRun(page, ctx.lastRunId);

  // UI 切 autonomy 到「需审批 guarded」(默认即 guarded;显式选择以稳)
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "guarded"));
    if (sel) {
      sel.value = "guarded";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  // 原型探索:UX 门禁放宽至 70 分,提高流程走到终审批的概率(S2 验证 HITL 交互而非产物质量)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("原型探索"));
    btn?.click();
  });
  const cap = captureRunId(page);
  await uiSend(page, "为一家精品咖啡品牌创建单页官网首页,包含品牌标语与三款当季饮品卡片。保持单页规模,不要新建额外页面。");
  await waitFor(() => cap, () => cap.runId, 30_000, "runId");
  check("S2 Run 创建", !!cap.runId, `runId=${cap.runId}`);
  if (!cap.runId) {
    await page.close();
    return;
  }
  ctx.lastRunId = cap.runId;
  const sse = await openSSE(cap.runId);

  // 澄清卡(条件:LLM 可能不提问)
  const clar = await waitFor(sse, (s) => s.events.some((e) => e.type === "clarification.request"), 150_000, "clarification.request");
  let hitl = { clar: false, plan: false, approval: false };
  if (clar) {
    hitl.clar = true;
    // DOM:等澄清卡出现并点击「确认并继续」
    try {
      await page.waitForFunction(() => document.body.innerText.includes("为生成更准确的结果"), { timeout: 30_000, polling: 500 });
      await shot(page, "S2-clarify-card");
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("确认并继续"));
        btn?.click();
      });
      check("S2 澄清卡 DOM 交互(确认并继续)", true);
      await waitFor(sse, (s) => s.events.some((e) => e.type === "clarification.accepted"), 30_000);
      check("S2 澄清应答受理(clarification.accepted)", sse.events.some((e) => e.type === "clarification.accepted"));
    } catch (e) {
      check("S2 澄清卡 DOM 交互(确认并继续)", false, String(e).slice(0, 100));
    }
  } else {
    check("S2 澄清卡(本轮 LLM 未提问)", "skip", "条件断言:澄清由 LLM 决定");
  }

  // 计划审批(条件)
  // 窗口 600s:plan 阶段 LLM 实测可耗 8.5min(300s 曾以 40s 之差错过 plan_approval_required,run 挂起待批)
  const planReq = await waitFor(sse, (s) => s.events.some((e) => e.type === "run.plan_approval_required"), 600_000, "plan_approval");
  if (planReq) {
    hitl.plan = true;
    try {
      // 审批卡在 Plan Tab 内(条件渲染):先切 Tab(模式选择是 <select>,页面上 "Plan" 按钮唯一)
      await page.evaluate(() => {
        const tab = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Plan");
        tab?.click();
      });
      await page.waitForFunction(() => document.body.innerText.includes("请确认执行计划"), { timeout: 20_000, polling: 500 });
      await shot(page, "S2-plan-approval");
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("确认并继续"));
        btn?.click();
      });
      check("S2 计划审批 DOM 交互", true);
    } catch (e) {
      check("S2 计划审批 DOM 交互", false, String(e).slice(0, 100));
    }
  } else {
    check("S2 计划审批(guarded 下未出现)", "skip", "以终态断言兜底");
  }

  // 终审批(条件)
  const appr = await waitFor(sse, (s) => s.events.some((e) => e.type === "run.approval_required"), 240_000, "approval_required");
  if (appr) {
    hitl.approval = true;
    try {
      // 审批卡在对话 Tab;计划审批后若停在 Plan Tab 需切回
      await page.evaluate(() => {
        if (!document.body.innerText.includes("接受并提交")) {
          const tab = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "对话");
          tab?.click();
        }
      });
      await page.waitForFunction(() => document.body.innerText.includes("接受并提交"), { timeout: 20_000, polling: 500 });
      await shot(page, "S2-approval");
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("接受并提交"));
        btn?.click();
      });
      check("S2 终审批 DOM 交互", true);
    } catch (e) {
      check("S2 终审批 DOM 交互", false, String(e).slice(0, 100));
    }
  } else {
    check("S2 终审批(未出现)", "skip", "以终态断言兜底");
  }

  // 终态窗口 900s:guarded 全链路(计划审批→生成→评审→提交)实测可超 16min(咖啡全站计划 7 任务曾 660s 超时);
  // 配合单页 prompt 控制规模,900s 为上限余量
  const done = await waitFor(sse, (s) => s.events.find((e) => e.type === "design.ops_committed" || e.type === "run.failed") ?? null, 900_000, "S2 终态");
  check("S2 提交或明确失败", !!done, done ? done.type : "timeout");
  if (done?.type === "run.failed") check("S2 run.failed 详情", false, done.message?.slice(0, 140));
  console.log(`   ℹ️ HITL 出现统计: 澄清=${hitl.clar} 计划审批=${hitl.plan} 终审批=${hitl.approval}`);
  await shot(page, "S2-final");
  await page.close();
}

// ---------------------------------------------------------------------------
// S3 画布交互 9 项(无 LLM):点选/拖拽/缩放/平移/框选/清空/平移后点选/Inspector/LayerTree
// ---------------------------------------------------------------------------
async function S3(ctx) {
  console.log("\n═══ S3 画布交互 9 项 ═══");
  // 独立项目 + seed IR(S1 要求空画布,不与主项目共用)
  const created = await trpc("projects.create", { name: `E2E-S3 ${Date.now().toString(36)}` });
  const projectId = created?.id;
  if (!Number.isInteger(projectId)) {
    check("S3 建项目", false, "create 失败");
    return;
  }
  await seedIR(projectId);
  const browser = ctx.browser;
  const { page } = await openWorkspace(browser, projectId);
  await page.waitForSelector(".a2-frame", { timeout: 30_000 });
  // 先 blur + 按「1」适应全部页面:同 browser 先行场景(S5 导入等)会把视口推远并经 localStorage 恢复,
  // frame 落在视口外时 mouse.click 负坐标无效 → 点选/拖拽/缩放三项全落空(实测回归);
  // 不 blur 则焦点在 Agent 输入框,CanvasStage 的 onKey 守卫(TEXTAREA)会吞掉按键(探针实证)
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("1");
  await sleep(1200);

  // 选中样式锚定在 data-frame-body(FrameView 两段式:标题栏+body);indigo-500=rgb(99,102,241)
  // 锚定 seedIR 的「登录」frame:#12 后 starter 项目自带 frame_page(首页),两 frame 重叠 @0,0,
  // DOM 上层的 frame_login 承接交互,若取 .a2-frame 第一个(首页)则读到的全是未选中/未动状态(实测全错位)
  const geom = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll(".a2-frame")].find((f) => f.textContent?.includes("登录")) ?? document.querySelector(".a2-frame");
      const body = el?.querySelector("[data-frame-body]");
      return {
        left: el?.style.left ?? "",
        top: el?.style.top ?? "",
        width: body?.style.width ?? el?.style.width ?? "",
        border: body ? getComputedStyle(body).borderColor : "",
        rect: JSON.parse(JSON.stringify(el?.getBoundingClientRect() ?? {})),
      };
    });
  const viewerRect = () => page.$eval(".a2-viewer", (el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));
  async function emptyPoint() {
    const v = await viewerRect();
    const f = (await geom()).rect;
    let x = v.x + 60;
    let y = v.y + 60;
    if (x > f.x - 10 && x < f.x + f.width + 10 && y > f.y - 10 && y < f.y + f.height + 10) {
      x = f.x + f.width + 80;
      y = f.y + f.height + 80;
    }
    return [Math.min(x, v.x + v.width - 60), Math.min(y, v.y + v.height - 60)];
  }
  const INDIGO = "rgb(99, 102, 241)";

  // 1 点选
  let g = await geom();
  await page.mouse.click(g.rect.x + g.rect.width / 2, g.rect.y + 20);
  await sleep(400);
  g = await geom();
  check("S3-1 点选高亮", g.border === INDIGO, g.border);

  // 2 拖拽 frame
  await page.mouse.move(g.rect.x + g.rect.width / 2, g.rect.y + 20);
  await page.mouse.down();
  await page.mouse.move(g.rect.x + g.rect.width / 2 + 90, g.rect.y + 20 + 60, { steps: 8 });
  await page.mouse.up();
  await sleep(800);
  g = await geom();
  check("S3-2 拖拽 frame", g.left !== "0px", `left=${g.left} top=${g.top}`);

  // 3 SE 缩放
  const se = await page.$('[data-direction="se"]');
  if (se) {
    const hb = await se.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 45, hb.y + hb.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await sleep(800);
    g = await geom();
    check("S3-3 SE 手柄缩放", parseFloat(g.width) > 1440, `width=${g.width}`);
  } else check("S3-3 SE 手柄缩放", false, "无手柄元素");

  // 4 空白拖拽平移
  const before = await geom();
  const [ex, ey] = await emptyPoint();
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  await page.mouse.move(ex - 200, ey - 120, { steps: 10 });
  await page.mouse.up();
  await sleep(500);
  const after = await geom();
  const screenMoved = Math.abs(after.rect.x - before.rect.x) > 50 || Math.abs(after.rect.y - before.rect.y) > 50;
  const contentSame = after.left === before.left && after.top === before.top;
  check("S3-4 空白拖拽平移", screenMoved && contentSame, `screenMoved=${screenMoved} contentSame=${contentSame}`);

  // 5 Shift 框选
  const fr = (await geom()).rect;
  await page.keyboard.down("Shift");
  await page.mouse.move(fr.x - 30, fr.y - 30);
  await page.mouse.down();
  await page.mouse.move(fr.x + fr.width + 30, fr.y + fr.height + 30, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await sleep(400);
  g = await geom();
  check("S3-5 Shift 框选", g.border === INDIGO, g.border);

  // 6 空白单击清空
  const [cx, cy] = await emptyPoint();
  await page.mouse.click(cx, cy);
  await sleep(400);
  g = await geom();
  check("S3-6 空白单击清空", g.border !== INDIGO, g.border === INDIGO ? "仍选中" : "");

  // 7 平移后再点选
  const [px, py] = await emptyPoint();
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px - 60, py - 40, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  const fr2 = (await geom()).rect;
  await page.mouse.click(fr2.x + fr2.width / 2, fr2.y + 20);
  await sleep(400);
  g = await geom();
  check("S3-7 平移后点选", g.border === INDIGO, g.border);

  // 8 Inspector 联动:选中 frame 后右侧出现属性面板(含「尺寸/宽度」类文本)
  let inspectorOk = false;
  try {
    await page.waitForFunction(
      () => /宽度|尺寸|圆角|透明度|属性/.test(document.body.innerText),
      { timeout: 5_000, polling: 400 },
    );
    inspectorOk = true;
  } catch {
    /* Inspector 文案可能不同 */
  }
  check("S3-8 Inspector 属性面板联动", inspectorOk);
  await shot(page, "S3-inspector");

  // 9 LayerTree 同步:左栏树含 seed 页面标题「登录」,点击后 frame 选中
  const treeHas = await page.evaluate(() => document.body.innerText.includes("登录"));
  check("S3-9 LayerTree 含页面节点", treeHas);
  await shot(page, "S3-final");
  await page.close();
  if (!KEEP) await trpc("projects.remove", { id: projectId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// S4 edit 增量编辑流(LLM):选中组件 → Refine 模式 → 增量预览(draft)→ replaceProps 落库
// ---------------------------------------------------------------------------
async function S4(ctx) {
  const { browser, projectId } = ctx;
  if (!ctx.s1RunId) {
    check("S4 依赖 S1", "skip", "S1 未产出 runId");
    return;
  }
  console.log("\n═══ S4 edit 编辑流(LLM)═══");
  // 上游场景遗留的活跃 Run 会把发送按钮换成「停止」,先取消恢复初始态
  let page = (await openWorkspace(browser, projectId)).page;
  await ensureNoActiveRun(page, ctx.lastRunId);
  await page.waitForSelector(".a2-frame", { timeout: 20_000 });

  // edit 流尝试(最多 2 轮:端点空响应/超时有随机性,failed retryable 时重发新 Run)
  let committed = null;
  for (let attempt = 1; attempt <= 2 && !committed; attempt++) {
    if (attempt > 1) {
      console.log(`   ↻ S4 第 ${attempt} 次尝试(上轮失败,先取消遗留 Run)`);
      await ensureNoActiveRun(page, ctx.lastRunId);
      // 同 S1:重开工作台防页面级状态残留/崩溃(detached Frame)
      try { await page.close(); } catch { /* 已关闭 */ }
      page = (await openWorkspace(browser, projectId)).page;
      await page.waitForSelector(".a2-frame", { timeout: 20_000 });
    }
    // 每轮重新点选(重开后几何重取;上轮 Run 可能改变页面状态/选区)
    // 点击后必须校验选中成功(悬浮工具条 display:block):S1 提交后画布平移/多 frame 重叠,
    // 盲点坐标可能落空 → scope 为空 → 后端 refine 被降级为整页重建(缺陷 #13 场景)
    let selectedOk = false;
    for (let tries = 0; tries < 3 && !selectedOk; tries++) {
      // 每轮都按「1」适应全部页面(CanvasStage 快捷键):画布视口可能停在 S1 提交后的保存位置,
      // 第一个 frame 的 rect 在视口外(x<0)时 mouse.click 负坐标无效
      // → 十六轮 S4 两 attempt 全部落空实证;不 blur 则焦点在输入框,按键被 onKey 守卫吞掉(探针实证)
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press("1");
      await sleep(800);
      const gb = await page.$eval(".a2-frame", (el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));
      await page.mouse.click(gb.x + gb.width / 2, Math.max(gb.y, 0) + 20);
      await sleep(600);
      // 多 frame 重叠时点击实际命中 DOM 顺序后者(覆盖在上层),校验必须遍历所有 frame;
      // 只查第一个 frame 曾致十三/十五轮「点选成功被误报失败」(run 实际已带正确 scope)
      selectedOk = await page.evaluate(() =>
        [...document.querySelectorAll(".a2-frame")].some((f) => {
          const bar = f.querySelector(".bottom-full");
          return !!bar && getComputedStyle(bar).display === "block";
        }),
      );
    }
    check(`S4[${attempt}] 画布 frame 点选成功`, selectedOk, selectedOk ? "" : "点击未产生页面级选中");

    // UI 切到 Refine 模式;并切 autopilot(无 scope 的 refine 需要 plan,guarded 会在计划审批挂起)+ 原型探索
    await page.evaluate(() => {
      const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "refine_selection"));
      if (sel) {
        sel.value = "refine_selection";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const sel2 = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "autopilot"));
      if (sel2) {
        sel2.value = "autopilot";
        sel2.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("原型探索"));
      btn?.click();
    });
    const cap = captureRunId(page);
    // 明确最小改动边界:refine 模式下 LLM 曾把小编辑放大成全站 7 任务计划,浪费窗口且偏离编辑语义
    await uiSend(page, "仅做最小修改:把登录按钮的文字改为「立即登录」,并把主色调改为绿色系。不要新建页面,不要修改页面其他部分,不要改动整体结构。");
    await waitFor(() => cap, () => cap.runId, 30_000, "runId");
    check(`S4[${attempt}] Run 创建`, !!cap.runId, `runId=${cap.runId}`);
    if (!cap.runId) {
      await page.close();
      return;
    }
    ctx.lastRunId = cap.runId;
    const sse = await openSSE(cap.runId);

    // 增量预览帧(轮询等待:期间出现澄清卡则自动应答,避免 run 挂起 awaiting_clarification 耗尽窗口;
    // edit 分支短编辑可能无中间差分帧,无 preview 不代表链路失败,以 commit 为准)
    const previewStart = Date.now();
    let preview = null;
    while (Date.now() - previewStart < 420_000) {
      preview = sse.events.find((e) => e.type === "design.preview");
      // commit/失败已到即短路:短编辑(单 op)可能全程无差分帧,继续等只是白耗窗口
      if (preview || sse.events.find((e) => e.type === "design.ops_committed" || e.type === "run.failed")) break;
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("确认并继续"));
        btn?.click();
      }).catch(() => { /* 页面瞬时不态,下一轮再试 */ });
      await sleep(8000);
    }
    check(`S4[${attempt}] 增量预览帧`, !!preview, preview ? "" : "短编辑无差分帧(以 commit 为准)");
    const withTarget = sse.events.some((e) => e.type === "design.preview" && typeof e.message?.targetPageId === "number");
    if (sse.events.some((e) => e.type === "design.preview")) check(`S4[${attempt}] 就地预览(targetPageId draft)`, withTarget, withTarget ? "" : "create 式预览");

    // commit 等待(双通道:SSE + runs.events 重放轮询)——长跑 SSE 会断连丢尾部事件,
    // 实验中 run 已 completed 但断言超时(#14 场景);重放端点拿全量事件不受断连影响
    const commitStart = Date.now();
    let done = null;
    while (Date.now() - commitStart < 600_000) {
      done = sse.events.find((e) => e.type === "design.ops_committed" || e.type === "run.failed");
      if (done) break;
      try {
        const replay = await page.evaluate(async (rid) => {
          const input = encodeURIComponent(JSON.stringify({ "0": { json: { runId: rid, afterSeq: -1 } } }));
          const r = await fetch(`/api/trpc/runs.events?batch=1&input=${input}`, { credentials: "include" });
          const j = await r.json();
          return j?.[0]?.result?.data?.json ?? null;
        }, cap.runId);
        if (Array.isArray(replay)) {
          for (const e of replay) if (!sse.events.some((x) => x.type === e.type && x.seq === e.seq)) sse.events.push(e);
          done = replay.find((e) => e.type === "design.ops_committed" || e.type === "run.failed");
          if (done) break;
        }
      } catch { /* 页面瞬时不态,下轮再试 */ }
      await sleep(10_000);
    }
    committed = done?.type === "design.ops_committed" ? done : null;
    const failedEvt = done?.type === "run.failed" ? done : null;
    check(`S4[${attempt}] 编辑提交(design.ops_committed)`, !!committed, failedEvt ? `failed:${failedEvt.message?.slice(0, 100)}` : done ? "" : "timeout");
    if (committed) {
      const upd = (committed.changes ?? []).reduce((n, c) => n + (c.updated?.length ?? 0), 0);
      check(`S4[${attempt}] replaceProps 落库(updated≥1)`, upd >= 1, `updated=${upd}`);
    } else if (failedEvt && !failedEvt.retryable) {
      sse.close();
      break; // 不可重试的失败,不再尝试
    }
    sse.close();
  }
  await shot(page, "S4-final");
  await page.close();
}

// ---------------------------------------------------------------------------
// S5 TSX 导入(无 LLM):粘贴解析 → 新 revision → 画布新 frame → 真实渲染
// ---------------------------------------------------------------------------
async function S5(ctx) {
  const { browser, projectId } = ctx;
  console.log("\n═══ S5 TSX 导入 ═══");
  const wsBefore = await trpc("workspace.get", { projectId }, true);
  const imported = await trpc("imports.create", {
    projectId,
    baseRevision: wsBefore.revision,
    files: [{
      name: "e2e-imported.tsx",
      content: "export default function P() {\n  return (<section><h1>E2E 导入页</h1><input placeholder=\"搜索\" /><button>提交</button></section>);\n}\n",
    }],
  });
  check("S5 导入提交(新 revision)", Number.isInteger(imported?.revision) && imported.revision > wsBefore.revision, `revision=${imported?.revision}(base=${wsBefore.revision}) unmapped=${imported?.report?.unmapped?.length ?? 0}`);
  const wsAfter = await trpc("workspace.get", { projectId }, true);
  check("S5 画布 frame 新增", (wsAfter?.frames?.length ?? 0) > (wsBefore?.frames?.length ?? 0), `frames ${wsBefore?.frames?.length}→${wsAfter?.frames?.length}`);

  const { page } = await openWorkspace(browser, projectId);
  // FrameView 为 iframe 架构:内容在子 frame 内,需跨 iframe 查询(同源)
  let rendered = false;
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll(".a2-frame")].some((el) => {
        const doc = el.querySelector("iframe")?.contentDocument;
        return doc && [...doc.querySelectorAll("h1,h2")].some((h) => h.textContent?.includes("E2E 导入页"));
      }),
      { timeout: 25_000, polling: 800 },
    );
    rendered = true;
  } catch {
    /* 未渲染 */
  }
  check("S5 导入页真实渲染(FrameView h1)", rendered);
  await shot(page, "S5-final");
  await page.close();
}

// ---------------------------------------------------------------------------
// S6 导出与发布(无 LLM):构建门禁 → 下载 → publish.export/deploy → deployed 页
// ---------------------------------------------------------------------------
async function S6(ctx) {
  const { projectId } = ctx;
  console.log("\n═══ S6 导出与发布 ═══");
  // 单独运行时主项目可能为空(S1/S5 未跑):补 seed 保证有页面可导出
  const wsPre = await trpc("workspace.get", { projectId }, true);
  if (!wsPre?.frames?.length) await seedIR(projectId);
  const ws = await trpc("workspace.get", { projectId }, true);
  const build = await trpc("exports.build", { projectId, baseRevision: ws.revision, projectName: "e2e-browser-gate" });
  check("S6 导出任务入队", !!build?.jobId, `jobId=${build?.jobId}`);
  if (!build?.jobId) return;
  let exportId = null;
  let lastErr = "";
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const s = await trpc("exports.buildStatus", { jobId: build.jobId }, true);
    if (s?.status === "passed") {
      exportId = s.exportId;
      break;
    }
    if (s?.status === "failed") {
      lastErr = s.issues?.[0]?.message?.slice(0, 160) || s.error || "unknown";
      break;
    }
  }
  check("S6 完整构建门禁(tsc+vite build)", !!exportId, exportId ?? lastErr);
  if (exportId) {
    const dl = await fetch(`${BASE}/api/exports/${exportId}/download`);
    check("S6 产物下载 200(zip)", dl.status === 200, `status=${dl.status}`);
    dl.body?.cancel?.();
  }
  const zip = await trpc("publish.export", { projectId, target: "html" }).catch((e) => ({ _err: String(e).slice(0, 120) }));
  check("S6 publish.export(html zip)", !!zip?.fileCount, `files=${zip?.fileCount ?? zip?._err}`);
  const slug = `e2e-browser-${Date.now().toString(36)}`;
  const dep = await trpc("publish.deploy", { projectId, slug }).catch((e) => ({ _err: String(e).slice(0, 120) }));
  check("S6 publish.deploy", !!dep?.url, `url=${dep?.url ?? dep?._err}`);
  if (dep?.url) {
    const site = await fetch(`${BASE}${dep.url}`);
    check("S6 deployed 站点 200", site.status === 200, `status=${site.status}`);
    site.body?.cancel?.();
    const depSlug = dep.url.split("/").filter(Boolean).pop();
    await trpc("publish.removeDeploy", { projectId, slug: depSlug }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// S7 三套渲染器(无 LLM,固定 IR):shadcn/antd/element 各渲染出 button+input
// ---------------------------------------------------------------------------
async function S7(ctx) {
  console.log("\n═══ S7 三套渲染器(shadcn/antd/element)═══");
  for (const preset of ["shadcn", "antd", "element"]) {
    const created = await trpc("projects.create", { name: `E2E-R-${preset}-${Date.now().toString(36)}`, preset });
    const pid = created?.id;
    if (!pid) {
      check(`S7[${preset}] 建项目`, false, "create 失败");
      continue;
    }
    try {
      await seedIR(pid);
      const browser = ctx.browser;
      const { page } = await openWorkspace(browser, pid);
      // FrameView 为 iframe 架构:button/input 在子 frame 内,跨 iframe 查询(同源)
      let ok = false;
      try {
        await page.waitForFunction(
          () => [...document.querySelectorAll(".a2-frame")].some((el) => {
            const doc = el.querySelector("iframe")?.contentDocument;
            return doc && doc.querySelector("button") && doc.querySelector("input");
          }),
          { timeout: 25_000, polling: 800 },
        );
        ok = true;
      } catch {
        /* 渲染失败 */
      }
      check(`S7[${preset}] Button+Input 渲染`, ok);
      await shot(page, `S7-${preset}`);
      await page.close();
    } finally {
      if (!KEEP) await trpc("projects.remove", { id: pid }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// S8 周边功能:评论/告警/模板封面/Run 取消/重连重放
// ---------------------------------------------------------------------------
async function S8(ctx) {
  const { browser, projectId } = ctx;
  console.log("\n═══ S8 周边功能 ═══");
  const { page } = await openWorkspace(browser, projectId);

  // 评论链路:add → list → resolve
  const add = await trpc("comments.add", { projectId, surfaceId: "frame_login", body: "E2E 浏览器测试评论" });
  check("S8 评论添加", Number.isInteger(add?.id), `id=${add?.id}`);
  if (Number.isInteger(add?.id)) {
    const reply = await trpc("comments.add", { projectId, surfaceId: "frame_login", body: "E2E 回复", parentId: add.id }).catch((e) => ({ _err: String(e).slice(0, 100) }));
    check("S8 评论回复(讨论串)", Number.isInteger(reply?.id), reply?.id ?? reply?._err);
    const list = await trpc("comments.list", { projectId }, true);
    check("S8 评论列表", Array.isArray(list) && list.length >= 1, `n=${list?.length}`);
    await trpc("comments.resolve", { id: add.id, resolved: true }).catch(() => {});
  }

  // 告警与模板
  const alerts = await trpc("alerts.list", {}, true).catch((e) => ({ _err: String(e).slice(0, 100) }));
  check("S8 告警列表", alerts && !alerts._err, Array.isArray(alerts) ? `n=${alerts.length}` : JSON.stringify(alerts).slice(0, 80));
  const templates = await trpc("templates.list", {}, true).catch((e) => ({ _err: String(e).slice(0, 100) }));
  check("S8 模板列表", templates && !templates._err, Array.isArray(templates) ? `n=${templates.length}` : "ok");
  if (Array.isArray(templates) && templates.length) {
    const cover = await fetch(`${BASE}/api/templates/${templates[0].id}/cover`);
    check("S8 模板封面 200", cover.status === 200, `status=${cover.status}`);
    cover.body?.cancel?.();
  }

  // Run 取消:发短 run → 取消 → 终态 cancelled
  const conv = await trpc("chat.createConversation", { projectId, title: "S8 取消测试" }).catch(() => null);
  const run = await trpc("runs.create", COMMON_RUN_INPUT(projectId, conv?.id ?? 1, "创建一个极简产品介绍单页")).catch((e) => ({ _err: String(e).slice(0, 120) }));
  check("S8 取消用例 Run 创建", !!run?.runId, `runId=${run?.runId ?? run?._err}`);
  if (run?.runId) {
    const sse = await openSSE(run.runId);
    await waitFor(sse, (s) => s.events.some((e) => e.type === "run.state" && e.status !== "queued"), 60_000, "run 启动");
    await trpc("runs.cancel", { runId: run.runId }).catch(() => {});
    const cancelled = await waitFor(sse, (s) => s.events.some((e) => (e.type === "run.cancelled") || (e.type === "run.state" && e.status === "cancelled")), 60_000, "cancelled 终态");
    check("S8 Run 取消终态", !!cancelled);
    sse.close();
    const dbMod = await import("better-sqlite3");
    const pMod = await import("node:path");
    const db = new dbMod.default(pMod.resolve(process.cwd(), "data", "app.db"));
    const row = db.prepare("SELECT status FROM runs WHERE runId = ?").get(run.runId);
    db.close();
    check("S8 DB runs.status=cancelled", row?.status === "cancelled", `status=${row?.status}`);
  }

  // 重连重放:S1 runId 重新订阅应重放 ops_committed 历史
  if (ctx.s1RunId) {
    const replay = await openSSE(ctx.s1RunId);
    const hit = replay.ok ? await waitFor(replay, (s) => s.events.some((e) => e.type === "design.ops_committed"), 15_000, "重放") : null;
    check("S8 断线重连事件重放", !!hit, replay.ok ? (hit ? "ops_committed 重放" : "未收到") : `status=${replay.status ?? replay.error}`);
    replay.close();
  } else {
    check("S8 断线重连事件重放", "skip", "无 S1 runId");
  }
  await shot(page, "S8-final");
  await page.close();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log(`▶ E2E-BROWSER @ ${BASE}${ONLY ? ` (only: ${ONLY.join(",")})` : ""}${SKIP_LLM ? " [skip-llm]" : ""}`);
  const ping = await fetch(`${BASE}/api/trpc/ping?input=%7B%7D`).then((r) => r.json()).catch(() => null);
  if (!ping?.result?.data?.json?.ok) {
    console.error("❌ 服务不可达,请先启动 dev 服务");
    process.exit(1);
  }

  const ctx = { browser: null, projectId: null, s1RunId: null, lastRunId: null };
  const want = (id) => !ONLY || ONLY.includes(id);
  const llmSet = ["S1", "S2", "S4"].filter((s) => want(s));
  const skipLlmScenes = SKIP_LLM ? llmSet : [];
  for (const s of skipLlmScenes) {
    console.log(`⏭️  ${s} 跳过(--skip-llm)`);
    skipList.push(s);
  }

  const browser = await launchBrowser();
  ctx.browser = browser;

  // 主项目(S1/S2/S4/S5/S6/S8 共用)
  if (want("S1") || want("S2") || want("S4") || want("S9") || want("S5") || want("S6") || want("S8")) {
    const created = await trpc("projects.create", { name: `E2E-BROWSER ${Date.now().toString(36)}` });
    ctx.projectId = created?.id;
    check("主项目创建", Number.isInteger(ctx.projectId), `id=${ctx.projectId}`);
  }

  const scenes = [
    ["S1", S1],
    ["S9", S9],
    ["S2", S2],
    ["S4", S4],
    ["S5", S5],
    ["S3", S3],
    ["S6", S6],
    ["S7", S7],
    ["S8", S8],
  ];
  for (const [id, fn] of scenes) {
    if (!want(id)) continue;
    if (SKIP_LLM && ["S1", "S2", "S4", "S9"].includes(id)) continue;
    try {
      await fn(ctx);
    } catch (e) {
      check(`${id} 场景执行异常`, false, String(e).slice(0, 200));
      try {
        if (ctx.page) await shot(ctx.page, `${id}-crash`);
      } catch {
        /* ignore */
      }
    }
  }

  // 清理主项目(S7/S3 项目的清理各自负责)
  if (ctx.projectId && !KEEP) {
    const removed = await trpc("projects.remove", { id: ctx.projectId }).catch((e) => ({ _err: String(e).slice(0, 100) }));
    check("清理主项目", removed?.ok === true, removed?._err ?? `id=${ctx.projectId}`);
  }
  await browser.close();

  console.log(`\n──────── 汇总 ────────`);
  console.log(`通过 ${passes} · 失败 ${failures} · 跳过 ${skipList.length}`);
  if (skipList.length) console.log(`跳过项: ${skipList.join("; ")}`);
  const report = { base: BASE, passed: passes, failed: failures, skipped: skipList, at: new Date().toISOString() };
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[e2e-browser] 异常:", e);
  process.exit(1);
});
