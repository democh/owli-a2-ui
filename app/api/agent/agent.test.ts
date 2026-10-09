import { describe, expect, it, vi } from "vitest";
import { transition, isTerminal, STATUS_PROGRESS } from "../agent/run/RunStateMachine";
import { ProposalBuffer } from "../agent/runtime/ProposalBuffer";
import { validateProposal, hasBlocking } from "../agent/validation/ValidationPipeline";
import { projectBuffer, parseA2uiMessageStream } from "../agent/validation/A2UIProjector";
import { createPreviewThrottle, createTextStreamThrottle } from "./orchestrator/DesignHarnessAgent";
import type { IRDocument } from "@contracts/design-ir";

describe("RunStateMachine", () => {
  it("合法迁移路径完整", () => {
    const happy: Parameters<typeof transition>[] = [
      ["queued", "intake"],
      ["intake", "resolving_style"],
      ["resolving_style", "selecting_skills"],
      ["selecting_skills", "planning_clarification"],
      ["planning_clarification", "planning"],
      ["planning", "generating"],
      ["generating", "parsing"],
      ["parsing", "protocol_validating"],
      ["protocol_validating", "ux_reviewing"],
      ["ux_reviewing", "policy_checking"],
      ["policy_checking", "committing"],
      ["committing", "completed"],
    ];
    for (const [f, t] of happy) expect(transition(f, t)).toBe(t);
  });

  it("编排管线真实顺序合法(与 executeRun §19.4 一致,防表/实现脱节)", () => {
    const pipeline: Parameters<typeof transition>[] = [
      ["queued", "intake"],
      ["intake", "planning_clarification"],
      ["planning_clarification", "awaiting_clarification"], // 有澄清问题
      ["awaiting_clarification", "resolving_style"], // 澄清回答后继续
      ["resolving_style", "selecting_skills"],
      ["selecting_skills", "planning"], // 复杂任务拆解
      ["planning", "awaiting_plan_approval"],
      ["awaiting_plan_approval", "generating"],
      ["generating", "parsing"],
      ["parsing", "protocol_validating"],
      ["protocol_validating", "ux_reviewing"],
      ["ux_reviewing", "policy_checking"],
      ["policy_checking", "awaiting_approval"],
      ["awaiting_approval", "committing"],
      ["committing", "completed"],
    ];
    for (const [f, t] of pipeline) expect(transition(f, t)).toBe(t);
  });

  it("编排跳过分支合法(无澄清/无 plan/suggest 直完成/修复循环)", () => {
    const skips: Parameters<typeof transition>[] = [
      ["planning_clarification", "resolving_style"], // 澄清策略无问题
      ["selecting_skills", "generating"], // 简单局部修改跳过 plan
      ["policy_checking", "committing"], // 自动化自治直接提交
      ["awaiting_approval", "completed"], // suggest 模式仅解释不提交
      ["ux_reviewing", "repairing"],
      ["repairing", "protocol_validating"], // 修复后重新校验
    ];
    for (const [f, t] of skips) expect(transition(f, t)).toBe(t);
  });

  it("非法迁移抛错", () => {
    expect(() => transition("queued", "committing")).toThrow();
    expect(() => transition("completed", "generating")).toThrow();
  });

  it("取消语义:任意非终态可进入 cancelling → cancelled", () => {
    for (const s of ["generating", "awaiting_clarification", "awaiting_approval", "ux_reviewing"] as const) {
      expect(transition(s, "cancelling")).toBe("cancelling");
      expect(transition("cancelling", "cancelled")).toBe("cancelled");
    }
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("generating")).toBe(false);
  });

  it("进度单调递增到 1", () => {
    const seq = ["queued", "intake", "planning", "generating", "protocol_validating", "ux_reviewing", "committing", "completed"] as const;
    let prev = 0;
    for (const s of seq) {
      expect(STATUS_PROGRESS[s]).toBeGreaterThanOrEqual(prev);
      prev = STATUS_PROGRESS[s];
    }
    expect(STATUS_PROGRESS.completed).toBe(1);
  });
});

