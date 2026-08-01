import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { rm } from "fs/promises";
import path from "path";
import { authedQuery, createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { requireProject } from "../queries/projects";
import { env } from "../lib/env";
import { conversations, deploys, llmCalls, messages, pages, projects, userSettings, versions } from "@db/schema";
import type { ChatAction, ChatGenerateResult, ChatStep, DeviceId, ImageRef, PresetId, SurfaceDoc, VisionSetting } from "@contracts/a2ui";
import { applyOps, chatActionSchema, DEVICE_IDS, imageRefSchema, planFromActions, PRESET_IDS, resolveVision, surfaceDocSchema } from "@contracts/a2ui";
import { runAnalyze, runPipeline, type DraftChunk, type PipelineInput } from "../llm/pipeline";
import type { ChatTurn } from "../llm/prompts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/** 新项目起始页:静态欢迎页(一次性写死的默认资产,非模板引擎) */
const STARTER_SURFACE: SurfaceDoc = {
  version: "1.0",
  page: { id: "page", title: "首页", device: "desktop" },
  theme: {
    preset: "shadcn",
    tokens: { primary: "#4f46e5", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#4f46e5", radius: 10, font: "" },
  },
  components: {
    n1: { type: "Col", props: { gap: 0 }, children: ["n2", "n3", "n4"] },
    n2: { type: "Navbar", props: { logo: "A2UI", links: ["产品", "文档", "定价", "关于"], cta: "开始设计" }, children: [] },
    n3: {
      type: "Hero",
      props: {
        badge: "AI 驱动的页面设计工作台",
        title: "用一句话，生成完整页面",
        subtitle: "在右侧 Agent 面板描述你想要的页面，大模型会逐 token 流式生成并实时渲染到画布。",
        primaryCta: "开始生成",
        secondaryCta: "查看示例",
      },
      children: [],
    },
    n4: {
      type: "Footer",
      props: {
        logo: "A2UI",
        copyright: "© 2026 A2UI Studio",
        groups: [
          { title: "产品", links: ["功能", "定价", "更新日志"] },
          { title: "资源", links: ["文档", "组件目录", "快捷键"] },
        ],
      },
      children: [],
    },
  },
  root: "n1",
};

/** 数据库中损坏的 surface JSON 兜底(保底可渲染,不再走模板引擎) */
function parseSurface(raw: string): SurfaceDoc {
  try {
    return surfaceDocSchema.parse(JSON.parse(raw));
  } catch {
    return STARTER_SURFACE;
  }
}
/** 历史数据可能存了已下线的预设(如 astryx),统一归一化 */
const normalizePreset = (p: string): PresetId =>
  (PRESET_IDS as string[]).includes(p) ? (p as PresetId) : "shadcn";

type Db = ReturnType<typeof getDb>;

/** 自动快照保留上限(AI 生成 / 回滚前快照);用户手动保存的 manual 快照永久保留 */
const AUTO_SNAPSHOT_KEEP = 30;

/**
 * 打版本快照(同步执行,可在事务内调用)
 * auto 快照超出保留上限时,按 id 从新到旧裁剪最旧的
 * 导出供 publish 路由在部署成功后打「部署快照」
 */
export function snapshotVersion(db: Db, projectId: number, label: string, kind: "auto" | "manual" = "auto") {
  const allPages = db.select().from(pages).where(eq(pages.projectId, projectId)).all();
  db.insert(versions).values({
    projectId,
    label,
    kind,
    snapshot: JSON.stringify({ pages: allPages }),
  }).run();
  if (kind !== "auto") return;
  const autoRows = db
    .select({ id: versions.id })
    .from(versions)
    .where(and(eq(versions.projectId, projectId), eq(versions.kind, "auto")))
    .orderBy(desc(versions.id))
    .all();
  const stale = autoRows.slice(AUTO_SNAPSHOT_KEEP).map((r) => r.id);
  if (stale.length) db.delete(versions).where(inArray(versions.id, stale)).run();
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------
export const projectsRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, ctx.user.id))
      .orderBy(desc(projects.updatedAt));
    if (!rows.length) return [];
    const projectIds = rows.map((p) => p.id);
    // 聚合查询替代逐项目 N+1:一次取页面计数,一次取各项目首页(缩略用)
    const counts = await db
      .select({ projectId: pages.projectId, count: sql<number>`count(*)` })
      .from(pages)
      .where(inArray(pages.projectId, projectIds))
      .groupBy(pages.projectId);
    const countMap = new Map(counts.map((c) => [c.projectId, c.count]));
    const firstIds = await db
      .select({ id: sql<number>`min(${pages.id})` })
      .from(pages)
      .where(inArray(pages.projectId, projectIds))
      .groupBy(pages.projectId);
    const firstPages = firstIds.length
      ? await db
          .select({ projectId: pages.projectId, surface: pages.surface })
          .from(pages)
          .where(inArray(pages.id, firstIds.map((r) => r.id)))
      : [];
    const thumbMap = new Map(firstPages.map((p) => [p.projectId, p.surface]));
    return rows.map((p) => {
      const thumb = thumbMap.get(p.id);
      return {
        ...p,
        pageCount: countMap.get(p.id) ?? 0,
        thumbSurface: thumb ? parseSurface(thumb) : null,
      };
    });
  }),

  create: authedQuery
    .input(z.object({ name: z.string().min(1).max(100), preset: z.enum(PRESET_IDS as [PresetId, ...PresetId[]]).default("shadcn") }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // 事务:项目 + 起始页 + 初始快照,任一步失败整体回滚
      const projectId = db.transaction((tx) => {
        const r = tx.insert(projects).values({ userId: ctx.user.id, name: input.name, preset: input.preset }).run();
        const pid = Number(r.lastInsertRowid);
        // 起始页:静态欢迎页,引导用户在 Agent 面板用 LLM 生成
        tx.insert(pages).values({
          projectId: pid,
          title: STARTER_SURFACE.page.title,
          device: STARTER_SURFACE.page.device,
          surface: JSON.stringify(STARTER_SURFACE),
          posX: 0,
          posY: 0,
          width: 1440,
          height: 900,
        }).run();
        snapshotVersion(tx as unknown as Db, pid, "项目创建");
        return pid;
      });
      return { id: projectId };
    }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx.user.id, input.id);
      const db = getDb();
      const pPages = await db
        .select()
        .from(pages)
        .where(eq(pages.projectId, project.id))
        .orderBy(pages.id);
      return {
        ...project,
        preset: normalizePreset(project.preset),
        pages: pPages.map((p) => ({ ...p, surface: parseSurface(p.surface) })),
      };
    }),

  update: authedQuery
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(100).optional(),
      preset: z.enum(PRESET_IDS as [PresetId, ...PresetId[]]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.id);
      const db = getDb();
      await db.update(projects)
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.preset ? { preset: input.preset } : {}),
        })
        .where(eq(projects.id, input.id));
      return { ok: true };
    }),

  remove: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.id);
      const db = getDb();
      const pPages = await db.select({ id: pages.id }).from(pages).where(eq(pages.projectId, input.id));
      // 事务:消息 → 会话 → 版本 → 页面 → 部署记录 → 项目,任一步失败整体回滚
      db.transaction((tx) => {
        const convs = tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.projectId, input.id)).all();
        for (const c of convs) tx.delete(messages).where(eq(messages.conversationId, c.id)).run();
        tx.delete(conversations).where(eq(conversations.projectId, input.id)).run();
        tx.delete(versions).where(eq(versions.projectId, input.id)).run();
        tx.delete(llmCalls).where(eq(llmCalls.projectId, input.id)).run();
        tx.delete(pages).where(eq(pages.projectId, input.id)).run();
        tx.delete(deploys).where(eq(deploys.projectId, input.id)).run();
        tx.delete(projects).where(eq(projects.id, input.id)).run();
      });
      // 部署产物目录:事务提交后尽力清理(文件系统不参与事务)
      await rm(path.resolve(process.cwd(), "data", "deploys", String(input.id)), { recursive: true, force: true }).catch(() => {});
      return { ok: true, removed: pPages.length };
    }),
});

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
export const pagesRouter = createRouter({
  update: authedQuery
    .input(z.object({
      id: z.number(),
      projectId: z.number(),
      title: z.string().max(100).optional(),
      device: z.enum(DEVICE_IDS as [DeviceId, ...DeviceId[]]).optional(),
      posX: z.number().optional(),
      posY: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      surface: surfaceDocSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      const { id, surface, ...rest } = input;
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined && k !== "projectId") set[k] = v;
      if (surface) set.surface = JSON.stringify(surface);
      // 限定 projectId,防止跨项目改页面
      await db.update(pages).set(set).where(and(eq(pages.id, id), eq(pages.projectId, input.projectId)));
      return { ok: true };
    }),

  /** 批量更新(撤销/重做持久化用):单事务内完成,任一页失败整体回滚 */
  batchUpdate: authedQuery
    .input(z.object({
      projectId: z.number(),
      pages: z.array(z.object({
        id: z.number(),
        title: z.string().max(100).optional(),
        device: z.enum(DEVICE_IDS as [DeviceId, ...DeviceId[]]).optional(),
        posX: z.number().optional(),
        posY: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        surface: surfaceDocSchema.optional(),
      })).min(1).max(50),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      db.transaction((tx) => {
        for (const p of input.pages) {
          const { id, surface, ...rest } = p;
          const set: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rest)) if (v !== undefined && k !== "projectId") set[k] = v;
          if (surface) set.surface = JSON.stringify(surface);
          if (Object.keys(set).length)
            tx.update(pages).set(set).where(and(eq(pages.id, id), eq(pages.projectId, input.projectId))).run();
        }
      });
      return { ok: true, updated: input.pages.length };
    }),

  remove: authedQuery
    .input(z.object({ id: z.number(), projectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      await getDb().delete(pages).where(eq(pages.id, input.id));
      return { ok: true };
    }),

  duplicate: authedQuery
    .input(z.object({ id: z.number(), projectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      const rows = await db.select().from(pages).where(eq(pages.id, input.id)).limit(1);
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND" });
      const src = rows[0];
      const r = await db.insert(pages).values({
        projectId: input.projectId,
        title: `${src.title} 副本`,
        device: src.device,
        surface: src.surface,
        posX: src.posX + src.width + 120,
        posY: src.posY,
        width: src.width,
        height: src.height,
      });
      return { id: Number(r.lastInsertRowid) };
    }),
});

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------
export const versionsRouter = createRouter({
  list: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      return getDb().select({
        id: versions.id, label: versions.label, createdAt: versions.createdAt,
      }).from(versions).where(eq(versions.projectId, input.projectId)).orderBy(desc(versions.id));
    }),

  /** 读取单个版本的快照内容(供前端 diff 对比;surface 已解析) */
  get: authedQuery
    .input(z.object({ id: z.number(), projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const rows = await getDb().select().from(versions)
        .where(and(eq(versions.id, input.id), eq(versions.projectId, input.projectId))).limit(1);
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "版本不存在" });
      const snap = JSON.parse(rows[0].snapshot) as { pages: (typeof pages.$inferSelect)[] };
      // 快照可能来自旧 schema 版本:解析失败的页面跳过(diff 中显示为「删除」),
      // 不走 STARTER fallback,否则 diff 会显示整页虚假变化
      const snapPages = snap.pages.flatMap((p) => {
        try {
          return [{ id: p.id, title: p.title, surface: surfaceDocSchema.parse(JSON.parse(p.surface)) }];
        } catch {
          return [];
        }
      });
      return {
        id: rows[0].id,
        label: rows[0].label,
        createdAt: rows[0].createdAt,
        pages: snapPages,
      };
    }),

  save: authedQuery
    .input(z.object({ projectId: z.number(), label: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      // 手动保存的快照永久保留,不受自动快照限额裁剪
      snapshotVersion(getDb(), input.projectId, input.label, "manual");
      return { ok: true };
    }),

  restore: authedQuery
    .input(z.object({ id: z.number(), projectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      // 版本必须属于当前项目(防止跨项目恢复)
      const rows = await db.select().from(versions)
        .where(and(eq(versions.id, input.id), eq(versions.projectId, input.projectId))).limit(1);
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "版本不存在" });
      const snap = JSON.parse(rows[0].snapshot) as { pages: (typeof pages.$inferSelect)[] };
      // 事务:回滚前快照 + 清页 + 按原 id 重建。保留原页面 id,
      // 画布选中态 / 对话 chips / 撤销栈中的 pageId 在恢复后依然有效
      db.transaction((tx) => {
        snapshotVersion(tx as unknown as Db, input.projectId, "回滚前自动快照");
        tx.delete(pages).where(eq(pages.projectId, input.projectId)).run();
        for (const p of snap.pages) {
          tx.insert(pages).values({
            id: p.id,
            projectId: input.projectId,
            title: p.title, device: p.device, surface: p.surface,
            posX: p.posX, posY: p.posY, width: p.width, height: p.height,
          }).run();
        }
      });
      return { ok: true };
    }),

  remove: authedQuery
    .input(z.object({ id: z.number(), projectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      await getDb().delete(versions).where(eq(versions.id, input.id));
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// 用户设置(LLM Provider)
// ---------------------------------------------------------------------------
/** API Key 脱敏提示:只暴露前 3 位 + 后 4 位,完整 Key 不出服务端 */
function maskKey(key: string): string {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "已配置";
}

export const settingsRouter = createRouter({
  get: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, ctx.user.id)).limit(1);
    // 完整 Key 永不返回前端:apiKey 恒为空串,用 hasApiKey + apiKeyHint 表达配置状态
    // 仅支持 kimi 通道(OpenAI 兼容协议,可指向 Kimi / DeepSeek / GPT 等任意兼容服务)
    if (!rows.length) {
      return {
        provider: "kimi",
        apiKey: "",
        hasApiKey: !!env.kimiApiKey,
        apiKeyHint: maskKey(env.kimiApiKey),
        baseUrl: env.kimiBaseUrl,
        model: env.kimiModel,
        vision: "auto" as VisionSetting,
        supportsImages: resolveVision("auto", "kimi", env.kimiModel),
      };
    }
    const s = rows[0];
    // 历史数据可能存了已下线的 anthropic/builtin,统一归一化为 kimi
    const provider = "kimi";
    const envCfg = { key: env.kimiApiKey, baseUrl: env.kimiBaseUrl, model: env.kimiModel };
    // 未保存个人 Key 时整套走 env 兜底:Key 与 BaseUrl/Model 必须同源,
    // 混用会出现「env 的 Key 发到设置里的旧端点」导致 401
    const useEnv = !s.llmApiKey;
    const effectiveKey = s.llmApiKey || envCfg.key;
    const model = useEnv ? envCfg.model : s.llmModel || envCfg.model;
    const vision = (s.llmVision ?? "auto") as VisionSetting;
    return {
      provider,
      apiKey: "",
      hasApiKey: !!effectiveKey,
      apiKeyHint: maskKey(effectiveKey),
      baseUrl: useEnv ? envCfg.baseUrl : s.llmBaseUrl || envCfg.baseUrl,
      model,
      vision,
      supportsImages: resolveVision(vision, provider, model),
    };
  }),

  update: authedQuery
    .input(z.object({
      provider: z.literal("kimi").default("kimi"),
      /** 留空 = 保留已保存的 Key 不修改 */
      apiKey: z.string().max(200),
      baseUrl: z.string().url().max(255),
      model: z.string().max(64),
      /** 图片对话能力开关;缺省保持原值 */
      vision: z.enum(["auto", "on", "off"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.select().from(userSettings).where(eq(userSettings.userId, ctx.user.id)).limit(1);
      const nextKey = input.apiKey || rows[0]?.llmApiKey || null;
      if (!rows.length) {
        await db.insert(userSettings).values({
          userId: ctx.user.id, llmProvider: input.provider,
          llmApiKey: nextKey, llmBaseUrl: input.baseUrl, llmModel: input.model,
          llmVision: input.vision ?? "auto",
        });
      } else {
        await db.update(userSettings).set({
          llmProvider: input.provider, llmApiKey: nextKey,
          llmBaseUrl: input.baseUrl, llmModel: input.model,
          ...(input.vision ? { llmVision: input.vision } : {}),
        }).where(eq(userSettings.userId, ctx.user.id));
      }
      return { ok: true };
    }),
});

// ---------------------------------------------------------------------------
// 对话生成
// ---------------------------------------------------------------------------
const chipSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), pageId: z.string(), title: z.string() }),
  z.object({ kind: z.literal("element"), pageId: z.string(), aid: z.string(), label: z.string() }),
]);

