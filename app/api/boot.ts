import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext, requireLocalUser } from "./context";
import { env } from "./lib/env";

const app = new Hono<{ Bindings: HttpBindings }>();

// 请求体上限 10MB:正常请求(SSE 提示词 / 批量撤销快照)在 KB~低 MB 级,50MB 只会放大 DoS 面
app.use(bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// 导出产物下载(M5):/api/exports/:exportId/download
app.get("/api/exports/:exportId/download", async (c) => {
  try {
    await requireLocalUser();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  const exportId = c.req.param("exportId");
  if (!/^exp_[a-z0-9_]+$/.test(exportId)) return c.notFound(); // id 格式 exp_<ts36>_<rand36>,允许下划线
  const { getDb } = await import("./queries/connection");
  const { exportFiles } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const row = getDb()
    .select()
    .from(exportFiles)
    .where(eq(exportFiles.exportId, exportId))
    .limit(1)
    .get();
  if (!row) return c.notFound();
  const { readFile } = await import("fs/promises");
  try {
    const buf = await readFile(row.zipPath);
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${row.exportId}.zip"`,
    });
  } catch {
    return c.notFound();
  }
});

// 模板封面(M7 模板库):/api/templates/:templateId/cover → 首页静态 HTML 缩略
// 无封面的老模板在首次访问时按需懒生成并回写
app.get("/api/templates/:templateId/cover", async (c) => {
  try {
    await requireLocalUser();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  const templateId = c.req.param("templateId");
  if (!/^tpl_[a-z0-9_]+$/.test(templateId)) return c.notFound();
  const { getDb } = await import("./queries/connection");
  const { irTemplates } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const db = getDb();
  const row = db.select().from(irTemplates).where(eq(irTemplates.templateId, templateId)).limit(1).get();
  if (!row) return c.notFound();
  let coverHtml = row.coverHtml;
  if (!coverHtml) {
    const { generateTemplateCoverHtml } = await import("./templates/cover");
    coverHtml = generateTemplateCoverHtml(row.name, JSON.parse(row.doc)) ?? "";
    if (coverHtml) {
      db.update(irTemplates).set({ coverHtml }).where(eq(irTemplates.templateId, templateId)).run();
    } else {
      return c.notFound();
    }
  }
  return c.html(coverHtml);
});

// Run 事件流 SSE(文档 §14.3 断线恢复;/api/runs/:runId/stream,客户端见 src/lib/runStream.ts)
// 连接即重放 run_events 历史 + 订阅实时推送;订阅与重放间隙的重叠事件由客户端 seq 去重兜底
app.get("/api/runs/:runId/stream", async (c) => {
  try {
    await requireLocalUser();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  const runId = c.req.param("runId");
  if (!/^run_[a-z0-9_]+$/.test(runId)) return c.notFound();
  const { getDb } = await import("./queries/connection");
  const { runs: runsTable } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const row = getDb()
    .select({ projectId: runsTable.projectId })
    .from(runsTable)
    .where(eq(runsTable.runId, runId))
    .limit(1)
    .get();
  if (!row) return c.notFound();
  const user = await requireLocalUser();
  const { requireProjectRole } = await import("./queries/projects");
  try {
    await requireProjectRole(user.id, row.projectId, "viewer");
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
  const { RunManager } = await import("./agent/run/RunManager");
  const { isTerminal } = await import("./agent/run/RunStateMachine");
  return streamSSE(c, async (stream) => {
    let open = true;
    // 先订阅后重放:间隙期实时事件可能与历史重叠,客户端按 seq 去重幂等
    const unsub = RunManager.subscribe(runId, (e) => {
      if (open) stream.writeSSE({ data: JSON.stringify(e) }).catch(() => {});
    });
    stream.onAbort(() => {
      open = false;
      unsub();
    });
    const history = RunManager.replay(runId);
    for (const e of history) {
      if (!open) return;
      await stream.writeSSE({ data: JSON.stringify(e) });
    }
    // 服务重启截断:内存执行态已丢且历史未达终态 → 补发合成失败事件,避免客户端无限等待
    const last = history[history.length - 1];
    // 终态判定:显式终态事件类型,或 run.state 已迁移至终态状态(状态机路径以 run.state 收尾)
    const lastStatus = last?.type === "run.state" ? last.status : undefined;
    const reachedTerminal =
      !!last && (last.type === "design.explanation" || last.type === "run.cancelled" || last.type === "run.failed" || (lastStatus != null && isTerminal(lastStatus)));
    if (!RunManager.context(runId) && !reachedTerminal) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "run.failed", runId, seq: (last?.seq ?? -1) + 1, message: "服务已重启,本次运行中断", retryable: false }),
      });
    }
    while (open) {
      await stream.sleep(15_000); // 保活
    }
  });
});

// 部署产物静态托管:/deployed/{projectId}/{slug}[/file]
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  json: "application/json", md: "text/markdown; charset=utf-8", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ico: "image/x-icon",
  woff2: "font/woff2", txt: "text/plain; charset=utf-8",
};
const deployedHandler = async (c: Context<{ Bindings: HttpBindings }>) => {
  const { projectId, slug } = c.req.param();
  if (!/^\d+$/.test(projectId) || !/^[a-zA-Z0-9_-]+$/.test(slug)) return c.notFound();
  const wild = c.req.path.split(`/deployed/${projectId}/${slug}/`)[1] ?? "";
  // c.req.path 是 percent-encoded,先解码再校验;slugify 允许 CJK 文件名
  let rel = wild.replace(/^\/+/, "");
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return c.notFound();
  }
  rel = rel || "index.html";
  if (!/^[\w./\-一-鿿]+$/.test(rel) || rel.includes("..")) return c.notFound();
  const { readFile } = await import("fs/promises");
  const path = await import("path");
  const file = path.resolve(process.cwd(), "data", "deploys", projectId, slug, rel);
  const root = path.resolve(process.cwd(), "data", "deploys", projectId, slug);
  if (!file.startsWith(root)) return c.notFound();
  try {
    const buf = await readFile(file);
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    return c.body(new Uint8Array(buf), 200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  } catch {
    return c.notFound();
  }
};
app.get("/deployed/:projectId/:slug", deployedHandler);
app.get("/deployed/:projectId/:slug/*", deployedHandler);
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3002");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
