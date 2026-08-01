/**
 * A2UI 协议核心逻辑单元测试
 * 覆盖:文档校验 / ops 应用 / 计划生成 / 管线路由(无 Key 错误引导、换风格免 Key)
 */
import { describe, expect, it } from "vitest";
import {
  applyOps,
  planFromActions,
  surfaceDocSchema,
  validateSurface,
  type ChatAction,
  type SurfaceDoc,
} from "@contracts/a2ui";
import { runAnalyze, runPipeline, type PipelineInput } from "./llm/pipeline";
import { buildCreateUserPrompt, buildHistoryBlock, buildOpsUserMessage, buildRedesignUserPrompt } from "./llm/prompts";

function makeDoc(): SurfaceDoc {
  return surfaceDocSchema.parse({
    version: "1.0",
    page: { id: "page", title: "测试页", device: "desktop" },
    components: {
      n1: { type: "Section", props: {}, children: ["n2", "n3"] },
      n2: { type: "Title", props: { text: "你好" }, children: [] },
      n3: { type: "Text", props: { text: "正文" }, children: [] },
    },
    root: "n1",
  });
}

describe("validateSurface", () => {
  it("合法文档无错误", () => {
    expect(validateSurface(makeDoc())).toEqual([]);
  });

  it("root 不存在时报错", () => {
    const doc = makeDoc();
    doc.root = "missing";
    expect(validateSurface(doc).join()).toContain("missing");
  });

  it("检测循环引用", () => {
    const doc = makeDoc();
    doc.components.n1.children.push("n1");
    expect(validateSurface(doc).join()).toContain("循环引用");
  });

  it("检测悬空引用", () => {
    const doc = makeDoc();
    doc.components.n1.children.push("ghost");
    expect(validateSurface(doc).join()).toContain("ghost");
  });
});

describe("applyOps", () => {
  it("replaceProps 合并属性且不改变原 doc", () => {
    const doc = makeDoc();
    const next = applyOps(doc, [{ op: "replaceProps", id: "n2", props: { text: "世界", level: 1 } }]);
    expect(next.components.n2.props.text).toBe("世界");
    expect(next.components.n2.props.level).toBe(1);
    expect(doc.components.n2.props.text).toBe("你好");
  });

  it("addNode 插入指定位置并挂载 extra 子孙", () => {
    const doc = makeDoc();
    const next = applyOps(doc, [{
      op: "addNode",
      parentId: "n1",
      index: 0,
      id: "n9",
      node: { type: "Badge", props: { label: "新" }, children: ["n10"] },
      extra: { n10: { type: "Text", props: { text: "子节点" }, children: [] } },
    }]);
    expect(next.components.n1.children[0]).toBe("n9");
    expect(next.components.n10.props.text).toBe("子节点");
    expect(validateSurface(next)).toEqual([]);
  });

  it("removeNode 级联删除子树并清理父引用", () => {
    const doc = makeDoc();
    doc.components.n3.children = ["n4"];
    doc.components.n4 = { type: "Tag", props: {}, children: [] };
    const next = applyOps(doc, [{ op: "removeNode", id: "n3" }]);
    expect(next.components.n3).toBeUndefined();
    expect(next.components.n4).toBeUndefined();
    expect(next.components.n1.children).toEqual(["n2"]);
  });

  it("moveNode 移动节点到新父级", () => {
    const doc = makeDoc();
    doc.components.n5 = { type: "Col", props: {}, children: [] };
    const next = applyOps(doc, [{ op: "moveNode", id: "n2", newParentId: "n5" }]);
    expect(next.components.n1.children).toEqual(["n3"]);
    expect(next.components.n5.children).toEqual(["n2"]);
  });

  it("setTokens 部分更新主题", () => {
    const doc = makeDoc();
    const next = applyOps(doc, [{ op: "setTokens", tokens: { primary: "#ff0000" } }]);
    expect(next.theme.tokens.primary).toBe("#ff0000");
    expect(next.theme.tokens.accent).toBe(doc.theme.tokens.accent);
  });

  it("setTitle 更新页面标题", () => {
    const next = applyOps(makeDoc(), [{ op: "setTitle", title: "新标题" }]);
    expect(next.page.title).toBe("新标题");
  });

  it("对不存在的节点操作安全跳过", () => {
    const doc = makeDoc();
    const next = applyOps(doc, [
      { op: "replaceProps", id: "ghost", props: { a: 1 } },
      { op: "removeNode", id: "ghost" },
    ]);
    expect(validateSurface(next)).toEqual([]);
  });
});