describe("ProposalBuffer", () => {
  it("updateComponents last-write-wins 合并", () => {
    const buf = new ProposalBuffer();
    buf.push({ kind: "createSurface", surfaceId: "s1", root: "root" });
    buf.push({
      kind: "updateComponents",
      surfaceId: "s1",
      components: [{ id: "root", type: "Section", props: {}, children: ["t1"] }, { id: "t1", type: "Title", props: { text: "v1" }, children: [] }],
      batchEnd: false,
    });
    buf.push({
      kind: "updateComponents",
      surfaceId: "s1",
      components: [{ id: "t1", type: "Title", props: { text: "v2" }, children: [] }],
      batchEnd: false,
    });
    const s = buf.getSurface("s1")!;
    expect(s.components.get("t1")!.props.text).toBe("v2");
    expect(s.components.size).toBe(2);
  });

  it("未闭合结构 closureIssues 非空,禁止 commit", () => {
    const buf = new ProposalBuffer();
    buf.push({ kind: "createSurface", surfaceId: "s1" });
    buf.push({
      kind: "updateComponents",
      surfaceId: "s1",
      components: [{ id: "root", type: "Section", props: {}, children: ["ghost"] }],
      batchEnd: false,
    });
    expect(buf.closureIssues().length).toBeGreaterThan(0);
    expect(buf.readyToFlush()).toBe(false);
    // 补齐引用后闭合
    buf.push({
      kind: "updateComponents",
      surfaceId: "s1",
      components: [{ id: "ghost", type: "Text", props: {}, children: [] }],
      batchEnd: true,
    });
    expect(buf.closureIssues()).toEqual([]);
    expect(buf.readyToFlush()).toBe(true);
  });

  it("deleteSurface 移除分组", () => {
    const buf = new ProposalBuffer();
    buf.push({ kind: "createSurface", surfaceId: "s1" });
    buf.push({ kind: "deleteSurface", surfaceId: "s1" });
    expect(buf.surfaceIds).toEqual([]);
  });
});

describe("A2UIProjector", () => {
  it("解析 JSON 数组与 JSONL 两种流", () => {
    const arr = parseA2uiMessageStream(
      JSON.stringify([{ kind: "createSurface", surfaceId: "s1" }]),
    );
    expect(arr[0].kind).toBe("createSurface");
    const jsonl = parseA2uiMessageStream(
      '{"kind":"createSurface","surfaceId":"s1"}\n{"kind":"updateComponents","surfaceId":"s1","components":[{"id":"a","type":"Text"}]}',
    );
    expect(jsonl.length).toBe(2);
    expect(jsonl[1].kind).toBe("updateComponents");
  });

  it("新 surface 投影为整面上架,数据模型一并投影", () => {
    const buf = new ProposalBuffer();
    buf.push({ kind: "createSurface", surfaceId: "s1", root: "root", title: "新页" });
    buf.push({
      kind: "updateComponents",
      surfaceId: "s1",
      components: [
        { id: "root", type: "Section", props: {}, children: [] },
      ],
      batchEnd: true,
    });
    buf.push({ kind: "updateDataModel", surfaceId: "s1", modelId: "dm_users", value: { name: "张三" } });
    const baseDoc = emptyDoc();
    const result = projectBuffer(buf, baseDoc);
    expect(result.newSurfaces).toHaveLength(1);
    expect(result.newSurfaces[0].root).toBe("root");
    expect(result.dataModels[0].schema.name).toBe("string");
  });

  it("既有 surface 的 upsert 投影为 replaceProps / addNode", () => {
    const buf = new ProposalBuffer();
    const baseDoc = emptyDoc();
    baseDoc.surfaces["s1"] = {
      id: "s1",
      title: "",
      root: "root",
      components: { root: { type: "Section", props: {}, children: ["t1"] }, t1: { type: "Title", props: { text: "旧" }, children: [] } },
    };
    buf.push({
      kind: "updateComponents",
      surfaceId: "s1",
      components: [
        { id: "t1", type: "Title", props: { text: "新" }, children: [] },
        { id: "b1", type: "Button", props: { label: "提交" }, children: [] },
      ],
      batchEnd: true,
    });
    const result = projectBuffer(buf, baseDoc);
    expect(result.newSurfaces).toHaveLength(0);
    expect(result.ops).toHaveLength(2);
    expect(result.ops[0].op).toBe("replaceProps");
    expect(result.ops[1].op).toBe("addNode");
  });
});

