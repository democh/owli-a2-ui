import { and, asc, desc, eq } from "drizzle-orm";
import {
  type AgentEvent,
  type AgentRunRequest,
  type ApprovalAccept,
  type ApprovalRequest,
  type ClarificationRequest,
  type ClarificationResponse,
  type PlanTask,
  type RunStatus,
  statusGroup,
} from "@contracts/agent";
import { isTerminal, transition, STATUS_LABELS, STATUS_PROGRESS } from "./RunStateMachine";
import { getDb } from "../../queries/connection";
import { runs, runEvents } from "@db/schema";

/**
 * Run Manager(文档 §5.2.1)
 *
 * - 创建/取消/审批/澄清应答的状态中枢
 * - 事件发射:seq 单调分配 → run_events 持久化(断线重放)→ 监听者推送(SSE)
 * - 等待用户(澄清/审批)通过 Promise 挂起执行流,取消时以 CancelledError 恢复
 */

export class RunCancelledError extends Error {
  constructor() {
    super("Run 已取消");
    this.name = "RunCancelledError";
  }
}

type Listener = (event: AgentEvent) => void;

/** 分发式 Omit:联合的每个成员各自把 seq 变为可选(seq 由 RunManager 统一分配) */
type EventInput = AgentEvent extends infer E
  ? E extends { seq: number }
    ? Omit<E, "seq"> & { seq?: number }
    : never
  : never;

interface PendingWait {
  kind: "clarification" | "approval" | "plan_approval";
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/** §14.3 执行控制:暂停闸门 + 任务跳过(状态机不变,仅执行流层面) */
interface RunControls {
  paused: boolean;
  skipTaskIds: Set<string>;
  /** 暂停挂起的 waiter;resume 时逐个唤醒 */
  pauseWaiters: Set<() => void>;
}

interface RunContext {
  request: AgentRunRequest;
  status: RunStatus;
  abort: AbortController;
  seq: number;
  listeners: Set<Listener>;
  pending?: PendingWait;
  controls: RunControls;
  startedAt: number;
}

class RunManagerImpl {
  private contexts = new Map<string, RunContext>();

  // -------------------------------------------------------------------------
  // 创建 / 查询
  // -------------------------------------------------------------------------

