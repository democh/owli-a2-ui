/**
 * prompt 文件加载的回归测试:占位符必须全部被注入,模块组合顺序与内容完整
 * 修改 prompts/ 下的 .md 后若破坏占位符或模块契约,此测试会失败
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPS_SYSTEM_PROMPT,
  SURFACE_SYSTEM_PROMPT,
  buildCreateUserPrompt,
  buildOpsUserMessage,
  buildRedesignUserPrompt,
  buildSelectedDesc,
  opsJsonRepairMessage,
  opsRepairMessage,
  surfaceRepairMessage,
} from "./prompts";

describe("prompts 文件加载", () => {
  it("系统提示词无残留占位符", () => {
    for (const p of [SURFACE_SYSTEM_PROMPT, OPS_SYSTEM_PROMPT]) {
      expect(p).not.toMatch(/\{\{\w+\}\}/);
      expect(p).toContain("组件 props 速查");
      expect(p).toContain("布局"); // CATALOG_LINES 已注入
    }
  });

  it("模块目录按序组合,每个模块文件都被包含", () => {
    const surfaceDir = path.resolve(process.cwd(), "api/llm/prompts/surface");
    const opsDir = path.resolve(process.cwd(), "api/llm/prompts/ops");
    const moduleFiles = (dir: string) =>
      fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    // 每个模块文件的特征内容都出现在组合结果中
    for (const f of moduleFiles(surfaceDir)) {
      if (f === "08-catalog.md") continue; // 纯占位符,注入后另作断言
      const firstLine = fs.readFileSync(path.join(surfaceDir, f), "utf-8").trim().split("\n")[0];
      expect(SURFACE_SYSTEM_PROMPT, `surface/${f}`).toContain(firstLine.slice(0, 20));
    }
    for (const f of moduleFiles(opsDir)) {
      if (f === "99-catalog.md") continue;
      const firstLine = fs.readFileSync(path.join(opsDir, f), "utf-8").trim().split("\n")[0];
      expect(OPS_SYSTEM_PROMPT, `ops/${f}`).toContain(firstLine.slice(0, 20));
    }
    // 角色模块在最前;组件目录在输出自检之前,自检(含输出纪律)落在末尾
    expect(SURFACE_SYSTEM_PROMPT.startsWith("你是 A2UI 资深页面架构师")).toBe(true);
    expect(SURFACE_SYSTEM_PROMPT.indexOf("组件 props 速查")).toBeLessThan(SURFACE_SYSTEM_PROMPT.indexOf("输出前自检"));
    expect(SURFACE_SYSTEM_PROMPT.trimEnd().endsWith("无任何多余文字")).toBe(true);
    expect(OPS_SYSTEM_PROMPT.startsWith("你是 A2UI 资深页面编辑器")).toBe(true);
    expect(OPS_SYSTEM_PROMPT.trimEnd().endsWith("zap")).toBe(true);
  });

  it("user 模板渲染", () => {
    const create = buildCreateUserPrompt("做个官网", "desktop");
    expect(create).toContain("需求:做个官网");
    expect(create).toContain("设备:desktop");
    expect(buildRedesignUserPrompt("首页", "换成深色", "mobile")).toContain("「首页」");
    expect(buildSelectedDesc(["n3"], () => "Button")).toBe("选中组件:n3(Button)");
    expect(buildSelectedDesc(undefined, () => undefined)).toBe("");
    expect(surfaceRepairMessage("缺 root")).toBe("校验失败:缺 root。只修正上述问题,其余内容保持不变,重新输出完整 JSON。");
    expect(opsRepairMessage("ops 为空")).toBe("ops 校验失败:ops 为空。只修复上述问题,重新输出完整 ops JSON。");
    expect(opsJsonRepairMessage("bad")).toBe("JSON 解析失败:bad。确保输出是完整闭合的严格 JSON,重新输出。");
    const msg = buildOpsUserMessage({
      tokens: { primary: "#000" },
      contextNodes: { n1: {} },
      selectedDesc: "",
      instruction: "改颜色",
    });
    expect(msg).toContain('"primary":"#000"');
    expect(msg).toContain("修改指令:改颜色");
  });
});
