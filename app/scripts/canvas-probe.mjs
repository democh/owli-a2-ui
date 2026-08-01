/* 探针:选中态下空白处 elementFromPoint */
import puppeteer from "puppeteer-core";

const BASE = "http://localhost:3000";
const createResp = await fetch(`${BASE}/api/trpc/projects.create?batch=1`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ "0": { json: { name: "探针", preset: "shadcn" } } }),
});
const projectId = (await createResp.json())[0].result.data.json.id;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await page.goto(`${BASE}/project/${projectId}`, { waitUntil: "networkidle0" });
await page.waitForSelector(".a2-frame");
await new Promise((r) => setTimeout(r, 1500));

// 选中 frame
const fr = await page.$eval(".a2-frame", (el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));
await page.mouse.click(fr.x + fr.width / 2, fr.y + 20);
await new Promise((r) => setTimeout(r, 400));

const v = await page.$eval(".a2-viewer", (el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));
const f = (await page.$eval(".a2-frame", (el) => JSON.parse(JSON.stringify(el.getBoundingClientRect()))));
let x = v.x + 60, y = v.y + 60;
if (x > f.x - 10 && x < f.x + f.width + 10 && y > f.y - 10 && y < f.y + f.height + 10) { x = f.x + f.width + 80; y = f.y + f.height + 80; }
x = Math.min(x, v.x + v.width - 60); y = Math.min(y, v.y + v.height - 60);
console.log("空白点:", Math.round(x), Math.round(y));

console.log("命中链:", await page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  const chain = [];
  let cur = el;
  while (cur && chain.length < 7) { chain.push(`${cur.tagName}.${String(cur.className).slice(0, 45)}`); cur = cur.parentElement; }
  return chain.join(" <- ");
}, [x, y]));

// 监听 content div 的 click 是否触发
await page.evaluate(() => {
  window.__clicks = [];
  document.querySelector(".a2-viewer .relative").addEventListener("click", (e) => {
    window.__clicks.push(`target=${String(e.target.className).slice(0, 40)} current=${String(e.currentTarget.className).slice(0, 40)} same=${e.target === e.currentTarget}`);
  }, true);
});
await page.mouse.click(x, y);
await new Promise((r) => setTimeout(r, 300));
console.log("click 事件:", await page.evaluate(() => window.__clicks.join(" | ") || "(未触发)"));

await browser.close();
await fetch(`${BASE}/api/trpc/projects.remove?batch=1`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ "0": { json: { id: projectId } } }),
});
