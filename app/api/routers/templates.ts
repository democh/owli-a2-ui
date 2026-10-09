import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { authedQuery, createRouter } from "../middleware";
import { assertProjectRole } from "../queries/projects";
import { loadHead, commitRunChanges } from "../command/commandService";
import { surfacesToFrameOps } from "../import/frame-ops";
import { generateTemplateCoverHtml } from "../templates/cover";
import { getDb } from "../queries/connection";
import { irTemplates } from "@db/schema";
import type { IRDocument, IRSurface } from "@contracts/design-ir";

/**
 * 模板库(M7 模板市场):Design IR 快照 → 分类模板 → 一键应用到任意项目。
 * 保存读取当前 head;应用走既有提交链路(baseRevision 校验 + inverseOps 可撤销)。
 */

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const templatesRouter = createRouter({
  /** 保存当前项目 head 为模板(editor 及以上) */
  save: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        name: z.string().min(1).max(60),
        description: z.string().max(200).default(""),
        category: z.string().min(1).max(30).default("通用"),
        tags: z.array(z.string().max(20)).max(8).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectRole(ctx.user.id, input.projectId, "editor");
      const head = loadHead(input.projectId);
      if (!head) throw new Error("项目还没有 Design IR");
      if (!Object.keys(head.doc.surfaces).length) throw new Error("画布为空,没有可保存的页面");
      const db = getDb();
      const templateId = newId("tpl");

      // 封面:首个 surface → 静态 HTML(复用站点导出管线;列表缩略图)
      const coverHtml = generateTemplateCoverHtml(input.name, head.doc) ?? "";

      db.insert(irTemplates)
        .values({
          templateId,
          name: input.name,
          description: input.description,
          category: input.category,
          tags: input.tags.join(","),
          doc: JSON.stringify({ theme: head.doc.theme, surfaces: head.doc.surfaces }),
          coverHtml,
          sourceProjectId: input.projectId,
          createdBy: ctx.user.id,
        })
        .run();
      return { templateId };
    }),

  /** 模板市场列表(登录即可浏览;按分类过滤) */
  list: authedQuery
    .input(z.object({ category: z.string().optional() }).default({}))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = input.category
        ? await db.select().from(irTemplates).where(eq(irTemplates.category, input.category)).orderBy(desc(irTemplates.id)).limit(50)
        : await db.select().from(irTemplates).orderBy(desc(irTemplates.id)).limit(50);
      return rows.map((r) => ({
        templateId: r.templateId,
        name: r.name,
        description: r.description,
        category: r.category,
        tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
        surfaceCount: Object.keys((JSON.parse(r.doc) as IRDocument).surfaces ?? {}).length,
        hasCover: !!r.coverHtml,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
      }));
    }),

  /** 应用模板:模板 surfaces → addFrame ops → 提交为新 revision */
  applyToProject: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        baseRevision: z.number().int().nonnegative(),
        templateId: z.string().min(1),
        device: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectRole(ctx.user.id, input.projectId, "editor");
      const head = loadHead(input.projectId);
      if (!head) throw new Error("项目还没有 Design IR");
      if (head.revision !== input.baseRevision) {
        throw new Error(`Revision 冲突:当前 head=${head.revision},请刷新后重试`);
      }
      const db = getDb();
      const rows = await db.select().from(irTemplates).where(eq(irTemplates.templateId, input.templateId)).limit(1);
      if (!rows.length) throw new Error("模板不存在");
      const doc = JSON.parse(rows[0].doc) as { theme: IRDocument["theme"]; surfaces: Record<string, IRSurface> };
      const surfaces = Object.values(doc.surfaces);
      if (!surfaces.length) throw new Error("模板没有任何页面");

      const { ops, boards, frames } = surfacesToFrameOps(surfaces, input.device);
      const result = commitRunChanges({
        projectId: input.projectId,
        baseRevision: input.baseRevision,
        ops,
        scope: {},
        provenance: { actorType: "user", actorId: String(ctx.user.id), promptVersion: `template:${input.templateId}` },
        boards,
        frames,
      });
      return { revision: result.revision, batchId: result.batchId, appliedSurfaces: surfaces.length };
    }),

  /** 删除模板(创建者本人) */
  remove: authedQuery
    .input(z.object({ templateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(irTemplates)
        .where(and(eq(irTemplates.templateId, input.templateId), eq(irTemplates.createdBy, ctx.user.id)))
        .limit(1);
      if (!rows.length) throw new Error("模板不存在或无权删除");
      await db.delete(irTemplates).where(eq(irTemplates.id, rows[0].id));
      return { ok: true };
    }),

  /** 替换封面(创建者本人;演进项 §2.1"封面自定义"):上传截图 → data URL 存 coverHtml */
  setCover: authedQuery
    .input(
      z.object({
        templateId: z.string().min(1),
        /** base64 图片 data URL(png/jpeg/webp/gif),≤512KB 原始体积 */
        image: z
          .string()
          .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, "仅支持 base64 图片 data URL")
          .max(700_000, "封面图片过大(≤512KB)"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(irTemplates)
        .where(and(eq(irTemplates.templateId, input.templateId), eq(irTemplates.createdBy, ctx.user.id)))
        .limit(1);
      if (!rows.length) throw new Error("模板不存在或无权修改封面");
      const coverHtml = `<img src="${input.image}" style="width:100%;height:100%;object-fit:cover;border:0;display:block" />`;
      db.update(irTemplates).set({ coverHtml }).where(eq(irTemplates.id, rows[0].id)).run();
      return { ok: true };
    }),
});
