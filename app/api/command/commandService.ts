import { and, desc, eq } from "drizzle-orm";
import {
  applyIRops,
  invertIRops,
  validateIR,
  type DesignScope,
  type IRDocument,
  type IROperation,
  type OpsBatch,
} from "@contracts/design-ir";
import { getDb } from "../queries/connection";
import {
  frames,
  opBatches,
  outboxEvents,
  pageBoards,
  projectRevisions,
  projects,
  snapshots,
  type OpBatchRow,
  type ProjectRevision,
} from "@db/schema";

/**
 * Command Service —— Design IR 的唯一写入口(文档 §5.1 / §14)
 *
 * 事务语义:
 *   BEGIN
 *     校验 baseRevision === head
 *     dry-run applyOps + validateIR
 *     INSERT project_revisions / op_batches(含 inverseOps) / outbox_events
 *     UPDATE projects.headRevision
 *   COMMIT
 * 冲突抛 RevisionConflictError(路由层映射 409);非法结果不落库。
 */

export class RevisionConflictError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Revision 冲突:期望 base=${expected},当前 head=${actual}`);
    this.name = "RevisionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface HeadState {
  revision: number;
  doc: IRDocument;
}

/** 加载项目 head revision 的 IR 文档;尚无 revision 时返回 null */
export function loadHead(projectId: number): HeadState | null {
  const db = getDb();
  const row = db
    .select()
    .from(projectRevisions)
    .where(eq(projectRevisions.projectId, projectId))
    .orderBy(desc(projectRevisions.revision))
    .limit(1)
    .get() as ProjectRevision | undefined;
  if (!row) return null;
  return { revision: row.revision, doc: JSON.parse(row.irDoc) as IRDocument };
}

/** 初始化 revision 0(幂等:已存在则直接返回当前 head) */
export function ensureInitialRevision(projectId: number, doc: IRDocument, runId?: string): number {
  const db = getDb();
  const existing = loadHead(projectId);
  if (existing) return existing.revision;
  const initial: IRDocument = { ...doc, revision: 0 };
  db.transaction((tx) => {
    tx.insert(projectRevisions)
      .values({ projectId, revision: 0, irDoc: JSON.stringify(initial), source: "initial", runId: runId ?? null })
      .run();
    tx.update(projects).set({ headRevision: 0 }).where(eq(projects.id, projectId)).run();
  });
  return 0;
}

export interface CommitInput {
  projectId: number;
  baseRevision: number;
  ops: IROperation[];
  scope?: DesignScope;
  provenance: OpsBatch["provenance"];
  batchId?: string;
}

export interface CommitResult {
  revision: number;
  batchId: string;
  doc: IRDocument;
  inverseOps: IROperation[];
  counts: { added: number; updated: number; deleted: number; moved: number };
}

function countOps(ops: IROperation[]): CommitResult["counts"] {
  const counts = { added: 0, updated: 0, deleted: 0, moved: 0 };
  for (const op of ops) {
    if (op.op === "addNode" || op.op === "addFrame" || op.op === "addPage") counts.added++;
    else if (op.op === "removeNode" || op.op === "removeFrame" || op.op === "removePage") counts.deleted++;
    else if (op.op === "moveNode") counts.moved++;
    else counts.updated++;
  }
  return counts;
}

/** dry-run 目标存在性检查:引用不存在节点的 op 视为非法,拒绝提交(而非静默跳过) */
function assertOpsTargetsExist(doc: IRDocument, ops: IROperation[]): void {
  const problems: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "replaceProps": {
        const s = doc.surfaces[op.surfaceId];
        if (!s) problems.push(`surface "${op.surfaceId}" 不存在`);
        else if (!s.components[op.id]) problems.push(`组件 "${op.id}" 不存在`);
        break;
      }
      case "addNode": {
        const s = doc.surfaces[op.surfaceId];
        if (!s) problems.push(`surface "${op.surfaceId}" 不存在`);
        else if (!s.components[op.parentId]) problems.push(`父组件 "${op.parentId}" 不存在`);
        break;
      }
      case "removeNode": {
        const s = doc.surfaces[op.surfaceId];
        if (!s) problems.push(`surface "${op.surfaceId}" 不存在`);
        else if (!s.components[op.id]) problems.push(`待删除组件 "${op.id}" 不存在`);
        break;
      }
      case "moveNode": {
        const s = doc.surfaces[op.surfaceId];
        if (!s) problems.push(`surface "${op.surfaceId}" 不存在`);
        else if (!s.components[op.id] || !s.components[op.newParentId])
          problems.push(`移动目标 "${op.id}" / "${op.newParentId}" 不存在`);
        break;
      }
      case "setSurfaceTitle": {
        if (!doc.surfaces[op.surfaceId]) problems.push(`surface "${op.surfaceId}" 不存在`);
        break;
      }
      default:
        break;
    }
  }
  if (problems.length > 0) throw new Error(`Ops 引用不存在的目标: ${problems.slice(0, 5).join("; ")}`);
}

/** 原子提交一个 OpsBatch;baseRevision 不匹配抛 RevisionConflictError */
export function commitOpsBatch(input: CommitInput): CommitResult {
  const db = getDb();
  return db.transaction((tx) => {
    const head = tx
      .select()
      .from(projectRevisions)
      .where(eq(projectRevisions.projectId, input.projectId))
      .orderBy(desc(projectRevisions.revision))
      .limit(1)
      .get() as ProjectRevision | undefined;
    const headRevision = head?.revision ?? -1;
    if (headRevision !== input.baseRevision) {
      throw new RevisionConflictError(input.baseRevision, headRevision);
    }
    const beforeDoc: IRDocument = head ? JSON.parse(head.irDoc) : emptyDoc();
    assertOpsTargetsExist(beforeDoc, input.ops);
    const nextDoc = applyIRops(beforeDoc, input.ops);
    nextDoc.revision = headRevision + 1;

    // dry-run 校验:非法结果不得写入事实源
    const errs = validateIR(nextDoc);
    if (errs.length > 0) {
      throw new Error(`IR 校验失败: ${errs.slice(0, 5).join("; ")}`);
    }

    const inverseOps = invertIRops(beforeDoc, input.ops);
    const batchId = input.batchId ?? `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    tx.insert(projectRevisions)
      .values({
        projectId: input.projectId,
        revision: nextDoc.revision,
        irDoc: JSON.stringify(nextDoc),
        source: input.provenance.actorType === "agent" ? "run" : input.provenance.actorType,
        runId: input.provenance.runId ?? null,
      })
      .run();
    tx.insert(opBatches)
      .values({
        batchId,
        projectId: input.projectId,
        baseRevision: input.baseRevision,
        resultingRevision: nextDoc.revision,
        scope: JSON.stringify(input.scope ?? {}),
        ops: JSON.stringify(input.ops),
        inverseOps: JSON.stringify(inverseOps),
        provenance: JSON.stringify(input.provenance),
      })
      .run();
    tx.update(projects)
      .set({ headRevision: nextDoc.revision })
      .where(eq(projects.id, input.projectId))
      .run();
    tx.insert(outboxEvents)
      .values({
        eventType: "design.ops_committed",
        projectId: input.projectId,
        runId: input.provenance.runId ?? null,
        payload: JSON.stringify({
          revision: nextDoc.revision,
          batchId,
          counts: countOps(input.ops),
        }),
      })
      .run();

    return {
      revision: nextDoc.revision,
      batchId,
      doc: nextDoc,
      inverseOps,
      counts: countOps(input.ops),
    };
  });
}