describe("ValidationPipeline", () => {
  it("未知组件类型 / 非法 URL / 非白名单 action 均为 error", () => {
    const baseDoc = emptyDoc();
    baseDoc.surfaces["s1"] = {
      id: "s1",
      title: "",
      root: "root",
      components: { root: { type: "Section", props: {}, children: [] } },
    };
    const issues = validateProposal({
      baseDoc,
      ops: [
        { op: "addNode", surfaceId: "s1", parentId: "root", id: "bad", node: { type: "NotInCatalog", props: {}, children: [] }, extra: {} },
        { op: "addNode", surfaceId: "s1", parentId: "root", id: "img1", node: { type: "Image", props: { src: "http://evil.com/a.png" }, children: [] }, extra: {} },
        { op: "addNode", surfaceId: "s1", parentId: "root", id: "btn1", node: { type: "Button", props: { label: "x", action: "eval" }, children: [] }, extra: {} },
      ],
    });
    expect(hasBlocking(issues)).toBe(true);
    expect(issues.some((i) => i.code === "catalog_unknown_type")).toBe(true);
    expect(issues.some((i) => i.code === "security_url")).toBe(true);
    expect(issues.some((i) => i.code === "security_action")).toBe(true);
  });

  it("合法 ops 零阻断", () => {
    const baseDoc = emptyDoc();
    baseDoc.surfaces["s1"] = {
      id: "s1",
      title: "",
      root: "root",
      components: { root: { type: "Section", props: {}, children: [] } },
    };
    const issues = validateProposal({
      baseDoc,
      ops: [{ op: "replaceProps", surfaceId: "s1", id: "root", props: { title: "新" } }],
    });
    expect(hasBlocking(issues)).toBe(false);
  });
});

function emptyDoc(): IRDocument {
  return {
    revision: 0,
    theme: { preset: "shadcn", tokens: {
      primary: "#18181b", background: "#ffffff", surface: "#f4f4f5",
      text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "",
    } },
    surfaces: {},
    dataModels: {}, componentDefs: {},
  };
}

describe("createPreviewThrottle(流式预览节流)", () => {
  it("窗口内多次 push 只 emit 最新累积串,flush 补发尾帧且幂等", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const throttle = createPreviewThrottle((acc) => seen.push(acc), 150);
    throttle.push("a");
    throttle.push("ab");
    throttle.push("abc");
    await vi.advanceTimersByTimeAsync(160);
    expect(seen).toEqual(["abc"]); // 150ms 窗口合并为一次,只发最新
    throttle.push("abcd");
    throttle.flush(); // 流结束尾帧:立即 emit 并清空 pending
    expect(seen).toEqual(["abc", "abcd"]);
    throttle.flush(); // 幂等
    expect(seen).toEqual(["abc", "abcd"]);
    vi.useRealTimers();
  });

  it("间隔超过窗口:每次 push 各自触发一次 emit", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const throttle = createPreviewThrottle((acc) => seen.push(acc), 50);
    throttle.push("1");
    await vi.advanceTimersByTimeAsync(60);
    throttle.push("12");
    await vi.advanceTimersByTimeAsync(60);
    expect(seen).toEqual(["1", "12"]);
    vi.useRealTimers();
  });
});

describe("createTextStreamThrottle(打字机文本节流)", () => {
  it("按字符阈值批量发增量,flush 补尾", () => {
    const deltas: string[] = [];
    const t = createTextStreamThrottle((d) => deltas.push(d), 10, 5);
    let acc = "";
    for (const ch of "0123456789abcdefghij") {
      acc += ch;
      t.push(acc);
    }
    // ≥10 字符即触发:期望 2 次以上增量且拼接无损
    const joined = deltas.join("");
    expect(joined).toBe("0123456789abcdefghij");
    t.push(`${acc}XYZ`);
    t.flush();
    expect(deltas.join("")).toBe("0123456789abcdefghijXYZ");
  });
});
