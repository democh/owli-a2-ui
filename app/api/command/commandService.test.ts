import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离测试库:必须在加载 connection/env 之前设置 DATABASE_URL
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui-cmdtest-"));
process.env.DATABASE_URL = path.join(tmpDir, "test.db");

const { commitOpsBatch, ensureInitialRevision, loadHead, undoBatch, redoBatch, rollbackRun, createSnapshot, restoreSnapshot, RevisionConflictError } = await import("./commandService");
const { getDb } = await import("../queries/connection");
const { users, projects, opBatches } = await import("@db/schema");
const { eq } = await import("drizzle-orm");

type IRDocument = import("@contracts/design-ir").IRDocument;

let projectId = 0;

async function setup() {
  const db = getDb();
  db.insert(users)
    .values({ unionId: "u_test", name: "测试用户" })
    .onConflictDoNothing()
    .run();
  const user = db.select().from(users).where(eq(users.unionId, "u_test")).get();
  const p = db
    .insert(projects)
    .values({ userId: user!.id, name: "命令服务测试项目" })
    .run();
  projectId = Number(p.lastInsertRowid);
}

function docWithSurface(): IRDocument {
  return {
    revision: 0,
    theme: {
      preset: "shadcn",
      tokens: {
        primary: "#18181b", background: "#ffffff", surface: "#f4f4f5",
        text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "",
      },
    },
    surfaces: {
      frame_home: {
        id: "frame_home",
        title: "首页",
        root: "root",
        components: {
          root: { type: "Section", props: {}, children: ["title_1"] },
          title_1: { type: "Title", props: { text: "首页" }, children: [] },
        },
      },
    },
    dataModels: {}, componentDefs: {},
  };
}

const provenance = {
  actorType: "agent" as const,
  actorId: "run_test",
  runId: "run_test",
};

describe("CommandService", () => {
  beforeAll(async () => {
    await setup();
    ensureInitialRevision(projectId, docWithSurface());
  });

  beforeEach(() => {
    // 每个用例独立 runId,避免回滚断言互相干扰
    provenance.runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  });

  it("baseRevision 匹配时原子提交并推进 head", () => {
    const head = loadHead(projectId)!;
    const result = commitOpsBatch({
      projectId,
      baseRevision: head.revision,
      ops: [
        {
          op: "replaceProps",
          surfaceId: "frame_home",
          id: "title_1",
          props: { text: "新标题" },
        },
      ],
      provenance,
    });
    expect(result.revision).toBe(head.revision + 1);
    expect(loadHead(projectId)!.doc.surfaces.frame_home.components.title_1.props.text).toBe("新标题");
  });

  it("baseRevision 不匹配抛冲突且不落库", () => {
    const head = loadHead(projectId)!;
    expect(() =>
      commitOpsBatch({
        projectId,
        baseRevision: head.revision + 5,
        ops: [{ op: "setTokens", tokens: { primary: "#000" } }],
        provenance,
      }),
    ).toThrow(RevisionConflictError);
    expect(loadHead(projectId)!.revision).toBe(head.revision);
  });

  it("非法 IR 拒绝提交", () => {
    const head = loadHead(projectId)!;
    expect(() =>
      commitOpsBatch({
        projectId,
        baseRevision: head.revision,
        ops: [
          {
            op: "addNode",
            surfaceId: "frame_home",
            parentId: "ghost_parent",
            id: "x1",
            node: { type: "Text", props: {}, children: [] },
            extra: {},
          },
        ],
        provenance,
      }),
    ).toThrow();
  });

  it("undo/redo 往返恢复文档", () => {
    const head = loadHead(projectId)!;
    commitOpsBatch({
      projectId,
      baseRevision: head.revision,
      ops: [
        { op: "addNode", surfaceId: "frame_home", parentId: "root", id: "btn_undo", node: { type: "Button", props: { label: "撤销测试" }, children: [] }, extra: {} },
      ],
      provenance,
    });
    expect(loadHead(projectId)!.doc.surfaces.frame_home.components.btn_undo).toBeDefined();
    undoBatch(projectId);
    expect(loadHead(projectId)!.doc.surfaces.frame_home.components.btn_undo).toBeUndefined();
    redoBatch(projectId);
    expect(loadHead(projectId)!.doc.surfaces.frame_home.components.btn_undo).toBeDefined();
    // 清理:再撤销一次,保持后续用例状态干净
    undoBatch(projectId);
  });

  it("rollbackRun 按 Run 原子回滚全部批次", () => {
    const head = loadHead(projectId)!;
    commitOpsBatch({
      projectId,
      baseRevision: head.revision,
      ops: [{ op: "setTokens", tokens: { primary: "#123456" } }],
      provenance,
    });
    const head2 = loadHead(projectId)!;
    commitOpsBatch({
      projectId,
      baseRevision: head2.revision,
      ops: [{ op: "setTokens", tokens: { radius: 4 } }],
      provenance,
    });
    expect(loadHead(projectId)!.doc.theme.tokens.primary).toBe("#123456");
    const r = rollbackRun(projectId, provenance.runId);
    expect(r.batches).toBe(2);
    const doc = loadHead(projectId)!.doc;
    expect(doc.theme.tokens.primary).toBe(head.doc.theme.tokens.primary);
    expect(doc.theme.tokens.radius).toBe(head.doc.theme.tokens.radius);
  });

  it("快照创建与恢复", () => {
    const head = loadHead(projectId)!;
    const snap = createSnapshot(projectId, "测试快照", "manual");
    expect(snap.revision).toBe(head.revision);
    commitOpsBatch({
      projectId,
      baseRevision: head.revision,
      ops: [{ op: "setSurfaceTitle", surfaceId: "frame_home", title: "改动后" }],
      provenance: { actorType: "user", actorId: "0" },
    });
    const restored = restoreSnapshot(projectId, 1, loadHead(projectId)!.revision);
    expect(loadHead(projectId)!.doc.surfaces.frame_home.title).not.toBe("改动后");
    expect(restored.revision).toBeGreaterThan(head.revision);
  });

  it("op_batches 记录 provenance 与 inverseOps", () => {
    const db = getDb();
    const rows = db.select().from(opBatches).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const b of rows) {
      const prov = JSON.parse(b.provenance) as { actorType?: string; runId?: string };
      expect(prov.actorType).toBeDefined();
      expect(Array.isArray(JSON.parse(b.inverseOps))).toBe(true);
    }
    const agentBatches = rows.filter((b) => (JSON.parse(b.provenance) as { actorType?: string }).actorType === "agent");
    expect(agentBatches.length).toBeGreaterThan(0);
  });
});
