import { selectSkills } from "../agent/experts";
import type { AgentContext } from "../agent/context/ContextBuilder";
import type { AgentRunMode, DesignBrief } from "@contracts/agent";
import { BUILTIN_SKILLS } from "@contracts/skill";

/**
 * Skill 触发评测集(文档 §24.8)
 *
 * 每个 Skill ≥3 个触发正例 + 负例;断言 Skill Router 的命中/排除,
 * 输出触发准确率(hitRate)与误触发率(falseTriggerRate),供 runEvals 报告引用。
 *
 * selectSkills 语义:BUILTIN 顺序遍历,intent 命中(按 Run Mode)或关键词子串命中
 * 即选中,最多 3 个;manual 模式只取指定集合。因此正例的 expect 需按序截断到 3。
 */

export interface SkillCase {
  id: string;
  prompt: string;
  mode: AgentRunMode;
  /** 期望命中的 skillId(按 BUILTIN 顺序,最多 3 个) */
  expect: string[];
  /** 期望排除的 skillId(误触发防护) */
  not?: string[];
}

export const SKILL_CASES: SkillCase[] = [
  // accessibility-wcag22
  { id: "sk_a11y_1", prompt: "给这个表单做一次无障碍审查:键盘、对比度、读屏", mode: "accessibility_audit", expect: ["accessibility-wcag22", "form-design"] },
  { id: "sk_a11y_2", prompt: "无障碍审查:焦点可见性与触控目标", mode: "review_only", expect: ["heuristic-evaluation", "accessibility-wcag22"] },
  { id: "sk_a11y_3", prompt: "检查注册流程的可访问性与表单 label", mode: "review_only", expect: ["heuristic-evaluation", "accessibility-wcag22", "form-design"] },
  { id: "sk_a11y_neg", prompt: "评审这个页面的信息架构与层级", mode: "review_only", expect: ["heuristic-evaluation"], not: ["accessibility-wcag22"] },

  // enterprise-dashboard(高密度后台意图族)
  { id: "sk_dash_1", prompt: "设计一个 CRM 客户管理后台,表格与筛选优先", mode: "create_page", expect: ["heuristic-evaluation", "accessibility-wcag22", "enterprise-dashboard"] },
  { id: "sk_dash_2", prompt: "为运营平台做一个数据 Dashboard,告警优先", mode: "redesign_frame", expect: ["heuristic-evaluation", "enterprise-dashboard", "ux-writing"] },
  { id: "sk_dash_3", prompt: "优化管理后台的表格效率与批量操作", mode: "refine_selection", expect: ["enterprise-dashboard", "form-design", "ux-writing"] },

  // form-design
  { id: "sk_form_1", prompt: "把登录表单的校验时机和错误恢复优化一下", mode: "refine_selection", expect: ["enterprise-dashboard", "form-design", "ux-writing"] },
  { id: "sk_form_2", prompt: "优化设置页表单:必填标识与错误提示", mode: "refine_selection", expect: ["enterprise-dashboard", "form-design", "ux-writing"] },
  { id: "sk_form_3", prompt: "设计一个多步骤结账表单", mode: "create_page", expect: ["heuristic-evaluation", "accessibility-wcag22", "enterprise-dashboard"] },

  // ux-writing
  { id: "sk_uxw_1", prompt: "把报错文案改成「发生了什么/为什么/下一步」结构", mode: "refine_selection", expect: ["enterprise-dashboard", "form-design", "ux-writing"] },
  { id: "sk_uxw_2", prompt: "为空状态写引导文案,去掉 Lorem Ipsum", mode: "refine_selection", expect: ["enterprise-dashboard", "form-design", "ux-writing"] },

  // landing-page-cro
  { id: "sk_cro_1", prompt: "评审这个营销落地页的转化路径与 CTA 层级", mode: "review_only", expect: ["heuristic-evaluation", "landing-page-cro"] },
  { id: "sk_cro_2", prompt: "落地页首屏价值主张不清晰,帮忙重排", mode: "redesign_frame", expect: ["heuristic-evaluation", "enterprise-dashboard", "ux-writing"] },

  // shadcn-modern-saas
  { id: "sk_shadcn_1", prompt: "检查 shadcn 风格一致性与留白秩序", mode: "review_only", expect: ["heuristic-evaluation", "shadcn-modern-saas"] },
  { id: "sk_shadcn_2", prompt: "做一个类 Linear 的 SaaS 工作台首页", mode: "create_page", expect: ["heuristic-evaluation", "accessibility-wcag22", "enterprise-dashboard"] },

  // ant-design-enterprise
  { id: "sk_antd_1", prompt: "检查 antd 组件用法是否符合企业级规范", mode: "review_only", expect: ["heuristic-evaluation", "ant-design-enterprise"] },
  { id: "sk_antd_2", prompt: "按 Ant Design 规范重排中后台表格", mode: "refine_selection", expect: ["enterprise-dashboard", "form-design", "ux-writing"] },

  // material-design
  { id: "sk_md_1", prompt: "按 Material 规范检查涟漪反馈与 Elevation 层级", mode: "review_only", expect: ["heuristic-evaluation", "material-design"] },
  { id: "sk_md_2", prompt: "这个安卓风格应用缺少状态层反馈", mode: "review_only", expect: ["heuristic-evaluation", "material-design"] },
  { id: "sk_md_3", prompt: "用 MD3 的 Elevation 体系重做卡片层级", mode: "redesign_frame", expect: ["heuristic-evaluation", "enterprise-dashboard", "ux-writing"] },

  // mobile-first
  { id: "sk_mobile_1", prompt: "检查安全区与底部导航,单手操作是否可行", mode: "review_only", expect: ["heuristic-evaluation", "mobile-first"] },
  { id: "sk_mobile_2", prompt: "单手操作场景下主按钮位置不合理", mode: "review_only", expect: ["heuristic-evaluation", "mobile-first"] },
  { id: "sk_mobile_3", prompt: "移动端优先重排这个 H5 页面", mode: "redesign_frame", expect: ["heuristic-evaluation", "enterprise-dashboard", "ux-writing"] },

  // motion-design(intents 不含 create_page,便于负例)
  { id: "sk_motion_1", prompt: "检查动效与过渡是否解释状态变化", mode: "review_only", expect: ["heuristic-evaluation", "motion-design"] },
  { id: "sk_motion_2", prompt: "转场动画过长且缺少 reduced-motion 降级", mode: "review_only", expect: ["heuristic-evaluation", "motion-design"] },
  { id: "sk_motion_3", prompt: "给列表加入微交互反馈", mode: "interaction_design", expect: ["motion-design"] },

  // data-visualization
  { id: "sk_viz_1", prompt: "检查图表配色语义与指标卡层级", mode: "review_only", expect: ["heuristic-evaluation", "data-visualization"] },
  { id: "sk_viz_2", prompt: "趋势图与报表的可视化层级混乱", mode: "review_only", expect: ["heuristic-evaluation", "data-visualization"] },
  { id: "sk_viz_3", prompt: "为一个可视化大屏规划指标体系", mode: "data_model_design", expect: ["data-visualization"] },

  // design-token-audit(intents 不含 create_page)
  { id: "sk_token_1", prompt: "审查 Token 一致性:间距规范与颜色语义", mode: "review_only", expect: ["heuristic-evaluation", "design-token-audit"] },
  { id: "sk_token_2", prompt: "检查设计令牌是否存在魔法值", mode: "review_only", expect: ["heuristic-evaluation", "design-token-audit"] },
  { id: "sk_token_3", prompt: "对比同类组件的一致性检查", mode: "refine_selection", expect: ["enterprise-dashboard", "form-design", "ux-writing"], not: ["design-token-audit"] },

  // responsive-design
  { id: "sk_resp_1", prompt: "检查响应式适配与平板断点策略", mode: "review_only", expect: ["heuristic-evaluation", "responsive-design"] },
  { id: "sk_resp_2", prompt: "宽屏到窄屏的重排方案不合理", mode: "redesign_frame", expect: ["heuristic-evaluation", "enterprise-dashboard", "ux-writing"] },

  // manual 模式:只取指定集合
  { id: "sk_manual_1", prompt: "按指定能力包处理当前页面", mode: "create_page", expect: ["data-visualization"], not: ["design-token-audit"] },

  // 负例:泛化请求不触发专属 Skill(create_frame 模式无 intent 泛匹配,纯关键词判定)
  { id: "sk_neg_generic", prompt: "生成一个关于美食的静态展示页", mode: "create_page", expect: ["heuristic-evaluation", "accessibility-wcag22", "enterprise-dashboard"], not: ["motion-design", "design-token-audit"] },
  { id: "sk_neg_frame", prompt: "生成一个关于园艺的介绍页", mode: "create_frame", expect: [], not: ["motion-design", "design-token-audit", "data-visualization"] },
];

