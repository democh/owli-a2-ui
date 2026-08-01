/**
 * Agent 面板共享常量:快捷提示语 / 步骤图标 / 阶段推测映射
 */
import { Check, ClipboardList, Hammer, Layers, Map, Play, Sparkles } from "lucide-react";

export const QUICK_PROMPTS = [
  "生成一个营销落地页",
  "生成落地页+定价页+关于我们,一套",
  "做一个数据看板",
  "生成移动端 App 首页",
  "把主题色改成绿色",
  "换成 Element UI 风格",
];

export const STEP_ICON: Record<string, typeof Sparkles> = {
  understand: Sparkles,
  context: Layers,
  plan: Map,
  generate: Hammer,
  validate: Check,
  apply: Play,
  snapshot: ClipboardList,
};

/** 收到上一个步骤后,推测中的下一阶段(合成 running 行) */
export const NEXT_PHASE: Record<string, string> = {
  understand: "装配上下文",
  context: "生成 A2UI",
  plan: "逐页生成页面",
  generate: "校验与应用",
  validate: "应用变更",
  apply: "保存快照",
};