async function buildPipelineInput(ctx: { user: { id: number } }, projectId: number, prompt: string, chips: PipelineInput["chips"], images?: ImageRef[]): Promise<{ input: PipelineInput; project: typeof projects.$inferSelect }> {
  const project = await requireProject(ctx.user.id, projectId);
  const db = getDb();
  const pPages = await db.select().from(pages).where(eq(pages.projectId, project.id)).orderBy(pages.id);
  const parsedPages = pPages.map((p) => ({ ...p, surface: parseSurface(p.surface) }));
  const settingRows = await db.select().from(userSettings).where(eq(userSettings.userId, ctx.user.id)).limit(1);
  const s = settingRows[0];
  // 历史数据可能存了已下线的 anthropic,统一归一化为 kimi(OpenAI 兼容通道)
  const provider = "kimi";
  const envCfg = { key: env.kimiApiKey, baseUrl: env.kimiBaseUrl, model: env.kimiModel };
  // 与 settings.get 同源策略:无个人 Key 时整套走 env,避免跨服务混用
  const useEnv = !s?.llmApiKey;
  const llm = {
    provider,
    apiKey: s?.llmApiKey || envCfg.key || null,
    baseUrl: useEnv ? envCfg.baseUrl : s?.llmBaseUrl || envCfg.baseUrl,
    model: useEnv ? envCfg.model : s?.llmModel || envCfg.model,
    maxTokens: env.llmMaxTokens,
  };
  // 图片对话:按用户 vision 设置 + 模型能力解析;关闭时图片直接丢弃(消息也不留缩略图)
  const vision = resolveVision((s?.llmVision ?? "auto") as VisionSetting, provider, llm.model);
  return {
    input: {
      projectId: project.id,
      prompt,
      chips,
      projectPreset: normalizePreset(project.preset),
      pages: parsedPages,
      llm,
      vision,
      images: vision && images?.length ? images : undefined,
    },
    project,
  };
}

