import { transformSync } from "esbuild";
import { DEVICES, type DeviceId } from "@contracts/a2ui";
import { resolveInstances, type IRDocument, type IRSurface } from "@contracts/design-ir";
import type { GeneratedFile, CodegenResult } from "../codegen";
import { staticFallbackOf } from "../codegen";

/**
 * Vue 3 导出模板(M7,experimental):IR surface → Vue 3 SFC 工程
 *
 * 策略与 React 静态版一致:Catalog 组件 → 原生元素 + Tailwind 类(零 UI 库运行时);
 * 语义映射复用 codegen 的 MAP(className → class),未映射组件降级 <div data-unknown>。
 * 门禁:vite build(experimental 档跳过 tsc;组件为纯模板,无类型面)。
 */

function escapeText(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

function textOf(props: Record<string, unknown>): string {
  for (const k of ["text", "label", "title", "value", "name"]) {
    if (typeof props[k] === "string") return props[k] as string;
  }
  return "";
}

/** surface → Vue template body(class 语义;void/自闭合与 React 版同构) */
export function surfaceToVueTemplate(surface: IRSurface, unmapped: CodegenResult["unmapped"]): string {
  const lines: string[] = [];
  const emit = (id: string, depth: number): void => {
    const node = surface.components[id];
    if (!node) return;
    const pad = "  ".repeat(depth + 2);
    const fb = staticFallbackOf(node.type, node.props ?? {});
    if (!fb) {
      unmapped.push({ surfaceId: surface.id, type: node.type });
      lines.push(`${pad}<div data-unknown="${escapeText(node.type)}">`);
      node.children.forEach((c) => emit(c, depth + 1));
      lines.push(`${pad}</div>`);
      return;
    }
    const attrs = [`class="${escapeText(fb.className)}"`];
    for (const [k, v] of Object.entries(fb.extra ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      attrs.push(`${k}="${escapeText(v)}"`);
    }
    const text = escapeText(textOf(node.props ?? {}));
    if (fb.selfClose) {
      lines.push(`${pad}<${fb.comp} ${attrs.join(" ")} />`);
      node.children.forEach((c) => emit(c, depth)); // void 元素的子节点独立输出
      return;
    }
    if (node.children.length === 0) {
      lines.push(`${pad}<${fb.comp} ${attrs.join(" ")}>${text}</${fb.comp}>`);
    } else {
      lines.push(`${pad}<${fb.comp} ${attrs.join(" ")}>`);
      if (text) lines.push(`${pad}  ${text}`);
      node.children.forEach((c) => emit(c, depth + 1));
      lines.push(`${pad}</${fb.comp}>`);
    }
  };
  emit(surface.root, 0);
  return lines.join("\n");
}

/** 生成完整可构建 Vue 3 工程(package.json/vite/入口/SFC 页面) */
export function generateVueProject(input: {
  projectName: string;
  doc: IRDocument;
  pages: { surfaceId: string; title: string; device: DeviceId }[];
  /** 兼容签名;vue3 模板忽略 UI 库运行时 */
  adapterId?: string;
}): CodegenResult {
  void input.adapterId;
  const { projectName, doc: rawDoc, pages } = input;
  const doc = resolveInstances(rawDoc); // M7:组件实例展开后再映射
  const unmapped: CodegenResult["unmapped"] = [];
  const tokens = doc.theme.tokens;
  const files: GeneratedFile[] = [];

  const pageFiles = pages.map((p, i) => {
    const surface = doc.surfaces[p.surfaceId];
    let body = "<div />";
    if (surface) {
      body = surfaceToVueTemplate(surface, unmapped);
    }
    const comp = `Page${i + 1}`;
    const vp = DEVICES[p.device] ?? DEVICES.desktop;
    return {
      comp,
      title: p.title,
      surfaceId: p.surfaceId,
      viewport: vp,
      content: `<script setup>\n// 由 A2UI Codegen 生成(vue3 · experimental)\nconst maxWidth = ${vp.width};\n</script>\n\n<template>\n  <div class="mx-auto" :style="{ maxWidth: maxWidth + 'px' }">\n${body}\n  </div>\n</template>\n`,
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
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { vue: "^3.5.13" },
        devDependencies: {
          "@vitejs/plugin-vue": "^5.2.1",
          autoprefixer: "^10.4.20",
          postcss: "^8.4.49",
          tailwindcss: "^3.4.17",
          vite: "^5.4.11",
        },
      },
      null,
      2,
    ),
  });

  files.push({
    path: "vite.config.js",
    content: `import { defineConfig } from "vite";\nimport vue from "@vitejs/plugin-vue";\n\nexport default defineConfig({ plugins: [vue()] });\n`,
  });

  files.push({
    path: "tailwind.config.js",
    content: `/** @type {import('tailwindcss').Config} */\nexport default { content: ["./index.html", "./src/**/*.{vue,js}"], theme: { extend: {} }, plugins: [] };\n`,
  });

  files.push({
    path: "postcss.config.js",
    content: `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`,
  });

  files.push({
    path: "index.html",
    content: `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${escapeText(projectName)}</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n`,
  });

  files.push({
    path: "src/index.css",
    content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  --a2-primary: ${tokens.primary};\n  --a2-background: ${tokens.background};\n  --a2-surface: ${tokens.surface};\n  --a2-text: ${tokens.text};\n  --a2-muted: ${tokens.mutedText};\n  --a2-accent: ${tokens.accent};\n  --a2-radius: ${tokens.radius}px;\n}\n\nbody { background: var(--a2-background); color: var(--a2-text); font-family: system-ui, sans-serif; }\n`,
  });

  files.push({
    path: "src/main.js",
    content: `import { createApp } from "vue";\nimport App from "./App.vue";\nimport "./index.css";\n\ncreateApp(App).mount("#app");\n`,
  });

  // App.vue:hash 路由 + 导航(v-else-if 链与 React 版条件渲染同构)
  const nav = pageFiles
    .map((p) => `        <a class="text-sm text-gray-500 hover:text-gray-900" href="#/${encodeURIComponent(p.surfaceId)}">${escapeText(p.title)}</a>`)
    .join("\n");
  const branches = pageFiles
    .map((p, i) => {
      const h = `#/${encodeURIComponent(p.surfaceId)}`;
      const cond = i === 0 ? `!hash || hash === '${h}'` : `hash === '${h}'`;
      const directive = i === 0 ? "v-if" : "v-else-if";
      return `      <${p.comp} ${directive}="${cond}" />`;
    })
    .join("\n");
  const imports = pageFiles.map((p) => `import ${p.comp} from "./pages/${p.comp}.vue";`).join("\n");

  files.push({
    path: "src/App.vue",
    content: `<script setup>\nimport { ref, onMounted, onUnmounted } from "vue";\n${imports}\n\nconst hash = ref(typeof window !== "undefined" ? window.location.hash : "");\nconst onHash = () => {\n  hash.value = window.location.hash;\n};\nonMounted(() => window.addEventListener("hashchange", onHash));\nonUnmounted(() => window.removeEventListener("hashchange", onHash));\n</script>\n\n<template>\n  <div>\n    <nav class="border-b px-6 py-3">\n      <div class="mx-auto flex max-w-6xl items-center gap-6">\n        <span class="font-semibold">${escapeText(projectName)}</span>\n${nav}\n      </div>\n    </nav>\n${branches}\n  </div>\n</template>\n`,
  });

  for (const p of pageFiles) {
    files.push({ path: `src/pages/${p.comp}.vue`, content: p.content });
  }

  return { files, unmapped };
}

/** Vue SFC 结构校验(轻量门禁:template/script 配对与包配置;完整构建走 vite build) */
export function validateVueFiles(files: GeneratedFile[]): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  for (const f of files) {
    if (f.path.endsWith(".vue")) {
      const hasTemplate = /<template>[\s\S]*<\/template>/.test(f.content);
      if (!hasTemplate) errors.push({ path: f.path, message: "SFC 缺少 <template> 块" });
      if ((f.content.match(/<template>/g) ?? []).length !== 1) {
        errors.push({ path: f.path, message: "SFC 只允许一个根 <template> 块" });
      }
      continue;
    }
    if (/\.(js|ts)$/.test(f.path) && !f.path.includes("config")) {
      try {
        transformSync(f.content, { loader: "js" });
      } catch (e) {
        errors.push({ path: f.path, message: (e as Error).message.slice(0, 300) });
      }
    }
  }
  return errors;
}
