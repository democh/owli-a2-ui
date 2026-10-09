import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "./cases";
import { runEvalChecks, summarize, type EvalCaseResult, type EvalSubject } from "./checkers";
import type { IRSurface } from "@contracts/design-ir";

/**
 * 评测集离线验证(M6-6):用例结构完整性 + checker 确定性自测。
 * LLM 全量评测见 evals.llm.test.ts(EVALS_LLM=1 显式触发)。
 */

function surface(components: IRSurface["components"], device = "desktop"): IRSurface {
  const root = "root";
  return { id: `s_${device}`, title: "s", root, components };
}

const loginSurface: IRSurface = surface({
  root: { type: "Section", props: {}, children: ["t", "u", "p", "b"] },
  t: { type: "Title", props: { text: "登录" }, children: [] },
  u: { type: "Input", props: { label: "邮箱", placeholder: "you@example.com" }, children: [] },
  p: { type: "Input", props: { label: "密码", placeholder: "••••••" }, children: [] },
  b: { type: "Button", props: { text: "登录" }, children: [] },
});

const base: EvalSubject = { surfaces: [loginSurface], ops: [], devices: ["desktop"] };

describe("评测集用例完整性(M6-6)", () => {
  it("100 组用例(§17.3 全量),id 唯一,均含确定性断言", () => {
    expect(EVAL_CASES).toHaveLength(100);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(100);
    for (const c of EVAL_CASES) {
      expect(c.checks.length).toBeGreaterThanOrEqual(1);
      expect(c.prompt.length).toBeGreaterThan(4);
    }
  });

  it("领域覆盖文档 §17.3 全量", () => {
    const domains = new Set(EVAL_CASES.map((c) => c.domain));
    for (const d of [
      "登录页", "Dashboard", "表格", "表单", "无障碍", "Prompt Injection", "移动端",
      "设置页", "详情页", "多步骤表单", "落地页", "空态错误态", "高密度后台",
      "低密度营销页", "超大组件树", "非法数据路径", "不支持组件请求",
    ] as const) {
      expect(domains.has(d)).toBe(true);
    }
  });

  it("注入类用例必须携带安全断言(漏报防护)", () => {
    for (const c of EVAL_CASES.filter((x) => x.domain === "Prompt Injection")) {
      expect(c.checks.some((k) => k.kind === "no_destructive_ops")).toBe(true);
    }
  });
});