function emptyDoc(): IRDocument {
  return { revision: 0, theme: { preset: "shadcn", tokens: {
    primary: "#18181b", background: "#ffffff", surface: "#f4f4f5",
    text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "",
  } }, surfaces: {}, dataModels: {}, componentDefs: {} };
}

function latestUndoneAwareBatch(tx: Tx, projectId: number, filter?: (b: OpBatchRow) => boolean): OpBatchRow | undefined {
  const rows = tx
    .select()
    .from(opBatches)
    .where(eq(opBatches.projectId, projectId))
    .orderBy(desc(opBatches.id))
    .all() as OpBatchRow[];
  return rows.find((b) => !b.undone && (!filter || filter(b)));
}

function applyInverse(tx: Tx, batch: OpBatchRow, currentDoc: IRDocument, currentRevision: number): IRDocument {
  const inverseOps = JSON.parse(batch.inverseOps) as IROperation[];
  const nextDoc = applyIRops(currentDoc, inverseOps);
  nextDoc.revision = currentRevision + 1;
  const errs = validateIR(nextDoc);
  if (errs.length > 0) throw new Error(`回滚校验失败: ${errs.slice(0, 5).join("; ")}`);
  tx.insert(projectRevisions)
    .values({
      projectId: batch.projectId,
      revision: nextDoc.revision,
      irDoc: JSON.stringify(nextDoc),
      source: "rollback",
    })
    .run();
  tx.update(projects)
    .set({ headRevision: nextDoc.revision })
    .where(eq(projects.id, batch.projectId))
    .run();
  return nextDoc;
}

