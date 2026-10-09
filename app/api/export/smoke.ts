import http from "http";
import path from "path";

/**
 * 构建门禁 smoke 层(可选,默认关闭:env BUILD_GATE_SMOKE=1)
 *
 * puppeteer-core 打开 vite build 产物页面,断言:
 *  - 页面可加载(dist/index.html 200)
 *  - 无 console error / pageerror
 * 依赖本地 Chrome,通过 CHROME_PATH 指定可执行文件路径。
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

/** 极简静态服务:仅服务 smoke 用途,请求结束即关 */
function serveStatic(root: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const file = path.resolve(root, rel);
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      import("fs").then(({ readFileSync, existsSync, statSync }) => {
        if (!existsSync(file) || !statSync(file).isFile()) {
          // SPA 兜底:未命中文件回 index.html
          const indexHtml = path.join(root, "index.html");
          if (existsSync(indexHtml)) {
            res.writeHead(200, { "content-type": MIME[".html"] }).end(readFileSync(indexHtml));
          } else {
            res.writeHead(404).end();
          }
          return;
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" }).end(readFileSync(file));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

export async function smokeTestDist(workDir: string): Promise<{ ok: boolean; detail: string }> {
  const dist = path.join(workDir, "dist");
  const chromePath = process.env.CHROME_PATH;
  if (!chromePath) {
    return { ok: false, detail: "未配置 CHROME_PATH,无法执行 smoke(不影响构建结果)" };
  }
  const { default: puppeteer } = await import("puppeteer-core");

  const server = await serveStatic(dist);
  const errors: string[] = [];
  try {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });
      page.on("pageerror", (err: unknown) => errors.push(`pageerror: ${err instanceof Error ? err.message : String(err)}`));
      await page.goto(server.url, { waitUntil: "networkidle2", timeout: 20_000 });
      const hasRoot = await page.$("#root");
      if (!hasRoot) errors.push("挂载点 #root 不存在");
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
  return errors.length === 0
    ? { ok: true, detail: "页面加载正常,无 console error" }
    : { ok: false, detail: errors.slice(0, 10).join("; ").slice(0, 1000) };
}
