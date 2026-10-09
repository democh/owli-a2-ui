import { transformSync } from "esbuild";
import { DEVICES, type DeviceId, type SurfaceDoc } from "@contracts/a2ui";
import { resolveInstances, type IRDocument, type IRSurface } from "@contracts/design-ir";
import { surfaceToTsxRuntime, type RuntimeTemplate, type StaticFallback } from "./templates/runtime";
import { antdTemplate } from "./templates/antd-template";
import { shadcnUiTemplate } from "./templates/shadcn-ui-template";

/**
 * Codegen(文档 M5):IR surface → 可构建的静态 React 工程
 *
 * 策略:语义映射 —— Catalog 组件 → 原生元素 + Tailwind 类(不携带 UI 库运行时,
 * 保证产物零依赖可构建);未映射组件降级为 <div data-unknown>。
 * 映射表集中维护,按 Adapter 迭代扩展;M5-2 运行时模板(adapterId=antd/shadcn-ui)
 * 生成真实组件 import + 映射渲染器,默认 shadcn-tailwind 保持静态版零回归。
 */

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface CodegenResult {
  files: GeneratedFile[];
  /** 未映射组件类型清单(导入报告语义) */
  unmapped: { surfaceId: string; type: string }[];
}

// ---------------------------------------------------------------------------
// Catalog type → (tag, className) 语义映射
// ---------------------------------------------------------------------------

type Emit = { tag: string; cls: string; void?: boolean };

