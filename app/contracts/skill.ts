import { z } from "zod";

/**
 * UI/UX Skill 扩展体系契约(文档 §24)
 *
 * Skill 是可插拔的专家能力包:Prompt 片段 + 设计规则 + 检查清单 + 推荐澄清问题。
 * Skill 不能直接提交 IR,不能调用高危工具,不能绕过 Commit Gate。
 * v1 内置 Skill 只含 promptFragments + rules(无代码 validator,沙箱归入 M6)。
 */

export const skillTrustSchema = z.enum(["official", "verified", "third_party"]);
export type SkillTrust = z.infer<typeof skillTrustSchema>;

export const skillManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  publisher: z.string().default("internal"),
  trust: skillTrustSchema.default("official"),
  description: z.string().default(""),
  /** 触发条件:意图 / 页面类型 / 关键词(Skill Router 用) */
  triggers: z.object({
    intents: z.array(z.string()).default([]),
    pageTypes: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
  }),
  /** 兼容的 UI 库 Adapter;空数组表示全兼容 */
  compatibleAdapters: z.array(z.string()).default([]),
  capabilities: z.object({
    /** prompts/agent/skills/{id}.md 的片段 id 列表(加载进 expert prompt) */
    promptFragments: z.array(z.string()).default([]),
    /** 结构化设计规则(注入 UI Designer 与 Critic) */
    rules: z.array(z.string()).default([]),
    /** 推荐澄清问题 id(由 ClarificationPlanner 决定是否采纳) */
    recommendedQuestions: z.array(z.string()).default([]),
  }),
  permissions: z.object({
    readDesign: z.boolean().default(true),
    writeProposal: z.boolean().default(true),
    commitDesign: z.literal(false).default(false),
    network: z.literal(false).default(false),
  }),
  limits: z.object({
    maxContextTokens: z.number().int().default(4000),
    maxIssues: z.number().int().default(50),
  }),
  enabled: z.boolean().default(true),
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;

/** Skill 对本次 Run 的贡献(记录进 run_events / skill_runs,可审计) */
export interface SkillContribution {
  skillId: string;
  version: string;
  reason: string;
  promptFragmentIds: string[];
  designRules: string[];
  recommendedQuestionIds: string[];
}

// ---------------------------------------------------------------------------
// v1 内置 Skill(文档 §24.4 的子集;promptFragments 指向 prompts/agent/skills/*.md)
// ---------------------------------------------------------------------------

