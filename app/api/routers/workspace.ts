import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { authedQuery, createRouter } from "../middleware";
import { loadHead, undoBatch, redoBatch, ensureInitialRevision, commitOpsBatch } from "../command/commandService";
import { assertProjectRole } from "../queries/projects";
import { resolveInstances } from "@contracts/design-ir";
import { getDb } from "../queries/connection";
import { frames, pageBoards } from "@db/schema";
import { eq } from "drizzle-orm";
import { emptyIRDocument } from "./workspaceDoc";
import type { IRDocument, IRSurface } from "@contracts/design-ir";
import { DEVICES, type DeviceId, type SurfaceDoc } from "@contracts/a2ui";

/**
 * workspace 路由:工作台主数据加载与几何/撤销(基于 Design IR + page_boards/frames)
 */

/** 把 IR 文档投影为画布消费的旧 PageState 形状(画布/渲染器零改动) */
function toLegacyPages(projectId: number, boards: { id: number; title: string; posX: number; posY: number }[], frameRows: { id: number; pageBoardId: number; surfaceId: string; title: string; device: string; width: number; height: number; posX: number; posY: number }[], doc: IRDocument) {
  const boardById = new Map(boards.map((b) => [b.id, b]));
  return frameRows.map((f) => {
    const surface: IRSurface | undefined = doc.surfaces[f.surfaceId];
    const board = boardById.get(f.pageBoardId);
    const device = (Object.keys(DEVICES).includes(f.device) ? f.device : "desktop") as DeviceId;
    const title = f.title || surface?.title || board?.title || f.surfaceId;
    const surfaceDoc: SurfaceDoc = {
      version: "1.0",
      page: { id: f.surfaceId, title, device },
      theme: doc.theme,
      components: (surface?.components ?? {}) as SurfaceDoc["components"],
      root: surface?.root ?? Object.keys(surface?.components ?? {})[0] ?? "root",
    };
    return {
      id: f.id,
      projectId,
      title,
      device,
      surface: surfaceDoc,
      posX: f.posX,
      posY: f.posY,
      width: f.width,
      height: f.height,
      surfaceId: f.surfaceId,
      boardId: f.pageBoardId,
      boardTitle: board?.title ?? "",
    };
  });
}

