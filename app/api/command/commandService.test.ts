import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离测试库:必须在加载 connection/env 之前设置 DATABASE_URL
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui-cmdtest-"));
process.env.DATABASE_URL = path.join(tmpDir, "test.db");

const { commitOpsBatch, commitRunChanges, ensureInitialRevision, loadHead, undoBatch, redoBatch, rollbackRun, createSnapshot, restoreSnapshot, RevisionConflictError } = await import("./commandService");
const { getDb } = await import("../queries/connection");
const { users, projects, opBatches, projectRevisions } = await import("@db/schema");
const { eq } = await import("drizzle-orm");

type IRDocument = import("@contracts/design-ir").IRDocument;
import { DEFAULT_TOKENS, DEFAULT_VISUAL } from "@contracts/a2ui";

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
      tokens: DEFAULT_TOKENS,
      visual: DEFAULT_VISUAL,
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

  it("视觉语言开关:仅带 visual 的 setTokens 可提交并可撤销", () => {
    const head = loadHead(projectId)!;
    commitOpsBatch({
      projectId,
      baseRevision: head.revision,
      ops: [{ op: "setTokens", tokens: {}, visual: { cardStyle: "clay", motion: "none" } }],
      provenance: { actorType: "user", actorId: "0" },
    });
    const after = loadHead(projectId)!;
    expect(after.doc.theme.visual.cardStyle).toBe("clay");
    expect(after.doc.theme.visual.motion).toBe("none");
    undoBatch(projectId);
    const undone = loadHead(projectId)!;
    expect(undone.doc.theme.visual.cardStyle).toBe(head.doc.theme.visual.cardStyle);
    expect(undone.doc.theme.visual.motion).toBe(head.doc.theme.visual.motion);
  });

  it("历史 revision 整体缺省 theme.visual 时,setTokens(visual) 提交/撤销不崩溃(回归:画布不联动根因)", () => {
    const db = getDb();
    const user = db.select().from(users).where(eq(users.unionId, "u_test")).get()!;
    // 新建独立项目,直接写入风格字段上线前的"旧版" revision(theme 整体缺省 visual)
    const p = db.insert(projects).values({ userId: user.id, name: "旧数据兼容测试" }).run();
    const legacyPid = Number(p.lastInsertRowid);
    const legacyDoc = {
      revision: 0,
      theme: { preset: "shadcn", tokens: DEFAULT_TOKENS }, // 关键:缺 visual
      surfaces: docWithSurface().surfaces,
      dataModels: {},
      componentDefs: {},
    };
    db.insert(projectRevisions)
      .values({ projectId: legacyPid, revision: 0, irDoc: JSON.stringify(legacyDoc), source: "initial" })
      .run();
    db.update(projects).set({ headRevision: 0 }).where(eq(projects.id, legacyPid)).run();

    const head = loadHead(legacyPid)!;
    // 读口经 parseIrDoc 补默认:head 的 visual 应为默认值而非 undefined
    expect(head.doc.theme.visual).toBeDefined();
    expect(() =>
      commitOpsBatch({
        projectId: legacyPid,
        baseRevision: head.revision,
        ops: [{ op: "setTokens", tokens: {}, visual: { cardStyle: "elevated" } }],
        provenance: { actorType: "agent", actorId: "run_legacy", runId: "run_legacy" },
      }),
    ).not.toThrow();
    expect(loadHead(legacyPid)!.doc.theme.visual.cardStyle).toBe("elevated");
    // 撤销:invertIRops 读旧值——未补默认时会在 undefined 上取值崩溃 → run.failed
    expect(() => undoBatch(legacyPid)).not.toThrow();
  });

  it("commitRunChanges(实跑崩溃入口)对缺 theme.visual 的历史 revision 不崩溃", () => {
    const db = getDb();
    const user = db.select().from(users).where(eq(users.unionId, "u_test")).get()!;
    const p = db.insert(projects).values({ userId: user.id, name: "commitRunChanges 旧数据" }).run();
    const legacyPid = Number(p.lastInsertRowid);
    const legacyDoc = {
      revision: 0,
      theme: { preset: "shadcn", tokens: DEFAULT_TOKENS }, // 缺 visual(风格字段上线前的存库形态)
      surfaces: docWithSurface().surfaces,
      dataModels: {},
      componentDefs: {},
    };
    db.insert(projectRevisions)
      .values({ projectId: legacyPid, revision: 0, irDoc: JSON.stringify(legacyDoc), source: "initial" })
      .run();
    db.update(projects).set({ headRevision: 0 }).where(eq(projects.id, legacyPid)).run();
    const head = loadHead(legacyPid)!;
    // 编排器 assembleOps prependThemeOp 产出的正是携带 visual 的 setTokens → 旧代码在此崩溃
    expect(() =>
      commitRunChanges({
        projectId: legacyPid,
        baseRevision: head.revision,
        ops: [{ op: "setTokens", tokens: { primary: "#22c55e" }, visual: { cardStyle: "elevated", density: "compact" } }],
        provenance: { actorType: "agent", actorId: "run_rc", runId: "run_rc" },
      }),
    ).not.toThrow();
    const after = loadHead(legacyPid)!;
    expect(after.doc.theme.visual.cardStyle).toBe("elevated");
    expect(after.doc.theme.tokens.primary).toBe("#22c55e");
    // 回滚整个 run(再次走 invertIRops 旧值回滚路径)
    expect(() => rollbackRun(legacyPid, "run_rc")).not.toThrow();
    expect(loadHead(legacyPid)!.doc.theme.visual.cardStyle).toBe(head.doc.theme.visual.cardStyle);
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
