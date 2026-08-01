/* 复验 v2:坐标基于画布实际区域 */
import puppeteer from "puppeteer-core";

const BASE = "http://localhost:3000";
const createResp = await fetch(`${BASE}/api/trpc/projects.create?batch=1`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ "0": { json: { name: "复验", preset: "shadcn" } } }),
});
const projectId = (await createResp.json())[0].result.data.json.id;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto(`${BASE}/project/${projectId}`, { waitUntil: "networkidle0" });
await page.waitForSelector(".a2-frame");
await new Promise((r) => setTimeout(r, 1500));

const geom = () => page.$eval(".a2-frame", (el) => ({
  left: el.style.left, top: el.style.top, width: el.style.width,
  border: getComputedStyle(el.firstElementChild).borderColor,
  rect: JSON.parse(JSON.stringify(el.getBoundingClientRect())),
}));
const viewerRect = () => page.$eval(".a2-viewer", (el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));
// 画布内的一个空白点(不在 frame 上)
async function emptyPoint() {
  const v = await viewerRect();
  const f = (await geom()).rect;
  // 候选:画布左上角向内 60px
  let x = v.x + 60, y = v.y + 60;
  if (x > f.x - 10 && x < f.x + f.width + 10 && y > f.y - 10 && y < f.y + f.height + 10) {
    x = f.x + f.width + 80; y = f.y + f.height + 80; // frame 右下侧
  }
  return [Math.min(x, v.x + v.width - 60), Math.min(y, v.y + v.height - 60)];
}
const INDIGO = "rgb(99, 102, 241)";

// 1. 点选
let g = await geom();
await page.mouse.click(g.rect.x + g.rect.width / 2, g.rect.y + 20);
await new Promise((r) => setTimeout(r, 400));
g = await geom();
console.log("1 点选:", g.border === INDIGO ? "✅" : `❌ ${g.border}`);

// 2. 拖拽 frame
await page.mouse.move(g.rect.x + g.rect.width / 2, g.rect.y + 20);
await page.mouse.down();
await page.mouse.move(g.rect.x + g.rect.width / 2 + 90, g.rect.y + 20 + 60, { steps: 8 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 800));
g = await geom();
console.log("2 拖拽 frame:", g.left !== "0px" ? `✅ left=${g.left} top=${g.top}` : "❌");

// 3. 缩放
const se = await page.$('[data-direction="se"]');
if (se) {
  const hb = await se.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 45, hb.y + hb.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 800));
  g = await geom();
  console.log("3 缩放:", parseFloat(g.width) > 1440 ? `✅ width=${g.width}` : `❌ width=${g.width}`);
} else console.log("3 缩放: ❌ 无手柄");

// 4. 空白处左键拖拽 = 平移
const before = await geom();
const [ex, ey] = await emptyPoint();
await page.mouse.move(ex, ey);
await page.mouse.down();
await page.mouse.move(ex - 200, ey - 120, { steps: 10 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 500));
const after = await geom();
const screenMoved = Math.abs(after.rect.x - before.rect.x) > 50 || Math.abs(after.rect.y - before.rect.y) > 50;
const contentSame = after.left === before.left && after.top === before.top;
console.log("4 空白拖拽平移:", screenMoved && contentSame ? `✅ 屏幕位移(${Math.round(after.rect.x - before.rect.x)},${Math.round(after.rect.y - before.rect.y)})` : `❌ screenMoved=${screenMoved} contentSame=${contentSame} (起点 ${Math.round(ex)},${Math.round(ey)})`);

// 5. Shift+拖拽框选
const fr = (await geom()).rect;
await page.keyboard.down("Shift");
await page.mouse.move(fr.x - 30, fr.y - 30);
await page.mouse.down();
await page.mouse.move(fr.x + fr.width + 30, fr.y + fr.height + 30, { steps: 8 });
await page.mouse.up();
await page.keyboard.up("Shift");
await new Promise((r) => setTimeout(r, 400));
g = await geom();
console.log("5 Shift 框选:", g.border === INDIGO ? "✅" : `❌ ${g.border}`);

// 6. 空白单击清空
const [cx2, cy2] = await emptyPoint();
await page.mouse.click(cx2, cy2);
await new Promise((r) => setTimeout(r, 400));
g = await geom();
console.log("6 空白单击清空:", g.border !== INDIGO ? "✅" : "❌ 仍选中");

// 7. 平移后再点选
const [px, py] = await emptyPoint();
await page.mouse.move(px, py);
await page.mouse.down();
await page.mouse.move(px - 60, py - 40, { steps: 5 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 300));
const fr2 = (await geom()).rect;
await page.mouse.click(fr2.x + fr2.width / 2, fr2.y + 20);
await new Promise((r) => setTimeout(r, 400));
g = await geom();
console.log("7 平移后点选:", g.border === INDIGO ? "✅" : `❌ ${g.border}`);

await browser.close();
await fetch(`${BASE}/api/trpc/projects.remove?batch=1`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ "0": { json: { id: projectId } } }),
});
