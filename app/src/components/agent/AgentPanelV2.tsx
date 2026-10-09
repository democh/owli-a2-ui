/**
 * Agent 工作区 v2(文档 §8/§14)
 * - Tabs:[对话][Plan][过程][评审][Diff]
 * - Turn Card:状态机徽标 / 目标 / Brief 摘要 / Plan / 工具卡 / 产物 / 操作
 * - 结构化澄清卡片(单选/多选/自定义/滑杆)+ 审批卡(接受/拒绝)
 * - 输入区:模式选择(Ask/Plan/Design/Review/Repair/Auto)+ @页面/元素引用 chips + 发送/停止
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell, Bot, ChevronDown, ChevronRight, CircleDot, Clock, FileDiff, GitBranch, ListChecks, Send, Settings2,
  Square, Timer, Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/stores/workspaceStore";
import { trpc } from "@/providers/trpc";
import { useRunStore, type AgentPanelTab, type Turn } from "@/stores/runStore";
import { openRunStream } from "@/lib/runStream";
import { STATUS_LABELS } from "@/lib/statusLabels";
import type { AgentRunMode, AutonomyLevel, PlanTask, ToolCard, UXReviewIssue } from "@contracts/agent";
import { BUILTIN_SKILLS } from "@contracts/skill";
import { MarkdownLite } from "./MarkdownLite";
import { ClarificationCard } from "./ClarificationCard";
import { InspectorPanel } from "@/components/panels/InspectorPanel";

/** §8.3 / 命令:快速切换模式并预填模板文案 */
const COMMANDS: { id: string; label: string; mode: AgentRunMode; template: string }[] = [
  { id: "review", label: "/评审 · 对当前范围运行 UX 评审", mode: "review_only", template: "请对当前选中范围运行完整 UX 评审:信息架构、视觉层级、交互完整性、可访问性,输出问题清单与修复建议。" },
  { id: "repair", label: "/修复 · 按评审问题生成修复 Proposal", mode: "repair_design", template: "请针对最近的评审问题生成最小修复 Proposal,不改变整体设计方向。" },
  { id: "redesign", label: "/重设计 · 重新设计当前页面", mode: "redesign_frame", template: "请重新设计当前选中页面,保持核心任务与信息架构,提升视觉层级与一致性。" },
  { id: "mobile", label: "/移动端 · 生成移动端版本", mode: "create_frame", template: "为当前选中页面生成移动端版本:保持信息架构与核心内容一致,按移动端优先重排布局(单列结构、底部主操作、大触控目标)。" },
  { id: "tablet", label: "/平板 · 生成平板版本", mode: "create_frame", template: "为当前选中页面生成平板版本:保持信息架构一致,适配中等屏幕宽度的两栏/网格布局。" },
];

/** M7 打字机:生成中的原始输出增量(等宽字体 + 光标闪烁 + 自动滚底;流结束后保留) */
function StreamTypewriter({ text, active }: { text: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // §14.7:默认跟随滚底;用户手动上滚后停止拉回,显示「有新进展」按钮
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el && active && follow) el.scrollTop = el.scrollHeight;
  }, [text, active, follow]);
  // 流结束复位跟随(渲染期调整状态,避免 effect 内 setState)
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) setFollow(true);
  }
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 24);
  };
  if (!text) return null;
  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={onScroll}
        className="a2-agent-scroll max-h-44 overflow-y-auto rounded-md border border-indigo-100 bg-indigo-50/40 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-neutral-600"
        data-testid="stream-typewriter"
      >
        {text}
        {active && <span className="animate-pulse text-indigo-500">▌</span>}
      </div>
      {active && !follow && (
        <button
          onClick={() => {
            setFollow(true);
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[10px] font-medium text-primary-foreground shadow-lg"
        >
          有新进展 ↓
        </button>
      )}
    </div>
  );
}

const MODES: { id: AgentRunMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "plan_only", label: "Plan" },
  { id: "create_page", label: "Design" },
  { id: "refine_selection", label: "Refine" },
  { id: "redesign_frame", label: "Redesign" },
  { id: "review_only", label: "Review" },
  { id: "repair_design", label: "Repair" },
];

const AUTONOMY: { id: AutonomyLevel; label: string }[] = [
  { id: "suggest", label: "仅建议" },
  { id: "review", label: "逐次确认" },
  { id: "guarded", label: "需审批" },
  { id: "autopilot", label: "自动" },
];

const TABS: { id: AgentPanelTab; label: string; icon: typeof Bot }[] = [
  { id: "chat", label: "对话", icon: Bot },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "timeline", label: "过程", icon: Waypoints },
  { id: "review", label: "评审", icon: GitBranch },
  { id: "diff", label: "Diff", icon: FileDiff },
];

const STATUS_COLOR: Record<string, string> = {
  idle: "bg-slate-400",
  running: "bg-blue-500",
  waiting_user: "bg-amber-500",
  success: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-slate-400",
};

/** §15.3 HITL 超时可见倒计时:优先用服务端 expiresAt(断线重连不重置);归零提示按默认策略处理 */
function Countdown({ seconds, expiresAt }: { seconds?: number; expiresAt?: string }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = expiresAt
    ? Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000))
    : Math.max(0, Math.round((seconds ?? 0) - (now - startedAt) / 1000));
  if (remaining <= 0) {
    return <span className="inline-flex items-center gap-1 text-red-500"><Timer className="size-3" />已超时,将按默认策略处理</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
      <Timer className="size-3" />
      {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
    </span>
  );
}