export const workspaceRouter = createRouter({
  /** 工作台主数据:PageBoards + Frames + IR 文档 + head revision + 画布兼容投影 */
  get: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(({ ctx, input }) => {
      assertProjectRole(ctx.user.id, input.projectId, "viewer"); // RBAC:viewer 可读工作台
      const db = getDb();
      const boards = db.select().from(pageBoards).where(eq(pageBoards.projectId, input.projectId)).all();
      const allFrames = db.select().from(frames).all();
      const boardIds = new Set(boards.map((b) => b.id));
      const projectFrames = allFrames.filter((f) => boardIds.has(f.pageBoardId));
      // 无 revision 时自动建初始(空文档)
      const head = loadHead(input.projectId);
      const revision = head?.revision ?? ensureInitialRevision(input.projectId, emptyIRDocument());
      // M7:组件实例展开后再投影(画布/渲染器不感知 instanceOf)
      const doc = resolveInstances((head?.doc ?? emptyIRDocument()) as IRDocument);
      return {
        boards,
        frames: projectFrames,
        doc: doc as unknown as Record<string, unknown>,
        revision,
        /** 画布兼容层:IR → 旧 PageState(新模型为主数据源;旧 pages 仅在无 frames 时兜底) */
        legacyPages: toLegacyPages(input.projectId, boards, projectFrames, doc),
      };
    }),

  /** frame 几何更新(拖拽/缩放落库;600ms 去抖由前端控制) */
  updateFrame: authedQuery
    .input(
      z.object({
        frameId: z.number(),
        patch: z.object({
          posX: z.number().int().optional(),
          posY: z.number().int().optional(),
          width: z.number().int().optional(),
          height: z.number().int().optional(),
          title: z.string().optional(),
        }),
      }),
    )
    .mutation(({ ctx, input }) => {
      const db = getDb();
      // frame → board → projectId:解析归属后做 RBAC
      const frameRow = db.select({ pageBoardId: frames.pageBoardId }).from(frames).where(eq(frames.id, input.frameId)).limit(1).get();
      const boardRow = frameRow
        ? db.select({ projectId: pageBoards.projectId }).from(pageBoards).where(eq(pageBoards.id, frameRow.pageBoardId)).limit(1).get()
        : undefined;
      if (!boardRow) throw new TRPCError({ code: "NOT_FOUND", message: "Frame 不存在" });
      assertProjectRole(ctx.user.id, boardRow.projectId, "editor"); // RBAC:editor 才能更新几何
      db.update(frames).set(input.patch).where(eq(frames.id, input.frameId)).run();
      return { ok: true };
    }),

  updateBoard: authedQuery
    .input(
      z.object({
        boardId: z.number(),
        patch: z.object({
          posX: z.number().int().optional(),
          posY: z.number().int().optional(),
          title: z.string().optional(),
        }),
      }),
    )
    .mutation(({ ctx, input }) => {
      const db = getDb();
      const boardRow = db.select({ projectId: pageBoards.projectId }).from(pageBoards).where(eq(pageBoards.id, input.boardId)).limit(1).get();
      if (!boardRow) throw new TRPCError({ code: "NOT_FOUND", message: "PageBoard 不存在" });
      assertProjectRole(ctx.user.id, boardRow.projectId, "editor"); // RBAC:editor 才能更新底板
      db.update(pageBoards).set(input.patch).where(eq(pageBoards.id, input.boardId)).run();
      return { ok: true };
    }),

  /** M7 PageBoard 归组(保守方案):拖放后变更 frame 所属底板(需同项目) */
  moveFrameToBoard: authedQuery
    .input(z.object({ frameId: z.number(), boardId: z.number() }))
    .mutation(({ ctx, input }) => {
      const db = getDb();
      const frameRow = db.select({ pageBoardId: frames.pageBoardId }).from(frames).where(eq(frames.id, input.frameId)).limit(1).get();
      const targetRow = db.select({ projectId: pageBoards.projectId }).from(pageBoards).where(eq(pageBoards.id, input.boardId)).limit(1).get();
      if (!frameRow || !targetRow) throw new TRPCError({ code: "NOT_FOUND", message: "Frame 或 PageBoard 不存在" });
      if (frameRow.pageBoardId === input.boardId) return { ok: true }; // 已在该底板
      const sourceRow = db.select({ projectId: pageBoards.projectId }).from(pageBoards).where(eq(pageBoards.id, frameRow.pageBoardId)).limit(1).get();
      if (!sourceRow || sourceRow.projectId !== targetRow.projectId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能跨项目移动 Frame" });
      }
      assertProjectRole(ctx.user.id, targetRow.projectId, "editor"); // RBAC:editor 才能归组
      db.update(frames).set({ pageBoardId: input.boardId, updatedAt: new Date() }).where(eq(frames.id, input.frameId)).run();
      return { ok: true };
    }),

  /** M7 手动编辑接入 IR:画布/检查器的 surface ops 落 Design IR(主事实源)。
   *  baseRevision 由服务端读 head(单编辑者场景,避免客户端 revision 陈旧竞态)。 */
  commitPageOps: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        surfaceId: z.string().min(1),
        ops: z
          .array(
            z.object({
              op: z.enum(["replaceProps", "addNode", "removeNode", "moveNode"]),
              id: z.string().optional(),
              parentId: z.string().optional(),
              index: z.number().int().optional(),
              props: z.record(z.string(), z.unknown()).optional(),
              node: z.record(z.string(), z.unknown()).optional(),
              extra: z.record(z.string(), z.unknown()).optional(),
              newParentId: z.string().optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .mutation(({ ctx, input }) => {
      assertProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 才能编辑
      const head = loadHead(input.projectId);
      if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "项目还没有 Design IR" });
      if (!head.doc.surfaces[input.surfaceId]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "目标页面不存在" });
      }
      const ops = input.ops.map((o) => ({ ...o, surfaceId: input.surfaceId })) as never[];
      const result = commitOpsBatch({
        projectId: input.projectId,
        baseRevision: head.revision,
        ops,
        scope: {},
        provenance: { actorType: "user", actorId: String(ctx.user.id), promptVersion: "manual-edit" },
      });
      return { revision: result.revision };
    }),

  undo: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(({ ctx, input }) => {
      assertProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 才能撤销
      try {
        return undoBatch(input.projectId);
      } catch {
        return { revision: -1 };
      }
    }),

  redo: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(({ ctx, input }) => {
      assertProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 才能重做
      try {
        return redoBatch(input.projectId);
      } catch {
        return { revision: -1 };
      }
    }),
});
