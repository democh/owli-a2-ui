import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { authedQuery, createRouter } from "../middleware";
import { assertProjectRole } from "../queries/projects";
import { getDb } from "../queries/connection";
import { comments, users } from "@db/schema";

/**
 * 多人评论(M7 协作):按页面/元素锚定的评论流。
 * viewer 可读;editor 及以上可写;解决/删除仅作者或 owner。
 */

export const commentsRouter = createRouter({
  /** 评论列表(viewer 及以上;可按 surfaceId/nodeId 过滤) */
  list: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        surfaceId: z.string().optional(),
        nodeId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertProjectRole(ctx.user.id, input.projectId, "viewer");
      const db = getDb();
      const conds = [eq(comments.projectId, input.projectId)];
      if (input.surfaceId) conds.push(eq(comments.surfaceId, input.surfaceId));
      if (input.nodeId) conds.push(eq(comments.nodeId, input.nodeId));
      const rows = await db
        .select({
          id: comments.id,
          surfaceId: comments.surfaceId,
          nodeId: comments.nodeId,
          parentId: comments.parentId,
          body: comments.body,
          resolved: comments.resolved,
          createdAt: comments.createdAt,
          authorId: comments.authorId,
          authorName: users.name,
        })
        .from(comments)
        .leftJoin(users, eq(users.id, comments.authorId))
        .where(and(...conds))
        .orderBy(desc(comments.id))
        .limit(100);
      return rows;
    }),

  /** 发表评论(editor 及以上;parentId = 讨论串回复) */
  add: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        surfaceId: z.string().max(120).default(""),
        nodeId: z.string().max(120).optional(),
        body: z.string().min(1).max(2000),
        /** 回复目标(须为同项目的顶级或回复评论) */
        parentId: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectRole(ctx.user.id, input.projectId, "editor");
      const db = getDb();
      if (input.parentId != null) {
        const parent = await db
          .select({ id: comments.id, projectId: comments.projectId, surfaceId: comments.surfaceId })
          .from(comments)
          .where(eq(comments.id, input.parentId))
          .limit(1);
        if (!parent.length || parent[0].projectId !== input.projectId) {
          throw new TRPCError({ code: "NOT_FOUND", message: "回复目标评论不存在" });
        }
        if (parent[0].surfaceId !== input.surfaceId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "回复目标与评论不在同一页面" });
        }
      }
      const r = await db
        .insert(comments)
        .values({
          projectId: input.projectId,
          surfaceId: input.surfaceId,
          nodeId: input.nodeId ?? null,
          parentId: input.parentId ?? null,
          authorId: ctx.user.id,
          body: input.body,
        })
        .returning({ id: comments.id });
      return { id: r[0]?.id ?? 0 };
    }),

  /** 标记已解决/未解决(作者本人或 owner) */
  resolve: authedQuery
    .input(z.object({ projectId: z.number(), commentId: z.number(), resolved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.select().from(comments).where(eq(comments.id, input.commentId)).limit(1);
      const c = rows[0];
      if (!c || c.projectId !== input.projectId) throw new TRPCError({ code: "NOT_FOUND", message: "评论不存在" });
      if (c.authorId !== ctx.user.id) await assertProjectRole(ctx.user.id, input.projectId, "owner");
      await db.update(comments).set({ resolved: input.resolved }).where(eq(comments.id, input.commentId));
      return { ok: true };
    }),

  /** 删除评论(作者本人或 owner) */
  remove: authedQuery
    .input(z.object({ projectId: z.number(), commentId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.select().from(comments).where(eq(comments.id, input.commentId)).limit(1);
      const c = rows[0];
      if (!c || c.projectId !== input.projectId) throw new TRPCError({ code: "NOT_FOUND", message: "评论不存在" });
      if (c.authorId !== ctx.user.id) await assertProjectRole(ctx.user.id, input.projectId, "owner");
      await db.delete(comments).where(eq(comments.id, input.commentId));
      return { ok: true };
    }),
});
