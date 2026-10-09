/**
 * 导出与部署
 * export:项目 → zip(react-vite / vue-vite / html),base64 返回
 * deploy:项目 → html 静态站点,写入本地目录并产出可访问 URL(成功后打部署快照)
 * removeDeploy:删除某个部署(磁盘产物 + DB 记录)
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { TRPCError } from "@trpc/server";
import { authedQuery, createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { requireProject, requireProjectRole } from "../queries/projects";
import { deploys, pages } from "@db/schema";
import type { SurfaceDoc } from "@contracts/a2ui";
import { surfaceDocSchema } from "@contracts/a2ui";
import { buildExport, buildHtmlSite, type ExportTarget } from "../export/site";
import { zipFiles } from "../export/zip";
import { snapshotVersion } from "./studio";

function parseSurface(raw: string): SurfaceDoc | null {
  try {
    return surfaceDocSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadPages(projectId: number, pageId?: number) {
  const db = getDb();
  const rows = await db.select().from(pages).where(eq(pages.projectId, projectId)).orderBy(pages.id);
  const list = rows
    .filter((r) => !pageId || r.id === pageId)
    .map((r) => ({ title: r.title, surface: parseSurface(r.surface) }))
    .filter((r): r is { title: string; surface: SurfaceDoc } => !!r.surface);
  if (!list.length) throw new TRPCError({ code: "BAD_REQUEST", message: "没有可导出的页面" });
  return list;
}

const DEPLOY_ROOT = path.resolve(process.cwd(), "data", "deploys");

export const publishRouter = createRouter({
  /** 导出工程 zip(base64) */
  export: authedQuery
    .input(z.object({
      projectId: z.number(),
      target: z.enum(["html", "react-vite", "vue-vite"]),
      pageId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx.user.id, input.projectId);
      const pageList = await loadPages(project.id, input.pageId);
      const files = buildExport(input.target as ExportTarget, project.name, pageList);
      const zip = await zipFiles(files);
      const scope = input.pageId ? pageList[0].title : project.name;
      const filename = `${scope}-${input.target}.zip`.replace(/[\\/:*?"<>|]/g, "-");
      return {
        filename,
        fileCount: Object.keys(files).length,
        base64: zip.toString("base64"),
      };
    }),

  /** 一键部署:html 站点 → 本地静态目录 → 可访问 URL;可选自定义 slug(URL 标识) */
  deploy: authedQuery
    .input(z.object({
      projectId: z.number(),
      slug: z.string()
        .regex(/^[a-z0-9][a-z0-9-]{0,38}$/, "标识需以小写字母或数字开头,仅含小写字母/数字/连字符")
        // pending 是部署记录写入期间的中间态 slug,保留不用
        .refine((s) => s !== "pending", "该标识为系统保留,请换一个")
        .optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx.user.id, input.projectId);
      const pageList = await loadPages(project.id);
      const files = buildHtmlSite(project.name, pageList);

      const db = getDb();
      if (input.slug) {
        const dup = await db.select({ id: deploys.id }).from(deploys)
          .where(and(eq(deploys.projectId, project.id), eq(deploys.slug, input.slug))).limit(1);
        if (dup.length) throw new TRPCError({ code: "CONFLICT", message: `标识「${input.slug}」已被本项目其他部署占用` });
      }
      const r = await db.insert(deploys).values({
        projectId: project.id,
        slug: "pending",
        pageCount: pageList.length,
      });
      const deployId = Number(r.lastInsertRowid);
      const slug = input.slug ?? `d${deployId}`;
      await db.update(deploys).set({ slug }).where(eq(deploys.id, deployId));

      try {
        const dir = path.join(DEPLOY_ROOT, String(project.id), slug);
        await mkdir(dir, { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          await writeFile(path.join(dir, name), content, "utf8");
        }
        // 入口:index.html = 第一个页面
        const first = Object.keys(files).find((f) => f.endsWith(".html"));
        if (first && first !== "index.html") {
          await writeFile(path.join(dir, "index.html"), files[first], "utf8");
        }
      } catch (e) {
        await db.update(deploys).set({ status: "failed" }).where(eq(deploys.id, deployId));
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `部署失败:${(e as Error).message}` });
      }

      // 部署成功 → 打一份设计稿快照(版本页可回滚到「上次发布」状态;auto 类型受保留上限约束)
      try {
        snapshotVersion(db, project.id, `部署 ${slug}`);
      } catch (e) {
        console.error("[publish] 部署快照失败(不影响部署结果):", e);
      }

      return {
        deployId,
        url: `/deployed/${project.id}/${slug}/`,
        pageCount: pageList.length,
      };
    }),

  /** 删除部署:磁盘产物 + DB 记录(仅限自己的项目) */
  removeDeploy: authedQuery
    .input(z.object({ deployId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.select().from(deploys).where(eq(deploys.id, input.deployId)).limit(1);
      const dep = rows[0];
      if (!dep) throw new TRPCError({ code: "NOT_FOUND", message: "部署不存在" });
      await requireProjectRole(ctx.user.id, dep.projectId, "owner"); // RBAC:仅 owner 可删除部署(Delete 矩阵)
      // slug 由服务端生成(dN 或自定义小写标识),双保险校验防路径穿越
      if (!/^[a-zA-Z0-9_-]+$/.test(dep.slug)) throw new TRPCError({ code: "BAD_REQUEST", message: "非法部署标识" });
      await rm(path.join(DEPLOY_ROOT, String(dep.projectId), dep.slug), { recursive: true, force: true });
      await db.delete(deploys).where(and(eq(deploys.id, dep.id), eq(deploys.projectId, dep.projectId)));
      return { ok: true as const };
    }),

  /** 部署历史 */
  deploys: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读部署历史
      const rows = await getDb()
        .select()
        .from(deploys)
        .where(eq(deploys.projectId, input.projectId))
        .orderBy(desc(deploys.id))
        .limit(20);
      return rows.map((d) => ({
        ...d,
        url: `/deployed/${input.projectId}/${d.slug}/`,
      }));
    }),
});
