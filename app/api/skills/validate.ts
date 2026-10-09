import { skillManifestSchema, type SkillManifest } from "@contracts/skill";

/**
 * Skill 沙箱校验(M7 Skill Marketplace)
 *
 * 第三方 manifest 必须满足(在 zod schema 之上的安全策略):
 *  - 结构合法(skillManifestSchema)
 *  - 硬权限边界:commitDesign / network 必须 false(Skill 永远不能提交 IR 或联网)
 *  - 第三方 trust 必须显式 publisher
 *  - id 仅允许 [a-z0-9-](防路径拼接/prompt 注入字符)
 *  - 资源上限:promptFragments ≤ 8、rules ≤ 20、maxContextTokens ≤ 8000
 *  - manifest 总大小 ≤ 32KB
 */

export interface SkillValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: SkillManifest;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function validateSkillManifest(raw: unknown): SkillValidationResult {
  const errors: string[] = [];

  if (typeof raw === "string") {
    if (raw.length > 32 * 1024) return { ok: false, errors: ["manifest 超过 32KB 上限"] };
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: [`manifest 不是合法 JSON:${(e as Error).message.slice(0, 80)}`] };
    }
  }

  const parsed = skillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const m = parsed.data;

  if (!ID_RE.test(m.id)) errors.push(`id "${m.id}" 不合法(仅小写字母/数字/连字符,2-64 位)`);
  if (m.permissions.commitDesign !== false) errors.push("沙箱边界:permissions.commitDesign 必须为 false");
  if (m.permissions.network !== false) errors.push("沙箱边界:permissions.network 必须为 false");
  if (m.trust === "third_party" && (!m.publisher || m.publisher === "internal")) {
    errors.push("第三方 Skill 必须显式声明 publisher");
  }
  if (m.capabilities.promptFragments.length > 8) errors.push("promptFragments 数量超限(≤8)");
  if (m.capabilities.rules.length > 20) errors.push("rules 数量超限(≤20)");
  if (m.limits.maxContextTokens > 8000) errors.push("maxContextTokens 超限(≤8000)");

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], manifest: m };
}
