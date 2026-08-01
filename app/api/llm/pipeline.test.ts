/**
 * pipeline 意图路由(runAnalyze → route)表驱动测试
 * route() 的正则意图识别是最易回归的部分:改一个关键词就可能改变生成路径
 */
import { describe, expect, it } from "vitest";
import type { PresetId, SurfaceDoc } from "@contracts/a2ui";
import { DEFAULT_TOKENS, sitemapSchema } from "@contracts/a2ui";
import { looksLikeSite, runAnalyze, type PipelineInput } from "./pipeline";

const surface: SurfaceDoc = {
  version: "1.0",
  page: { id: "p", title: "首页", device: "desktop" },
  theme: { preset: "shadcn", tokens: DEFAULT_TOKENS },
  components: { n1: { type: "Col", props: {}, children: [] } },
  root: "n1",
};

function page(id: number, title: string): PipelineInput["pages"][number] {
  return { id, title, device: "desktop", posX: 0, posY: 0, width: 1440, height: 900, surface };
}

function input(overrides: Partial<PipelineInput>): PipelineInput {
  return {
    prompt: "",
    chips: [],
    projectPreset: "shadcn" as PresetId,
    pages: [],
    llm: null,
    ...overrides,
  };
}

describe("route:create 新建页面", () => {
  it("无页面、无选中 → create", () => {
    const r = runAnalyze(input({ prompt: "生成一个营销落地页" }));
    expect(r.mode).toBe("create");
    expect(r.intentLabel).toBe("生成新页面");
  });

  it("设备关键词 → create + contextSummary 含 mobile", () => {
    const r = runAnalyze(input({ prompt: "生成手机版首页" }));
    expect(r.mode).toBe("create");
    expect(r.contextSummary).toContain("mobile");
  });

  it("有页面但无编辑意图、无选中 → create(不误判为改最后一页)", () => {
    const r = runAnalyze(input({ prompt: "再生成一个定价页", pages: [page(1, "首页")] }));
    expect(r.mode).toBe("create");
  });
});

describe("route:edit 编辑页面", () => {
  it("编辑意图关键词 → 改最后一页", () => {
    const r = runAnalyze(input({ prompt: "把标题改成欢迎光临", pages: [page(1, "首页"), page(2, "定价")] }));
    expect(r.mode).toBe("edit");
    expect(r.targetTitle).toBe("定价");
  });

  it("page chip 指定目标页", () => {
    const r = runAnalyze(input({
      prompt: "重新设计",
      pages: [page(1, "首页"), page(2, "定价")],
      chips: [{ kind: "page", pageId: "1", title: "首页" }],
    }));
    expect(r.mode).toBe("edit");
    expect(r.targetTitle).toBe("首页");
  });

  it("element chips → edit + contextSummary 含组件数", () => {
    const r = runAnalyze(input({
      prompt: "改成红色",
      pages: [page(1, "首页")],
      chips: [
        { kind: "element", pageId: "1", aid: "n5", label: "首页 · Button#n5" },
        { kind: "element", pageId: "1", aid: "n8", label: "首页 · Title#n8" },
      ],
    }));
    expect(r.mode).toBe("edit");
    expect(r.contextSummary).toContain("2 个组件");
  });
});

describe("route:preset 切换风格", () => {
  it("换风格关键词 → preset 模式", () => {
    const r = runAnalyze(input({ prompt: "换成 Ant Design 风格" }));
    expect(r.mode).toBe("preset");
    expect(r.intentLabel).toContain("Ant Design");
  });

  it("目标风格与当前相同 → 不走 preset(走 create/edit)", () => {
    const r = runAnalyze(input({ prompt: "换成 shadcn 风格", projectPreset: "shadcn" }));
    expect(r.mode).not.toBe("preset");
  });

  it("选中了页面时换风格 → 优先 edit 而非 preset", () => {
    const r = runAnalyze(input({
      prompt: "换成 antd 风格",
      pages: [page(1, "首页")],
      chips: [{ kind: "page", pageId: "1", title: "首页" }],
    }));
    expect(r.mode).toBe("edit");
  });
});

describe("looksLikeSite 两段式站点生成信号", () => {
  it.each([
    "生成落地页+定价页+关于我们,一套",
    "做一个企业官网",
    "帮我建一个 SaaS 产品网站",
    "生成手机版整套",
    "做一套后台,三个页面",
    "页面包括首页、定价和联系页",
  ])("命中: %s", (prompt) => {
    expect(looksLikeSite(prompt)).toBe(true);
  });

  it.each([
    "生成一个营销落地页",
    "做一个数据看板",
    "生成移动端 App 首页",
    "再生成一个定价页",
  ])("不命中: %s", (prompt) => {
    expect(looksLikeSite(prompt)).toBe(false);
  });
});

describe("sitemapSchema", () => {
  const valid = {
    pages: [
      { title: "首页", purpose: "品牌展示与转化" },
      { title: "定价", purpose: "三档套餐对比" },
    ],
    nav: ["首页", "定价"],
  };

  it("合法结构通过", () => {
    expect(sitemapSchema.safeParse(valid).success).toBe(true);
  });

  it("nav 为空数组不通过", () => {
    expect(sitemapSchema.safeParse({ ...valid, nav: [] }).success).toBe(false);
  });

  it("页面超过 6 个不通过(防失控)", () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({ title: `页${i + 1}`, purpose: "x" }));
    expect(sitemapSchema.safeParse({ pages, nav: ["页1"] }).success).toBe(false);
  });

  it("缺 purpose 不通过", () => {
    const bad = { pages: [{ title: "首页" }], nav: ["首页"] };
    expect(sitemapSchema.safeParse(bad).success).toBe(false);
  });
});