type PageRow = {
  id: number; title: string; device: string;
  posX: number; posY: number; width: number; height: number;
  surface: SurfaceDoc;
};

/** 将 ChatAction 应用到数据库,返回落库后的页面(createPage 场景)。同步执行,可在事务内调用 */
function applyActionsToDb(
  db: Db,
  projectId: number,
  parsedPages: PageRow[],
  actions: ChatAction[],
) {
  const appliedPages: (PageRow & { projectId: number; clientPageId?: string })[] = [];
  // 多页同建时逐页右移,避免重叠(posX 在循环内累积)
  let nextX = parsedPages.reduce((m, p) => Math.max(m, p.posX + p.width), 0);
  for (const action of actions) {
    if (action.type === "createPage") {
      const dims = { desktop: [1440, 900], laptop: [1280, 800], tablet: [768, 1024], mobile: [390, 844] }[action.device];
      const posX = nextX ? nextX + 160 : 0;
      const r = db.insert(pages).values({
        projectId,
        title: action.title,
        device: action.device,
        surface: JSON.stringify(action.surface),
        posX,
        posY: 0,
        width: dims[0],
        height: dims[1],
      }).run();
      appliedPages.push({
        id: Number(r.lastInsertRowid), projectId, title: action.title, device: action.device,
        surface: action.surface, posX, posY: 0,
        width: dims[0], height: dims[1],
        // 回传 LLM 管线生成的临时 pageId,前端据此精确对应(不再靠标题匹配)
        clientPageId: action.pageId,
      });
      nextX = posX + dims[0];
    } else if (action.type === "updateSurface") {
      const page = parsedPages.find((p) => String(p.id) === action.pageId);
      if (page) {
        db.update(pages).set({
          surface: JSON.stringify(action.surface),
          title: action.surface.page.title || page.title,
          device: action.surface.page.device,
        }).where(eq(pages.id, page.id)).run();
      }
    } else if (action.type === "ops") {
      const page = parsedPages.find((p) => String(p.id) === action.pageId);
      if (page) {
        const next = applyOps(page.surface, action.ops);
        db.update(pages).set({
          surface: JSON.stringify(next),
          title: next.page.title || page.title,
        }).where(eq(pages.id, page.id)).run();
      }
    } else if (action.type === "setPreset") {
      db.update(projects).set({ preset: action.preset }).where(eq(projects.id, projectId)).run();
    }
  }
  return appliedPages;
}

