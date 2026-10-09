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

export type AgentPanelTab = "chat" | "plan" | "timeline" | "review" | "diff";

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
  /** §14.3 执行暂停闸门(状态机状态不变,Plan Tab 展示与恢复) */
  paused?: boolean;
  startedAt: number;
}

interface RunState {
  turns: Record<string, Turn>;
  /** 当前活跃 run(顶部栏状态灯/Tab 联动) */
  activeRunId: string | null;
  /** 待应答的澄清(HITL) */
  pendingClarification: (ClarificationRequest & { runId: string }) | null;
  /** 待审批(HITL) */
  pendingApproval: (ApprovalRequest & { diffSummary: ApprovalRequest["diffSummary"] }) | null;
  /** §14.2 待确认的执行计划(HITL;确认时可携带编辑后的任务清单) */
  pendingPlanApproval: { runId: string; tasks: PlanTask[]; timeoutSeconds: number; expiresAt?: string } | null;
  /** 当前 Tab;事件到达时自动切换(评审→review,Diff→diff) */
  tab: AgentPanelTab;
  /** 生成中的渐进预览:surfaceId → 部分文档 JSON */
  previews: Record<string, unknown>;
  /** M7 增量预览的累积文档:surfaceId → mergePreviewDelta 还原的完整 SurfaceDoc */
  previewDocs: Record<string, import("@contracts/a2ui").SurfaceDoc>;
  /** M7 打字机:当前 run 生成原始输出(累积;不落库) */
  streamText: string;
  /** 已提交结果(触发画布刷新) */
  lastCommittedRevision: number | null;
  committedRuns: string[];

  startTurn: (runId: string, goal: string) => void;
  applyEvent: (e: AgentEvent) => void;
  clearClarification: () => void;
  clearApproval: () => void;
  clearPlanApproval: () => void;
  /** 当前 run 连接失效(服务重启/记录不存在)时清空活跃标记 */
  clearActiveRun: () => void;
  setTab: (t: AgentPanelTab) => void;
  activeTurn: () => Turn | null;
  /** Run 级撤销成功后从已提交清单移除(§16.5) */
  removeCommittedRun: (runId: string) => void;
  /** §14.3 执行中跳过任务的乐观更新(权威状态以 run.plan 事件为准) */
  markTaskSkipped: (runId: string, taskId: string) => void;
}

function emptyTurn(runId: string, goal: string): Turn {
  return {
    runId,
    status: "queued",
    label: "排队中",
    progress: 0,
    goal,
    planTasks: [],
    toolCards: [],
    startedAt: Date.now(),
  };
}

