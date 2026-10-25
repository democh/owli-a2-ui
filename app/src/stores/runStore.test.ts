/**
 * runStore 历史回放(replay=true)守卫单测:
 * 结束 Run 的事件重建只回填展示态,不得污染 activeRunId / 画布挂起态。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useRunStore } from "./runStore";
import { useWorkspace } from "./workspaceStore";
import type { AgentEvent } from "@contracts/agent";

const RID = "run_hist_1";

/** 构造一个已完成 Run 的持久化事件序列(仅回填展示态所需) */
function completedEvents(): AgentEvent[] {
  return [
    { type: "run.state", runId: RID, seq: 0, status: "generating", label: "生成中", progress: 0.5 } as AgentEvent,
    { type: "design.ops_committed", runId: RID, seq: 1, revision: 42, changes: [] } as unknown as AgentEvent,
    { type: "design.explanation", runId: RID, seq: 2, markdown: "已生成首页" } as AgentEvent,
  ];
}

beforeEach(() => {
  // 全量重置 store 内存态,避免用例间串扰
  useRunStore.setState({
    turns: {},
    activeRunId: null,
    pendingClarification: null,
    pendingApproval: null,
    pendingPlanApproval: null,
    previews: {},
    previewDocs: {},
    skeletonIds: {},
    streamText: "",
    committedRuns: [],
  });
  useWorkspace.setState({ draft: null });
});

describe("runStore.seedHistoryRun", () => {
  it("回放结束 Run:重建 completed 状态与结论,不抢 activeRunId", () => {
    useRunStore.getState().seedHistoryRun(RID, "生成一个首页", 1_700_000_000_000, completedEvents());

    const s = useRunStore.getState();
    const turn = s.turns[RID];
    expect(turn).toBeTruthy();
    expect(turn.status).toBe("completed");
    expect(turn.explanation).toBe("已生成首页");
    // startedAt 采用传入的真实时间戳(而非 Date.now)
    expect(turn.startedAt).toBe(1_700_000_000_000);
    // goal 保留发起原文
    expect(turn.goal).toBe("生成一个首页");
    // 关键守卫:历史回放不得改写活跃标记
    expect(s.activeRunId).toBeNull();
    // ops_committed 幂等记入 committedRuns(撤销入口依赖)
    expect(s.committedRuns).toContain(RID);
  });

  it("回放不触发画布侧效应(nodeDiffs/draft 保持不变)", () => {
    useWorkspace.setState({ nodeDiffs: {} });
    const evs = [
      { type: "run.state", runId: RID, seq: 0, status: "committing", label: "提交中", progress: 0.9 } as AgentEvent,
      {
        type: "design.ops_committed",
        runId: RID,
        seq: 1,
        revision: 7,
        changes: [{ surfaceId: "s1", added: ["a1"], updated: [], removed: [] }],
      } as unknown as AgentEvent,
    ];
    useRunStore.getState().seedHistoryRun(RID, "x", 1, evs);
    // replay 模式跳过逐节点持久 Diff 着色
    expect(useWorkspace.getState().nodeDiffs).toEqual({});
  });

  it("回放澄清/审批挂起事件:不重新挂起 HITL", () => {
    const evs = [
      {
        type: "clarification.request",
        runId: RID,
        seq: 0,
        request: { requestId: "c1", runId: RID, questions: [] },
      } as unknown as AgentEvent,
      { type: "run.approval_required", runId: RID, seq: 1, request: { runId: RID } } as unknown as AgentEvent,
    ];
    useRunStore.getState().seedHistoryRun(RID, "x", 1, evs);
    const s = useRunStore.getState();
    expect(s.pendingClarification).toBeNull();
    expect(s.pendingApproval).toBeNull();
  });

  it("重复回放同一 Run:不覆盖既有 Turn,committedRuns 不重复累加", () => {
    useRunStore.getState().seedHistoryRun(RID, "a", 1, completedEvents());
    useRunStore.getState().seedHistoryRun(RID, "a", 1, completedEvents());
    expect(useRunStore.getState().committedRuns.filter((r) => r === RID)).toHaveLength(1);
  });

  it("实时 applyEvent(非 replay)仍会设 activeRunId", () => {
    useRunStore.getState().applyEvent({
      type: "run.state",
      runId: "run_live",
      seq: 0,
      status: "generating",
      label: "生成中",
      progress: 0.2,
    } as AgentEvent);
    expect(useRunStore.getState().activeRunId).toBe("run_live");
  });

  it("断线恢复(非 replay 回放挂起事件):重新挂起 pendingPlanApproval 供用户确认", () => {
    // 页面重载后重连一个 awaiting_plan_approval 的进行中 Run,服务端重放挂起事件:
    // 应挂起 pendingPlanApproval(用户仍需确认);单流主线已无 Tab 切换副作用
    useRunStore.getState().applyEvent(
      { type: "run.plan_approval_required", runId: "run_restore", seq: 0, tasks: [], timeoutSeconds: 120 } as unknown as AgentEvent,
      false,
    );
    const s = useRunStore.getState();
    expect(s.pendingPlanApproval?.runId).toBe("run_restore");
  });

  it("回放计划确认挂起事件:不重新挂起(历史轮早已确认)", () => {
    useRunStore.getState().seedHistoryRun("run_p", "x", 1, [
      { type: "run.plan_approval_required", runId: "run_p", seq: 0, tasks: [], timeoutSeconds: 120 } as unknown as AgentEvent,
    ]);
    expect(useRunStore.getState().pendingPlanApproval).toBeNull();
  });
});