/** 持久化一轮对话消息(同步,可在事务内调用);conversationId 缺省时用最近会话或新建,返回实际使用的会话 id */
function persistChat(
  db: Db,
  projectId: number,
  prompt: string,
  chips: unknown,
  result: { assistantText: string; engine: string; model?: string; actions: { type: string }[]; steps: unknown },
  conversationId?: number | null,
  /** 用户消息附带的图片缩略 dataUrl(仅回显用,不回放给模型) */
  images?: string[],
): number {
  let convId: number | undefined;
  if (conversationId) {
    const owned = db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId))).limit(1).all();
    convId = owned[0]?.id;
  }
  if (!convId) {
    const convs = db.select().from(conversations).where(eq(conversations.projectId, projectId)).orderBy(desc(conversations.id)).limit(1).all();
    convId = convs[0]?.id;
  }
  if (!convId) {
    const c = db.insert(conversations).values({ projectId, title: prompt.slice(0, 30) }).run();
    convId = Number(c.lastInsertRowid);
  }
  db.insert(messages).values([
    { conversationId: convId, role: "user", content: prompt, meta: JSON.stringify({ chips, ...(images?.length ? { images } : {}) }) },
    { conversationId: convId, role: "assistant", content: result.assistantText, meta: JSON.stringify({ engine: result.engine, model: result.model, actions: result.actions.map((a) => a.type), steps: result.steps }) },
  ]).run();
  return convId;
}

