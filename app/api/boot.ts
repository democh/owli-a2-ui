import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { z } from "zod";
import { appRouter } from "./router";
import { createContext, requireLocalUser } from "./context";
import { executeChatGenerate } from "./routers/studio";
import { imageRefSchema } from "@contracts/a2ui";
import { env } from "./lib/env";

const app = new Hono<{ Bindings: HttpBindings }>();

// 请求体上限 10MB:正常请求(SSE 提示词 / 批量撤销快照)在 KB~低 MB 级,50MB 只会放大 DoS 面
app.use(bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// ---------------------------------------------------------------------------
// SSE 流式对话生成:实时推送 Agent 执行步骤,结束时下发完整结果
// 事件: step(执行步骤) / result(最终结果) / error(失败)
// ---------------------------------------------------------------------------
const streamBodySchema = z.object({
  projectId: z.number(),
  prompt: z.string().min(1).max(4000),
  chips: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("page"), pageId: z.string(), title: z.string() }),
        z.object({ kind: z.literal("element"), pageId: z.string(), aid: z.string(), label: z.string() }),
      ]),
    )
    .default([]),
  conversationId: z.number().nullish(),
  /** 参考图片(服务端会按 vision 设置二次过滤;最多 3 张) */
  images: z.array(imageRefSchema).max(3).optional(),
  /** 图片缩略 dataUrl,仅用于消息持久化回显 */
  imageThumbs: z.array(z.string().max(300_000)).max(3).optional(),
});

app.post("/api/chat/stream", async (c) => {
  let user;
  try {
    user = await requireLocalUser();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  const parsed = streamBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad request" }, 400);
  const params = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch { /* 客户端已断开 */ }
      };
      try {
        const out = await executeChatGenerate(
          user.id,
          { ...params, signal: c.req.raw.signal },
          (step) => send({ type: "step", step }),
          (draft) => send({ type: "draft", mode: draft.mode, pageId: draft.pageId, delta: draft.delta }),
        );
        send({
          type: "result",
          result: out.result,
          plan: out.plan ?? null,
          appliedPages: out.appliedPages,
          conversationId: out.conversationId,
        });
      } catch (e) {
        send({ type: "error", message: (e as Error).message.slice(0, 300) });
      } finally {
        try { controller.close(); } catch { /* ignore */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
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
