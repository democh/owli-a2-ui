import "dotenv/config";

export const env = {
  isProduction: process.env.NODE_ENV === "production",
  /** SQLite 文件路径(可选,默认 ./data/app.db) */
  databaseUrl: process.env.DATABASE_URL ?? "",
  ownerUnionId: process.env.OWNER_UNION_ID ?? "",
  /** 全局默认 OpenAI 兼容 LLM 配置;用户未在设置中填写时兜底使用。
   *  优先读 DEFAULT_AI_*(通用命名,可指向任意 OpenAI 兼容服务),
   *  回退 KIMI_*(历史命名,保持兼容) */
  kimiApiKey: process.env.DEFAULT_AI_API_KEY ?? process.env.KIMI_API_KEY ?? "",
  kimiBaseUrl: process.env.DEFAULT_AI_BASE_URL ?? process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1",
  kimiModel: process.env.DEFAULT_AI_MODEL ?? process.env.KIMI_MODEL ?? "kimi-k3",
  /** 输出 token 上限。推理模型(如 deepseek-v4-flash)的思考过程会占用该预算,
   *  需要明显调大(如 65536),否则思考耗尽预算导致正文为空 */
  llmMaxTokens: Number(process.env.DEFAULT_AI_MAX_TOKENS) || 16384,
  /** M6-2 计费单价(USD / 百万 tokens):成本估算 = tokens * 单价;按服务商牌价配置 */
  priceInputPerMUsd: Number(process.env.PRICE_INPUT_PER_M_USD) || 0.6,
  priceOutputPerMUsd: Number(process.env.PRICE_OUTPUT_PER_M_USD) || 2.5,
  /** M6-2 用户级默认预算(USD):user_settings.budgetMaxCostUsd=0 时兜底;0 表示不限 */
  defaultBudgetMaxCostUsd: Number(process.env.DEFAULT_BUDGET_MAX_COST_USD) || 20,
  /** M6-2 Run 内默认 token 预算:constraints.maxTokens 未指定时兜底;0 表示不限 */
  defaultRunMaxTokens: Number(process.env.DEFAULT_RUN_MAX_TOKENS) || 0,
  /** §18.4 Run 内默认工具/模型调用数上限:constraints.maxToolCalls 未指定时兜底;0 表示不限 */
  defaultRunMaxToolCalls: Number(process.env.DEFAULT_RUN_MAX_TOOL_CALLS) || 40,
  /** M6-3 OTEL:OTLP/HTTP JSON collector 地址;未配置时 span 仅入内存环形缓冲(默认关闭) */
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
  /** M7 并行专家评审:Critic 数量(1=单评审,行为与历史一致);上限 5 */
  reviewCritics: Math.min(5, Math.max(1, Number(process.env.REVIEW_CRITICS) || 1)),
};