export const BUILTIN_SKILLS: SkillManifest[] = [
  {
    id: "heuristic-evaluation",
    name: "可用性启发式评审",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "基于 Nielsen 十大可用性启发式做设计评审",
    triggers: {
      intents: ["review_only", "create_page", "redesign_frame"],
      pageTypes: [],
      keywords: ["评审", "可用性", "易用性", "启发式"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["heuristic-evaluation"],
      rules: ["一致性标准", "错误预防", "系统状态可见", "用户控制与自由"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 4000, maxIssues: 50 },
    enabled: true,
  },
  {
    id: "accessibility-wcag22",
    name: "WCAG 2.2 AA 无障碍",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "按 WCAG 2.2 AA 审查语义、键盘、对比度、触控目标",
    triggers: {
      intents: ["accessibility_audit", "form_design", "create_page"],
      pageTypes: ["form", "dashboard", "settings", "checkout"],
      keywords: ["无障碍", "可访问性", "WCAG", "键盘", "对比度", "读屏"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["accessibility-wcag22"],
      rules: ["焦点可见", "触控目标≥44px", "颜色非唯一信息载体", "表单控件必须有关联 label"],
      recommendedQuestions: ["accessibility_level"],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 4000, maxIssues: 50 },
    enabled: true,
  },
  {
    id: "enterprise-dashboard",
    name: "企业级数据后台",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "数据密集后台:表格、筛选、批量操作、告警层级",
    triggers: {
      intents: ["create_page", "redesign_frame", "refine_selection"],
      pageTypes: ["dashboard", "admin", "list"],
      keywords: ["后台", "管理", "表格", "Dashboard", "数据", "运营", "CRM"],
    },
    compatibleAdapters: ["shadcn-tailwind", "ant-design"],
    capabilities: {
      promptFragments: ["enterprise-dashboard"],
      rules: ["主操作唯一", "表格必须有筛选/排序/空态/加载/错误", "异常与告警优先呈现"],
      recommendedQuestions: ["target_user", "data_density"],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 4000, maxIssues: 50 },
    enabled: true,
  },
  {
    id: "form-design",
    name: "表单设计",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "表单结构、校验时机、错误恢复",
    triggers: {
      intents: ["create_page", "refine_selection"],
      pageTypes: ["form", "settings", "checkout", "login"],
      keywords: ["表单", "登录", "注册", "设置", "提交", "校验"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["form-design"],
      rules: ["每个输入有可见 label", "必填明确", "错误说明问题与修复方式", "placeholder 不当 label"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 4000, maxIssues: 50 },
    enabled: true,
  },
  {
    id: "ux-writing",
    name: "UX 文案",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "文案、错误消息、空态与帮助文本",
    triggers: {
      intents: ["create_page", "refine_selection", "redesign_frame"],
      pageTypes: [],
      keywords: ["文案", "错误提示", "空状态", "引导"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["ux-writing"],
      rules: ["标题说明是什么,按钮说明会发生什么", "错误消息含原因与下一步", "不使用 Lorem Ipsum"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  {
    id: "responsive-design",
    name: "响应式设计",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "多断点重排与移动端降级策略",
    triggers: {
      intents: ["create_page", "redesign_frame"],
      pageTypes: [],
      keywords: ["移动端", "手机", "响应式", "适配", "平板"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["responsive-design"],
      rules: ["移动端重排优先级而非机械缩放", "触控目标≥44px", "提供非手势替代"],
      recommendedQuestions: ["target_platforms"],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  // §24.4 补齐批次:以下 8 个与文档表逐条对齐
  {
    id: "landing-page-cro",
    name: "落地页转化优化",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "落地页信息架构与转化路径:首屏价值主张、信任要素、CTA 层级",
    triggers: {
      intents: ["create_page", "redesign_frame"],
      pageTypes: ["landing", "marketing", "pricing"],
      keywords: ["落地页", "转化", "营销页", "注册率", "CTA", "卖点"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["landing-page-cro"],
      rules: ["首屏一句话说清价值主张", "主 CTA 首屏可见且唯一", "社会证明靠近决策点", "减少离开路径(导航弱化可选)"],
      recommendedQuestions: ["conversion_goal"],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  {
    id: "shadcn-modern-saas",
    name: "shadcn 现代 SaaS 风格",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "shadcn/ui + Tailwind 现代生产力风格:克制留白、细边框、低干扰",
    triggers: {
      intents: ["create_page", "redesign_frame", "refine_selection"],
      pageTypes: ["saas", "dashboard", "settings"],
      keywords: ["shadcn", "SaaS", "现代简洁", "Linear 风", "Notion 风", "生产力"],
    },
    compatibleAdapters: ["shadcn-tailwind"],
    capabilities: {
      promptFragments: ["shadcn-modern-saas"],
      rules: ["低饱和灰阶 + 单一主色", "细边框替代重阴影", "圆角与间距全站一致", "交互反馈轻量不抢内容"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  {
    id: "ant-design-enterprise",
    name: "Ant Design 企业级规范",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "Ant Design 企业后台规范:高密度表格、筛选、稳定状态色",
    triggers: {
      intents: ["create_page", "redesign_frame", "refine_selection"],
      pageTypes: ["admin", "dashboard", "list", "form"],
      keywords: ["Ant Design", "antd", "企业级规范", "中后台", "ProComponents"],
    },
    compatibleAdapters: ["ant-design"],
    capabilities: {
      promptFragments: ["ant-design-enterprise"],
      rules: ["表格密度 compact,操作列收敛", "状态色语义固定(成功/失败/警告)", "表单标签左对齐、必填明确", "遵循 antd 组件默认交互,不重造轮子"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  {
    id: "material-design",
    name: "Material Design 规范",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "Material 结构、状态层与动效规范:Elevation、涟漪、FAB",
    triggers: {
      intents: ["create_page", "redesign_frame"],
      pageTypes: ["app", "dashboard"],
      keywords: ["Material", "MD3", "涟漪", "Elevation", "安卓风"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["material-design"],
      rules: ["表面层级用 Elevation 表达", "交互反馈有涟漪/状态层", "主操作可用 FAB,次操作收敛", "动效遵循缓动规范,不做纯装饰"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  {
    id: "mobile-first",
    name: "移动端优先",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "移动端布局:大触控目标、底部主操作、安全区与手势替代",
    triggers: {
      intents: ["create_page", "redesign_frame"],
      pageTypes: ["mobile"],
      keywords: ["移动端优先", "手机端", "安全区", "底部导航", "单手操作"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["mobile-first"],
      rules: ["触控目标 ≥44px 且间距充分", "主操作贴近拇指热区(底部)", "单列信息流,重排优先级而非缩放", "手势必须提供可见按钮替代"],
      recommendedQuestions: ["target_platforms"],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  {
    id: "motion-design",
    name: "动效设计",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "微交互与动效层级:状态解释、时长缓动、减少动态偏好降级",
    triggers: {
      intents: ["create_page", "redesign_frame", "interaction_design"],
      pageTypes: [],
      keywords: ["动效", "动画", "微交互", "过渡", "转场"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["motion-design"],
      rules: ["动效必须解释状态变化,不做纯装饰", "时长 120-300ms,ease-out 为主", "列表进出有层级错峰", "尊重 prefers-reduced-motion 提供降级"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 2500, maxIssues: 25 },
    enabled: true,
  },
  {
    id: "data-visualization",
    name: "数据可视化",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "指标、图表与 Dashboard 信息层级:KPI/趋势/明细的组织",
    triggers: {
      intents: ["create_page", "redesign_frame", "data_model_design"],
      pageTypes: ["dashboard", "report"],
      keywords: ["图表", "可视化", "指标卡", "趋势图", "报表"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["data-visualization"],
      rules: ["KPI 卡前置,趋势与明细分层", "每张图表有明确问题假设", "色板受 Token 约束,不超 6 个语义色", "空态/加载态/异常态齐备"],
      recommendedQuestions: ["data_density"],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 3000, maxIssues: 30 },
    enabled: true,
  },
  {
    id: "design-token-audit",
    name: "设计令牌审计",
    version: "1.0.0",
    publisher: "internal",
    trust: "official",
    description: "Token 一致性:颜色语义、间距档位、圆角与字号秩序",
    triggers: {
      intents: ["refine_selection", "redesign_frame"],
      pageTypes: [],
      keywords: ["Token", "设计令牌", "一致性检查", "间距规范", "颜色语义"],
    },
    compatibleAdapters: [],
    capabilities: {
      promptFragments: ["design-token-audit"],
      rules: ["颜色必须来自语义 Token,禁止魔法值", "间距只用间距档位(4/8/12/16/24…)", "同类组件圆角/字号一致", "发现离群值给出去除方案"],
      recommendedQuestions: [],
    },
    permissions: { readDesign: true, writeProposal: true, commitDesign: false, network: false },
    limits: { maxContextTokens: 2500, maxIssues: 40 },
    enabled: true,
  },
];

export function skillById(id: string): SkillManifest | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}
