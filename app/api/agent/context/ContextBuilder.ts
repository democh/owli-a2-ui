import { desc, eq } from "drizzle-orm";
import { CATALOG_GROUPS, CATALOG_TYPES, DEFAULT_TOKENS } from "@contracts/a2ui";
import type { AgentRunRequest, DesignDecision } from "@contracts/agent";
import type { IRDocument, IRSurface } from "@contracts/design-ir";
import { patternsDigest, retrievePatterns, type DesignPattern } from "@contracts/patterns";
import { memoryDigest, projectMemorySchema, type ProjectMemory } from "@contracts/memory";
import { getDb } from "../../queries/connection";
import { designDecisions, frames, messages, pageBoards, projects, userSettings } from "@db/schema";

/**
 * Context Builder(文档 §5.2.2 / §10)
 *
 * 构建最小充分上下文:L0 安全规则由 prompt 模板承载;
 * L1-L7 在此组装——项目摘要、scope 子树、Catalog Digest、Tokens、历史决策、会话摘要、设计模式(§10.4)。
 * 上下文压缩永远不能丢弃最新用户消息和当前 scope。
 */

export interface AgentContext {
  request: AgentRunRequest;
  doc: IRDocument;
  /** 项目页面/画框结构摘要(供 prompt 引用) */
  projectSummary: string;
  /** scope 命中的 surface 子树(局部修改用;空表示无选中) */
  scopeSurfaces: { surfaceId: string; surface: IRSurface; nodeIds: string[] }[];
  catalogDigest: string;
  /** 最近会话(user/assistant 轮次) */
  history: { role: "user" | "assistant"; content: string }[];
  recentDecisions: DesignDecision[];
  /** §10.4 检索命中的设计模式(供 prompt 注入;空表示无匹配) */
  patterns: DesignPattern[];
  /** 模式摘要文本(直接拼入 prompt) */
  patternsDigest: string;
  /** §10.5 用户长期偏好摘要(设置页管理;空串表示未配置) */
  memoryDigest: string;
}

/** Catalog Digest(文档 §10.3):面向 LLM 的目录摘要,而非完整 schema */
export function buildCatalogDigest(): string {
  return CATALOG_GROUPS.map((g) => `${g.group}: ${g.types.join(", ")}`).join("\n");
}

/** scope 子树提取:命中组件向下两层(与旧 ops 上下文策略一致) */
function extractSubtree(surface: IRSurface, nodeIds: string[]): { nodes: Record<string, unknown>; labels: string[] } {
  const nodes: Record<string, unknown> = {};
  const labels: string[] = [];
  const collect = (id: string, depth: number) => {
    const n = surface.components[id];
    if (!n || depth > 2) return;
    nodes[id] = n;
    const text = (n.props?.text ?? n.props?.label ?? "") as string;
    labels.push(`${n.type}#${id}${text ? `(${String(text).slice(0, 12)})` : ""}`);
    n.children.forEach((c) => collect(c, depth + 1));
  };
  nodeIds.forEach((id) => collect(id, 0));
  return { nodes, labels };
}

export function buildContext(request: AgentRunRequest, doc: IRDocument): AgentContext {
  const db = getDb();

  // 项目结构摘要
  const boards = db.select().from(pageBoards).where(eq(pageBoards.projectId, request.projectId)).all();
  const frameRows = db.select().from(frames).all();
  const projectFrames = frameRows.filter((f) => boards.some((b) => b.id === f.pageBoardId));
  const projectSummary = [
    `页面 ${boards.length} 个:${boards.map((b) => b.title).join("、") || "(空)"}`,
    `画框 ${projectFrames.length} 个:${projectFrames.map((f) => `${f.title || f.surfaceId}(${f.device})`).join("、") || "(空)"}`,
    `主题预设:${doc.theme.preset}`,
  ].join("\n");

  // scope 命中
  const scopeSurfaces: AgentContext["scopeSurfaces"] = [];
  if (request.scope.nodeIds?.length || request.scope.frameId) {
    for (const [surfaceId, surface] of Object.entries(doc.surfaces)) {
      if (request.scope.frameId && request.scope.frameId !== surfaceId) continue;
      const nodeIds = request.scope.nodeIds ?? [];
      if (!nodeIds.length) {
        // 页面级选中(仅选 frame 无元素):整 surface 入 scope。此前直接 continue,
        // 导致 Refine/Repair 拿不到 targetSurfaceId 被降级为整页重建(create)路径。
        scopeSurfaces.push({ surfaceId, surface, nodeIds: [] });
        continue;
      }
      const { nodes, labels } = extractSubtree(surface, nodeIds);
      scopeSurfaces.push({ surfaceId, surface: { ...surface, components: nodes as IRSurface["components"] }, nodeIds });
      void labels;
    }
  }

  // 最近会话(8 条)
  const history: AgentContext["history"] = [];
  const msgRows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, request.conversationId))
    .orderBy(desc(messages.id))
    .limit(8)
    .all();
  for (const m of msgRows.reverse()) {
    if (m.role === "user" || m.role === "assistant") {
      history.push({ role: m.role, content: m.content.slice(0, 500) });
    }
  }

  // 近期设计决策(5 条)
  const decisionRows = db
    .select()
    .from(designDecisions)
    .orderBy(desc(designDecisions.id))
    .limit(5)
    .all();
  const recentDecisions: DesignDecision[] = decisionRows.map((d) => ({
    decisionId: d.decisionId,
    runId: d.runId,
    topic: d.topic,
    chosen: d.chosen,
    alternatives: JSON.parse(d.alternatives ?? "[]"),
    rationale: d.rationale,
    tradeoffs: JSON.parse(d.tradeoffs ?? "[]"),
    confidence: d.confidence / 100,
  }));

  // §10.4 设计模式检索:按用户消息命中 Top-2(确定性词面匹配)
  const patterns = retrievePatterns(request.userMessage);
  const digest = patternsDigest(patterns);

  // §10.5 用户长期偏好(设置页管理;Agent 只读注入,不静默修改)
  const ownerRow = db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, request.projectId)).limit(1).get();
  const memRow = ownerRow
    ? db
        .select({ preferences: userSettings.preferences })
        .from(userSettings)
        .where(eq(userSettings.userId, ownerRow.userId))
        .limit(1)
        .get()
    : undefined;
  let memory: ProjectMemory | null = null;
  try {
    // 经 schema 规范化:preferences 是用户自由 JSON,缺失字段(如空对象 {})补默认值,避免下游访问 undefined
    const parsed = projectMemorySchema.safeParse(JSON.parse(memRow?.preferences ?? "{}"));
    memory = parsed.success ? parsed.data : null;
  } catch {
    memory = null;
  }
  const memText = memoryDigest(memory);

  return {
    request,
    doc,
    projectSummary,
    scopeSurfaces,
    catalogDigest: buildCatalogDigest(),
    history,
    recentDecisions,
    patterns,
    patternsDigest: digest,
    memoryDigest: memText,
  };
}

export { CATALOG_TYPES, DEFAULT_TOKENS };
