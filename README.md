# owli-A2UI

AI 驱动的 UI 页面生成工具，通过自然语言描述自动生成多风格 UI 页面。

## 功能特性

- **多设计系统支持**：shadcn/ui、Ant Design、Element UI、AI 自定义
- **AI 页面生成**：接入 DeepSeek 等 LLM，通过对话式交互生成页面
- **可视化画布**：多页面预览、缩放平移、组件选取
- **页面管理**：数据中心、商品管理、订单管理、客户管理、营销分析等模块一键生成
- **风格切换**：支持在不同 UI 组件库之间快速切换

## 预览

![preview](assets/preview.png)

## 技术栈

- **前端**：React + TypeScript + Vite + Tailwind CSS
- **后端**：Node.js + tRPC + Drizzle ORM + SQLite
- **AI**：DeepSeek / Kimi 等大语言模型

## 快速开始

```bash
cd app
npm install
npm run dev
```

## 项目结构

```
app/
├── api/          # 后端 API 路由
├── src/
│   ├── components/  # UI 组件
│   ├── pages/       # 页面
│   ├── stores/      # 状态管理
│   └── hooks/       # 自定义 Hooks
├── db/           # 数据库 Schema
└── contracts/    # 类型与契约定义
```