describe("确定性 checker", () => {
  it("功能类:requires/minNodes/feedback 正向命中", () => {
    const r = runEvalChecks(
      [
        { kind: "requires_components", params: ["Input", "Button"] },
        { kind: "min_nodes", params: ["4"] },
        { kind: "interactive_feedback" },
      ],
      base,
    );
    expect(r.every((x) => x.ok)).toBe(true);
  });

  it("requires_components 缺失时失败并给出明细", () => {
    const r = runEvalChecks([{ kind: "requires_components", params: ["Table", "Badge"] }], base);
    expect(r[0]?.ok).toBe(false);
    expect(r[0]?.detail).toContain("Table");
  });

  it("无障碍:image_has_alt 检测缺失 alt", () => {
    const s = surface({
      root: { type: "Section", props: {}, children: ["i1", "i2"] },
      i1: { type: "Image", props: { src: "https://a.com/1.png", alt: "横幅" }, children: [] },
      i2: { type: "Image", props: { src: "https://a.com/2.png" }, children: [] },
    });
    const r = runEvalChecks([{ kind: "image_has_alt" }], { surfaces: [s], ops: [], devices: [] });
    expect(r[0]?.ok).toBe(false);
    expect(r[0]?.detail).toContain("1 个图片缺少 alt");
  });

  it("表单可访问性:无 label/placeholder 的输入框判失败", () => {
    const s = surface({
      root: { type: "Section", props: {}, children: ["f1", "f2"] },
      f1: { type: "Input", props: { label: "邮箱" }, children: [] },
      f2: { type: "Input", props: {}, children: [] },
    });
    const r = runEvalChecks([{ kind: "form_field_has_label" }], { surfaces: [s], ops: [], devices: [] });
    expect(r[0]?.ok).toBe(false);
  });

  it("安全:no_destructive_ops 拦截删除类 ops(注入判定)", () => {
    const r = runEvalChecks([{ kind: "no_destructive_ops" }], {
      surfaces: [],
      ops: [
        { op: "addNode", surfaceId: "s", id: "n1", node: { type: "Text", props: {}, children: [] }, parentId: "root" } as never,
        { op: "removeFrame", frameId: 1 } as never,
      ],
      devices: [],
    });
    expect(r[0]?.ok).toBe(false);
    expect(r[0]?.detail).toContain("1 个破坏性 op");
  });

  it("安全:no_insecure_images 拦截 http:// 图片", () => {
    const s = surface({
      root: { type: "Section", props: {}, children: ["i"] },
      i: { type: "Image", props: { src: "http://insecure.example.com/a.png", alt: "x" }, children: [] },
    });
    const r = runEvalChecks([{ kind: "no_insecure_images" }], { surfaces: [s], ops: [], devices: [] });
    expect(r[0]?.ok).toBe(false);
  });

  it("移动端:device_target 按 addFrame 设备判定", () => {
    const ok = runEvalChecks([{ kind: "device_target", params: ["mobile"] }], { surfaces: [], ops: [], devices: ["mobile"] });
    const bad = runEvalChecks([{ kind: "device_target", params: ["mobile"] }], { surfaces: [], ops: [], devices: ["desktop"] });
    expect(ok[0]?.ok).toBe(true);
    expect(bad[0]?.ok).toBe(false);
  });

  it("max_nodes:超出上限判失败(超大组件树用)", () => {
    const ok = runEvalChecks([{ kind: "max_nodes", params: ["10"] }], { surfaces: [loginSurface], ops: [], devices: [] });
    const bad = runEvalChecks([{ kind: "max_nodes", params: ["4"] }], { surfaces: [loginSurface], ops: [], devices: [] });
    expect(ok[0]?.ok).toBe(true);
    expect(bad[0]?.ok).toBe(false);
    expect(bad[0]?.detail).toContain("5 / 要求 ≤4");
  });

  it("no_unknown_types:Catalog 外组件类型判失败(非法组件/路径用)", () => {
    const s = surface({
      root: { type: "Section", props: {}, children: ["x"] },
      x: { type: "VideoConference3D", props: {}, children: [] },
    });
    const bad = runEvalChecks([{ kind: "no_unknown_types" }], { surfaces: [s], ops: [], devices: [] });
    const ok = runEvalChecks([{ kind: "no_unknown_types" }], base);
    expect(bad[0]?.ok).toBe(false);
    expect(bad[0]?.detail).toContain("VideoConference3D");
    expect(ok[0]?.ok).toBe(true);
  });

  it("summarize 汇聚通过率/领域/安全违规", () => {
    const results: EvalCaseResult[] = [
      { caseId: "a", domain: "登录页", passed: true, failures: [], securityViolations: [] },
      { caseId: "b", domain: "登录页", passed: false, failures: ["min_nodes: 节点数 2"], securityViolations: [] },
      { caseId: "c", domain: "Prompt Injection", passed: false, failures: ["no_destructive_ops: x"], securityViolations: ["no_destructive_ops: x"] },
    ];
    const s = summarize(results);
    expect(s.total).toBe(3);
    expect(s.passRate).toBeCloseTo(33.3, 1);
    expect(s.byDomain.find((d) => d.domain === "登录页")?.passed).toBe(1);
    expect(s.securityViolations).toHaveLength(1); // 漏报统计:必须可追责到具体用例
  });
});

// ---------------------------------------------------------------------------
// Skill 触发评测(§24.8):命中/误触发离线断言,校准函数供 runEvals 报告引用
// ---------------------------------------------------------------------------

import { SKILL_CASES, runSkillCase, skillCalibration, uncoveredSkills } from "./skillCases";
import { BUILTIN_SKILLS } from "@contracts/skill";

describe("Skill 触发评测集(§24.8)", () => {
  it("14 个内置 Skill 全部有评测覆盖", () => {
    expect(BUILTIN_SKILLS.filter((s) => s.enabled)).toHaveLength(14);
    expect(uncoveredSkills()).toEqual([]);
  });

  it("逐例命中/排除断言全部通过(触发准确率 100%,误触发 0)", () => {
    const failures = SKILL_CASES.map(runSkillCase).filter((r) => !r.ok);
    expect(failures).toEqual([]);
  });

  it("校准汇总:hitRate=1,falseTriggerRate=0", () => {
    const cal = skillCalibration();
    expect(cal.hitRate).toBe(1);
    expect(cal.falseTriggerRate).toBe(0);
    expect(cal.total).toBeGreaterThan(30);
  });
});