/**
 * 加载本轮生成之前的最近对话(与 persistChat 相同的会话解析规则:指定会话须归属本项目,否则用最近会话)。
 * 注入 LLM 上下文供模型理解多轮指代(「改回去」「再换一个」);当前轮消息尚未落库,故取到的均为历史轮。
 */
function loadRecentHistory(projectId: number, conversationId: number | null | undefined, limit = 6): ChatTurn[] {
  const db = getDb();
  let convId: number | undefined;
  if (conversationId) {
    const owned = db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId))).limit(1).all();
    convId = owned[0]?.id;
  }
  if (!convId) {
    const convs = db.select({ id: conversations.id }).from(conversations)
      .where(eq(conversations.projectId, projectId)).orderBy(desc(conversations.id)).limit(1).all();
    convId = convs[0]?.id;
  }
  if (!convId) return [];
  const rows = db.select({ role: messages.role, content: messages.content }).from(messages)
    .where(eq(messages.conversationId, convId)).orderBy(desc(messages.id)).limit(limit).all();
  return rows.reverse().map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
}

export interface ChatGenerateParams {
  projectId: number;
  prompt: string;
  chips: PipelineInput["chips"];
  /** 续接的会话 id(null/缺省 = 复用最近会话或自动新建) */
  conversationId?: number | null;
  /** 客户端断开时联动中止 LLM 调用(释放互斥锁、及时止损) */
  signal?: AbortSignal;
  /** 随 prompt 附带的参考图片(仅 vision 开启时生效;最多 3 张) */
  images?: ImageRef[];
  /** 图片缩略 dataUrl,仅用于消息持久化回显 */
  imageThumbs?: string[];
}