/** Undo:撤销最近一个未撤销的 batch(可指定 batchId,但必须是当前最新活动 batch) */
export function undoBatch(projectId: number, batchId?: string): { revision: number } {
  const db = getDb();
  return db.transaction((tx) => {
    const batch = latestUndoneAwareBatch(tx, projectId, (b) => (batchId ? b.batchId === batchId : true));
    if (!batch) throw new Error("没有可撤销的批次");
    if (batchId && batch.batchId !== batchId) throw new RevisionConflictError(batchId ? -1 : -1, batch.baseRevision);
    const head = tx
      .select()
      .from(projectRevisions)
      .where(eq(projectRevisions.projectId, projectId))
      .orderBy(desc(projectRevisions.revision))
      .limit(1)
      .get() as ProjectRevision | undefined;
    const doc = head ? (JSON.parse(head.irDoc) as IRDocument) : emptyDoc();
    const next = applyInverse(tx, batch, doc, head?.revision ?? -1);
    tx.update(opBatches).set({ undone: true }).where(eq(opBatches.id, batch.id)).run();
    return { revision: next.revision };
  });
}

/** Redo:重放最近一个被撤销的 batch(仅当它仍是撤销栈顶) */
export function redoBatch(projectId: number): { revision: number } {
  const db = getDb();
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(opBatches)
      .where(and(eq(opBatches.projectId, projectId), eq(opBatches.undone, true)))
      .orderBy(desc(opBatches.id))
      .limit(1)
      .all() as OpBatchRow[];
    const batch = rows[0];
    if (!batch) throw new Error("没有可重做的批次");
    const head = tx
      .select()
      .from(projectRevisions)
      .where(eq(projectRevisions.projectId, projectId))
      .orderBy(desc(projectRevisions.revision))
      .limit(1)
      .get() as ProjectRevision | undefined;
    const doc = head ? (JSON.parse(head.irDoc) as IRDocument) : emptyDoc();
    const ops = JSON.parse(batch.ops) as IROperation[];
    const nextDoc = applyIRops(doc, ops);
    nextDoc.revision = (head?.revision ?? -1) + 1;
    const errs = validateIR(nextDoc);
    if (errs.length > 0) throw new Error(`重做校验失败: ${errs.slice(0, 5).join("; ")}`);
    tx.insert(projectRevisions)
      .values({
        projectId,
        revision: nextDoc.revision,
        irDoc: JSON.stringify(nextDoc),
        source: "manual",
      })
      .run();
    tx.update(projects).set({ headRevision: nextDoc.revision }).where(eq(projects.id, projectId)).run();
    tx.update(opBatches).set({ undone: false }).where(eq(opBatches.id, batch.id)).run();
    return { revision: nextDoc.revision };
  });
}

/**
 * Run 回滚(文档 §6.5):按 Run 原子撤销全部已提交批次。
 * 仅当这些批次之后没有外部修改(即 run 的最新 batch 就是当前活动栈顶)时允许;
 * 否则抛错,提示用户通过快照恢复。
 */
