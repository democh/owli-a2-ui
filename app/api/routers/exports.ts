import { z } from "zod";
import { mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { zipFiles } from "../export/zip";
import { authedQuery, createRouter } from "../middleware";
import { loadHead } from "../command/commandService";
import { requireProjectRole } from "../queries/projects";
import { generateProject, validateGeneratedFiles } from "../export/codegen/codegen";
import { generateVueProject, validateVueFiles } from "../export/codegen/templates/vue-template";
import { enqueueBuildJob, getBuildJob, setFinalizer, type ExportJob } from "../export/jobs";
import { getDb } from "../queries/connection";
import { exportFiles, frames } from "@db/schema";
import { desc, eq } from "drizzle-orm";
import type { DeviceId } from "@contracts/a2ui";

/**
 * exports 路由(M5 工程交付):Design IR → 可构建 React 工程 zip
 * create:同步快路径(仅 esbuild 语法门禁);build:异步完整门禁(tsc + vite build)+ 轮询。
 */

// 注入完整门禁通过后的产物落盘逻辑(zip 写盘 + export_files 登记)
setFinalizer(async (job: ExportJob, files) => {
  const exportId = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const zipPath = path.resolve(process.cwd(), "data", "exports", String(job.projectId), `${exportId}.zip`);
  mkdirSync(path.dirname(zipPath), { recursive: true });
  const zipBuffer = await zipFiles(Object.fromEntries(files.map((f) => [f.path, f.content])));
  await writeFile(zipPath, zipBuffer);
  getDb()
    .insert(exportFiles)
    .values({
      exportId,
      projectId: job.projectId,
      revision: job.revision,
      adapterId: job.adapterId,
      fileCount: files.length,
      unmapped: JSON.stringify(job.unmapped),
      zipPath,
    })
    .run();
  return exportId;
});

export const exportsRouter = createRouter({
  /** 生成导出工程(绑定 revision;语法门禁失败抛错并返回未映射报告) */
  create: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        baseRevision: z.number().int().nonnegative(),
        projectName: z.string().min(1).max(60),
        adapterId: z.string().default("shadcn-tailwind"),
        /** §6.3 导出该页面:按 surfaceId 过滤(缺省导出全部) */
        surfaceIds: z.array(z.string().min(1)).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 才能导出(Export 矩阵)
      const head = loadHead(input.projectId);
      if (!head) throw new Error("项目还没有 Design IR");
      if (head.revision !== input.baseRevision) {
        throw new Error(`Revision 冲突:当前 head=${head.revision},请刷新后重试`);
      }
      const doc = head.doc;
      const db = getDb();
      const frameRows = db.select().from(frames).all();
      const surfaceIds = new Set(Object.keys(doc.surfaces));
      const filterSet = input.surfaceIds ? new Set(input.surfaceIds) : null;
      const pages = frameRows
        .filter((f) => surfaceIds.has(f.surfaceId) && (!filterSet || filterSet.has(f.surfaceId)))
        .map((f) => ({ surfaceId: f.surfaceId, title: f.title || f.surfaceId, device: f.device as DeviceId }));
      if (filterSet && !pages.length) throw new Error("指定的页面不存在或没有画布数据");

      // vue3(experimental):Vue 3 SFC 工程;其余适配器走 React codegen
      const isVue = input.adapterId === "vue3";
      const { files, unmapped } = isVue
        ? generateVueProject({ projectName: input.projectName, doc, pages, adapterId: input.adapterId })
        : generateProject({ projectName: input.projectName, doc, pages, adapterId: input.adapterId });

      // 语法门禁(MVP 快速层:esbuild transform / SFC 结构;完整 install+build 归后续迭代)
      const errors = isVue ? validateVueFiles(files) : validateGeneratedFiles(files);
      if (errors.length > 0) {
        throw new Error(`导出语法门禁失败: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ").slice(0, 300)}`);
      }

      const exportId = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const zipPath = path.resolve(process.cwd(), "data", "exports", String(input.projectId), `${exportId}.zip`);
      mkdirSync(path.dirname(zipPath), { recursive: true });
      const zipBuffer = await zipFiles(Object.fromEntries(files.map((f) => [f.path, f.content])));
      await writeFile(zipPath, zipBuffer);

      db.insert(exportFiles)
        .values({
          exportId,
          projectId: input.projectId,
          revision: input.baseRevision,
          adapterId: input.adapterId,
          fileCount: files.length,
          unmapped: JSON.stringify(unmapped),
          zipPath,
        })
        .run();

      return { exportId, fileCount: files.length, unmapped };
    }),

  /** 异步完整构建门禁(入队即返回 jobId;tsc --noEmit → vite build → 通过后自动登记产物) */
  build: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        baseRevision: z.number().int().nonnegative(),
        projectName: z.string().min(1).max(60),
        adapterId: z.string().default("shadcn-tailwind"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 才能导出
      const head = loadHead(input.projectId);
      if (!head) throw new Error("项目还没有 Design IR");
      if (head.revision !== input.baseRevision) {
        throw new Error(`Revision 冲突:当前 head=${head.revision},请刷新后重试`);
      }
      const doc = head.doc;
      const frameRows = getDb().select().from(frames).all();
      const surfaceIds = new Set(Object.keys(doc.surfaces));
      const pages = frameRows
        .filter((f) => surfaceIds.has(f.surfaceId))
        .map((f) => ({ surfaceId: f.surfaceId, title: f.title || f.surfaceId, device: f.device as DeviceId }));
      if (!pages.length) throw new Error("没有可导出的页面(画布为空)");
      const jobId = enqueueBuildJob({
        projectId: input.projectId,
        revision: input.baseRevision,
        adapterId: input.adapterId,
        projectName: input.projectName,
        doc,
        pages,
      });
      return { jobId };
    }),

  /** 构建任务状态轮询(poll until passed/failed) */
  buildStatus: authedQuery
    .input(z.object({ jobId: z.string() }))
    .query(async ({ ctx, input }) => {
      const job = getBuildJob(input.jobId);
      if (!job) throw new Error("任务不存在或已过期");
      await requireProjectRole(ctx.user.id, job.projectId, "viewer"); // RBAC:成员可查看
      return {
        jobId: job.id,
        status: job.status,
        unmapped: job.unmapped,
        issues: job.issues,
        steps: job.steps,
        durationMs: job.durationMs,
        exportId: job.exportId,
        fileCount: job.fileCount,
        error: job.error,
      };
    }),

  list: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ ctx, input }) => {
      await requireProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读导出历史
      return getDb()
        .select({
          exportId: exportFiles.exportId,
          revision: exportFiles.revision,
          adapterId: exportFiles.adapterId,
          fileCount: exportFiles.fileCount,
          unmapped: exportFiles.unmapped,
          createdAt: exportFiles.createdAt,
        })
        .from(exportFiles)
        .where(eq(exportFiles.projectId, input.projectId))
        .orderBy(desc(exportFiles.id))
        .limit(20);
    }),
});
