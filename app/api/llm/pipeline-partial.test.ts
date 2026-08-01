/**
 * 两段式站点生成「部分成功」回归测试
 * 核心契约:单页失败不拖垮整批 —— 成功页照常交付 createPage actions,
 * 失败页在步骤条留下 error 步骤、在结论文本中明示;全部失败才整体抛错;
 * 用户主动停止(AbortError)则整批中止,不做部分交付
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SurfaceDoc } from "@contracts/a2ui";
import { DEFAULT_TOKENS } from "@contracts/a2ui";

vi.mock("./kimi", () => ({
  kimiGenerateSitemap: vi.fn(),
  kimiGenerateSurfaces: vi.fn(),
  kimiGenerateOps: vi.fn(),
}));

import { kimiGenerateSitemap, kimiGenerateSurfaces } from "./kimi";
import { runPipeline, type PipelineInput } from "./pipeline";

const sitemapMock = vi.mocked(kimiGenerateSitemap);
const surfacesMock = vi.mocked(kimiGenerateSurfaces);

function surface(title: string): SurfaceDoc {
  return {
    version: "1.0",
    page: { id: "p", title, device: "desktop" },
    theme: { preset: "shadcn", tokens: DEFAULT_TOKENS },
    components: { n1: { type: "Col", props: {}, children: [] } },
    root: "n1",
  };
}

const SITE_INPUT: PipelineInput = {
  prompt: "帮我做一个产品官网,包括首页、定价、关于我们",
  chips: [],
  projectPreset: "shadcn",
  pages: [],
  // 不传 projectId:recordLlmCall 直接跳过,测试不触 DB
  llm: { provider: "kimi", apiKey: "test-key", baseUrl: "https://api.example.com", model: "kimi-k2" },
};

const SITEMAP = {
  pages: [
    { title: "首页", purpose: "品牌展示与转化入口" },
    { title: "定价", purpose: "三档价格对比" },
    { title: "关于", purpose: "团队与公司介绍" },
  ],
  nav: ["首页", "定价", "关于"],
};

beforeEach(() => {
  vi.clearAllMocks();
  sitemapMock.mockResolvedValue(SITEMAP);
});

/**
 * 页级失败判定锚点:每页 prompt 都内嵌全量 sitemap JSON(含所有页标题),
 * 只有「本次生成」行标识当前页,必须按它区分,避免误伤全部页面
 */
const CURRENT_PAGE = (title: string) => new RegExp(`本次生成[^\n]*「${title}」`);

describe("twoPhaseSite 部分成功", () => {
  it("单页失败:成功页照常交付,步骤条与结论明示失败页", async () => {
    surfacesMock.mockImplementation(async (_cfg, prompt, _onToken, onUsage) => {
      onUsage?.({ promptTokens: 100, completionTokens: 2000 });
      if (CURRENT_PAGE("定价").test(prompt)) throw new Error("模型服务限流(HTTP 429),请稍后重试");
      return [surface("占位")];
    });

    const result = await runPipeline(SITE_INPUT);

    // 成功 2 页交付,失败页不产生 action
    expect(result.actions).toHaveLength(2);
    const titles = result.actions.map((a) => (a.type === "createPage" ? a.title : ""));
    expect(titles).toEqual(["首页", "关于"]);

    // 结论文本明示失败页与补救指引
    expect(result.assistantText).toContain("定价");
    expect(result.assistantText).toContain("生成失败");
    expect(result.assistantText).toContain("其余页面已保留");

    // 步骤条:失败页留下 error 步骤,成功页 done 且带 token 用量详情
    const failed = result.steps.find((s) => s.status === "error" && s.label.includes("定价"));
    expect(failed).toBeDefined();
    expect(failed!.detail).toContain("限流");
    const ok = result.steps.find((s) => s.status === "done" && s.label.includes("首页"));
    expect(ok).toBeDefined();
    expect(ok!.detail).toContain("tokens");
  });

  it("全部失败:整体抛错(首个失败原因),与单段式行为一致", async () => {
    surfacesMock.mockRejectedValue(new Error("模型服务暂时不可用(HTTP 500),请稍后重试"));

    await expect(runPipeline(SITE_INPUT)).rejects.toThrow("暂时不可用");
  });

  it("用户主动停止:AbortError 整批中止,不做部分交付", async () => {
    surfacesMock.mockImplementation(async (_cfg, prompt) => {
      if (CURRENT_PAGE("定价").test(prompt)) {
        const e = new Error("已停止生成");
        e.name = "AbortError";
        throw e;
      }
      return [surface("占位")];
    });

    await expect(runPipeline(SITE_INPUT)).rejects.toMatchObject({ name: "AbortError" });
  });
});