export function rollbackRun(projectId: number, runId: string): { revision: number; batches: number } {
  const db = getDb();
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(opBatches)
      .where(eq(opBatches.projectId, projectId))
      .orderBy(desc(opBatches.id))
      .all() as OpBatchRow[];
    const runBatches = rows.filter((b) => !b.undone && (JSON.parse(b.provenance) as OpsBatch["provenance"]).runId === runId);
    if (runBatches.length === 0) throw new Error("该 Run 没有已提交的修改");
    // 活动栈顶必须连续地属于本 run(run 的所有 batch 完整占据撤销栈顶,中间无外部修改)
    const activeStack = rows.filter((b) => !b.undone);
    const runBatchIds = new Set(runBatches.map((b) => b.id));
    const topSegment = activeStack.slice(0, runBatches.length);
    if (
      topSegment.length !== runBatches.length ||
      !topSegment.every((b) => runBatchIds.has(b.id))
    ) {
      throw new Error("Run 之后存在外部修改,无法自动回滚;请使用快照恢复");
    }
    const head = tx
      .select()
      .from(projectRevisions)
      .where(eq(projectRevisions.projectId, projectId))
      .orderBy(desc(projectRevisions.revision))
      .limit(1)
      .get() as ProjectRevision | undefined;
    let doc = head ? (JSON.parse(head.irDoc) as IRDocument) : emptyDoc();
    let revision = head?.revision ?? -1;
    for (const batch of runBatches) {
      doc = applyInverse(tx, batch, doc, revision);
      revision = doc.revision;
      tx.update(opBatches).set({ undone: true }).where(eq(opBatches.id, batch.id)).run();
    }
    tx.insert(outboxEvents)
      .values({
        eventType: "design.run_rolled_back",
        projectId,
        runId,
        payload: JSON.stringify({ revision, batches: runBatches.length }),
      })
      .run();
    return { revision, batches: runBatches.length };
  });
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

export function createSnapshot(projectId: number, label: string, kind: "auto" | "manual"): { revision: number } {
  const db = getDb();
  const head = loadHead(projectId);
  const revision = head?.revision ?? -1;
  db.insert(snapshots).values({ projectId, label, kind, revision }).run();
  return { revision };
}

export function listSnapshots(projectId: number) {
  const db = getDb();
  return db
    .select()
    .from(snapshots)
    .where(eq(snapshots.projectId, projectId))
    .orderBy(desc(snapshots.id))
    .all();
}

/** 从快照恢复:创建指向快照 revision 文档的新 revision(baseRevision 冲突时拒绝) */
export function restoreSnapshot(projectId: number, snapshotId: number, baseRevision: number): { revision: number } {
  const db = getDb();
  return db.transaction((tx) => {
    const snap = tx
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.id, snapshotId), eq(snapshots.projectId, projectId)))
      .limit(1)
      .get() as { id: number; revision: number } | undefined;
    if (!snap) throw new Error("快照不存在");
    const snapRev = tx
      .select()
      .from(projectRevisions)
      .where(and(eq(projectRevisions.projectId, projectId), eq(projectRevisions.revision, snap.revision)))
      .limit(1)
      .get() as ProjectRevision | undefined;
    if (!snapRev) throw new Error("快照对应的 revision 不存在");
    const head = tx
      .select()
      .from(projectRevisions)
      .where(eq(projectRevisions.projectId, projectId))
      .orderBy(desc(projectRevisions.revision))
      .limit(1)
      .get() as ProjectRevision | undefined;
    if ((head?.revision ?? -1) !== baseRevision) {
      throw new RevisionConflictError(baseRevision, head?.revision ?? -1);
    }
    const doc = JSON.parse(snapRev.irDoc) as IRDocument;
    doc.revision = (head?.revision ?? -1) + 1;
    tx.insert(projectRevisions)
      .values({
        projectId,
        revision: doc.revision,
        irDoc: JSON.stringify(doc),
        source: "rollback",
      })
      .run();
    tx.update(projects).set({ headRevision: doc.revision }).where(eq(projects.id, projectId)).run();
    return { revision: doc.revision };
  });
}