export function AgentPanelV2({
  projectId,
  conversationId,
  selectedChips,
  onOpenSettings,
  onCommitted,
}: {
  projectId: number;
  conversationId: number | null;
  selectedChips: { kind: "page" | "element"; pageId: string; surfaceId?: string; title?: string; aid?: string; label?: string }[];
  onOpenSettings: () => void;
  onCommitted: () => void;
}) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AgentRunMode>("create_page");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("guarded");
  // §12.1 原型探索模式:门禁放宽至 70(仍阻断 P0/P1),结果不建议直接生产导出
  const [prototypeMode, setPrototypeMode] = useState(false);
  // §8.3 输入区能力:@ 引用页面/组件 · # 手动指定 Skill(覆盖自动路由) · / 快捷命令
  const [skillPick, setSkillPick] = useState<string[]>([]);
  const [trigger, setTrigger] = useState<null | "#" | "/" | "@">(null);
  /** @ 引用追加的上下文 chips(与画布选中合并;发送后清空) */
  const [refChips, setRefChips] = useState<{ kind: "page" | "element"; pageId: string; surfaceId?: string; title?: string; aid?: string; label?: string }[]>([]);
  const runStreamRef = useRef<{ close: () => void } | null>(null);
  /** Inspector 与 Agent 共存(文档 §9):选中元素时下半区显示,可收起 */
  const hasSelection = useWorkspace((w) => w.selectedElements.length > 0);
  // §8.3 @ 引用选择器的数据源:页面与当前选中页组件
  const wsPages = useWorkspace((w) => w.pages);
  const wsSelectedPageIds = useWorkspace((w) => w.selectedPageIds);
  const [dockOpen, setDockOpen] = useState(true);

  // §8.2 面板宽度:默认 400px,左缘拖拽 320-520,持久化
  const [panelW, setPanelW] = useState<number>(() => {
    const v = Number(typeof localStorage !== "undefined" ? localStorage.getItem("a2.agentW") : "");
    return v >= 320 && v <= 520 ? v : 400;
  });
  const panelWRef = useRef(panelW);
  const startPanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWRef.current;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(520, Math.max(320, Math.round(startW + (startX - ev.clientX))));
      panelWRef.current = w;
      setPanelW(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try { localStorage.setItem("a2.agentW", String(panelWRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);
  
    // M7 InspectorDock 分割线拖拽(零依赖手写):高度百分比持久化到 localStorage
    const [dockHeight, setDockHeight] = useState<number>(() => {
      const v = Number(typeof localStorage !== "undefined" ? localStorage.getItem("a2.dockH") : "");
      return v >= 12 && v <= 75 ? v : 38;
    });
    const panelBodyRef = useRef<HTMLDivElement>(null);
    const dockHeightRef = useRef(dockHeight);
    const startDockResize = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      const rootEl = panelBodyRef.current?.parentElement;
      if (!rootEl) return;
      const startY = e.clientY;
      const startH = dockHeightRef.current;
      const total = rootEl.clientHeight;
      if (total <= 0) return;
      const onMove = (ev: MouseEvent) => {
        const h = Math.min(75, Math.max(12, Math.round(startH + ((startY - ev.clientY) / total) * 100)));
        dockHeightRef.current = h;
        setDockHeight(h);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try { localStorage.setItem("a2.dockH", String(dockHeightRef.current)); } catch { /* ignore */ }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }, []);

  const run = useRunStore();
  const turn = run.activeTurn();
  const workspaceQ = trpc.workspace.get.useQuery({ projectId });
  const createRun = trpc.runs.create.useMutation();
  const createConversation = trpc.chat.createConversation.useMutation();
  const clarifyMut = trpc.runs.clarify.useMutation();
  const approveMut = trpc.runs.approve.useMutation();
  const cancelRun = trpc.runs.cancel.useMutation();
  // M-§16.5 Run 级撤销:回滚本次 Run 全部修改(后端 rollbackRun 原子执行)
  const rollbackMut = trpc.runs.rollback.useMutation({
    onSuccess: (_r, vars) => {
      toast.success("已撤销本次生成的全部修改");
      run.removeCommittedRun(vars.runId);
      onCommitted();
    },
    onError: (e) => toast.error(`撤销失败:${e.message.slice(0, 120)}`),
  });
  // §14.2/§14.3 Plan 确认:可携带编辑/跳过后的任务清单
  const planApproveMut = trpc.runs.planApprove.useMutation({
    onError: (e) => toast.error(`计划确认失败:${e.message.slice(0, 120)}`),
  });
  // §14.3 执行控制:暂停/恢复/跳过任务
  const pauseMut = trpc.runs.pause.useMutation({
    onError: (e) => toast.error(`暂停失败:${e.message.slice(0, 120)}`),
  });
  const resumeMut = trpc.runs.resume.useMutation({
    onError: (e) => toast.error(`恢复失败:${e.message.slice(0, 120)}`),
  });
  const skipTaskMut = trpc.runs.skipTask.useMutation({
    onError: (e) => toast.error(`跳过失败:${e.message.slice(0, 120)}`),
  });
  // §8.5 断线恢复:页面(重)加载时查询项目最近 Run,用于恢复进行中 Run 的订阅与 Turn 状态
  const recentRunsQ = trpc.runs.list.useQuery({ projectId, limit: 5 });

  const baseRevision = workspaceQ.data?.revision ?? 0;

  /** 核心 doSend:支持模式/上下文覆盖(页面菜单、/命令、外部桥触发复用) */
  const doSend = useCallback(
    async (
      text: string,
      modeOverride?: AgentRunMode,
      chipsOverride?: typeof selectedChips,
    ) => {
      const useMode = modeOverride ?? mode;
      const srcChips = [...(chipsOverride ?? selectedChips), ...refChips];
      // 画布选中态 → scope(此前选中信息只来自 @引用 chips,画布点选完全不传入,
      // refine 类模式拿不到 targetSurfaceId 只能退化为整页重生成);
      // frameId 语义=surfaceId 字符串(DesignScope 契约与 ContextBuilder 比对一致)
      const wsState = useWorkspace.getState();
      const selEls = wsState.selectedElements;
      const selPages = wsState.selectedPageIds;
      const surfaceIdOf = (pid: number) => wsState.pages.find((p) => p.id === pid)?.surfaceId ?? "";
      const canvasScope = selEls.length
        ? { frameId: surfaceIdOf(selEls[0].pageId), nodeIds: selEls.map((e) => e.aid) }
        : selPages.length
          ? { frameId: surfaceIdOf(selPages[0]), nodeIds: [] as string[] }
          : null;
      // 会话未初始化时自动创建(消除"对话尚未初始化"死路)
      let convId = conversationId;
      if (!convId) {
        try {
          const created = await createConversation.mutateAsync({ projectId, title: text.slice(0, 30) || "新对话" });
          convId = created.id;
          useWorkspace.getState().setConversationId(created.id);
        } catch (err) {
          toast.error((err as Error).message.slice(0, 120));
          return;
        }
      }
      const chips = srcChips.map((c) =>
        c.kind === "page"
          ? { kind: "page" as const, pageId: c.pageId, title: c.title ?? "" }
          : { kind: "element" as const, pageId: c.pageId, surfaceId: c.pageId, aid: c.aid ?? "", label: c.label ?? "" },
      );
      try {
        const { runId } = await createRun.mutateAsync({
          projectId,
          conversationId: convId,
          mode: useMode,
          userMessage: text,
          // frameId 语义=surfaceId(DesignScope 契约):优先 chip 携带的 surfaceId,
          // 兜底用 pageId(String(page.id))在 pages 里反查;后端 ContextBuilder 以它匹配 IR surfaces
          scope: (srcChips.length
            ? {
                frameId:
                  srcChips[0].surfaceId ??
                  wsState.pages.find((p) => String(p.id) === srcChips[0].pageId || p.surfaceId === srcChips[0].pageId)?.surfaceId ??
                  srcChips[0].pageId,
                nodeIds: srcChips.filter((c) => c.kind === "element").map((c) => c.aid ?? ""),
              }
            : (canvasScope ?? {})),
          baseRevision,
          idempotencyKey: `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          autonomyLevel: autonomy,
          constraints: { prototypeMode },
          chips,
          // #skill 手动指定:覆盖自动路由(§8.3 / §24.5)
          skillSelection: skillPick.length ? { mode: "manual" as const, skillIds: [...skillPick] } : undefined,
        });
        run.startTurn(runId, text);
        setSkillPick([]); // 已随 Run 提交,清空手动选择
        setRefChips([]); // 引用 chips 已随 Run 提交
        runStreamRef.current?.close();
        runStreamRef.current = openRunStream(
          runId,
          (e) => {
            run.applyEvent(e);
            if (e.type === "design.ops_committed") onCommitted();
          },
          () => onCommitted(),
          () => {
            // run 不可达(服务重启内存态丢失 / 记录不存在):停止连接并复位活跃标记
            runStreamRef.current = null;
            run.clearActiveRun();
            toast.error("运行连接已失效(服务可能已重启),请重新发起请求");
          },
        );
      } catch (err) {
        toast.error((err as Error).message.slice(0, 120));
      }
    },
    [conversationId, selectedChips, refChips, mode, autonomy, prototypeMode, baseRevision, projectId, skillPick, createConversation, createRun, onCommitted, run],
  );

  // §8.5 断线恢复:页面(重)加载时若有进行中的 Run,重建 Turn 并重连 SSE。
  // 服务端流"先订阅后重放 + seq 去重",UI 状态(状态机/工具卡/评审/审批挂起/画布 ghost)
  // 全部由重放事件重建;此后 ops_committed → onCommitted → 画布 refetch 也随之恢复。
  // (此前刷新页面会"丢失"生成中的 Run:activeRunId 是内存态,画布停在旧 IR,Rev 不再前进)
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (recoveredRef.current || !recentRunsQ.data?.length) return;
    const active = recentRunsQ.data.find(
      (r) => r.status !== "completed" && r.status !== "cancelled" && r.status !== "failed",
    );
    if (!active) return;
    recoveredRef.current = true;
    run.startTurn(active.runId, active.userMessage ?? "");
    if (active.conversationId) useWorkspace.getState().setConversationId(active.conversationId);
    runStreamRef.current?.close();
    runStreamRef.current = openRunStream(
      active.runId,
      (e) => {
        run.applyEvent(e);
        if (e.type === "design.ops_committed") onCommitted();
      },
      () => onCommitted(),
      () => {
        // 恢复时 run 已不可达(服务重启 / 记录不存在):静默复位,不误导用户
        runStreamRef.current = null;
        run.clearActiveRun();
      },
    );
  }, [recentRunsQ.data, run, onCommitted]);

  // 外部触发桥(§6.3 页面菜单 / §14.6.6 代码块应用):__sendPrompt(prompt, opts)
  const doSendRef = useRef(doSend);
  useEffect(() => {
    doSendRef.current = doSend;
  }, [doSend]);
  // §14.6.1 引用 Chip 定位桥:@page/@frame/@node → 画布定位;@proposal → Diff Tab;
  // @revision → 版本提示;#skill → 加入手选(下次请求生效)
  useEffect(() => {
    const w = window as unknown as {
      __locateRef?: (kind: string, id: string) => void;
      __focusNode?: (sid: string, nid?: string) => void;
    };
    w.__locateRef = (kind, id) => {
      if (kind === "page" || kind === "frame") {
        const ws = useWorkspace.getState();
        const page = ws.pages.find((p) => p.surfaceId === id || String(p.id) === id);
        if (!page) { toast.error(`未找到${kind === "page" ? "页面" : "画框"} ${id}`); return; }
        w.__focusNode?.(page.surfaceId ?? String(page.id));
        toast.info(`已定位到${kind === "page" ? "页面" : "画框"}:${page.title}`);
      } else if (kind === "node") {
        const ws = useWorkspace.getState();
        const host = ws.pages.find((p) => p.surface && (p.surface as { components?: Record<string, unknown> }).components && id in (p.surface as { components: Record<string, unknown> }).components);
        if (!host) { toast.error(`未找到组件 ${id}`); return; }
        w.__focusNode?.(host.surfaceId ?? String(host.id), id);
      } else if (kind === "proposal") {
        useRunStore.getState().setTab("diff");
        toast.info("已打开 Diff 视图");
      } else if (kind === "revision") {
        toast.info(`版本 ${id}:可在顶栏「版本」菜单中查看与恢复`);
      } else if (kind === "skill") {
        setSkillPick((cur) => (cur.includes(id) ? cur : [...cur, id]));
        toast.info(`已添加 Skill #${id}(随下一次请求生效)`);
      } else {
        toast.info(`${kind}:${id}`);
      }
    };
    return () => {
      delete w.__locateRef;
    };
  }, []);
  useEffect(() => {
    const w = window as unknown as {
      __sendPrompt?: (prompt: string, opts?: { mode?: AgentRunMode; autoSend?: boolean; pageId?: string; pageTitle?: string }) => void;
    };
    w.__sendPrompt = (prompt, opts) => {
      if (opts?.mode) setMode(opts.mode);
      const chips = opts?.pageId
        ? [{ kind: "page" as const, pageId: opts.pageId, title: opts.pageTitle ?? "" }]
        : undefined;
      if (opts?.autoSend) void doSendRef.current(prompt, opts.mode, chips);
      else setInput(prompt);
    };
    return () => {
      delete w.__sendPrompt;
    };
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void doSend(text);
  }, [input, doSend]);

  const stop = () => {
    if (run.activeRunId) cancelRun.mutate({ runId: run.activeRunId });
  };

  const agentStatusGroup = useMemo(() => {
    if (!turn) return "idle";
    if (turn.status === "completed") return "success";
    if (turn.status === "failed") return "failed";
    if (turn.status === "cancelled" || turn.status === "cancelling") return "cancelled";
    if (turn.status === "awaiting_clarification" || turn.status === "awaiting_approval") return "waiting_user";
    return "running";
  }, [turn]);

  // M6 站内告警:铃铛未读数 + 下拉列表(§17 规则评估点落在后端)
  const tutils = trpc.useUtils();
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alertsQ = trpc.alerts.unreadCount.useQuery();
  const alertsListQ = trpc.alerts.list.useQuery({}, { enabled: alertsOpen });
  const alertsAckAllMut = trpc.alerts.ackAll.useMutation({
    onSuccess: () => {
      void tutils.alerts.unreadCount.invalidate();
      void tutils.alerts.list.invalidate({});
    },
  });
  const alertsAckMut = trpc.alerts.ack.useMutation({
    onSuccess: () => {
      void tutils.alerts.unreadCount.invalidate();
      void tutils.alerts.list.invalidate({});
    },
  });

  return (
    <div className="a2-panel relative flex h-full shrink-0 flex-col bg-background" style={{ width: panelW }}>
      {/* §8.2 左缘拖拽手柄:320-520px,持久化 */}
      <div
        onMouseDown={startPanelResize}
        className="absolute left-0 top-0 z-40 h-full w-1 cursor-col-resize transition-colors hover:bg-indigo-300/60"
        title="拖拽调整面板宽度(320-520px)"
      />
      {/* 头部:标题 + 状态灯 + 设置 */}
      <div className="flex h-[44px] shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bot className="size-4" /> Agent
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <CircleDot className={`size-3 ${STATUS_COLOR[agentStatusGroup]}`} />
            {turn ? STATUS_LABELS[turn.status] ?? turn.label : "空闲"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* M6 站内告警铃铛 */}
          <div className="relative">
            <button
              className="relative rounded p-1 hover:bg-muted"
              onClick={() => setAlertsOpen((v) => !v)}
              aria-label="告警"
            >
              <Bell className="size-4" />
              {(alertsQ.data?.n ?? 0) > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-medium text-white">
                  {alertsQ.data?.n}
                </span>
              )}
            </button>
            {alertsOpen && (
              <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border bg-background p-1 shadow-xl">
                <div className="flex items-center justify-between px-2 py-1 text-[10px] text-muted-foreground">
                  <span>最近告警</span>
                  {(alertsQ.data?.n ?? 0) > 0 && (
                    <button className="underline hover:text-foreground" onClick={() => alertsAckAllMut.mutate()}>
                      全部已读
                    </button>
                  )}
                </div>
                <div className="a2-agent-scroll max-h-64 overflow-y-auto">
                  {(alertsListQ.data ?? []).map((a) => (
                    <button
                      key={a.id}
                      onClick={() => alertsAckMut.mutate({ id: a.id })}
                      title="点击标记已读"
                      className={`block w-full rounded px-2 py-1.5 text-left text-[11px] transition hover:bg-muted ${a.readAt ? "opacity-50" : ""}`}
                    >
                      <span className="flex items-start gap-1.5">
                        <span className={`mt-1 size-1.5 shrink-0 rounded-full ${a.level === "error" ? "bg-red-500" : a.level === "warning" ? "bg-amber-500" : "bg-sky-500"}`} />
                        {/* 完整展示告警消息(后端已限 400 字符):不 truncate,换行 + 长词断行 */}
                        <span className="min-w-0 flex-1 whitespace-normal break-words">{a.message}</span>
                      </span>
                      <span className="mt-0.5 block text-[9px] text-muted-foreground">
                        {a.rule} · {new Date(a.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </button>
                  ))}
                  {(alertsListQ.data ?? []).length === 0 && (
                    <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">暂无告警</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <button className="rounded p-1 hover:bg-muted" onClick={onOpenSettings} aria-label="设置">
            <Settings2 className="size-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => run.setTab(t.id)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
              run.tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <t.icon className="size-3.5" />
            {t.label}
            {t.id === "review" && turn?.review?.issues.filter((i) => i.blocking).length ? (
              <span className="ml-0.5 rounded-full bg-red-500 px-1 text-[10px] text-white">
                {turn.review.issues.filter((i) => i.blocking).length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* 内容区(与 Inspector 共存区之间为手写可拖拽分割线,零依赖) */}
      <div ref={panelBodyRef} className="a2-agent-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {run.tab === "chat" && (
          <div className="space-y-3">
            {run.pendingClarification && (
              <ClarificationCard
                request={run.pendingClarification}
                onSubmit={async (answers) => {
                  await clarifyMut.mutateAsync({
                    requestId: run.pendingClarification!.requestId,
                    runId: run.pendingClarification!.runId,
                    answers,
                    submittedAt: new Date().toISOString(),
                  });
                  run.clearClarification();
                }}
              />
            )}
            {run.pendingApproval && (
              <ApprovalCard
                title={run.pendingApproval.title}
                reason={run.pendingApproval.reason}
                summary={run.pendingApproval.diffSummary}
                timeoutSeconds={run.pendingApproval.timeoutSeconds}
                expiresAt={run.pendingApproval.expiresAt}
                onDecide={async (approved, accept) => {
                  await approveMut.mutateAsync({ runId: run.pendingApproval!.runId, approved, accept });
                  run.clearApproval();
                  if (approved) onCommitted();
                }}
              />
            )}
            {turn ? <TurnCard turn={turn} /> : <EmptyHint />}
            {/* M-§16.5 已提交 Run 的撤销入口(回滚前由后端自动快照) */}
            {turn && run.committedRuns.includes(turn.runId) && (
              <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-xs dark:border-emerald-800 dark:bg-emerald-950/20">
                <span className="text-emerald-700 dark:text-emerald-300">本次生成已提交,可整体撤销(自动先存快照)。</span>
                <button
                  disabled={rollbackMut.isPending}
                  onClick={() => {
                    if (confirm("撤销本次生成的全部修改?将恢复到提交前状态(先自动创建快照)。")) {
                      rollbackMut.mutate({ projectId, runId: turn.runId });
                    }
                  }}
                  className="rounded-md border border-emerald-300 px-3 py-1 font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
                >
                  {rollbackMut.isPending ? "撤销中…" : "撤销本次生成"}
                </button>
              </div>
            )}
            {/* §14.2 失败 Turn 的重试入口:以原目标重新发起(§14.3 从失败重试) */}
            {turn?.status === "failed" && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50/50 px-3 py-2 text-xs dark:border-red-900 dark:bg-red-950/20">
                <span className="min-w-0 flex-1 truncate text-red-600 dark:text-red-300">{turn.error ?? "执行失败"}</span>
                <button
                  onClick={() => {
                    const w = window as unknown as { __sendPrompt?: (p: string, o?: { autoSend?: boolean }) => void };
                    w.__sendPrompt?.(turn.goal, { autoSend: true });
                  }}
                  className="shrink-0 rounded-md border border-red-300 px-3 py-1 font-medium text-red-700 transition hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40"
                >
                  重新运行
                </button>
              </div>
            )}
            {/* M7 打字机:生成中的原始输出(LLM 逐 token 增量,自动滚底) */}
            <StreamTypewriter text={run.streamText} active={turn?.status === "generating" || turn?.status === "parsing"} />
          </div>
        )}
        {run.tab === "plan" && (
          <PlanTab
            tasks={turn?.planTasks ?? []}
            plan={turn?.plan}
            approval={run.pendingPlanApproval && run.pendingPlanApproval.runId === turn?.runId ? run.pendingPlanApproval : null}
            busy={planApproveMut.isPending}
            paused={!!turn?.paused}
            active={!!turn && turn.status !== "completed" && turn.status !== "failed" && turn.status !== "cancelled"}
            onPauseToggle={() => {
              if (!turn) return;
              if (turn.paused) resumeMut.mutate({ runId: turn.runId });
              else pauseMut.mutate({ runId: turn.runId });
            }}
            onSkipTask={(taskId) => {
              if (!turn) return;
              skipTaskMut.mutate(
                { runId: turn.runId, taskId },
                { onSuccess: () => run.markTaskSkipped(turn.runId, taskId) },
              );
            }}
            onApprove={async (approved, editedTasks) => {
              if (!run.pendingPlanApproval) return;
              try {
                await planApproveMut.mutateAsync({
                  runId: run.pendingPlanApproval.runId,
                  approved,
                  tasks: editedTasks?.map((t) => ({ taskId: t.taskId, title: t.title, description: t.description, status: t.status })),
                });
                run.clearPlanApproval();
                if (approved) toast.success("计划已确认,继续生成");
              } catch { /* 错误已在 mutation onError 提示 */ }
            }}
          />
        )}
        {run.tab === "timeline" && <TimelineTab cards={turn?.toolCards ?? []} status={turn?.status} />}
        {run.tab === "review" && (
          <ReviewTab
            report={turn?.review}
            onLocate={(sid, nid) => (window as unknown as { __focusNode?: (s: string, n: string) => void }).__focusNode?.(sid, nid)}
            hasPendingApproval={!!run.pendingApproval}
            onAutoRepair={() => {
              if (!turn?.review) return;
              const issues = turn.review.issues.filter((i) => i.blocking || i.severity === "P0" || i.severity === "P1").slice(0, 5);
              const summary = issues.length
                ? issues.map((i) => `[${i.severity}] ${i.message}(建议:${i.recommendation ?? "无"})`).join("; ")
                : turn.review.recommendations.slice(0, 3).join("; ");
              void doSend(`请针对最近一次评审的以下问题做最小修复(不改变整体设计方向),重新走校验与评审:${summary}`, "repair_design");
            }}
            onCommitAnyway={() => {
              if (run.pendingApproval) {
                const rid = run.pendingApproval.runId;
                void approveMut.mutateAsync({ runId: rid, approved: true }).then(() => {
                  run.clearApproval();
                  onCommitted();
                });
              } else {
                toast.info("当前没有待审批的 Proposal;未通过门禁的方案请使用「自动修复」重新生成");
              }
            }}
            onDiscard={() => {
              if (run.pendingApproval) {
                const rid = run.pendingApproval.runId;
                void approveMut.mutateAsync({ runId: rid, approved: false }).then(() => run.clearApproval());
              } else {
                toast.info("已忽略本次评审结果");
              }
            }}
          />
        )}
        {run.tab === "diff" && <DiffTab summary={turn?.review} committed={run.committedRuns.includes(run.activeRunId ?? "")} />}
      </div>

      {/* Inspector 共存区(文档 §9):拖拽手柄调整高度(M7 取舍项:零依赖手写分割,高度持久化) */}
      {hasSelection && dockOpen && (
        <>
          <div
            onMouseDown={startDockResize}
            className="group relative h-1.5 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-indigo-200"
          >
            <div className="mx-auto my-0.5 h-0.5 w-10 rounded-full bg-neutral-300 group-hover:bg-indigo-400" />
          </div>
          <div className="flex shrink-0 flex-col border-t bg-background" style={{ height: `${dockHeight}%` }}>
            <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted-foreground">
              <span>Inspector · 选中元素属性</span>
              <button className="rounded px-1.5 hover:bg-muted" onClick={() => setDockOpen((v) => !v)}>收起</button>
            </div>
            <div className="a2-agent-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              <InspectorPanel />
            </div>
          </div>
        </>
      )}

      {hasSelection && !dockOpen && (
        <div className="flex shrink-0 items-center justify-between border-t bg-background px-3 py-1 text-[11px] text-muted-foreground">
          <span>Inspector · 选中元素属性</span>
          <button className="rounded px-1.5 hover:bg-muted" onClick={() => setDockOpen((v) => !v)}>展开</button>
        </div>
      )}

      {/* 输入区 */}
      <div className="a2-agent-input relative shrink-0 border-t p-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as AgentRunMode)}
            className="rounded border bg-background px-1.5 py-0.5"
            aria-label="模式"
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <select
            value={autonomy}
            onChange={(e) => setAutonomy(e.target.value as AutonomyLevel)}
            className="rounded border bg-background px-1.5 py-0.5"
            aria-label="自治级别"
          >
            {AUTONOMY.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
          <button
            onClick={() => setPrototypeMode((v) => !v)}
            title="§12.1 原型探索模式:UX 门禁放宽至 70 分(P0/P1 仍阻断),结果不建议直接生产导出"
            aria-pressed={prototypeMode}
            className={`rounded-full px-2 py-0.5 transition ${
              prototypeMode
                ? "bg-amber-500/15 font-medium text-amber-600 dark:text-amber-300"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            原型探索{prototypeMode ? " · 开" : ""}
          </button>
          {skillPick.map((sid) => (
            <span key={sid} className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-violet-600 dark:text-violet-300">
              #{sid}
              <button aria-label={`移除 Skill ${sid}`} onClick={() => setSkillPick((s) => s.filter((x) => x !== sid))}>×</button>
            </span>
          ))}
          {selectedChips.map((c, i) => (
            <span key={i} className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
              {c.kind === "page" ? `页面:${c.title ?? c.pageId}` : `${c.label ?? c.aid}`}
            </span>
          ))}
        </div>
        <textarea
          value={input}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            // §8.3:输入以 @ / # / / 开头时唤起对应选择器
            setTrigger(v === "@" || v === "#" || v === "/" ? (v as "@" | "#" | "/") : null);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
            if (e.key === "Escape") setTrigger(null);
          }}
          rows={3}
          placeholder="描述目标,或使用 @ 引用页面/元素 · # 选择 Skill · / 命令…"
          className="w-full resize-none rounded-md border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        {/* @引用 / #Skill / /命令 选择器(§8.3) */}
        {trigger && (
          <div className="absolute bottom-full left-3 right-3 z-30 mb-1 max-h-56 overflow-y-auto rounded-md border bg-background p-1 shadow-xl">
            {trigger === "@" ? (
              (() => {
                const refPage = wsPages.find((p) => p.id === wsSelectedPageIds[0]) ?? wsPages[0];
                const nodes = refPage ? Object.entries(refPage.surface.components).slice(0, 12) : [];
                return (
                  <>
                    <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">引用页面</div>
                    {wsPages.slice(0, 8).map((p) => (
                      <button key={p.id}
                        onClick={() => {
                          setRefChips((cur) => (cur.some((c) => c.kind === "page" && c.pageId === String(p.id)) ? cur : [...cur, { kind: "page" as const, pageId: String(p.id), surfaceId: p.surfaceId, title: p.title }]));
                          setInput((v) => v.replace(/[@#/]$/, "") + `@page(${p.surfaceId ?? p.id}) `);
                          setTrigger(null);
                        }}
                        className="block w-full rounded px-2 py-1.5 text-left text-xs transition hover:bg-muted">
                        <span className="font-medium">@page</span>
                        <span className="ml-1.5 text-muted-foreground">{p.title}</span>
                      </button>
                    ))}
                    {refPage && (
                      <>
                        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">「{refPage.title}」组件</div>
                        {nodes.map(([aid, node]) => (
                          <button key={aid}
                            onClick={() => {
                              setRefChips((cur) => (cur.some((c) => c.kind === "element" && c.aid === aid) ? cur : [...cur, { kind: "element" as const, pageId: String(refPage.id), surfaceId: refPage.surfaceId ?? String(refPage.id), aid, label: `${node.type}#${aid}` }]));
                              setInput((v) => v.replace(/[@#/]$/, "") + `@node(${aid}) `);
                              setTrigger(null);
                            }}
                            className="block w-full rounded px-2 py-1.5 text-left text-xs transition hover:bg-muted">
                            <span className="font-medium">@node</span>
                            <span className="ml-1.5 text-muted-foreground">{node.type}#{aid}</span>
                          </button>
                        ))}
                      </>
                    )}
                  </>
                );
              })()
            ) : trigger === "#" ? (
              BUILTIN_SKILLS.filter((s) => s.enabled).map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSkillPick((cur) => (cur.includes(s.id) ? cur : [...cur, s.id]));
                    setInput((v) => v.replace(/^[#@/]$/, ""));
                    setTrigger(null);
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left text-xs transition hover:bg-muted"
                >
                  <span className="font-medium">#{s.id}</span>
                  <span className="ml-1.5 text-muted-foreground">{s.description}</span>
                </button>
              ))
            ) : (
              COMMANDS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setMode(c.mode);
                    setInput(c.template);
                    setTrigger(null);
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left text-xs transition hover:bg-muted"
                >
                  {c.label}
                </button>
              ))
            )}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">⌘↵ 发送 · Rev {baseRevision}</span>
          {turn && turn.status !== "completed" && turn.status !== "failed" && turn.status !== "cancelled" ? (
            <button onClick={stop} className="inline-flex items-center gap-1 rounded-md bg-destructive px-3 py-1.5 text-xs text-white">
              <Square className="size-3" /> 停止
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40"
            >
              <Send className="size-3" /> 发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turn Card(文档 §14.1:折叠摘要 + 展开细节)
// ---------------------------------------------------------------------------

function TurnCard({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const t = turn;
  const done = t.planTasks.filter((x) => x.status === "completed").length;
  return (
    <div className="rounded-lg border">
      <button className="flex w-full items-center justify-between gap-2 p-3 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CircleDot className={`size-3.5 ${STATUS_COLOR[statusGroupOf(t.status)]}`} />
            Turn · {t.goal.slice(0, 24) || "(无目标)"}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t.brief?.summary ? t.brief.summary.slice(0, 60) : STATUS_LABELS[t.status] ?? t.label}
            {t.planTasks.length ? ` · Plan ${done}/${t.planTasks.length}` : ""}
          </div>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round(t.progress * 100)}%</span>
      </button>
      {open && (
        <div className="space-y-3 border-t p-3 text-xs">
          {t.brief && (
            <Section title="需求理解">
              <div>{t.brief.objective}</div>
              {t.brief.assumptions.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                  {t.brief.assumptions.slice(0, 3).map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              )}
            </Section>
          )}
          {t.plan && (
            <Section title="设计规划">
              <div>{t.plan.rationale.slice(0, 160)}</div>
            </Section>
          )}
          {t.style && (
            <Section title="风格方向">
              <div className="flex flex-wrap gap-1">
                {t.style.visualKeywords.map((k) => (
                  <span key={k} className="rounded-full bg-muted px-2 py-0.5">{k}</span>
                ))}
              </div>
            </Section>
          )}
          {/* §16.1/§24.5 Skill 贡献:id@version + 触发原因 */}
          {t.skills && t.skills.length > 0 && (
            <Section title="Skill 贡献">
              <div className="flex flex-wrap gap-1">
                {t.skills.map((s) => (
                  <span
                    key={s.skillId}
                    title={s.reason}
                    className="rounded-full bg-violet-500/10 px-2 py-0.5 text-violet-600 dark:text-violet-300"
                  >
                    #{s.skillId}@{s.version}
                  </span>
                ))}
              </div>
            </Section>
          )}
          {t.toolCards.length > 0 && (
            <Section title="执行过程">
              {t.toolCards.map((c) => (
                <div key={c.cardId} className="flex items-center justify-between py-0.5">
                  <span>{c.title}</span>
                  <span className="text-muted-foreground">
                    {c.status === "done" ? "✓" : c.status === "error" ? "✗" : "…"}
                    {c.durationMs ? ` ${(c.durationMs / 1000).toFixed(1)}s` : ""}
                    {c.tokens ? ` · ${c.tokens >= 1000 ? `${(c.tokens / 1000).toFixed(1)}k` : c.tokens} tok` : ""}
                  </span>
                </div>
              ))}
            </Section>
          )}
          {t.proposal && (
            <Section title="产物">
              <div className="rounded-md border border-violet-200 bg-violet-50/40 p-2 dark:border-violet-800 dark:bg-violet-950/20">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">📦 Proposal · {t.proposal.proposalId.slice(-12)}</span>
                  <span className="shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] text-violet-600 dark:text-violet-300">
                    {t.proposal.status}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  +{t.proposal.changeSummary.added} ~{t.proposal.changeSummary.updated} -{t.proposal.changeSummary.deleted} ↻{t.proposal.changeSummary.moved} · 置信度 {Math.round(t.proposal.confidence * 100)}%
                </div>
              </div>
            </Section>
          )}
          {t.explanation && (
            <div className="rounded-md bg-muted/50 p-2">
              <MarkdownLite source={t.explanation} />
            </div>
          )}
          {t.error && <div className="rounded-md bg-red-50 p-2 text-red-600 dark:bg-red-950/40">{t.error}</div>}
        </div>
      )}
    </div>
  );
}

function statusGroupOf(s: string): string {
  if (s === "completed") return "success";
  if (s === "failed") return "failed";
  if (s === "cancelled" || s === "cancelling") return "cancelled";
  if (s === "awaiting_clarification" || s === "awaiting_approval") return "waiting_user";
  if (s === "queued") return "idle";
  return "running";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="mt-8 text-center text-xs text-muted-foreground">
      <Clock className="mx-auto mb-2 size-6 opacity-40" />
      描述你的设计目标,Agent 会先理解需求、规划,再生成 Proposal 并通过评审后提交。
    </div>
  );
}

