import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { projectMembers, projects, type Project } from "@db/schema";
import { getDb } from "./connection";

/**
 * RBAC(文档 §9.3 工具权限矩阵 / M6-1)
 *
 * 角色:owner(全权)> editor(设计变更)> viewer(只读)。
 * 项目归属人恒为 owner;project_members 表中的成员按其角色放行;
 * 非成员/项目不存在统一抛 NOT_FOUND(不泄露项目存在性),角色不足抛 FORBIDDEN。
 */

export type ProjectRole = "viewer" | "editor" | "owner";

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

/** 解析用户对项目的有效角色;项目不存在或用户非成员返回 null */
export function resolveProjectRole(
  userId: number,
  projectId: number,
): { project: Project; role: ProjectRole } | null {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).limit(1).get();
  if (!project) return null;
  if (project.userId === userId) return { project, role: "owner" };
  const member = db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1)
    .get();
  const role = (member?.role ?? null) as ProjectRole | null;
  if (!role) return null;
  return { project, role };
}

/**
 * 校验用户对项目具备不低于 minRole 的权限,返回项目行与有效角色(同步版,可直接在同步 resolver 中断)。
 * 项目不存在或用户非成员 → NOT_FOUND;角色低于要求 → FORBIDDEN。
 */
export function assertProjectRole(userId: number, projectId: number, minRole: ProjectRole = "viewer") {
  const resolved = resolveProjectRole(userId, projectId);
  if (!resolved) throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
  const { project, role } = resolved;
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new TRPCError({ code: "FORBIDDEN", message: `权限不足:需要 ${minRole} 角色,当前为 ${role}` });
  }
  return { project, role };
}

/** assertProjectRole 的 async 别名(await 风格调用点使用) */
export async function requireProjectRole(userId: number, projectId: number, minRole: ProjectRole = "viewer") {
  return assertProjectRole(userId, projectId, minRole);
}

/**
 * 校验项目归属并返回项目行(旧调用点兼容)。
 * 归属人或 editor 成员均可通过;viewer 与非成员拒绝。
 */
export async function requireProject(userId: number, projectId: number) {
  const { project } = await requireProjectRole(userId, projectId, "editor");
  return project;
}