export interface ChatGenerateOutput {
  result: ChatGenerateResult;
  plan?: ReturnType<typeof planFromActions>;
  appliedPages: (PageRow & { projectId: number; clientPageId?: string })[];
  /** 本轮消息实际写入的会话 id(plan 分支未落库时为入参原值或 null) */
  conversationId: number | null;
}

/** 项目级生成互斥:同一项目同一时刻只允许一轮生成(防双击发送 / 多标签页并发导致落库错乱) */
const generatingProjects = new Set<number>();

/** 对话生成主流程入口(带项目级互斥锁) */
export async function executeChatGenerate(
  userId: number,
  params: ChatGenerateParams,
  onStep?: (s: ChatStep) => void,
  onDraft?: (d: DraftChunk) => void,
): Promise<ChatGenerateOutput> {
  if (generatingProjects.has(params.projectId)) {
    throw new Error("当前项目有正在进行的生成任务,请等待完成后再试");
  }
  generatingProjects.add(params.projectId);
  try {
    return await executeChatGenerateInner(userId, params, onStep, onDraft);
  } finally {
    generatingProjects.delete(params.projectId);
  }
}

/** 对话生成主流程(tRPC generate 与 SSE 流式端点共用);onStep 实时推送执行步骤,onDraft 推送 LLM 增量文本 */
async function executeChatGenerateInner(
  userId: number,
  params: ChatGenerateParams,
  onStep?: (s: ChatStep) => void,
  onDraft?: (d: DraftChunk) => void,
): Promise<ChatGenerateOutput> {
  const { input: pipelineInput, project } = await buildPipelineInput({ user: { id: userId } }, params.projectId, params.prompt, params.chips, params.images);
  // 客户端中断信号传给 LLM 层(fetch abort)
  pipelineInput.signal = params.signal;
  // 多轮对话历史(当前轮未落库,取到的均为历史轮);plan 模式不落库也无妨——读的是既有历史
  pipelineInput.history = loadRecentHistory(params.projectId, params.conversationId);
  const parsedPages = pipelineInput.pages;
  const result = await runPipeline(pipelineInput, onStep, onDraft);

  // 执行策略由模型产出自动判断(无手动 Auto/Build/Plan 切换):
  // 计划中含高风险操作(删除/移动组件、整页重生成)→ 转审批,用户确认后执行;低风险变更直接落库
  if (result.actions.length) {
    const plan = planFromActions(result.actions);
    if (plan.risk === "medium") {
      const waitStep: ChatStep = {
        key: "apply",
        label: "等待计划审批",
        status: "done",
        detail: plan.summary,
      };
      result.steps.push(waitStep);
      onStep?.(waitStep);
      return { result, plan, appliedPages: [], conversationId: params.conversationId ?? null };
    }
  }

  // 事务:消息持久化 + 动作落库 + 自动快照,任一步失败整体回滚(不留半截状态)
  const db = getDb();
  const t0 = Date.now();
  const snapLabel = `AI:${params.prompt.slice(0, 24)}`;
  const { convId, appliedPages } = db.transaction((tx) => {
    const t = tx as unknown as Db;
    // 图片未实际送入管线(vision 关闭被丢弃)时不留缩略图,避免历史里出现"发了图但模型没看到"的假象
    const thumbs = pipelineInput.images?.length ? params.imageThumbs : undefined;
    const cid = persistChat(t, project.id, params.prompt, params.chips, result, params.conversationId, thumbs);
    const applied = applyActionsToDb(t, project.id, parsedPages, result.actions);
    snapshotVersion(t, project.id, snapLabel);
    return { convId: cid, appliedPages: applied };
  });
  const snapStep: ChatStep = { key: "snapshot", label: "保存快照", status: "done", detail: snapLabel, durationMs: Date.now() - t0 };
  result.steps.push(snapStep);
  onStep?.(snapStep);

  return { result, appliedPages, conversationId: convId };
}

