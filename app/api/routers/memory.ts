import { z } from "zod";
import { eq } from "drizzle-orm";
import { authedQuery, createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { userSettings } from "@db/schema";
import { projectMemorySchema, type ProjectMemory } from "@contracts/memory";

/**
 * 项目记忆路由(文档 §10.5)
 *
 * Agent 不能静默修改长期偏好;记忆由用户在设置页显式查看/编辑/删除。
 * 存储于 user_settings.preferences(JSON)。
 */

function parseMemory(raw: string | null | undefined): ProjectMemory {
  try {
    const parsed = projectMemorySchema.safeParse(JSON.parse(raw ?? "{}"));
    return parsed.success ? parsed.data : projectMemorySchema.parse({});
  } catch {
    return projectMemorySchema.parse({});
  }
}

export const memoryRouter = createRouter({
  get: authedQuery.query(async ({ ctx }) => {
    const row = getDb()
      .select({ preferences: userSettings.preferences })
      .from(userSettings)
      .where(eq(userSettings.userId, ctx.user.id))
      .limit(1)
      .get();
    return { memory: parseMemory(row?.preferences) };
  }),

  /** 全量保存(设置页编辑;整块替换,避免 Agent 与用户的并发写冲突) */
  update: authedQuery
    .input(z.object({ memory: projectMemorySchema }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const json = JSON.stringify(projectMemorySchema.parse(input.memory));
      const rows = db.select({ id: userSettings.id }).from(userSettings).where(eq(userSettings.userId, ctx.user.id)).limit(1).get();
      if (rows) {
        db.update(userSettings).set({ preferences: json }).where(eq(userSettings.userId, ctx.user.id)).run();
      } else {
        db.insert(userSettings).values({ userId: ctx.user.id, preferences: json }).run();
      }
      return { ok: true, memory: parseMemory(json) };
    }),
});
