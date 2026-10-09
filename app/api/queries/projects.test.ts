import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离测试库:必须在加载 connection/env 之前设置 DATABASE_URL
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui-rbac-"));
process.env.DATABASE_URL = path.join(tmpDir, "test.db");

const { resolveProjectRole, assertProjectRole, requireProject } = await import("./projects");
const { getDb } = await import("../queries/connection");
const { projectMembers, projects, users } = await import("@db/schema");
const { eq } = await import("drizzle-orm");

/**
 * RBAC 权限矩阵测试(M6-1,文档 §9.3)
 * owner(归属人)全权;editor 设计变更;viewer 只读;非成员不可见(NOT_FOUND)。
 */

let ownerId = 0;
let editorId = 0;
let viewerId = 0;
let outsiderId = 0;
let projectId = 0;

function insertUser(unionId: string): number {
  const db = getDb();
  db.insert(users).values({ unionId, name: unionId }).onConflictDoNothing().run();
  return db.select().from(users).where(eq(users.unionId, unionId)).get()!.id;
}

describe("RBAC requireProjectRole", () => {
  beforeAll(() => {
    ownerId = insertUser("rbac_owner");
    editorId = insertUser("rbac_editor");
    viewerId = insertUser("rbac_viewer");
    outsiderId = insertUser("rbac_outsider");
    const db = getDb();
    const r = db.insert(projects).values({ userId: ownerId, name: "RBAC 测试项目" }).run();
    projectId = Number(r.lastInsertRowid);
    db.insert(projectMembers).values([
      { projectId, userId: editorId, role: "editor" },
      { projectId, userId: viewerId, role: "viewer" },
    ]).run();
  });

  it("角色解析:归属人恒为 owner,成员按角色,非成员为 null", () => {
    expect(resolveProjectRole(ownerId, projectId)?.role).toBe("owner");
    expect(resolveProjectRole(editorId, projectId)?.role).toBe("editor");
    expect(resolveProjectRole(viewerId, projectId)?.role).toBe("viewer");
    expect(resolveProjectRole(outsiderId, projectId)).toBeNull();
  });

  it("权限矩阵:viewer/editor/owner 对齐文档 §9.3", () => {
    // 只读上下文:三类角色均可
    expect(() => assertProjectRole(viewerId, projectId, "viewer")).not.toThrow();
    expect(() => assertProjectRole(editorId, projectId, "viewer")).not.toThrow();
    expect(() => assertProjectRole(ownerId, projectId, "viewer")).not.toThrow();
    // 设计变更(Proposal/Commit 类 mutation):viewer 拒绝,editor/owner 放行
    expect(() => assertProjectRole(viewerId, projectId, "editor")).toThrow(/FORBIDDEN|权限不足/);
    expect(() => assertProjectRole(editorId, projectId, "editor")).not.toThrow();
    expect(() => assertProjectRole(ownerId, projectId, "editor")).not.toThrow();
    // Delete/Rollback(删除/成员管理):仅 owner
    expect(() => assertProjectRole(viewerId, projectId, "owner")).toThrow();
    expect(() => assertProjectRole(editorId, projectId, "owner")).toThrow();
    expect(() => assertProjectRole(ownerId, projectId, "owner")).not.toThrow();
  });

  it("非成员与不存在项目均抛 NOT_FOUND(不泄露存在性)", () => {
    expect(() => assertProjectRole(outsiderId, projectId)).toThrow(/项目不存在/);
    expect(() => assertProjectRole(ownerId, 999999)).toThrow(/项目不存在/);
  });

  it("requireProject(旧语义)对 viewer 拒绝、editor 放行", async () => {
    await expect(requireProject(viewerId, projectId)).rejects.toThrow();
    await expect(requireProject(editorId, projectId)).resolves.toMatchObject({ id: projectId });
  });
});