export const chatRouter = createRouter({
  history: authedQuery
    .input(z.object({ projectId: z.number(), conversationId: z.number().nullish() }))
    .query(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      let convId: number | undefined;
      if (input.conversationId) {
        const owned = await db.select({ id: conversations.id }).from(conversations)
          .where(and(eq(conversations.id, input.conversationId), eq(conversations.projectId, input.projectId))).limit(1);
        convId = owned[0]?.id;
      }
      if (!convId) {
        const convs = await db.select().from(conversations)
          .where(eq(conversations.projectId, input.projectId)).orderBy(desc(conversations.id)).limit(1);
        convId = convs[0]?.id;
      }
      if (!convId) return { conversationId: null, messages: [] };
      const msgs = await db.select().from(messages)
        .where(eq(messages.conversationId, convId)).orderBy(messages.id);
      return { conversationId: convId, messages: msgs };
    }),

  /** 会话列表(含消息数,按最新在前) */
  conversations: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      const convs = await db.select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
        .from(conversations).where(eq(conversations.projectId, input.projectId)).orderBy(desc(conversations.id));
      if (!convs.length) return [];
      // 聚合查询替代逐会话 $count 的 N+1
      const counts = await db
        .select({ conversationId: messages.conversationId, count: sql<number>`count(*)` })
        .from(messages)
        .where(inArray(messages.conversationId, convs.map((c) => c.id)))
        .groupBy(messages.conversationId);
      const countMap = new Map(counts.map((c) => [c.conversationId, c.count]));
      return convs.map((c) => ({ ...c, messageCount: countMap.get(c.id) ?? 0 }));
    }),

  /** 新建空会话 */
  createConversation: authedQuery
    .input(z.object({ projectId: z.number(), title: z.string().max(60).default("新对话") }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const r = await getDb().insert(conversations).values({ projectId: input.projectId, title: input.title });
      return { id: Number(r.lastInsertRowid) };
    }),

  /** 删除单个会话及其消息 */
  removeConversation: authedQuery
    .input(z.object({ id: z.number(), projectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      db.transaction((tx) => {
        tx.delete(messages).where(eq(messages.conversationId, input.id)).run();
        tx.delete(conversations).where(and(eq(conversations.id, input.id), eq(conversations.projectId, input.projectId))).run();
      });
      return { ok: true };
    }),

  /** 清空项目全部会话历史(删除会话及其消息) */
  clear: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      const convs = await db.select({ id: conversations.id }).from(conversations)
        .where(eq(conversations.projectId, input.projectId));
      db.transaction((tx) => {
        for (const c of convs) tx.delete(messages).where(eq(messages.conversationId, c.id)).run();
        tx.delete(conversations).where(eq(conversations.projectId, input.projectId)).run();
      });
      return { ok: true, removed: convs.length };
    }),

  analyze: authedQuery
    .input(z.object({
      projectId: z.number(),
      prompt: z.string().min(1).max(4000),
      chips: z.array(chipSchema).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const { input: pipelineInput } = await buildPipelineInput(ctx, input.projectId, input.prompt, input.chips);
      return runAnalyze(pipelineInput);
    }),

  generate: authedQuery
    .input(z.object({
      projectId: z.number(),
      prompt: z.string().min(1).max(4000),
      chips: z.array(chipSchema).default([]),
      conversationId: z.number().nullish(),
      images: z.array(imageRefSchema).max(3).optional(),
      imageThumbs: z.array(z.string().max(300_000)).max(3).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const out = await executeChatGenerate(ctx.user.id, { ...input, signal: ctx.req.signal });
      if (out.plan) return { ...out.result, plan: out.plan, appliedPages: [], conversationId: out.conversationId };
      return { ...out.result, appliedPages: out.appliedPages, conversationId: out.conversationId };
    }),

  /** Plan 模式:用户批准后执行已审阅的 actions */
  applyPlan: authedQuery
    .input(z.object({
      projectId: z.number(),
      prompt: z.string().min(1).max(4000),
      chips: z.array(chipSchema).default([]),
      actions: z.array(chatActionSchema).min(1),
      engine: z.string().default("kimi"),
      assistantText: z.string().max(8000).default(""),
      conversationId: z.number().nullish(),
      steps: z.array(z.object({
        key: z.string(), label: z.string(),
        status: z.enum(["running", "done", "error"]),
        detail: z.string().optional(), durationMs: z.number().optional(),
      })).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      const pPages = await db.select().from(pages).where(eq(pages.projectId, project.id)).orderBy(pages.id);
      const parsedPages = pPages.map((p) => ({ ...p, surface: parseSurface(p.surface) }));

      const snapLabel = `AI:${input.prompt.slice(0, 24)}`;
      const t0 = Date.now();
      const steps = [
        ...input.steps,
        { key: "apply", label: "执行已批准计划", status: "done" as const, detail: `${input.actions.length} 个动作`, durationMs: 0 },
        { key: "snapshot", label: "保存快照", status: "done" as const, detail: snapLabel, durationMs: 0 },
      ];

      // 事务:动作落库 + 自动快照 + 消息持久化,任一步失败整体回滚
      const { convId, appliedPages, txMs } = db.transaction((tx) => {
        const t = tx as unknown as Db;
        const applied = applyActionsToDb(t, project.id, parsedPages, input.actions as ChatAction[]);
        snapshotVersion(t, project.id, snapLabel);
        const cid = persistChat(t, project.id, input.prompt, input.chips, {
          assistantText: input.assistantText, engine: input.engine,
          actions: input.actions, steps,
        }, input.conversationId);
        return { convId: cid, appliedPages: applied, txMs: Date.now() - t0 };
      });
      steps[steps.length - 1].durationMs = txMs;

      return { appliedPages, steps, conversationId: convId };
    }),
});

// ---------------------------------------------------------------------------
// LLM 调用统计(可观测性)
// ---------------------------------------------------------------------------
export const statsRouter = createRouter({
  /** 用量概览:聚合指标 + 最近 20 次调用明细 */
  overview: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProject(ctx.user.id, input.projectId);
      const db = getDb();
      const recent = await db
        .select({
          id: llmCalls.id, kind: llmCalls.kind, provider: llmCalls.provider, model: llmCalls.model,
          durationMs: llmCalls.durationMs, success: llmCalls.success, error: llmCalls.error,
          promptTokens: llmCalls.promptTokens, completionTokens: llmCalls.completionTokens,
          createdAt: llmCalls.createdAt,
        })
        .from(llmCalls)
        .where(eq(llmCalls.projectId, input.projectId))
        .orderBy(desc(llmCalls.id))
        .limit(20);
      const agg = await db
        .select({
          calls: sql<number>`count(*)`,
          failures: sql<number>`coalesce(sum(case when success = 0 then 1 else 0 end), 0)`,
          avgMs: sql<number>`coalesce(round(avg(durationMs)), 0)`,
          promptTokens: sql<number>`coalesce(sum(promptTokens), 0)`,
          completionTokens: sql<number>`coalesce(sum(completionTokens), 0)`,
        })
        .from(llmCalls)
        .where(eq(llmCalls.projectId, input.projectId));
      return { recent, totals: agg[0] };
    }),
});
