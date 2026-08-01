import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { projects } from "@db/schema";
import { getDb } from "./connection";

/** 校验项目归属并返回项目行;不存在或不属于该用户时抛 NOT_FOUND */
export async function requireProject(userId: number, projectId: number) {
  const db = getDb();
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
  return rows[0];
}