describe("planFromActions", () => {
  it("删组件/整页重生成标记为中风险", () => {
    const actions: ChatAction[] = [
      { type: "ops", pageId: "1", ops: [{ op: "removeNode", id: "n2" }], summary: "删除" },
    ];
    const plan = planFromActions(actions);
    expect(plan.risk).toBe("medium");
  });

  it("低风险动作整体低风险", () => {
    const actions: ChatAction[] = [
      { type: "setPreset", preset: "antd" },
      { type: "ops", pageId: "1", ops: [{ op: "setTitle", title: "X" }], summary: "改名" },
    ];
    expect(planFromActions(actions).risk).toBe("low");
  });
});

describe("管线(LLM-only,无内置模板引擎)", () => {
  const baseInput = (over: Partial<PipelineInput>): PipelineInput => ({
    prompt: "生成一个营销落地页",
    chips: [],
    projectPreset: "shadcn",
    pages: [],
    llm: null,
    ...over,
  });

  it("未配置 API Key 时生成页面抛出引导错误", async () => {
    await expect(runPipeline(baseInput({}))).rejects.toThrow(/API Key/);
  });

  it("未配置 API Key 时整页重生成同样抛出引导错误", async () => {
    const page = {
      id: 1, title: "首页", device: "desktop",
      posX: 0, posY: 0, width: 1440, height: 900,
      surface: makeDoc(),
    };
    await expect(
      runPipeline(baseInput({ prompt: "重新设计这一页", pages: [page], chips: [{ kind: "page", pageId: "1", title: "首页" }] })),
    ).rejects.toThrow(/API Key/);
  });

  it("换风格不需要 LLM,未配置 Key 也可执行", async () => {
    const result = await runPipeline(baseInput({ prompt: "换成 antd 风格" }));
    expect(result.actions).toEqual([{ type: "setPreset", preset: "antd" }]);
    expect(result.assistantText).toContain("Ant Design");
  });

  it("runAnalyze:新建页面路由", () => {
    const a = runAnalyze(baseInput({}));
    expect(a.mode).toBe("create");
    expect(a.intentLabel).toBe("生成新页面");
  });

  it("runAnalyze:选中页面 chip 时路由为编辑", () => {
    const page = {
      id: 7, title: "定价页", device: "desktop",
      posX: 0, posY: 0, width: 1440, height: 900,
      surface: makeDoc(),
    };
    const a = runAnalyze(baseInput({ pages: [page], chips: [{ kind: "page", pageId: "7", title: "定价页" }] }));
    expect(a.mode).toBe("edit");
    expect(a.targetTitle).toBe("定价页");
  });

  it("runAnalyze:设备关键词体现在上下文摘要", () => {
    const a = runAnalyze(baseInput({ prompt: "生成手机版首页" }));
    expect(a.contextSummary).toContain("mobile");
  });
});

describe("多轮对话历史注入", () => {
  it("空历史返回空串,user 消息不留占位符", () => {
    expect(buildHistoryBlock([])).toBe("");
    expect(buildHistoryBlock(undefined)).toBe("");
    const p = buildCreateUserPrompt("生成落地页", "desktop", buildHistoryBlock([]));
    expect(p).not.toContain("{{history}}");
    expect(p).not.toContain("对话历史");
  });

  it("历史块包含用户/助手角色行", () => {
    const block = buildHistoryBlock([
      { role: "user", content: "生成一个落地页" },
      { role: "assistant", content: "已生成「落地页」" },
      { role: "user", content: "改回去" },
    ]);
    expect(block).toContain("对话历史");
    expect(block).toContain("- 用户:生成一个落地页");
    expect(block).toContain("- 助手:已生成「落地页」");
    expect(block).toContain("以当前指令为准");
  });

  it("只保留最近 6 条,超长内容截断", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `第${i}轮` }));
    const block = buildHistoryBlock(turns);
    expect(block).not.toContain("第0轮");
    expect(block).not.toContain("第3轮");
    expect(block).toContain("第9轮");
    const long = buildHistoryBlock([{ role: "user", content: "长".repeat(500) }]);
    expect(long.length).toBeLessThan(500);
  });

  it("历史注入 create / redesign / ops 三种 user 消息", () => {
    const block = buildHistoryBlock([{ role: "user", content: "上一轮要求" }]);
    expect(buildCreateUserPrompt("新需求", "desktop", block)).toContain("上一轮要求");
    expect(buildRedesignUserPrompt("首页", "改需求", "desktop", block)).toContain("上一轮要求");
    const opsMsg = buildOpsUserMessage({
      tokens: {}, contextNodes: {}, selectedDesc: "", instruction: "改标题", history: block,
    });
    expect(opsMsg).toContain("上一轮要求");
  });

  it("不传 history 时三种消息均无残留占位符", () => {
    expect(buildCreateUserPrompt("新需求", "mobile")).not.toContain("{{");
    expect(buildRedesignUserPrompt("首页", "改需求", "tablet")).not.toContain("{{");
    const opsMsg = buildOpsUserMessage({ tokens: {}, contextNodes: {}, selectedDesc: "", instruction: "改标题" });
    expect(opsMsg).not.toContain("{{");
  });
});
