import { create } from "zustand";
import { useWorkspace, type PageState } from "./workspaceStore";
import { mergePreviewDelta } from "@/lib/partialSurface";
import type {
  AgentEvent,
  ApprovalRequest,
  ClarificationRequest,
  DesignBrief,
  DesignPlan,
  PlanTask,
  RunStatus,
  StyleDirection,
  ToolCard,
  UXReviewReport,
} from "@contracts/agent";

/**
 * runStore —— Run/TurnCard 状态(前端 Agent 工作区数据源)
 *
 * 每次 runs.create 形成一个 Turn(文档 §14):目标、上下文、Plan、工具卡、
 * 澄清、评审、Diff、审批、解释全部挂在 turnId(=runId)下。
 */

export interface Turn {
  runId: string;
  status: RunStatus;
  label: string;
  progress: number;
  goal: string;
  brief?: DesignBrief;
  plan?: DesignPlan;
  style?: StyleDirection;
  planTasks: PlanTask[];
  toolCards: ToolCard[];
  /** §16.1/§24.5 Skill 贡献(id@version + 触发原因) */
  skills?: { skillId: string; version: string; reason: string }[];
  review?: UXReviewReport;
  /** §14.1 Proposal 产物概要(design.proposal_created) */
  proposal?: { proposalId: string; status: string; rationale: string; confidence: number; changeSummary: { added: number; updated: number; deleted: number; moved: number; affectedSurfaces: string[] } };
  explanation?: string;
  error?: string;
  /** §14.3 执行暂停闸门(状态机状态不变,Plan 细节块展示与恢复) */
  paused?: boolean;
  startedAt: number;
}

interface RunState {
  turns: Record<string, Turn>;
  /** 当前活跃 run(顶部栏状态灯) */
  activeRunId: string | null;
  /** 待应答的澄清(HITL) */
  pendingClarification: (ClarificationRequest & { runId: string }) | null;
  /** 待审批(HITL) */
  pendingApproval: (ApprovalRequest & { diffSummary: ApprovalRequest["diffSummary"] }) | null;
  /** §14.2 待确认的执行计划(HITL;确认时可携带编辑后的任务清单) */
  pendingPlanApproval: { runId: string; tasks: PlanTask[]; timeoutSeconds: number; expiresAt?: string } | null;
  /** 生成中的渐进预览:surfaceId → 部分文档 JSON */
  previews: Record<string, unknown>;
  /** M7 增量预览的累积文档:surfaceId → mergePreviewDelta 还原的完整 SurfaceDoc */
  previewDocs: Record<string, import("@contracts/a2ui").SurfaceDoc>;
  /** 骨架幻影帧标记:surfaceId → 该页当前仅有骨架(尚未收到真实组件),画布保留空画框占位 */
  skeletonIds: Record<string, boolean>;
  /** M7 打字机:当前 run 生成原始输出(累积;不落库) */
  streamText: string;
  /** 已提交结果(触发画布刷新) */
  lastCommittedRevision: number | null;
  committedRuns: string[];

  startTurn: (runId: string, goal: string, startedAt?: number) => void;
  /**
   * 应用事件重建 Turn 状态。
   * replay=true 为历史回放模式(已结束 Run 的事件重建):
   *   只更新 store 展示态,跳过画布侧效应(draft/nodeDiffs/focus 闪烁/committed)
   *   与 HITL 重新挂起(pending 标记 / expiresAt)。
   * 断线恢复(页面重载时重连的进行中 Run)按实时语义回放:回填展示态、
   * 重新挂起 HITL(该 Run 确实待用户应答)。单流主线已废除 Tab 切换,
   * 重放不会再抢走用户当前视图。
   */
  applyEvent: (e: AgentEvent, replay?: boolean) => void;
  clearClarification: () => void;
  clearApproval: () => void;
  clearPlanApproval: () => void;
  /** 当前 run 连接失效(服务重启/记录不存在)时清空活跃标记 */
  clearActiveRun: () => void;
  activeTurn: () => Turn | null;
  /** Run 级撤销成功后从已提交清单移除(§16.5) */
  removeCommittedRun: (runId: string) => void;
  /** §14.3 执行中跳过任务的乐观更新(权威状态以 run.plan 事件为准) */
  markTaskSkipped: (runId: string, taskId: string) => void;
  /**
   * 历史回放:为一个已结束的 Run 重建 Turn(不抢 activeRunId)。
   * 逐条以 replay=true 应用持久化事件,只回填展示态。
   * terminalStatus 传 DB 行的终态:服务崩溃/重启时终态事件(解释/失败/取消)
   * 未落库,回放后的 Turn 会停在非终态样式(无限 spinner/耗时增长),
   * 以 DB 事实状态兜底覆盖。
   */
  seedHistoryRun: (runId: string, goal: string, startedAt: number, events: AgentEvent[], terminalStatus?: RunStatus) => void;
}

