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
};
