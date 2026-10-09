import { z } from "zod";

/**
 * 结构化澄清契约(文档 §25)
 *
 * Agent 不应通过自由文本追问,而应下发结构化澄清问题:
 * 单选/多选/自定义/混合/程度滑杆/布尔/排序,回答可归一化、可审计、可回放。
 */

export const clarificationResponseTypeSchema = z.enum([
  "single_select",
  "multi_select",
  "custom_text",
  "mixed",
  "scale",
  "boolean",
  "ranked_choice",
]);
export type ClarificationResponseType = z.infer<typeof clarificationResponseTypeSchema>;

/** 该问题影响的设计维度(归一化时决定写回 Brief 的哪个部分) */
export const clarificationAffectsSchema = z.enum([
  "layout",
  "style",
  "library",
  "data",
  "interaction",
  "accessibility",
  "scope",
]);
export type ClarificationAffects = z.infer<typeof clarificationAffectsSchema>;

export const clarificationOptionSchema = z.object({
  optionId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  /** 选项预览(风格卡片色板/布局示意等) */
  preview: z
    .object({
      type: z.enum(["color", "layout", "card", "typography", "motion"]),
      value: z.string(),
    })
    .optional(),
  /** 选择后果说明(文档要求每个选项可执行且说明后果) */
  consequences: z.array(z.string()).default([]),
});
export type ClarificationOption = z.infer<typeof clarificationOptionSchema>;

export const clarificationQuestionSchema = z.object({
  questionId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  responseType: clarificationResponseTypeSchema,
  options: z.array(clarificationOptionSchema).default([]),
  allowCustom: z.boolean().default(false),
  customPlaceholder: z.string().default(""),
  minSelections: z.number().int().optional(),
  maxSelections: z.number().int().optional(),
  /** scale 型的取值区间 */
  scaleMin: z.number().optional(),
  scaleMax: z.number().optional(),
  scaleStep: z.number().optional(),
  required: z.boolean().default(true),
  skippable: z.boolean().default(true),
  defaultOptionIds: z.array(z.string()).default([]),
  affects: z.array(clarificationAffectsSchema).default([]),
});
export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;

export const clarificationRequestSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  reason: z.string().default(""),
  questions: z.array(clarificationQuestionSchema).min(1).max(5),
  timeoutSeconds: z.number().int().default(300),
  canSkipAll: z.boolean().default(true),
  /** 跳过(或超时)时的策略 */
  defaultStrategy: z.enum(["use_recommended_defaults", "cancel_run"]).default("use_recommended_defaults"),
  /** §15.3 断线恢复:服务端截止时间(ISO);前端倒计时以此为准,重连不重置 */
  expiresAt: z.string().optional(),
});
export type ClarificationRequest = z.infer<typeof clarificationRequestSchema>;

export const clarificationAnswerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionIds: z.array(z.string()).default([]),
  customText: z.string().optional(),
  /** scale 型数值回答 */
  scaleValue: z.number().optional(),
  /** boolean 型回答 */
  boolValue: z.boolean().optional(),
  /** ranked_choice 型:按优先级排序的 optionId */
  rankedOptionIds: z.array(z.string()).default([]),
  skipped: z.boolean().default(false),
});
export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

export const clarificationResponseSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  answers: z.array(clarificationAnswerSchema),
  submittedAt: z.string(),
});
export type ClarificationResponse = z.infer<typeof clarificationResponseSchema>;

/**
 * 回答归一化结果:写回 Brief / StyleDirection / UI 库选择的标准化事实
 * (文档 §25.8:用户回答不直接进入 Prompt 原文,先归一化)
 */
export interface NormalizedClarification {
  facts: Record<string, string | string[] | number | boolean>;
  assumptions: string[];
  affects: ClarificationAffects[];
  skippedAll: boolean;
}