function emptyTurn(runId: string, goal: string, startedAt?: number): Turn {
  return {
    runId,
    status: "queued",
    label: "排队中",
    progress: 0,
    goal,
    planTasks: [],
    toolCards: [],
    startedAt: startedAt ?? Date.now(),
  };
}

/** turns 记录上限:长会话(反复生成/重放)防内存膨胀,保留最近 N 个 Turn(活跃 Run 不参与淘汰) */
const MAX_TURNS = 30;

/**
 * M7 打字机流节流:SSE 原始输出帧高频,逐帧写 store 会整条消息流重渲染。
 * 缓冲 80ms(≈12fps)合并一次提交;阶段切换/终态前强制 flush 保文本时序。
 * 不落库,persist 无感;历史回放(replay)不进入本缓冲。
 */
const STREAM_FLUSH_MS = 80;
let streamBuf = "";
let streamTimer: ReturnType<typeof setTimeout> | null = null;
function flushStreamText() {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  const add = streamBuf;
  streamBuf = "";
  if (add) useRunStore.setState((s) => ({ streamText: s.streamText + add }));
}
function resetStreamText() {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  streamBuf = "";
}
function capTurns(turns: Record<string, Turn>, activeRunId: string | null): Record<string, Turn> {
  const ids = Object.keys(turns);
  if (ids.length <= MAX_TURNS) return turns;
  const evictable = ids
    .filter((id) => id !== activeRunId)
    .sort((a, b) => turns[a].startedAt - turns[b].startedAt)
    .slice(0, ids.length - MAX_TURNS);
  if (!evictable.length) return turns;
  const next = { ...turns };
  for (const id of evictable) delete next[id];
  return next;
}