/** 语义映射表(静态兜底与 vue 模板共用;§23.3 适配器仅替换表达层) */
const MAP: Record<string, (props: Record<string, unknown>) => Emit> = {
  Section: (p) => ({ tag: "section", cls: `w-full px-6 py-10 ${p.bg ? "" : ""}` }),
  Container: () => ({ tag: "div", cls: "mx-auto max-w-6xl" }),
  Row: () => ({ tag: "div", cls: "flex flex-wrap gap-4" }),
  Col: () => ({ tag: "div", cls: "flex-1 min-w-0" }),
  Grid: (p) => ({ tag: "div", cls: `grid gap-4 ${p.cols ? `grid-cols-${p.cols}` : "grid-cols-3"}` }),
  Card: () => ({ tag: "div", cls: "rounded-xl border bg-white p-4 shadow-sm" }),
  Navbar: () => ({ tag: "header", cls: "flex items-center justify-between border-b px-6 py-3" }),
  Footer: () => ({ tag: "footer", cls: "border-t px-6 py-8 text-sm text-gray-500" }),
  Hero: () => ({ tag: "section", cls: "px-6 py-20 text-center" }),
  Divider: () => ({ tag: "hr", cls: "my-6 border-gray-200", void: true }),
  Title: (p) => ({ tag: `h${clampLevel(p.level)}`, cls: "text-2xl font-semibold tracking-tight" }),
  Text: () => ({ tag: "p", cls: "text-sm leading-relaxed text-gray-600" }),
  Link: (p) => ({ tag: "a", cls: "text-blue-600 underline-offset-2 hover:underline", href: safeHref(p.href) }),
  Badge: () => ({ tag: "span", cls: "inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs" }),
  Tag: () => ({ tag: "span", cls: "inline-block rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700" }),
  Button: (p) => ({ tag: "button", cls: `rounded-lg px-4 py-2 text-sm font-medium ${p.variant === "outline" ? "border" : "bg-gray-900 text-white"}` }),
  Input: (p) => ({ tag: "input", cls: "w-full rounded-lg border px-3 py-2 text-sm", void: true, extra: { placeholder: p.placeholder, type: p.type ?? "text" } }),
  Textarea: (p) => ({ tag: "textarea", cls: "w-full rounded-lg border px-3 py-2 text-sm", extra: { placeholder: p.placeholder } }),
  Image: (p) => ({ tag: "img", cls: "rounded-lg object-cover", void: true, extra: { src: safeHref(p.src) ?? "", alt: p.alt ?? "" } }),
  Avatar: (p) => ({ tag: "img", cls: "size-8 rounded-full object-cover", void: true, extra: { src: safeHref(p.src) ?? "", alt: "" } }),
  List: () => ({ tag: "ul", cls: "divide-y" }),
  ListItem: () => ({ tag: "li", cls: "py-2" }),
  Alert: (p) => ({ tag: "div", cls: `rounded-lg border p-3 text-sm ${p.variant === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-blue-200 bg-blue-50 text-blue-700"}` }),
  Statistic: () => ({ tag: "div", cls: "rounded-xl border p-4" }),
  Progress: (p) => ({ tag: "progress", cls: "w-full", void: true, extra: { value: Number(p.percent ?? 0), max: 100 } }),
  Pagination: () => ({ tag: "nav", cls: "flex items-center gap-1 text-sm" }),
  Breadcrumb: () => ({ tag: "nav", cls: "text-xs text-gray-400" }),
  Table: () => ({ tag: "table", cls: "w-full text-left text-sm" }),
  Empty: () => ({ tag: "div", cls: "py-12 text-center text-sm text-gray-400" }),
  Skeleton: () => ({ tag: "div", cls: "h-4 animate-pulse rounded bg-gray-200" }),
  Chart: () => ({ tag: "div", cls: "flex h-40 items-end gap-2 rounded-xl border p-4" }),
  Tabs: () => ({ tag: "div", cls: "flex gap-4 border-b text-sm" }),
  Switch: () => ({ tag: "button", cls: "h-5 w-9 rounded-full bg-gray-300", void: true }),
  Checkbox: () => ({ tag: "input", cls: "size-4 rounded border", void: true, extra: { type: "checkbox" } }),
  Rating: () => ({ tag: "div", cls: "text-amber-400" }),
  Timeline: () => ({ tag: "ol", cls: "border-l pl-4" }),
  Steps: () => ({ tag: "ol", cls: "flex items-center gap-2 text-xs" }),
  NavLinks: () => ({ tag: "nav", cls: "flex items-center gap-4 text-sm" }),
  SearchBar: () => ({ tag: "input", cls: "w-full rounded-lg border px-3 py-1.5 text-sm", void: true, extra: { type: "search" } }),
  Icon: (p) => ({ tag: "span", cls: "inline-block", extra: { "data-icon": p.name ?? "" } }),
  LogoCloud: () => ({ tag: "div", cls: "flex items-center justify-center gap-8 opacity-60" }),
  FeatureGrid: () => ({ tag: "div", cls: "grid gap-4 md:grid-cols-3" }),
  PricingTable: () => ({ tag: "div", cls: "grid gap-4 md:grid-cols-3" }),
  TestimonialCard: () => ({ tag: "figure", cls: "rounded-xl border p-4" }),
  StatsRow: () => ({ tag: "div", cls: "grid grid-cols-3 gap-4" }),
  CTASection: () => ({ tag: "section", cls: "rounded-2xl bg-gray-900 p-10 text-center text-white" }),
  FAQ: () => ({ tag: "div", cls: "divide-y" }),
  ProductCard: () => ({ tag: "div", cls: "rounded-xl border p-4" }),
  LoginForm: () => ({ tag: "form", cls: "mx-auto max-w-sm space-y-3 rounded-xl border p-6" }),
  Form: () => ({ tag: "form", cls: "space-y-3" }),
  SidebarLayout: () => ({ tag: "div", cls: "flex min-h-screen" }),
  TabBar: () => ({ tag: "nav", cls: "flex justify-around border-t py-2 text-xs" }),
};

function clampLevel(v: unknown): number {
  const n = Number(v);
  return n >= 1 && n <= 6 ? Math.floor(n) : 2;
}