/** 构造 selectSkills 可用的最小上下文(仅 userMessage/mode/skillSelection 被读取) */
function ctxOf(prompt: string, mode: AgentRunMode, manual?: string[]): AgentContext {
  return {
    request: {
      userMessage: prompt,
      mode,
      skillSelection: manual ? { mode: "manual", skillIds: manual } : { mode: "auto", skillIds: [] },
    },
  } as unknown as AgentContext;
}

const briefOf = (prompt: string): DesignBrief => ({ objective: prompt }) as unknown as DesignBrief;

export interface SkillCaseResult {
  caseId: string;
  hit: string[];
  expect: string[];
  /** 命中集合与期望完全一致,且 not 集合互斥 */
  ok: boolean;
}

export function runSkillCase(c: SkillCase): SkillCaseResult {
  const manual = c.id.startsWith("sk_manual_") ? c.expect : undefined;
  const hit = selectSkills(ctxOf(c.prompt, c.mode, manual), briefOf(c.prompt)).map((m) => m.skillId);
  const ok =
    hit.length === c.expect.length &&
    c.expect.every((id) => hit.includes(id)) &&
    (c.not ?? []).every((id) => !hit.includes(id));
  return { caseId: c.id, hit, expect: c.expect, ok };
}

/** 触发校准(§24.8):准确率(期望命中)/ 误触发率(not 命中占比) */
export function skillCalibration(): {
  total: number;
  hitRate: number;
  falseTriggerRate: number;
  failures: SkillCaseResult[];
} {
  const results = SKILL_CASES.map(runSkillCase);
  const positives = results.filter((r) => r.expect.length > 0);
  const hit = positives.filter((r) => r.ok).length;
  const falseTrigger = results.filter((r) => (r.expect.length === 0 ? r.hit.length > 0 : false)).length;
  return {
    total: results.length,
    hitRate: positives.length ? hit / positives.length : 1,
    falseTriggerRate: results.length ? falseTrigger / results.length : 0,
    failures: results.filter((r) => !r.ok),
  };
}

/** 静态守卫:评测集覆盖全部内置 Skill(防新增 Skill 漏配评测) */
export function uncoveredSkills(): string[] {
  const covered = new Set(SKILL_CASES.flatMap((c) => c.expect));
  return BUILTIN_SKILLS.filter((s) => s.enabled && !covered.has(s.id)).map((s) => s.id);
}