export const useRunStore = create<RunState>((set, get) => ({
  turns: {},
  activeRunId: null,
  pendingClarification: null,
  pendingApproval: null,
  pendingPlanApproval: null,
  previews: {},
  previewDocs: {},
  skeletonIds: {},
  streamText: "",
  lastCommittedRevision: null,
  committedRuns: [],

  startTurn: (runId, goal, startedAt) =>
    set((s) => ({
      turns: { ...s.turns, [runId]: s.turns[runId] ?? emptyTurn(runId, goal, startedAt) },
      activeRunId: runId,
    })),

  applyEvent: (e, replay) => {
    const s = get();
    const runId = e.runId;
    const existing = s.turns[runId];
    const turn: Turn = existing ?? emptyTurn(runId, "");
    // 写入本 Run 的 Turn 并统一走 capTurns 淘汰旧记录(防长会话内存膨胀)
    const setTurn = (patch: Partial<Turn>) =>
      set({ turns: capTurns({ ...s.turns, [runId]: { ...turn, ...patch } }, runId) });
    switch (e.type) {
      case "run.state":
        // 阶段切换前先冲出缓冲帧(残帧属于上一阶段,保持打字机文本时序)
        flushStreamText();
        if (e.status === "generating") resetStreamText(); // 新一轮生成开始:清缓冲再置空
        set({
          turns: capTurns({ ...s.turns, [runId]: { ...turn, status: e.status, label: e.label, progress: e.progress ?? turn.progress } }, runId),
          // 历史回放不抢活跃标记(否则会把当前实时订阅的 Run 误切到旧 Run)
          activeRunId: replay ? s.activeRunId : runId,
          // M7 打字机:新一轮生成开始时清空原始输出
          ...(e.status === "generating" ? { streamText: "" } : {}),
        });
        break;
      case "run.plan":
        set({ turns: capTurns({ ...s.turns, [runId]: { ...turn, planTasks: e.tasks } }, runId) });
        break;
      case "run.step": {
        const cards = [...turn.toolCards];
        const idx = cards.findIndex((c) => c.cardId === e.card.cardId);
        if (idx >= 0) cards[idx] = e.card;
        else cards.push(e.card);
        setTurn({ toolCards: cards });
        break;
      }
      case "run.failed":
        flushStreamText();
        setTurn({ status: "failed", error: e.message });
        if (!replay) useWorkspace.setState({ draft: null });
        break;
      case "run.cancelled":
        flushStreamText();
        setTurn({ status: "cancelled" });
        if (!replay) useWorkspace.setState({ draft: null });
        break;
      case "design.brief_created":
        setTurn({ brief: e.brief });
        break;
      case "design.plan_created":
        setTurn({ plan: e.plan });
        break;
      case "design.style_resolved":
        setTurn({ style: e.styleDirection });
        break;
      case "design.skills_selected":
        setTurn({ skills: e.contributions });
        break;
      case "design.proposal_created":
        // §14.1 Proposal 产物概要(Turn Card 产物区展示);回放也保留产物摘要
        setTurn({ proposal: e.proposal });
        break;
      case "design.review_completed":
        set({ turns: capTurns({ ...s.turns, [runId]: { ...turn, review: e.report } }, runId) });
        break;
      case "run.streamText": {
        // M7 打字机:高频帧先进缓冲,≤12fps 合并写回(activeRunId 即时标记不受影响)
        if (replay) break;
        streamBuf += e.text;
        set({ activeRunId: runId });
        if (!streamTimer) {
          streamTimer = setTimeout(() => {
            streamTimer = null;
            const add = streamBuf;
            streamBuf = "";
            if (add) useRunStore.setState((s) => ({ streamText: s.streamText + add }));
          }, STREAM_FLUSH_MS);
        }
        break;
      }
      case "design.preview": {
        if (replay) break; // 历史回放:预览帧不落画布(幽灵/draft 只属于实时生成)
        set({ previews: { ...s.previews, [e.surfaceId]: e.message } });
        const msg = e.message as {
          components?: { components?: Record<string, unknown>; page?: { title?: string; device?: string }; root?: string };
          targetPageId?: number;
          delta?: boolean;
          upserts?: Record<string, Record<string, unknown>>;
          meta?: { root?: string; title?: string; device?: string; skeleton?: boolean };
        };
        const prevDoc = s.previewDocs[e.surfaceId] ?? null;
        // 增量帧:与累积文档合并;全量帧(旧协议/尾帧):直接采用
        const doc = msg.delta
          ? mergePreviewDelta(prevDoc, msg.upserts, msg.meta)
          : (msg.components as unknown as import("@contracts/a2ui").SurfaceDoc | undefined);
        if (!doc) break;
        // 骨架幻影帧(meta.skeleton 且尚无组件)标记保留;真实组件帧到达即撤销标记(原位升级为实内容)
        const hasComponents = Object.keys(doc.components ?? {}).length > 0;
        const skeletonIds = { ...s.skeletonIds };
        if (hasComponents) delete skeletonIds[e.surfaceId];
        else if (msg.meta?.skeleton) skeletonIds[e.surfaceId] = true;
        set({ previewDocs: { ...s.previewDocs, [e.surfaceId]: doc }, skeletonIds });
        // edit 模式:就地渐进预览 —— 渐进 surface 写入目标画框的 draft(不污染 page.surface)
        if (typeof msg.targetPageId === "number") {
          useWorkspace.setState({
            draft: { ghosts: [], targetPageId: msg.targetPageId, surface: doc as unknown as PageState["surface"] },
          });
          break;
        }
        // create 模式:同步画布幻影画框(逐页生成:按 previewDocs 派生多页 ghost 并排累积;
        // 同 surfaceId 原位更新,新页追加——此前单 ghost 逐帧替换,多页生成只见一页闪现)
        {
          const docs = { ...s.previewDocs, [e.surfaceId]: doc };
          const entries = Object.entries(docs)
            // 保留有内容的页 + 仅有骨架占位的页(skeletonIds):后者渲染为画布上的 PageSkeleton 幻影画框
            .filter(([sid, d]) => Object.keys(d.components ?? {}).length || skeletonIds[sid])
            .sort(([a], [b]) => Number(a.replace("preview_", "")) - Number(b.replace("preview_", "")));
          if (entries.length) {
            const ws = useWorkspace.getState();
            const maxX = ws.pages.reduce((m, p) => Math.max(m, p.posX + p.width), 0);
            const ghosts: PageState[] = entries.map(([, d], idx) => ({
              id: -1_000_000 - idx,
              projectId: ws.projectId ?? 0,
              title: d.page?.title || "生成中…",
              device: (d.page?.device ?? "desktop") as PageState["device"],
              surface: d as unknown as PageState["surface"],
              posX: maxX + 60 + idx * 1500,
              posY: 0,
              width: 1440,
              height: 900,
            }));
            useWorkspace.setState({ draft: { ghosts, targetPageId: null, surface: null } });
          }
        }
        break;
      }
      case "design.explanation":
        flushStreamText(); // 终态前的生成文本落定,再落结论
        set({ turns: capTurns({ ...s.turns, [runId]: { ...turn, explanation: e.markdown, status: "completed" } }, runId) });
        break;
      case "design.ops_committed":
        flushStreamText();
        set({
          turns: { ...s.turns, [runId]: { ...turn, status: "completed" } },
          lastCommittedRevision: e.revision,
          committedRuns: s.committedRuns.includes(runId) ? s.committedRuns : [...s.committedRuns, runId],
          previews: {},
          previewDocs: {},
          skeletonIds: {},
        });
        if (replay) break; // 历史回放:不碰画布(draft/nodeDiffs/定位闪烁只针对实时提交)
        // M7 逐节点持久 Diff 着色:记录本次提交的增/改/删组件,画框内 outline 标色
        {
          const ws = useWorkspace.getState();
          const nodeDiffs = { ...ws.nodeDiffs };
          for (const c of e.changes) {
            nodeDiffs[c.surfaceId] = { added: c.added, updated: c.updated, removed: c.removed };
          }
          useWorkspace.setState({ draft: null, nodeDiffs });
        }
        // 提交后画布定位/高亮:聚焦首个受影响画框并闪烁其根/首节点
        {
          const firstChange = e.changes[0];
          if (firstChange) {
            const nid = firstChange.added[0] ?? firstChange.updated[0] ?? firstChange.removed[0];
            (window as unknown as { __focusNode?: (sid: string, nid?: string) => void }).__focusNode?.(firstChange.surfaceId, nid);
          }
        }
        break;
      case "clarification.request":
        // 历史回放:澄清早已应答,不重新挂起;断线恢复仍挂起 pending 供应答(恢复的 Run 确实待澄清)
        set({ pendingClarification: replay ? s.pendingClarification : e.request });
        break;
      case "clarification.accepted":
        set({ pendingClarification: null });
        break;
      case "run.approval_required":
        set({ pendingApproval: replay ? s.pendingApproval : e.request });
        break;
      case "run.plan_approval_required":
        // §14.2 计划确认挂起:活跃轮「Plan 与执行」细节块会因 signal 自动展开供确认/编辑
        // (回放不重新挂起;恢复仍挂起 pending,expiresAt 用于重连后精确倒计时)
        set({
          pendingPlanApproval: replay ? s.pendingPlanApproval : { runId, tasks: e.tasks, timeoutSeconds: e.timeoutSeconds, expiresAt: e.expiresAt },
        });
        break;
      case "run.paused":
        // §14.3 暂停/恢复闸门
        setTurn({ paused: e.paused });
        break;
      default:
        break;
    }
  },

  clearClarification: () => set({ pendingClarification: null }),
  clearApproval: () => set({ pendingApproval: null }),
  clearPlanApproval: () => set({ pendingPlanApproval: null }),
  clearActiveRun: () => set({ activeRunId: null }),
  activeTurn: () => {
    const s = get();
    return s.activeRunId ? s.turns[s.activeRunId] ?? null : null;
  },
  removeCommittedRun: (runId) =>
    set((s) => ({ committedRuns: s.committedRuns.filter((r) => r !== runId) })),

  markTaskSkipped: (runId, taskId) =>
    set((s) => {
      const turn = s.turns[runId];
      if (!turn) return {};
      return {
        turns: {
          ...s.turns,
          [runId]: { ...turn, planTasks: turn.planTasks.map((t) => (t.taskId === taskId ? { ...t, status: "skipped" as const } : t)) },
        },
      };
    }),

  seedHistoryRun: (runId, goal, startedAt, events, terminalStatus) => {
    // 先占位建 Turn(带真实 startedAt,供消息流排序与时间戳),已有则不覆盖
    set((s) => ({
      turns: capTurns({ ...s.turns, [runId]: s.turns[runId] ?? emptyTurn(runId, goal, startedAt) }, get().activeRunId),
    }));
    // 逐条回放(replay=true:跳过画布侧效应/挂起态/activeRunId 抢占)
    for (const e of events) get().applyEvent(e, true);
    // 兜底:事件流里没有终态事件(服务中断未落库)但 DB 已终态 → 强制收敛,
    // 消除历史卡的"进行中"僵尸样式(spinner/进度/耗时无限增长)
    if (terminalStatus) {
      const t = get().turns[runId];
      const isTerminal = t?.status === "completed" || t?.status === "cancelled" || t?.status === "failed";
      if (t && !isTerminal) {
        set((s) => ({ turns: { ...s.turns, [runId]: { ...t, status: terminalStatus } } }));
      }
    }
  },
}));
