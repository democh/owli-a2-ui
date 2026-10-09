import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { authedQuery, createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { designSkills } from "@db/schema";
import { validateSkillManifest } from "../skills/validate";

/**
 * Skill Marketplace(M7):第三方 Skill 提交 → 审核 → 启用。
 * 内置 Skill 恒为 approved;第三方提交初始 submitted,审核通过才进入 Skill Router 池
 * (experts 的 skillFragments 只消费 enabled=1 的 skill)。
 */

export const skillsRouter = createRouter({
  /** 市场列表:approved 的 Skill(含内置) */
  list: authedQuery.query(async () => {
    const db = getDb();
    const rows = await db.select().from(designSkills).where(eq(designSkills.status, "approved")).orderBy(desc(designSkills.id));
    return rows.map((r) => ({
      skillId: r.skillId,
      enabled: r.enabled,
      manifest: JSON.parse(r.manifest) as Record<string, unknown>,
    }));
  }),

  /** 提交第三方 Skill(沙箱校验通过 → submitted 待审核) */
  submit: authedQuery
    .input(z.object({ manifest: z.string().min(2).max(32 * 1024) }))
    .mutation(async ({ ctx, input }) => {
      const v = validateSkillManifest(input.manifest);
      if (!v.ok || !v.manifest) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Skill 校验失败:${v.errors.join("; ").slice(0, 300)}` });
      }
      const db = getDb();
      const dup = await db.select({ id: designSkills.id }).from(designSkills).where(eq(designSkills.skillId, v.manifest.id)).limit(1);
      if (dup.length) throw new TRPCError({ code: "CONFLICT", message: "同 id 的 Skill 已存在" });
      db.insert(designSkills)
        .values({
          skillId: v.manifest.id,
          manifest: JSON.stringify(v.manifest),
          enabled: false, // 审核通过才启用
          status: "submitted",
          createdBy: ctx.user.id,
        })
        .run();
      return { skillId: v.manifest.id, status: "submitted" as const };
    }),

  /** 待审核列表 */
  reviewList: authedQuery.query(async () => {
    const db = getDb();
    const rows = await db.select().from(designSkills).where(eq(designSkills.status, "submitted")).orderBy(desc(designSkills.id));
    return rows.map((r) => ({ skillId: r.skillId, manifest: JSON.parse(r.manifest) as Record<string, unknown>, createdBy: r.createdBy }));
  }),

  /** 审核通过(启用) */
  approve: authedQuery
    .input(z.object({ skillId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      db.update(designSkills).set({ status: "approved", enabled: true }).where(eq(designSkills.skillId, input.skillId)).run();
      return { ok: true };
    }),

  /** 审核拒绝 */
  reject: authedQuery
    .input(z.object({ skillId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      db.update(designSkills).set({ status: "rejected", enabled: false }).where(eq(designSkills.skillId, input.skillId)).run();
      return { ok: true };
    }),
});
