import { z } from "zod";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { rm } from "fs/promises";
import path from "path";
import { authedQuery, createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { requireProject, requireProjectRole } from "../queries/projects";
import { usageSnapshot } from "../agent/runtime/BudgetManager";
import { RunManager } from "../agent/run/RunManager";
import { ensureInitialRevision } from "../command/commandService";
import { env } from "../lib/env";
import { conversations, deploys, frames, llmCalls, messages, pageBoards, pages, projectMembers, projects, userSettings, versions } from "@db/schema";
import {
  alerts, auditLogs, clarificationRequests, clarificationResponses, comments, designBriefs, designDecisions, designPlans,
  designProposals, designSkills, exportFiles, outboxEvents, projectRevisions, opBatches,
  runEvents, runs, skillRuns, snapshots, styleDirections, uxReviewReports,
} from "@db/schema";
import type { DeviceId, PresetId, SurfaceDoc, VisionSetting } from "@contracts/a2ui";
import { DEVICE_IDS, PRESET_IDS, resolveVision, surfaceDocSchema } from "@contracts/a2ui";

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
      // 事务:项目 + owner 成员行 + 起始页 + 初始快照,任一步失败整体回滚
      const projectId = db.transaction((tx) => {
        const r = tx.insert(projects).values({ userId: ctx.user.id, name: input.name, preset: input.preset }).run();
        const pid = Number(r.lastInsertRowid);
        // RBAC:归属人自动注册为 owner 成员
        tx.insert(projectMembers).values({ projectId: pid, userId: ctx.user.id, role: "owner" }).run();
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
      // 初始 IR 文档与起始页对齐(surfaceId 规则 frame_${page.id} → frame_page):
      // 否则首次 workspace.get 懒创建的空文档 surfaces 为空,Agent ops 引用现有页面时 commit 校验会失败
      ensureInitialRevision(projectId, {
        revision: 0,
        theme: { preset: input.preset, tokens: STARTER_SURFACE.theme.tokens },
        surfaces: {
          frame_page: {
            id: "frame_page",
            title: STARTER_SURFACE.page.title,
            root: STARTER_SURFACE.root,
            components: STARTER_SURFACE.components,
          },
        },
        dataModels: {},
        componentDefs: {},
      });
      // starter 画框行:frames 表与 IR 单一事实源对齐——否则 starter 项目 legacyPages 为空,
      // 前端走 pages 表兜底路径(无 surfaceId),页面级选中的 scope.frameId 退化为数字 id,
      // 后端 ContextBuilder 匹配不到,Refine/Repair 类 run 只能整页重建
      const boardR = db
        .insert(pageBoards)
        .values({ projectId, title: STARTER_SURFACE.page.title, posX: 0, posY: 0 })
        .run();
      db
        .insert(frames)
        .values({
          pageBoardId: Number(boardR.lastInsertRowid),
          surfaceId: "frame_page",
          title: STARTER_SURFACE.page.title,
          device: STARTER_SURFACE.page.device,
          width: 1440,
          height: 900,
          posX: 0,
          posY: 0,
        })
        .run();
      return { id: projectId };
    }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      // RBAC:viewer 及以上可读
      const { project } = await requireProjectRole(ctx.user.id, input.id, "viewer");
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
      await requireProject(ctx.user.id, input.id); // RBAC:editor 及以上可改名/预设
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
      await requireProjectRole(ctx.user.id, input.id, "owner"); // RBAC:仅 owner 可删除项目
      const db = getDb();
      // 删除前先取消进行中的 Run:否则 executeRun 管线仍在内存中运行,继续向 run_events
      // 追加事件形成孤儿数据(runs 行已删,SSE/重放再也找不到该 Run)。
      const activeRunIds = db
        .select({ runId: runs.runId })
        .from(runs)
        .where(and(eq(runs.projectId, input.id), notInArray(runs.status, ["completed", "cancelled", "failed"])))
        .all()
        .map((r) => r.runId);
      for (const runId of activeRunIds) {
        RunManager.cancel(runId); // 内存 context 存在:中断 LLM 流并落 DB cancelled
        // 内存无 context(服务重启遗留的 running 行):直接落终态,防止被恢复逻辑误复活
        db.update(runs)
          .set({ status: "cancelled" })
          .where(and(eq(runs.runId, runId), notInArray(runs.status, ["completed", "cancelled", "failed"])))
          .run();
      }
      if (activeRunIds.length) await new Promise((r) => setTimeout(r, 1200)); // 给取消收尾(事件/时长落库)留一拍
      const pPages = await db.select({ id: pages.id }).from(pages).where(eq(pages.projectId, input.id));
      // 事务:全量清理。顺序遵循 FK 依赖(runs→conversations/conversations→messages 等):
// 先删引用 runs 的全部子表 → runs → conversations/messages → 其余 projects 子表 → projects
      db.transaction((tx) => {
        // Run 事实链:先取 runId,按依赖序删除(专家产物/事件流 → runs)
        const runIdRows = tx.select({ runId: runs.runId }).from(runs).where(eq(runs.projectId, input.id)).all();
        const runIds = runIdRows.length ? runIdRows.map((r) => r.runId) : ["__none__"];
        tx.delete(runEvents).where(inArray(runEvents.runId, runIds)).run();
        tx.delete(skillRuns).where(inArray(skillRuns.runId, runIds)).run();
        tx.delete(uxReviewReports).where(inArray(uxReviewReports.runId, runIds)).run();
        tx.delete(designBriefs).where(inArray(designBriefs.runId, runIds)).run();
        tx.delete(designPlans).where(inArray(designPlans.runId, runIds)).run();
        tx.delete(designDecisions).where(inArray(designDecisions.runId, runIds)).run();
        tx.delete(clarificationRequests).where(inArray(clarificationRequests.runId, runIds)).run();
        tx.delete(clarificationResponses).where(inArray(clarificationResponses.runId, runIds)).run();
        tx.delete(styleDirections).where(inArray(styleDirections.runId, runIds)).run();
        tx.delete(llmCalls).where(eq(llmCalls.projectId, input.id)).run();
        tx.delete(designProposals).where(eq(designProposals.projectId, input.id)).run();
        tx.delete(runs).where(eq(runs.projectId, input.id)).run();
        // 会话链:messages → conversations(runs 已删,FK 安全)
        const convs = tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.projectId, input.id)).all();
        for (const c of convs) tx.delete(messages).where(eq(messages.conversationId, c.id)).run();
        // 自愈:跨项目 Run 污染(#15)——其他项目的 run 可能引用本项目会话(前端切项目时序漏洞),
        // 不清理会永久阻塞 conversations 删除;连同其子表一并清除
        const convIds = convs.map((c) => c.id);
        if (convIds.length) {
          const polluted = tx.select({ runId: runs.runId }).from(runs).where(inArray(runs.conversationId, convIds)).all().map((r) => r.runId);
          if (polluted.length) {
            tx.delete(runEvents).where(inArray(runEvents.runId, polluted)).run();
            tx.delete(skillRuns).where(inArray(skillRuns.runId, polluted)).run();
            tx.delete(uxReviewReports).where(inArray(uxReviewReports.runId, polluted)).run();
            tx.delete(designBriefs).where(inArray(designBriefs.runId, polluted)).run();
            tx.delete(designPlans).where(inArray(designPlans.runId, polluted)).run();
            tx.delete(designDecisions).where(inArray(designDecisions.runId, polluted)).run();
            tx.delete(designProposals).where(inArray(designProposals.runId, polluted)).run();
            tx.delete(runs).where(inArray(runs.runId, polluted)).run();
          }
        }
        tx.delete(conversations).where(eq(conversations.projectId, input.id)).run();
        // 其余业务表/Harness 事实源:frames → page_boards → revisions/op_batches
        tx.delete(versions).where(eq(versions.projectId, input.id)).run();
        tx.delete(pages).where(eq(pages.projectId, input.id)).run();
        tx.delete(deploys).where(eq(deploys.projectId, input.id)).run();
        const boardIds = tx.select({ id: pageBoards.id }).from(pageBoards).where(eq(pageBoards.projectId, input.id)).all().map((b) => b.id);
        if (boardIds.length) tx.delete(frames).where(inArray(frames.pageBoardId, boardIds)).run();
        tx.delete(pageBoards).where(eq(pageBoards.projectId, input.id)).run();
        tx.delete(projectRevisions).where(eq(projectRevisions.projectId, input.id)).run();
        tx.delete(opBatches).where(eq(opBatches.projectId, input.id)).run();
        // 可观测性/导出登记/协作数据(comments 有 projects FK,任一残留即约束失败)
        tx.delete(exportFiles).where(eq(exportFiles.projectId, input.id)).run();
        tx.delete(snapshots).where(eq(snapshots.projectId, input.id)).run();
        tx.delete(auditLogs).where(eq(auditLogs.projectId, input.id)).run();
        tx.delete(outboxEvents).where(eq(outboxEvents.projectId, input.id)).run();
        tx.delete(comments).where(eq(comments.projectId, input.id)).run();
        tx.delete(alerts).where(eq(alerts.projectId, input.id)).run();
        void designSkills; // 全局技能表,不随项目删除
        tx.delete(projectMembers).where(eq(projectMembers.projectId, input.id)).run();
        tx.delete(projects).where(eq(projects.id, input.id)).run();
      });
      // 兜底:清理取消收尾竞态产生的孤儿事件(cancel 后管线仍可能写入最后一两条,而 runs 行已删)
      db.run(sql`DELETE FROM run_events WHERE runId NOT IN (SELECT runId FROM runs)`);
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
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读版本列表
      return getDb().select({
        id: versions.id, label: versions.label, createdAt: versions.createdAt,
      }).from(versions).where(eq(versions.projectId, input.projectId)).orderBy(desc(versions.id));
    }),

  /** 读取单个版本的快照内容(供前端 diff 对比;surface 已解析) */
  get: authedQuery
    .input(z.object({ id: z.number(), projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读版本内容
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
        budgetMaxCostUsd: 0,
        profileModels: {},
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
    let storedProfileModels: Record<string, string> = {};
    try {
      storedProfileModels = JSON.parse(s.profileModels ?? "{}") as Record<string, string>;
    } catch {
      /* 脏数据按未配置 */
    }
    return {
      provider,
      apiKey: "",
      hasApiKey: !!effectiveKey,
      apiKeyHint: maskKey(effectiveKey),
      baseUrl: useEnv ? envCfg.baseUrl : s.llmBaseUrl || envCfg.baseUrl,
      model,
      vision,
      supportsImages: resolveVision(vision, provider, model),
      budgetMaxCostUsd: s.budgetMaxCostUsd ?? 0,
      profileModels: storedProfileModels,
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
      /** M6-2 预算:用户级累计成本上限(USD);0=走系统默认 */
      budgetMaxCostUsd: z.number().min(0).max(100000).optional(),
      /** M7 多模型路由:按阶段覆盖模型;空/缺省 = 用主模型 */
      profileModels: z
        .object({
          planning: z.string().max(64).optional(),
          generation: z.string().max(64).optional(),
          review: z.string().max(64).optional(),
        })
        .optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.select().from(userSettings).where(eq(userSettings.userId, ctx.user.id)).limit(1);
      const nextKey = input.apiKey || rows[0]?.llmApiKey || null;
      const nextProfileModels = input.profileModels
        ? JSON.stringify({
            ...(input.profileModels.planning ? { planning: input.profileModels.planning } : {}),
            ...(input.profileModels.generation ? { generation: input.profileModels.generation } : {}),
            ...(input.profileModels.review ? { review: input.profileModels.review } : {}),
          })
        : (rows[0]?.profileModels ?? "{}");
      if (!rows.length) {
        await db.insert(userSettings).values({
          userId: ctx.user.id, llmProvider: input.provider,
          llmApiKey: nextKey, llmBaseUrl: input.baseUrl, llmModel: input.model,
          llmVision: input.vision ?? "auto",
          budgetMaxCostUsd: input.budgetMaxCostUsd ?? 0,
          profileModels: nextProfileModels,
        });
      } else {
        await db.update(userSettings).set({
          llmProvider: input.provider, llmApiKey: nextKey,
          llmBaseUrl: input.baseUrl, llmModel: input.model,
          ...(input.vision ? { llmVision: input.vision } : {}),
          ...(input.budgetMaxCostUsd != null ? { budgetMaxCostUsd: input.budgetMaxCostUsd } : {}),
          profileModels: nextProfileModels,
        }).where(eq(userSettings.userId, ctx.user.id));
      }
      return { ok: true };
    }),

  /** M6-2:用户级用量与预算(设置页展示) */
  usage: authedQuery.query(async ({ ctx }) => usageSnapshot(ctx.user.id)),
});

export const chatRouter = createRouter({
  history: authedQuery
    .input(z.object({ projectId: z.number(), conversationId: z.number().nullish() }))
    .query(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读历史
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
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读会话列表
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


});

// ---------------------------------------------------------------------------
// LLM 调用统计(可观测性)
// ---------------------------------------------------------------------------
export const statsRouter = createRouter({
  /** 用量概览:聚合指标 + 最近 20 次调用明细 */
  overview: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读用量统计
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
