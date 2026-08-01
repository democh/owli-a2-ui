import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/|deployed\/).*$/] }),
    inspectAttr(), react()],
  server: {
    // 固定 3002:3000/3001 常被本机其他项目占用
    port: 3002,
    headers: {
      // 禁用缓存,避免自动化验证拿到旧模块
      "Cache-Control": "no-store",
    },
    watch: {
      // 挂载文件系统不支持 inotify,使用轮询保证 HMR 生效
      usePolling: true,
      interval: 500,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // 按依赖族分包:框架 / antd / 画布交互库,提升缓存命中率与首屏速度。
        // 用函数形式而非数组形式:数组形式会被无条件 modulepreload,
        // 函数形式按真实引用关系决定 preload(antd 仅被 iframe 动态 import,不进首屏)
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // 宿主 UI 与 antd 共享的小型工具库须显式归入首屏包,
          // 否则 rollup 会把它们塞入 vendor-antd,导致首屏静态依赖整个 antd chunk
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler|clsx|tailwind-merge|class-variance-authority)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](antd|@ant-design|@rc-component|rc-[^\\/]+|dayjs)[\\/]/.test(id)) return "vendor-antd";
          if (/[\\/]node_modules[\\/](react-infinite-viewer|react-moveable|react-selecto|@scena|@daybrush|moveable|infinite-viewer|gesto|croact)[\\/]/.test(id)) return "vendor-canvas";
        },
      },
    },
  },
});