export const useRunStore = create<RunState>((set, get) => ({
  turns: {},
  activeRunId: null,
  pendingClarification: null,
  pendingApproval: null,
  pendingPlanApproval: null,
  tab: "chat",
  previews: {},
  previewDocs: {},
  streamText: "",
  lastCommittedRevision: null,
  committedRuns: [],

  startTurn: (runId, goal) =>
    set((s) => ({
      turns: { ...s.turns, [runId]: s.turns[runId] ?? emptyTurn(runId, goal) },
      activeRunId: runId,
      tab: "chat",
    })),

  applyEvent: (e) => {
    const s = get();
    const runId = e.runId;
    const existing = s.turns[runId];
    const turn: Turn = existing ?? emptyTurn(runId, "");
    switch (e.type) {
      case "run.state":
        set({
          turns: { ...s.turns, [runId]: { ...turn, status: e.status, label: e.label, progress: e.progress ?? turn.progress } },
          activeRunId: runId,
          // M7 打字机:新一轮生成开始时清空原始输出
          ...(e.status === "generating" ? { streamText: "" } : {}),
        });
        break;
      case "run.plan":
        set({ turns: { ...s.turns, [runId]: { ...turn, planTasks: e.tasks } }, tab: s.tab === "chat" ? "plan" : s.tab });
        break;
      case "run.step": {
        const cards = [...turn.toolCards];
        const idx = cards.findIndex((c) => c.cardId === e.card.cardId);
        if (idx >= 0) cards[idx] = e.card;
        else cards.push(e.card);
        set({ turns: { ...s.turns, [runId]: { ...turn, toolCards: cards } } });
        break;
      }
      case "run.failed":
        set({ turns: { ...s.turns, [runId]: { ...turn, status: "failed", error: e.message } } });
        useWorkspace.setState({ draft: null });
        break;
      case "run.cancelled":
        set({ turns: { ...s.turns, [runId]: { ...turn, status: "cancelled" } } });
        useWorkspace.setState({ draft: null });
        break;
      case "design.brief_created":
        set({ turns: { ...s.turns, [runId]: { ...turn, brief: e.brief } } });
        break;
      case "design.plan_created":
        set({ turns: { ...s.turns, [runId]: { ...turn, plan: e.plan } } });
        break;
      case "design.style_resolved":
        set({ turns: { ...s.turns, [runId]: { ...turn, style: e.styleDirection } } });
        break;
      case "design.skills_selected":
        set({ turns: { ...s.turns, [runId]: { ...turn, skills: e.contributions } } });
        break;
      case "run.streamText":
        // M7 打字机:累积原始输出增量(不落库)
        set({ streamText: (s.streamText ?? "") + e.text, activeRunId: runId });
        break;
      case "design.preview": {
        set({ previews: { ...s.previews, [e.surfaceId]: e.message } });
        const msg = e.message as {
          components?: { components?: Record<string, unknown>; page?: { title?: string; device?: string }; root?: string };
          targetPageId?: number;
          delta?: boolean;
          upserts?: Record<string, Record<string, unknown>>;
          meta?: { root?: string; title?: string; device?: string };
        };
        const prevDoc = s.previewDocs[e.surfaceId] ?? null;
        // 增量帧:与累积文档合并;全量帧(旧协议/尾帧):直接采用
        const doc = msg.delta
          ? mergePreviewDelta(prevDoc, msg.upserts, msg.meta)
          : (msg.components as unknown as import("@contracts/a2ui").SurfaceDoc | undefined);
        if (!doc) break;
        set({ previewDocs: { ...s.previewDocs, [e.surfaceId]: doc } });
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
            .filter(([, d]) => Object.keys(d.components ?? {}).length)
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
      case "design.review_completed":
        set({ turns: { ...s.turns, [runId]: { ...turn, review: e.report } }, tab: "review" });
        break;
      case "design.proposal_created":
        // §14.1 Proposal 产物概要(Turn Card 产物区展示)
        set({ turns: { ...s.turns, [runId]: { ...turn, proposal: e.proposal } } });
        break;
      case "design.explanation":
        set({ turns: { ...s.turns, [runId]: { ...turn, explanation: e.markdown, status: "completed" } }, tab: "chat" });
        break;
      case "design.ops_committed":
        set({
          turns: { ...s.turns, [runId]: { ...turn, status: "completed" } },
          lastCommittedRevision: e.revision,
          committedRuns: [...s.committedRuns, runId],
          previews: {},
          previewDocs: {},
        });
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
        set({ pendingClarification: e.request, tab: "chat" });
        break;
      case "clarification.accepted":
        set({ pendingClarification: null });
        break;
      case "run.approval_required":
        set({ pendingApproval: e.request });
        break;
      case "run.plan_approval_required":
        // §14.2 计划确认挂起:切到 Plan Tab 供确认/编辑(expiresAt 用于重连后精确倒计时)
        set({ pendingPlanApproval: { runId, tasks: e.tasks, timeoutSeconds: e.timeoutSeconds, expiresAt: e.expiresAt }, tab: "plan" });
        break;
      case "run.paused":
        // §14.3 暂停/恢复闸门
        set({ turns: { ...s.turns, [runId]: { ...turn, paused: e.paused } } });
        break;
      default:
        break;
    }
  },

  clearClarification: () => set({ pendingClarification: null }),
  clearApproval: () => set({ pendingApproval: null }),
  clearPlanApproval: () => set({ pendingPlanApproval: null }),
  clearActiveRun: () => set({ activeRunId: null }),
  setTab: (tab) => set({ tab }),
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
}));
