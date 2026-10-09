import { describe, expect, it } from "vitest";
import { validateSkillManifest } from "./validate";

/** Skill 沙箱校验测试(M7 Marketplace):结构/硬权限边界/资源上限 */
const BASE = {
  id: "marketing-landing",
  name: "营销落地页",
  version: "1.0.0",
  publisher: "acme-studio",
  trust: "third_party",
  description: "落地页最佳实践",
  triggers: { intents: ["create_page"], pageTypes: [], keywords: ["落地页"] },
  compatibleAdapters: [],
  capabilities: { promptFragments: ["marketing-landing"], rules: ["首屏一个主 CTA"], recommendedQuestions: [] },
  permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
  limits: { maxContextTokens: 4000, maxIssues: 50 },
  enabled: true,
};

describe("validateSkillManifest(沙箱校验)", () => {
  it("合法第三方 manifest 通过并返回规范化 manifest", () => {
    const v = validateSkillManifest(JSON.stringify(BASE));
    expect(v.ok).toBe(true);
    expect(v.manifest?.id).toBe("marketing-landing");
  });

  it("硬边界:commitDesign=true 被拒绝(Skill 永远不能提交 IR)", () => {
    const v = validateSkillManifest({ ...BASE, permissions: { ...BASE.permissions, commitDesign: true } });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("commitDesign"))).toBe(true);
  });

  it("硬边界:network=true 被拒绝(Skill 永远不能联网)", () => {
    const v = validateSkillManifest({ ...BASE, permissions: { ...BASE.permissions, network: true } });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("network"))).toBe(true);
  });

  it("第三方必须显式 publisher;id 仅允许小写字母/数字/连字符", () => {
    const noPub = validateSkillManifest({ ...BASE, publisher: "internal" });
    expect(noPub.ok).toBe(false);
    const badId = validateSkillManifest({ ...BASE, id: "Evil_Id;DROP" });
    expect(badId.ok).toBe(false);
    expect(badId.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("资源上限:rules 超量与 maxContextTokens 超限被拒绝", () => {
    const manyRules = validateSkillManifest({
      ...BASE,
      capabilities: { ...BASE.capabilities, rules: Array.from({ length: 21 }, (_, i) => `r${i}`) },
    });
    expect(manyRules.ok).toBe(false);
    const bigCtx = validateSkillManifest({ ...BASE, limits: { maxContextTokens: 9000, maxIssues: 50 } });
    expect(bigCtx.ok).toBe(false);
  });

  it("坏 JSON 与结构缺失给出可读错误", () => {
    expect(validateSkillManifest("{not json").ok).toBe(false);
    const v = validateSkillManifest({});
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});
