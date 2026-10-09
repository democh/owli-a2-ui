#!/usr/bin/env node
/**
 * 视觉回归(M6,文档 §21.4"E2E 和视觉回归"交付项)
 *
 * 对 /render 渲染页的四个预设样例逐像素对比上次基线:
 *   截图 → data/visual-baseline/<name>.png(无基线时首跑生成)
 *   对比 → pixelmatch 差异像素占比 ≤ 阈值(默认 5%)视为通过
 *   差异图 → data/visual-diff/<name>.png
 *
 * 注意:页面含 SSE 长连接,waitUntil 必须用 "load"(networkidle 永不空闲)。
 *
 * 运行:npm run test:visual [-- --base http://localhost:5173] [--threshold 0.05]
 * 环境要求:CHROME_PATH(默认 macOS Chrome 路径),服务已在 BASE 启动。
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:5173";
const THRESHOLD = args.includes("--threshold") ? Number(args[args.indexOf("--threshold") + 1]) : 0.05;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ROOT = path.resolve(process.cwd(), "data");
const BASELINE_DIR = path.join(ROOT, "visual-baseline");
const DIFF_DIR = path.join(ROOT, "visual-diff");
mkdirSync(BASELINE_DIR, { recursive: true });
mkdirSync(DIFF_DIR, { recursive: true });

/** 样例页:/render?demo=<preset> 需要服务端提供;若无 demo 端点则回退渲染预设静态样例页 */
const SAMPLES = [
  { name: "render-shadcn", url: `${BASE}/render?preset=shadcn&demo=1` },
  { name: "render-antd", url: `${BASE}/render?preset=antd&demo=1` },
  { name: "render-element", url: `${BASE}/render?preset=element&demo=1` },
  { name: "render-custom", url: `${BASE}/render?preset=custom&demo=1` },
];

let failures = 0;

function compare(name, currentBuf) {
  const baselinePath = path.join(BASELINE_DIR, `${name}.png`);
  const diffPath = path.join(DIFF_DIR, `${name}.png`);
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, currentBuf);
    console.log(`🆕 ${name}:首跑,已生成基线(${baselinePath})`);
    return;
  }
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const current = PNG.sync.read(currentBuf);
  if (baseline.width !== current.width || baseline.height !== current.height) {
    console.log(`❌ ${name}:尺寸变化 ${baseline.width}×${baseline.height} → ${current.width}×${current.height}(布局回归)`);
    failures++;
    return;
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, baseline.width, baseline.height, { threshold: 0.1 });
  const ratio = diffPixels / (baseline.width * baseline.height);
  if (ratio > THRESHOLD) {
    writeFileSync(diffPath, PNG.sync.write(diff));
    console.log(`❌ ${name}:差异像素 ${(ratio * 100).toFixed(2)}% > 阈值 ${(THRESHOLD * 100).toFixed(1)}%,差异图:${diffPath}`);
    failures++;
  } else {
    console.log(`✅ ${name}:差异 ${(ratio * 100).toFixed(2)}%(阈值内)`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  for (const s of SAMPLES) {
    try {
      await page.goto(s.url, { waitUntil: "load", timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 1500)); // 等渲染稳定(字体/懒加载)
      const buf = await page.screenshot({ type: "png" });
      compare(s.name, buf);
    } catch (e) {
      console.log(`❌ ${s.name}:截图失败 ${e.message.slice(0, 120)}`);
      failures++;
    }
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.log(`\n视觉回归:${failures} 项失败;确认变更有意后,删除 data/visual-baseline/ 对应基线重新生成。`);
  process.exit(1);
}
console.log("\n视觉回归:全部通过。");