// ---------------------------------------------------------------------------
// 审批卡(文档 §14.8)
// ---------------------------------------------------------------------------

function ApprovalCard({
  title, reason, summary, timeoutSeconds, expiresAt, onDecide,
}: {
  title: string;
  reason: string;
  summary: { added: number; updated: number; deleted: number; moved: number };
  /** §15.3 超时可见倒计时(归零默认拒绝,与服务端一致) */
  timeoutSeconds: number;
  /** §15.3 服务端截止时间(ISO;重连后倒计时不重置) */
  expiresAt?: string;
  onDecide: (approved: boolean, accept: { added: boolean; updated: boolean; deleted: boolean }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // §14.8 部分接受:按变更类别勾选(默认全选)
  const [accept, setAccept] = useState({ added: true, updated: true, deleted: true });
  const toggle = (k: keyof typeof accept) => setAccept((a) => ({ ...a, [k]: !a[k] }));
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">⚠ {title}</div>
        <Countdown seconds={timeoutSeconds} expiresAt={expiresAt} />
      </div>
      <div className="text-muted-foreground">{reason}</div>
      <div className="mt-2 flex gap-3 font-mono text-[11px]">
        <span className="text-emerald-600">+{summary.added} 新增</span>
        <span className="text-blue-600">~{summary.updated} 修改</span>
        <span className="text-red-600">-{summary.deleted} 删除</span>
        <span className="text-purple-600">↻{summary.moved} 移动</span>
      </div>
      {/* 部分接受:只接受勾选的变更类别(移动归入修改) */}
      <div className="mt-2 flex items-center gap-3 text-muted-foreground">
        <span className="text-[10px] uppercase tracking-wide">接受范围</span>
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={accept.added} onChange={() => toggle("added")} /> 新增
        </label>
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={accept.updated} onChange={() => toggle("updated")} /> 修改
        </label>
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={accept.deleted} onChange={() => toggle("deleted")} /> 删除
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); await onDecide(false, accept); setBusy(false); }}
          className="rounded-md border px-3 py-1.5 hover:bg-muted"
        >
          拒绝
        </button>
        <button
          disabled={busy || (!accept.added && !accept.updated && !accept.deleted)}
          onClick={async () => { setBusy(true); await onDecide(true, accept); setBusy(false); }}
          className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40"
        >
          {accept.added && accept.updated && accept.deleted ? "接受并提交" : "接受勾选项并提交"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan / Timeline / Review / Diff Tabs
// ---------------------------------------------------------------------------

/** 管线三步为门禁必需,不开放执行中跳过(与后端 PIPELINE_TASK_TITLES 同口径) */
const PIPELINE_TITLES = ["生成 UI Proposal", "协议校验与 UX 评审", "生成 Diff 并等待提交"];

function PlanTab({
  tasks, plan, approval, busy, paused, active, onPauseToggle, onSkipTask, onApprove,
}: {
  tasks: PlanTask[];
  plan?: { rationale: string } | undefined;
  /** §14.2 非空 = 该 Run 正在等待计划确认(可编辑) */
  approval: { runId: string; tasks: PlanTask[]; timeoutSeconds: number; expiresAt?: string } | null;
  /** 确认 mutation 进行中(防重复提交) */
  busy: boolean;
  /** §14.3 执行控制:暂停闸门状态与可用性 */
  paused: boolean;
  active: boolean;
  onPauseToggle: () => void;
  onSkipTask: (taskId: string) => void;
  onApprove: (approved: boolean, editedTasks?: PlanTask[]) => Promise<void>;
}) {
  // §14.3 编辑草稿(仅确认挂起时可编辑:改标题/跳过/删除)
  const [draft, setDraft] = useState<PlanTask[] | null>(null);
  const effective = approval ? (draft ?? approval.tasks) : tasks;
  if (!effective.length && !plan) return <Centered text="本 Turn 尚无 Plan;复杂任务会自动拆解为任务列表。" />;
  const skippedCount = effective.filter((t) => t.status === "skipped").length;
  return (
    <div className="space-y-2 text-xs">
      {plan?.rationale && <div className="rounded-md bg-muted/50 p-2">{plan.rationale}</div>}
      {approval && (
        <div className="rounded-md border border-amber-300 bg-amber-50/60 p-2 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium">⏳ 请确认执行计划(超时未确认将取消)</div>
            <Countdown seconds={approval.timeoutSeconds} expiresAt={approval.expiresAt} />
          </div>
          <div className="mt-0.5 text-muted-foreground">可修改任务标题、跳过(保留但忽略)或删除任务;确认后 Agent 严格按此计划生成。</div>
          <div className="mt-2 flex justify-end gap-2">
            <button
              disabled={busy}
              onClick={() => void onApprove(false)}
              className="rounded-md border px-3 py-1 hover:bg-muted disabled:opacity-40">
              取消
            </button>
            <button
              disabled={busy}
              onClick={() => void onApprove(true, effective)}
              className="rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground disabled:opacity-40">
              确认并继续{skippedCount ? `(跳过 ${skippedCount} 项)` : ""}
            </button>
          </div>
        </div>
      )}
      {/* §14.3 执行控制行:非确认挂起且执行中可暂停/恢复 */}
      {!approval && active && (
        <div className="flex items-center justify-between rounded-md border px-2 py-1.5">
          <span className="text-muted-foreground">
            {paused ? "执行已暂停;恢复后从当前阶段继续。" : "执行中:可跳过待执行任务,或暂停执行。"}
          </span>
          <button
            onClick={onPauseToggle}
            className={`rounded-md px-3 py-1 font-medium ${
              paused ? "bg-primary text-primary-foreground" : "border hover:bg-muted"
            }`}
          >
            {paused ? "恢复执行" : "暂停执行"}
          </button>
        </div>
      )}
      {effective.map((t, i) => {
        const skipped = t.status === "skipped";
        return (
          <div key={t.taskId} className={`rounded-md border p-2 ${skipped ? "opacity-50" : ""}`}>
            {approval ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!skipped}
                  onChange={() =>
                    setDraft((cur) =>
                      (cur ?? approval.tasks).map((x) =>
                        x.taskId === t.taskId ? { ...x, status: skipped ? ("pending" as const) : ("skipped" as const) } : x,
                      ),
                    )
                  }
                  title={skipped ? "恢复执行" : "跳过此任务"}
                />
                <input
                  value={t.title}
                  onChange={(e) =>
                    setDraft((cur) => (cur ?? approval.tasks).map((x) => (x.taskId === t.taskId ? { ...x, title: e.target.value.slice(0, 120) } : x)))
                  }
                  className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
                  aria-label={`任务 ${i + 1} 标题`}
                />
                <button
                  onClick={() => setDraft((cur) => (cur ?? approval.tasks).filter((x) => x.taskId !== t.taskId))}
                  className="shrink-0 rounded px-1 text-muted-foreground hover:bg-muted hover:text-red-500"
                  title="删除任务"
                >
                  ✕
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <span>{t.status === "completed" ? "✓" : t.status === "running" ? "●" : t.status === "failed" ? "✗" : t.status === "skipped" ? "⊘" : "○"}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.title}</div>
                  {t.output && <div className="text-muted-foreground">{t.output}</div>}
                </div>
                {t.durationMs != null && <span className="tabular-nums text-muted-foreground">{(t.durationMs / 1000).toFixed(1)}s</span>}
                {/* §14.3 执行中跳过:仅 pending 的非管线任务(管线三步为门禁必需) */}
                {!approval && active && t.status === "pending" && !PIPELINE_TITLES.includes(t.title) && (
                  <button
                    onClick={() => onSkipTask(t.taskId)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    title="跳过此任务(生成时将忽略相关内容)"
                  >
                    跳过
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TimelineTab({ cards, status }: { cards: ToolCard[]; status?: string }) {
  if (!cards.length) return <Centered text={status ? `当前阶段:${STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status}` : "Run 启动后,这里按时间线展示各阶段与工具调用。"} />;
  return (
    <div className="space-y-1 text-xs">
      {cards.map((c) => (
        <TimelineCard key={c.cardId} card={c} />
      ))}
    </div>
  );
}

/** §16.2 时间线节点:默认折叠(名称/状态/耗时),可展开输入摘要/校验/输出/原始 JSON/错误 */
function TimelineCard({ card: c }: { card: ToolCard }) {
  const [open, setOpen] = useState(c.status === "error"); // 失败卡片默认展开错误摘要
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <div className={`rounded-md border p-2 ${c.status === "error" ? "border-red-300 bg-red-50/50 dark:bg-red-950/20" : ""}`}>
      <button className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="flex min-w-0 items-center gap-1.5">
          {open ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
          <span className="truncate">{c.title}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">
          {c.status === "done" ? "✓" : c.status === "error" ? "✗" : "…"}
          {c.durationMs ? ` ${(c.durationMs / 1000).toFixed(1)}s` : ""}
          {c.tokens ? ` · ${c.tokens >= 1000 ? `${(c.tokens / 1000).toFixed(1)}k` : c.tokens} tok` : ""}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 border-t pt-1.5 text-[11px]">
          {c.inputRefs && c.inputRefs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {c.inputRefs.map((r, i) => (
                <span key={i} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{r}</span>
              ))}
            </div>
          )}
          {c.validation && c.validation.length > 0 && (
            <ul className="space-y-0.5">
              {c.validation.map((v, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className={v.ok ? "text-emerald-500" : "text-amber-500"}>{v.ok ? "✓" : "⚠"}</span>
                  <span className="min-w-0">
                    {v.label}
                    {v.detail && <span className="ml-1 text-muted-foreground">{v.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {c.outputSummary && <div className="text-muted-foreground">输出:{c.outputSummary}</div>}
          {c.error && <div className="rounded bg-red-50 p-1.5 text-red-600 dark:bg-red-950/40 dark:text-red-300">{c.error}</div>}
          {c.rawJson && (
            <>
              <button className="text-[10px] text-muted-foreground underline" onClick={() => setRawOpen((v) => !v)}>
                {rawOpen ? "收起原始 JSON" : "查看原始 JSON"}
              </button>
              {rawOpen && (
                <pre className="a2-agent-scroll max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[10px]">{c.rawJson}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const SEV_COLOR: Record<string, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-red-500 text-white",
  P2: "bg-amber-500 text-white",
  P3: "bg-slate-400 text-white",
};

function ReviewTab({
  report, onLocate, hasPendingApproval, onAutoRepair, onCommitAnyway, onDiscard,
}: {
  report?: { score: { total: number }; issues: UXReviewIssue[]; strengths: string[]; recommendations: string[] } | undefined;
  onLocate: (sid: string, nid: string) => void;
  /** §12.1 三动作:存在待审批 Proposal 时「仍要提交/放弃」直接作用于审批 */
  hasPendingApproval: boolean;
  onAutoRepair: () => void;
  onCommitAnyway: () => void;
  onDiscard: () => void;
}) {
  if (!report) return <Centered text="评审完成后,这里展示 UX 评分与问题清单。" />;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <div className="text-2xl font-semibold tabular-nums">{report.score.total}</div>
        <div className="text-muted-foreground">UX 总分 / 100</div>
      </div>
      {report.issues.map((i) => (
        <div key={i.issueId} className="rounded-md border p-2">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SEV_COLOR[i.severity] ?? ""}`}>{i.severity}</span>
            <span className="font-medium">{i.message}</span>
          </div>
          {i.recommendation && <div className="mt-1 text-muted-foreground">建议:{i.recommendation}</div>}
          {i.affectedNodeIds.length > 0 && (
            <button className="mt-1 text-primary underline" onClick={() => onLocate(i.surfaceId ?? "", i.affectedNodeIds[0])}>
              定位到画布
            </button>
          )}
        </div>
      ))}
      {report.recommendations.length > 0 && (
        <div className="text-muted-foreground">
          后续建议:
          <ul className="list-disc pl-4">
            {report.recommendations.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {/* §12.1 处置动作:自动修复 / 仍要提交 / 放弃 */}
      <div className="flex gap-2 border-t pt-2">
        <button
          onClick={onAutoRepair}
          className="flex-1 rounded-md bg-primary px-2 py-1.5 font-medium text-primary-foreground"
        >
          自动修复
        </button>
        <button
          onClick={onCommitAnyway}
          className="flex-1 rounded-md border px-2 py-1.5 hover:bg-muted"
          title={hasPendingApproval ? "接受待审批的 Proposal 并提交" : "无待审批 Proposal"}
        >
          仍要提交
        </button>
        <button
          onClick={onDiscard}
          className="flex-1 rounded-md border border-red-200 px-2 py-1.5 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
        >
          放弃
        </button>
      </div>
    </div>
  );
}

function DiffTab({ summary, committed }: { summary?: { score: { total: number }; issues: UXReviewIssue[] } | undefined; committed: boolean }) {
  if (!summary && !committed) return <Centered text="提交审批通过后,这里按页面分组展示变更摘要。" />;
  return (
    <div className="space-y-2 text-xs">
      {committed && <div className="rounded-md bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950/30">已提交到 Design IR(可在画布查看最新结果)。</div>}
      {summary?.issues.map((i) => (
        <div key={i.issueId} className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${SEV_COLOR[i.severity] ?? ""}`}>{i.severity}</span>
          <span>{i.message}</span>
        </div>
      ))}
    </div>
  );
}

function Centered({ text }: { text: string }) {
  return <div className="mt-8 text-center text-xs text-muted-foreground">{text}</div>;
}

