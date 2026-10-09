import { z } from "zod";

/**
 * 项目记忆(文档 §10.5)
 *
 * 用户长期偏好:Agent 注入上下文保持跨会话一致;
 * Agent 不能静默修改长期偏好 —— 只能由用户在设置页显式编辑(§10.5 写入规则)。
 */

export const projectMemorySchema = z.object({
  preferredDensity: z.enum(["compact", "comfortable", "spacious"]).optional(),
  preferredTone: z.string().max(80).optional(),
  colorPreferences: z.array(z.string().max(40)).max(8).default([]),
  componentPreferences: z.array(z.string().max(40)).max(12).default([]),
  forbiddenPatterns: z.array(z.string().max(80)).max(12).default([]),
  notes: z.string().max(400).optional(),
});
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

/** 面向 LLM 的偏好摘要(空记忆返回空串,不占上下文);preferences 为用户自由 JSON,缺失字段一律按空处理 */
export function memoryDigest(m: ProjectMemory | null | undefined): string {
  if (!m) return "";
  const lines: string[] = [];
  if (m.preferredDensity) lines.push(`信息密度偏好:${m.preferredDensity}`);
  if (m.preferredTone) lines.push(`语气/调性:${m.preferredTone}`);
  if (m.colorPreferences?.length) lines.push(`色彩偏好:${m.colorPreferences.join("、")}`);
  if (m.componentPreferences?.length) lines.push(`组件偏好:${m.componentPreferences.join("、")}`);
  if (m.forbiddenPatterns?.length) lines.push(`禁止使用:${m.forbiddenPatterns.join("、")}`);
  if (m.notes) lines.push(`其他偏好:${m.notes}`);
  return lines.join("\n");
}
