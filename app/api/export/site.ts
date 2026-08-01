/**
 * 工程产物生成:html 静态站点 / react-vite / vue-vite
 */
import type { SurfaceDoc } from "@contracts/a2ui";
import { surfaceToIR } from "./ir";
import { htmlDocument, irToHtml, irToJsx, slugify } from "./serialize";

export interface ExportPage {
  title: string;
  surface: SurfaceDoc;
}
export type ExportTarget = "html" | "react-vite" | "vue-vite";

export interface PageEntry extends ExportPage {
  slug: string;
}

function prepare(pages: ExportPage[]): PageEntry[] {
  const used = new Set<string>();
  return pages.map((p, i) => {
    let slug = slugify(p.title, i);
    while (used.has(slug)) slug = `${slug}-${i + 1}`;
    used.add(slug);
    return { ...p, slug };
  });
}

/**
 * 多页导航互通:把导航类链接文案(Navbar/Footer/侧栏菜单等)映射到对应页面的导出路径。
 * 命中规则:与页面标题精确一致,或去「页/页面」后缀后一致(「定价」↔「定价页」);
 * 未命中的链接保持 href="#" 不变。
 */
export function linkResolver(entries: PageEntry[], hrefOf: (e: PageEntry, index: number) => string) {
  const map = new Map<string, string>();
  const put = (key: string, href: string) => {
    const k = key.trim();
    if (k && !map.has(k)) map.set(k, href);
  };
  entries.forEach((e, i) => put(e.title, hrefOf(e, i)));
  entries.forEach((e, i) => put(e.title.replace(/(?:页面|页)$/, ""), hrefOf(e, i)));
  return (label: string): string | undefined =>
    map.get(label.trim()) ?? map.get(label.trim().replace(/(?:页面|页)$/, ""));
}

// ---------------------------------------------------------------------------
// html:纯静态多页站点
// ---------------------------------------------------------------------------
export function buildHtmlSite(projectName: string, pages: ExportPage[]): Record<string, string> {
  const entries = prepare(pages);
  const resolveLink = linkResolver(entries, (e) => `${e.slug}.html`);
  const files: Record<string, string> = {};
  for (const e of entries) {
    const ir = surfaceToIR(e.surface, { resolveLink });
    const nav = entries.map((n) => ({ href: `${n.slug}.html`, label: n.title, active: n.slug === e.slug }));
    files[`${e.slug}.html`] = htmlDocument(`${e.title} · ${projectName}`, irToHtml(ir, 1), nav);
  }
  files["README.md"] = `# ${projectName}\n\n由 A2UI Studio 导出的静态站点,直接用浏览器打开任意 .html 文件即可预览,或部署到任意静态托管。\n`;
  return files;
}

// ---------------------------------------------------------------------------
// react-vite:React + Vite + TS 工程
// ---------------------------------------------------------------------------
export function buildReactProject(projectName: string, pages: ExportPage[]): Record<string, string> {
  const entries = prepare(pages);
  const files: Record<string, string> = {};

  files["package.json"] = JSON.stringify({
    name: slugify(projectName, 0) || "a2ui-export",
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: { react: "^19.2.0", "react-dom": "^19.2.0", "react-router": "^7.6.1" },
    devDependencies: {
      "@types/react": "^19.2.5", "@types/react-dom": "^19.2.3",
      "@vitejs/plugin-react": "^5.1.1", typescript: "~5.9.3", vite: "^7.2.4",
    },
  }, null, 2);

  files["vite.config.ts"] = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ plugins: [react()] });
`;

  files["tsconfig.json"] = JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true,
    },
    include: ["src"],
  }, null, 2);

  files["index.html"] = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${projectName}</title>
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
`;

  files["src/main.tsx"] = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
`;

  files["src/index.css"] = `* { margin: 0; padding: 0; }
body { -webkit-font-smoothing: antialiased; }
button, a, input, textarea, select { font-family: inherit; }
`;

  const routes = entries.map((e, i) => {
    const comp = componentName(e.slug, i);
    return `        <Route path="${i === 0 ? "/" : `/${e.slug}`}" element={<${comp} />} />`;
  });
  const imports = entries.map((e, i) => `import ${componentName(e.slug, i)} from "./pages/${componentName(e.slug, i)}";`).join("\n");
  const navLinks = entries.map((e, i) => ({ to: i === 0 ? "/" : `/${e.slug}`, label: e.title }));

  files["src/App.tsx"] = `import { Link, Route, Routes } from "react-router";
${imports}

const NAV = ${JSON.stringify(navLinks, null, 2)} as { to: string; label: string }[];

