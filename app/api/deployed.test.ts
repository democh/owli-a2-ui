/**
 * 部署产物静态托管路由回归测试
 * 覆盖:中文(CJK)文件名访问 / percent-encoded 文件名 / 默认 index.html
 *      / 明文与编码(%2e%2e)路径穿越防护
 * 背景:曾因文件名校验正则仅允许 ASCII,导致所有中文标题页面部署后 404
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import app from "./boot";

const PID = "99999";
const SLUG = "t1";
const ROOT = path.resolve(process.cwd(), "data", "deploys", PID, SLUG);

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(path.join(ROOT, "index.html"), "<h1>首页索引</h1>");
  writeFileSync(path.join(ROOT, "首页.html"), "<h1>中文页面</h1>");
  writeFileSync(path.join(ROOT, "浮石-企业工作流自动化平台.html"), "<h1>测试通过</h1>");
});

afterAll(() => {
  rmSync(path.resolve(process.cwd(), "data", "deploys", PID), { recursive: true, force: true });
});

describe("deployed 静态托管", () => {
  it("默认返回 index.html", async () => {
    const res = await app.request(`/deployed/${PID}/${SLUG}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("首页索引");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("percent-encoded 中文文件名可访问(回归:曾 404)", async () => {
    const res = await app.request(`/deployed/${PID}/${SLUG}/${encodeURIComponent("首页.html")}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("中文页面");
  });

  it("长中文 slug 文件名可访问", async () => {
    const res = await app.request(
      `/deployed/${PID}/${SLUG}/${encodeURIComponent("浮石-企业工作流自动化平台.html")}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("测试通过");
  });

  it("拒绝明文路径穿越", async () => {
    const res = await app.request(`/deployed/${PID}/${SLUG}/../../app.db`);
    expect(res.status).toBe(404);
  });

  it("拒绝编码路径穿越(%2e%2e)", async () => {
    const res = await app.request(`/deployed/${PID}/${SLUG}/..%2f..%2fapp.db`);
    expect(res.status).toBe(404);
  });

  it("拒绝非法 slug / projectId", async () => {
    expect((await app.request(`/deployed/abc/${SLUG}/`)).status).toBe(404);
    expect((await app.request(`/deployed/${PID}/bad slug!/`)).status).toBe(404);
  });
});