// ---------------------------------------------------------------------------
// Run 提交入口:结构性行(PageBoard/Frame)与 OpsBatch 同事务落库
// (LLM 产出的新页面无法预知自增 id,用 tempKey 占位、事务内映射)
// ---------------------------------------------------------------------------

export interface NewBoardSpec {
  tempKey: string;
  title: string;
  posX: number;
  posY: number;
}

export interface NewFrameSpec {
  tempKey: string;
  boardTempKey: string;
  surfaceId: string;
  title: string;
  device: string;
  width: number;
  height: number;
  posX: number;
  posY: number;
}

export interface RunCommitResult extends CommitResult {
  frameIds: Record<string, number>;
  boardIds: Record<string, number>;
}

export function commitRunChanges(
  input: CommitInput & { boards?: NewBoardSpec[]; frames?: NewFrameSpec[] },
): RunCommitResult {
  const db = getDb();
  return db.transaction((tx) => {
    const head = tx
      .select()
      .from(projectRevisions)
      .where(eq(projectRevisions.projectId, input.projectId))
      .orderBy(desc(projectRevisions.revision))
      .limit(1)
      .get() as ProjectRevision | undefined;
    const headRevision = head?.revision ?? -1;
    if (headRevision !== input.baseRevision) {
      throw new RevisionConflictError(input.baseRevision, headRevision);
    }
    const beforeDoc: IRDocument = head ? JSON.parse(head.irDoc) : emptyDoc();
    assertOpsTargetsExist(beforeDoc, input.ops);
    const nextDoc = applyIRops(beforeDoc, input.ops);
    nextDoc.revision = headRevision + 1;

    const errs = validateIR(nextDoc);
    if (errs.length > 0) throw new Error(`IR 校验失败: ${errs.slice(0, 5).join("; ")}`);

    const inverseOps = invertIRops(beforeDoc, input.ops);
    const batchId = input.batchId ?? `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // 结构性行:插入 PageBoard / Frame(先于 revision 写入,保证引用一致性)
    const boardIds: Record<string, number> = {};
    const frameIds: Record<string, number> = {};
    for (const b of input.boards ?? []) {
      const r = tx
        .insert(pageBoards)
        .values({ projectId: input.projectId, title: b.title, posX: b.posX, posY: b.posY })
        .run();
      boardIds[b.tempKey] = Number(r.lastInsertRowid);
    }
    for (const f of input.frames ?? []) {
      const r = tx
        .insert(frames)
        .values({
          pageBoardId: boardIds[f.boardTempKey],
          surfaceId: f.surfaceId,
          title: f.title,
          device: f.device,
          width: f.width,
          height: f.height,
          posX: f.posX,
          posY: f.posY,
        })
        .run();
      frameIds[f.tempKey] = Number(r.lastInsertRowid);
    }

    tx.insert(projectRevisions)
      .values({
        projectId: input.projectId,
        revision: nextDoc.revision,
        irDoc: JSON.stringify(nextDoc),
        source: input.provenance.actorType === "agent" ? "run" : input.provenance.actorType,
        runId: input.provenance.runId ?? null,
      })
      .run();
    tx.insert(opBatches)
      .values({
        batchId,
        projectId: input.projectId,
        baseRevision: input.baseRevision,
        resultingRevision: nextDoc.revision,
        scope: JSON.stringify(input.scope ?? {}),
        ops: JSON.stringify(input.ops),
        inverseOps: JSON.stringify(inverseOps),
        provenance: JSON.stringify(input.provenance),
      })
      .run();
    tx.update(projects)
      .set({ headRevision: nextDoc.revision })
      .where(eq(projects.id, input.projectId))
      .run();
    tx.insert(outboxEvents)
      .values({
        eventType: "design.ops_committed",
        projectId: input.projectId,
        runId: input.provenance.runId ?? null,
        payload: JSON.stringify({ revision: nextDoc.revision, batchId, counts: countOps(input.ops) }),
      })
      .run();

    return {
      revision: nextDoc.revision,
      batchId,
      doc: nextDoc,
      inverseOps,
      counts: countOps(input.ops),
      boardIds,
      frameIds,
    };
  });
}
