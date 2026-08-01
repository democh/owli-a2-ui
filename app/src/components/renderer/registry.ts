import type { RendererRegistry } from "./shared";
import { shadcnRegistry } from "./shadcnRenderer";
import { elementRegistry } from "./elementRenderer";

/**
 * 预设 → 渲染器注册表
 * custom 复用 shadcn 实现(token 驱动);element 复刻 Element Plus 视觉语言
 * antd 不在此静态注册:依赖 ~1MB,由 RendererRoot 在 antd 预设下按需动态 import
 */
export const REGISTRIES: Record<string, RendererRegistry> = {
  shadcn: shadcnRegistry,
  element: elementRegistry,
  custom: shadcnRegistry,
};