function safeHref(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return /^(https:|data:image\/(png|jpeg|webp|gif);|#|\/)/.test(v) ? v : "#";
}

function escapeText(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/** 主文本 prop(text/label/title/value 优先级) */
function textOf(props: Record<string, unknown>): string {
  for (const k of ["text", "label", "title", "value", "name"]) {
    if (typeof props[k] === "string") return props[k] as string;
  }
  return "";
}

// ---------------------------------------------------------------------------
// surface → TSX
// ---------------------------------------------------------------------------

export function surfaceToTsx(surface: IRSurface, unmapped: CodegenResult["unmapped"]): string {
  const lines: string[] = [];
  const emit = (id: string, depth: number): void => {
    const node = surface.components[id];
    if (!node) return;
    const pad = "  ".repeat(depth + 2);
    const mapper = MAP[node.type];
    if (!mapper) {
      unmapped.push({ surfaceId: surface.id, type: node.type });
      lines.push(`${pad}<div data-unknown="${escapeText(node.type)}">`);
      node.children.forEach((c) => emit(c, depth + 1));
      lines.push(`${pad}</div>`);
      return;
    }
    const e = mapper(node.props ?? {});
    const attrs: string[] = [`className="${e.cls}"`];
    if ("href" in e && e.href) attrs.push(`href="${escapeText(e.href)}"`);
    for (const [k, v] of Object.entries((e as { extra?: Record<string, unknown> }).extra ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      attrs.push(`${k}="${escapeText(v)}"`);
    }
    const text = escapeText(textOf(node.props ?? {}));
    if (e.void) {
      lines.push(`${pad}<${e.tag} ${attrs.join(" ")} />`);
      node.children.forEach((c) => emit(c, depth)); // void 元素的子节点独立输出
      return;
    }
    if (node.children.length === 0) {
      lines.push(`${pad}<${e.tag} ${attrs.join(" ")}>${text}</${e.tag}>`);
    } else {
      lines.push(`${pad}<${e.tag} ${attrs.join(" ")}>`);
      if (text) lines.push(`${pad}  ${text}`);
      node.children.forEach((c) => emit(c, depth + 1));
      lines.push(`${pad}</${e.tag}>`);
    }
  };
  emit(surface.root, 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 工程文件装配
// ---------------------------------------------------------------------------

/** 生成完整可构建工程文件(package.json/vite/tsconfig/入口/页面) */
/** 按 adapterId 解析运行时模板;undefined = 默认 shadcn-tailwind(静态语义映射) */
function resolveTemplate(adapterId?: string): RuntimeTemplate | undefined {
  if (adapterId === "antd") return antdTemplate;
  if (adapterId === "shadcn-ui") return shadcnUiTemplate;
  return undefined;
}

/** 静态兜底:runtime 模板未覆盖的组件沿用 MAP 的 Tailwind 语义映射 */
export function staticFallbackOf(type: string, props: Record<string, unknown>): StaticFallback | undefined {
  const mapper = MAP[type];
  if (!mapper) return undefined;
  const e = mapper(props);
  return {
    comp: e.tag,
    className: e.cls,
    extra: (e as { extra?: Record<string, unknown> }).extra,
    selfClose: e.void,
  };
}

export function generateProject(input: {
  projectName: string;
  doc: IRDocument;
  /** surfaceId → 页面标题(路由与导航) */
  pages: { surfaceId: string; title: string; device: DeviceId }[];
  /** UI 库适配器:shadcn-tailwind(默认,静态)/ antd / shadcn-ui(运行时模板) */
  adapterId?: string;
}): CodegenResult {
  const { projectName, doc: rawDoc, pages } = input;
  const doc = resolveInstances(rawDoc); // M7:组件实例展开后再映射
  const tpl = resolveTemplate(input.adapterId);
  const unmapped: CodegenResult["unmapped"] = [];
  const tokens = doc.theme.tokens;
  const files: GeneratedFile[] = [];

  // 每个页面:PageX.tsx(全大写标识);运行时模板额外聚合组件 import
  const pageFiles = pages.map((p, i) => {
    const surface = doc.surfaces[p.surfaceId];
    let importLine = "";
    let body = "<div />";
    if (tpl && surface) {
      const r = surfaceToTsxRuntime(surface, tpl, staticFallbackOf, unmapped);
      body = r.body;
      const names = [...new Set(r.componentNames)].sort();
      if (names.length) importLine = `import { ${names.join(", ")} } from "${tpl.importSource}";\n`;
    } else {
      body = surface ? surfaceToTsx(surface, unmapped) : "<div />";
    }
    const comp = `Page${i + 1}`;
    const vp = DEVICES[p.device] ?? DEVICES.desktop;
    return {
      comp,
      title: p.title,
      surfaceId: p.surfaceId,
      viewport: vp,
      content: `${importLine}export default function ${comp}() {\n  return (\n    <div className="mx-auto" style={{ maxWidth: ${vp.width} }}>\n${body}\n    </div>\n  );\n}\n`,
    };
  });

  files.push({
    path: "package.json",
    content: JSON.stringify(
      {
        name: projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "a2ui-export",
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", ...(tpl?.extraDependencies ?? {}) },
        devDependencies: {
          "@types/react": "^18.3.12",
          "@types/react-dom": "^18.3.1",
          "@vitejs/plugin-react": "^4.3.4",
          autoprefixer: "^10.4.20",
          postcss: "^8.4.49",
          tailwindcss: "^3.4.17",
          typescript: "^5.6.3",
          vite: "^5.4.11",
        },
      },
      null,
      2,
    ),
  });

  files.push({
    path: "tsconfig.json",
    content: JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
  });

  files.push({
    path: "vite.config.ts",
    content: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
  });

  files.push({
    path: "tailwind.config.js",
    content: `/** @type {import('tailwindcss').Config} */\nexport default { content: ["./index.html", "./src/**/*.{ts,tsx}"], theme: { extend: {} }, plugins: [] };\n`,
  });

  files.push({
    path: "postcss.config.js",
    content: `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`,
  });

  files.push({
    path: "index.html",
    content: `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${escapeText(projectName)}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
  });

  files.push({
    path: "src/index.css",
    content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  --a2-primary: ${tokens.primary};\n  --a2-background: ${tokens.background};\n  --a2-surface: ${tokens.surface};\n  --a2-text: ${tokens.text};\n  --a2-muted: ${tokens.mutedText};\n  --a2-accent: ${tokens.accent};\n  --a2-radius: ${tokens.radius}px;\n}\n\nbody { background: var(--a2-background); color: var(--a2-text); font-family: system-ui, sans-serif; }\n`,
  });

  files.push({
    path: "src/main.tsx",
    content: `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n\nReactDOM.createRoot(document.getElementById("root")!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
  });

  const nav = pageFiles
    .map((p) => `        <a href="#/${encodeURIComponent(p.surfaceId)}" className="text-sm text-gray-500 hover:text-gray-900">${escapeText(p.title)}</a>`)
    .join("\n");
    // 路由条件内联到各自表达式,不引用 map 索引(esbuild 语法层查不出,完整门禁 tsc 会拦)
  const routes = pageFiles
    .map((p, i) => {
      const h = `#/${encodeURIComponent(p.surfaceId)}`;
      const cond = i === 0 ? `!hash || hash === "${h}"` : `hash === "${h}"`;
      return `      {${cond} ? <${p.comp} /> : null}`;
    })
    .join("\n");
  const imports = pageFiles.map((p) => `import ${p.comp} from "./pages/${p.comp}";`).join("\n");

  files.push({
    path: "src/App.tsx",
    content: `${imports}\n\nexport default function App() {\n  const hash = typeof window !== "undefined" ? window.location.hash : "";\n  return (\n    <div>\n      <nav className="border-b px-6 py-3">\n        <div className="mx-auto flex max-w-6xl items-center gap-6">\n          <span className="font-semibold">${escapeText(projectName)}</span>\n${nav}\n        </div>\n      </nav>\n${routes}\n    </div>\n  );\n}\n`,
  });

  for (const p of pageFiles) {
    files.push({ path: `src/pages/${p.comp}.tsx`, content: p.content });
  }

  // 运行时模板注入文件(组件包装层;按路径去重)
  for (const tf of tpl?.templateFiles ?? []) {
    if (!files.some((f) => f.path === tf.path)) files.push({ path: tf.path, content: tf.content });
  }

  return { files, unmapped };
}

/** TSX 语法合法性检查(esbuild transformSync;构建门禁的快速层) */
export function validateGeneratedFiles(files: GeneratedFile[]): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  for (const f of files) {
    if (!/\.(tsx|ts)$/.test(f.path)) continue;
    try {
      transformSync(f.content, { loader: f.path.endsWith(".tsx") ? "tsx" : "ts" });
    } catch (e) {
      errors.push({ path: f.path, message: (e as Error).message.slice(0, 300) });
    }
  }
  return errors;
}

/** 兼容旧调用:单 SurfaceDoc(测试用) */
export function surfaceDocToTsx(doc: SurfaceDoc): string {
  const surface: IRSurface = { id: doc.page.id, title: doc.page.title, components: doc.components, root: doc.root };
  return surfaceToTsx(surface, []);
}