  /** 创建 Run(幂等键防重);返回 runId */
  create(request: AgentRunRequest): { runId: string; reused: boolean } {
    const db = getDb();
    const existing = db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, request.projectId), eq(runs.idempotencyKey, request.idempotencyKey)))
      .limit(1)
      .get();
    if (existing) return { runId: existing.runId, reused: true };
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.insert(runs)
      .values({
        runId,
        projectId: request.projectId,
        conversationId: request.conversationId,
        mode: request.mode,
        status: "queued",
        autonomyLevel: request.autonomyLevel,
        userMessage: request.userMessage,
        baseRevision: request.baseRevision,
        idempotencyKey: request.idempotencyKey,
      })
      .run();
    return { runId, reused: false };
  }

  context(runId: string): RunContext | undefined {
    return this.contexts.get(runId);
  }

  request(runId: string): AgentRunRequest | undefined {
    return this.contexts.get(runId)?.request;
  }

  status(runId: string): RunStatus | undefined {
    return this.contexts.get(runId)?.status;
  }

  /** 注册执行上下文(Orchestrator 启动时) */
  attach(runId: string, request: AgentRunRequest): RunContext {
    let ctx = this.contexts.get(runId);
    if (!ctx) {
      ctx = {
        request,
        status: "queued",
        abort: new AbortController(),
        seq: -1,
        listeners: new Set(),
        controls: { paused: false, skipTaskIds: new Set(), pauseWaiters: new Set() },
        startedAt: Date.now(),
      };
      this.contexts.set(runId, ctx);
    }
    return ctx;
  }

  /** 从 run_events 重放历史事件(断线恢复 / 独立 Tab 打开) */
  replay(runId: string): AgentEvent[] {
    const db = getDb();
    const rows = db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq))
      .all();
    return rows.map((r) => JSON.parse(r.payload) as AgentEvent);
  }

  listProject(projectId: number, limit = 20) {
    const db = getDb();
    return db
      .select()
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .orderBy(desc(runs.id))
      .limit(limit)
      .all();
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  subscribe(runId: string, listener: Listener): () => void {
    const ctx = this.contexts.get(runId);
    if (!ctx) return () => {};
    ctx.listeners.add(listener);
    return () => ctx.listeners.delete(listener);
  }

  /**
   * 发射事件:分配 seq → 持久化 → 推送监听者
   * opts.persist=false:仅推送不落 run_events(流式预览帧;重放时旧预览无意义,
   * 且高频帧落库是主要写放大来源)。seq 仍单调分配,前端按 seq 去重兼容空洞。
   */
  emit(runId: string, event: EventInput, opts?: { persist?: boolean }): AgentEvent {
    const ctx = this.contexts.get(runId);
    const seq = event.seq ?? (ctx ? ctx.seq + 1 : 0);
    const full = { ...event, seq } as AgentEvent;
    if (opts?.persist !== false) {
      const db = getDb();
      db.insert(runEvents)
        .values({ runId, seq, type: full.type, payload: JSON.stringify(full) })
        .run();
    }
    if (ctx) {
      ctx.seq = Math.max(ctx.seq, seq);
      for (const l of ctx.listeners) {
        try {
          l(full);
        } catch {
          /* 监听者异常不阻断 */
        }
      }
    }
    return full;
  }

  /** 状态迁移(带 run.state 事件与 DB 同步);非法迁移抛错 */
  toStatus(runId: string, to: RunStatus): RunStatus {
    const ctx = this.contexts.get(runId);
    if (!ctx) throw new Error(`Run ${runId} 未附加`);
    const from = ctx.status;
    const next = transition(from, to);
    ctx.status = next;
    const db = getDb();
    db.update(runs).set({ status: next }).where(eq(runs.runId, runId)).run();
    this.emit(runId, {
      type: "run.state",
      runId,
      status: next,
      label: STATUS_LABELS[next],
      progress: STATUS_PROGRESS[next],
    });
    return next;
  }

  // -------------------------------------------------------------------------
  // 取消
    // -------------------------------------------------------------------------

  /** 取消:中止 LLM/工具,唤醒等待(拒绝),终态由执行流落定 */
  cancel(runId: string): void {
    const ctx = this.contexts.get(runId);
    if (!ctx || isTerminal(ctx.status)) return;
    ctx.abort.abort();
    // §14.3:唤醒暂停挂起的执行流(checkPause 重新检查 abort 后以 RunCancelledError 恢复)
    for (const wake of ctx.controls.pauseWaiters) wake();
    ctx.controls.pauseWaiters.clear();
    if (ctx.pending) {
      const p = ctx.pending;
      ctx.pending = undefined;
      p.reject(new RunCancelledError());
    }
    try {
      this.toStatus(runId, "cancelling");
    } catch {
      // 状态可能不允许(如 awaiting→cancelling 已包含),忽略
    }
    if (ctx.status === "cancelling") this.toStatus(runId, "cancelled");
    const db = getDb();
    db.update(runs)
      .set({ status: "cancelled", durationMs: Date.now() - ctx.startedAt })
      .where(eq(runs.runId, runId))
      .run();
  }

  /** 完成/失败时清理(保留 context 供查询,移除监听);finalStatus 显式指定终态(异常路径兜底,如 queued 直落 failed),避免以内存旧态覆盖 DB */
  finish(runId: string, finalStatus?: RunStatus): void {
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    if (finalStatus && finalStatus !== ctx.status) {
      try {
        ctx.status = transition(ctx.status, finalStatus);
      } catch {
        // 状态机不允许直迁(如 awaiting_* → failed):异常路径以 DB 终态为准,内存保持原值供诊断
      }
    }
    ctx.listeners.clear();
    const db = getDb();
    db.update(runs)
      .set({ status: finalStatus ?? ctx.status, durationMs: Date.now() - ctx.startedAt })
      .where(eq(runs.runId, runId))
      .run();
  }

  recordUsage(runId: string, usage: { promptTokens?: number; completionTokens?: number }, model: string): void {
    if (!usage) return;
    const db = getDb();
    const row = db.select().from(runs).where(eq(runs.runId, runId)).limit(1).get();
    if (!row) return;
    db.update(runs)
      .set({
        promptTokens: row.promptTokens + (usage.promptTokens ?? 0),
        completionTokens: row.completionTokens + (usage.completionTokens ?? 0),
        model: model || row.model,
      })
      .where(eq(runs.runId, runId))
      .run();
  }

  setFinalRevision(runId: string, revision: number): void {
    const db = getDb();
    db.update(runs).set({ finalRevision: revision }).where(eq(runs.runId, runId)).run();
  }

  // -------------------------------------------------------------------------
  // HITL 等待
  // -------------------------------------------------------------------------

  /** 挂起等待澄清;超时按 defaultStrategy 处理 */
  awaitClarification(runId: string, request: ClarificationRequest): Promise<ClarificationResponse> {
    return this.awaitUser(runId, "clarification", request) as Promise<ClarificationResponse>;
  }

  awaitApproval(runId: string, request: ApprovalRequest): Promise<{ approved: boolean; accept?: ApprovalAccept }> {
    return this.awaitUser(runId, "approval", request) as Promise<{ approved: boolean; accept?: ApprovalAccept }>;
  }

  private awaitUser(runId: string, kind: "clarification" | "approval" | "plan_approval", _payload: unknown): Promise<unknown> {
    void _payload;
    const ctx = this.contexts.get(runId);
    if (!ctx) return Promise.reject(new Error(`Run ${runId} 未附加`));
    return new Promise((resolve, reject) => {
      ctx.pending = { kind, resolve, reject };
    });
  }

  /** §14.2 Plan 确认挂起:review/guarded 自治下复杂任务先等用户确认/编辑计划 */
  awaitPlanApproval(runId: string, tasks: PlanTask[]): Promise<{ approved: boolean; tasks?: PlanTask[] }> {
    return this.awaitUser(runId, "plan_approval", tasks) as Promise<{ approved: boolean; tasks?: PlanTask[] }>;
  }

  // -------------------------------------------------------------------------
  // §14.3 执行控制:暂停 / 恢复 / 跳过任务
  // -------------------------------------------------------------------------

  /** 暂停:执行流在下一个阶段边界挂起(不改变状态机状态,可恢复) */
  pause(runId: string): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx || isTerminal(ctx.status)) return false;
    ctx.controls.paused = true;
    this.emit(runId, { type: "run.paused", runId, paused: true });
    return true;
  }

  /** 恢复:唤醒所有暂停 waiter,执行流继续 */
  resume(runId: string): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx || !ctx.controls.paused) return false;
    ctx.controls.paused = false;
    for (const wake of ctx.controls.pauseWaiters) wake();
    ctx.controls.pauseWaiters.clear();
    this.emit(runId, { type: "run.paused", runId, paused: false });
    return true;
  }

  /** 跳过任务:执行流在阶段边界消费(IA 任务跳过会注入生成上下文) */
  skipTask(runId: string, taskId: string): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx || isTerminal(ctx.status)) return false;
    ctx.controls.skipTaskIds.add(taskId);
    return true;
  }

  isSkipped(runId: string, taskId: string): boolean {
    return this.contexts.get(runId)?.controls.skipTaskIds.has(taskId) ?? false;
  }

  isPaused(runId: string): boolean {
    return this.contexts.get(runId)?.controls.paused ?? false;
  }

  /** 阶段边界调用:暂停期间挂起;取消请求到达时以 RunCancelledError 恢复执行流 */
  async checkPause(runId: string): Promise<void> {
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    while (ctx.controls.paused && !ctx.abort.signal.aborted) {
      await new Promise<void>((resolve) => ctx.controls.pauseWaiters.add(resolve));
    }
    if (ctx.abort.signal.aborted) throw new RunCancelledError();
  }

  /** 用户提交澄清回答 → 恢复执行流 */
  submitClarification(runId: string, response: ClarificationResponse): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx?.pending || ctx.pending.kind !== "clarification") return false;
    const p = ctx.pending;
    ctx.pending = undefined;
    this.emit(runId, {
      type: "clarification.accepted",
      runId,
      requestId: response.requestId,
      normalized: { answers: response.answers.length },
    });
    p.resolve(response);
    return true;
  }

  /** 用户审批决策 → 恢复执行流(accept:§14.8 部分接受的变更类别勾选) */
  resolveApproval(runId: string, approved: boolean, accept?: ApprovalAccept): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx?.pending || ctx.pending.kind !== "approval") return false;
    const p = ctx.pending;
    ctx.pending = undefined;
    p.resolve({ approved, accept });
    return true;
  }

  /** §14.2/§14.3 Plan 确认决策:可携带用户编辑/跳过后的任务清单(恢复执行流) */
  resolvePlanApproval(runId: string, approved: boolean, tasks?: PlanTask[]): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx?.pending || ctx.pending.kind !== "plan_approval") return false;
    const p = ctx.pending;
    ctx.pending = undefined;
    p.resolve({ approved, tasks });
    return true;
  }

  /** 用户状态组(顶部栏 Agent 状态灯) */
  statusGroup(runId: string): ReturnType<typeof statusGroup> | null {
    const s = this.status(runId);
    return s ? statusGroup(s) : null;
  }
}

export const RunManager = new RunManagerImpl();