export default function App() {
  return (
    <>
      <Routes>
${routes.join("\n")}
      </Routes>
      {NAV.length > 1 && (
        <nav style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 99, display: "flex", gap: 4, background: "rgba(20,20,25,0.85)", backdropFilter: "blur(8px)", padding: 6, borderRadius: 999, boxShadow: "0 8px 30px rgba(0,0,0,0.25)" }}>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} style={{ padding: "6px 14px", borderRadius: 999, fontSize: 12, textDecoration: "none", color: "rgba(255,255,255,0.8)" }}>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
`;

  const resolveLink = linkResolver(entries, (e, i) => (i === 0 ? "/" : `/${e.slug}`));
  for (const e of entries) {
    const comp = componentName(e.slug, entries.indexOf(e));
    const jsx = irToJsx(surfaceToIR(e.surface, { resolveLink }), 2);
    files[`src/pages/${comp}.tsx`] = `/**
 * ${e.title} —— 由 A2UI Studio 导出
 * 源数据:A2UI SurfaceDoc(组件 ${Object.keys(e.surface.components).length} 个)
 */
export default function ${comp}() {
  return (
${jsx}
  );
}
`;
  }

  files["README.md"] = `# ${projectName}\n\n由 A2UI Studio 导出的 React + Vite 工程。\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`;
  return files;
}

// ---------------------------------------------------------------------------
// vue-vite:Vue 3 + Vite 工程(模板为静态 HTML)
// ---------------------------------------------------------------------------
export function buildVueProject(projectName: string, pages: ExportPage[]): Record<string, string> {
  const entries = prepare(pages);
  const files: Record<string, string> = {};

  files["package.json"] = JSON.stringify({
    name: slugify(projectName, 0) || "a2ui-export",
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: { vue: "^3.5.13", "vue-router": "^4.5.0" },
    devDependencies: { "@vitejs/plugin-vue": "^5.2.1", vite: "^7.2.4" },
  }, null, 2);

  files["vite.config.js"] = `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({ plugins: [vue()] });
`;

  files["index.html"] = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${projectName}</title>
</head>
<body>
<div id="app"></div>
<script type="module" src="/src/main.js"></script>
</body>
</html>
`;

  const routes = entries.map((e, i) => {
    const comp = componentName(e.slug, i);
    return `  { path: "${i === 0 ? "/" : `/${e.slug}`}", component: ${comp} },`;
  });
  const imports = entries.map((e, i) => `import ${componentName(e.slug, i)} from "./pages/${componentName(e.slug, i)}.vue";`).join("\n");

  files["src/main.js"] = `import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
${imports}
import "./index.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
${routes.join("\n")}
  ],
});

createApp(App).use(router).mount("#app");
`;

  files["src/index.css"] = `* { margin: 0; padding: 0; }
body { -webkit-font-smoothing: antialiased; }
button, a, input, textarea, select { font-family: inherit; }
`;

  const navLinks = entries.map((e, i) => ({ to: i === 0 ? "/" : `/${e.slug}`, label: e.title }));
  files["src/App.vue"] = `<script setup>
import { RouterView, RouterLink } from "vue-router";
const NAV = ${JSON.stringify(navLinks, null, 2)};
</script>

<template>
  <RouterView />
  <nav v-if="NAV.length > 1" style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99;display:flex;gap:4px;background:rgba(20,20,25,0.85);backdrop-filter:blur(8px);padding:6px;border-radius:999px;box-shadow:0 8px 30px rgba(0,0,0,0.25)">
    <RouterLink v-for="n in NAV" :key="n.to" :to="n.to"
      style="padding:6px 14px;border-radius:999px;font-size:12px;text-decoration:none;color:rgba(255,255,255,0.8)">
      {{ n.label }}
    </RouterLink>
  </nav>
</template>
`;

  const resolveLink = linkResolver(entries, (e, i) => (i === 0 ? "/" : `/${e.slug}`));
  for (const e of entries) {
    const comp = componentName(e.slug, entries.indexOf(e));
    const html = irToHtml(surfaceToIR(e.surface, { resolveLink }), 1);
    files[`src/pages/${comp}.vue`] = `<!--
  ${e.title} —— 由 A2UI Studio 导出
  源数据:A2UI SurfaceDoc(组件 ${Object.keys(e.surface.components).length} 个)
-->
<template>
${html}
</template>
`;
  }

  files["README.md"] = `# ${projectName}\n\n由 A2UI Studio 导出的 Vue 3 + Vite 工程。\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`;
  return files;
}

function componentName(slug: string, index: number): string {
  const pascal = slug
    .split("-")
    .filter(Boolean)
    .map((s) => (/^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : `P${s}`))
    .join("");
  return pascal || `Page${index + 1}`;
}

export function buildExport(target: ExportTarget, projectName: string, pages: ExportPage[]): Record<string, string> {
  if (target === "react-vite") return buildReactProject(projectName, pages);
  if (target === "vue-vite") return buildVueProject(projectName, pages);
  return buildHtmlSite(projectName, pages);
}