describe("runStore 流式预览(实时) —— 骨架幻影帧", () => {
  const skeletonEv = (): AgentEvent =>
    ({
      type: "design.preview",
      runId: "run_live",
      seq: 0,
      surfaceId: "preview_0",
      message: { delta: true, upserts: {}, meta: { skeleton: true, title: "首页", device: "desktop" } },
    }) as unknown as AgentEvent;

  it("meta.skeleton 的空组件帧也上画布 ghost(消除 sitemap→首个组件间的预览死区)", () => {
    useWorkspace.setState({ pages: [] });
    useRunStore.getState().applyEvent(skeletonEv());
    const draft = useWorkspace.getState().draft;
    expect(draft?.ghosts).toHaveLength(1);
    expect(draft?.ghosts[0].title).toBe("首页");
    // 空组件 → FrameView 据此渲染 PageSkeleton 占位
    expect(Object.keys(draft!.ghosts[0].surface.components).length).toBe(0);
    expect(useRunStore.getState().skeletonIds["preview_0"]).toBe(true);
  });

  it("真实组件帧到达:同 surfaceId 原位升级并清除骨架标记", () => {
    useWorkspace.setState({ pages: [] });
    useRunStore.getState().applyEvent(skeletonEv());
    useRunStore.getState().applyEvent({
      type: "design.preview",
      runId: "run_live",
      seq: 1,
      surfaceId: "preview_0",
      message: {
        delta: true,
        upserts: { root: { type: "Section", props: {}, children: [] } },
        meta: { root: "root", title: "首页", device: "desktop" },
      },
    } as unknown as AgentEvent);
    const draft = useWorkspace.getState().draft;
    expect(draft?.ghosts).toHaveLength(1);
    expect(Object.keys(draft!.ghosts[0].surface.components).length).toBe(1);
    expect(useRunStore.getState().skeletonIds["preview_0"]).toBeUndefined();
  });

  it("ops_committed 清空骨架标记(不留残余幻影)", () => {
    useWorkspace.setState({ pages: [] });
    useRunStore.getState().applyEvent(skeletonEv());
    useRunStore.getState().applyEvent({
      type: "design.ops_committed",
      runId: "run_live",
      seq: 2,
      revision: 3,
      changes: [],
    } as unknown as AgentEvent);
    expect(useRunStore.getState().skeletonIds).toEqual({});
    expect(useRunStore.getState().previewDocs).toEqual({});
  });
});
