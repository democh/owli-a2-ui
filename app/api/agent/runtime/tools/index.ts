import { z } from "zod";
import { desc } from "drizzle-orm";
import { CATALOG_GROUPS, CATALOG_TYPES, CONTAINER_TYPES, type DeviceId } from "@contracts/a2ui";
import type { IRDocument, IRNode } from "@contracts/design-ir";
import type { DesignPlan, ValidationIssue } from "@contracts/agent";
import { loadHead, commitRunChanges, createSnapshot, rollbackRun } from "../../../command/commandService";
import { generateProject } from "../../../export/codegen/codegen";
import { getDb } from "../../../queries/connection";
import { designDecisions, frames, pageBoards } from "@db/schema";
import { validateProposal } from "../../validation/ValidationPipeline";
import { runReview } from "../../experts";
import type { AgentContext } from "../../context/ContextBuilder";
import type { LLMProvider } from "../LLMProvider";
import { defineTool, ToolRuntime } from "../ToolRuntime";
import { kimiGenerateOps, tryParseSurfaces } from "../../../llm/kimi";
import { SURFACE_SYSTEM_PROMPT, buildCreateUserPrompt, buildOpsUserMessage, buildSelectedDesc } from "../../../llm/prompts";

/**
 * 具名工具注册表(文档 §9.2)
 *
 * - 只读上下文:get_project_summary / get_doc_slice / get_design_tokens / list_catalog / get_component_schema / get_recent_decisions
 * - Proposal:propose_a2ui_surface / propose_design_ops(经 LLMProvider,非流式;流式预览由 Orchestrator 承担)
 * - 校验评审:validate_ir / check_accessibility / evaluate_ux
 * - 项目事务:create_snapshot / commit_ops(仅 Orchestrator)/ rollback_run(必须 userConfirmed)
 * - 工程:export_project(codegen 生成工程文件清单;打包与完整门禁走 exports 路由)
 *
 * LLM 依赖经 deps 注入(Orchestrator 构造注册表时传入),工具本身无全局状态,可单测。
 */

export interface ToolRegistryDeps {
  /** LLM 依赖(propose_* / evaluate_ux 使用;未注入时调用即报错) */
  provider?: LLMProvider;
  /** evaluate_ux 所需的请求上下文(Critic 提示词读取 userMessage) */
  userMessage?: string;
}

const DOC_IO_LIMIT = 6 * 1024 * 1024; // 整文档入参/出参上限(IR 序列化后可达数 MB)

/** 从 IR 文档提取 scope 子树(向下 depth 层) */
function sliceNodes(doc: IRDocument, surfaceId: string, nodeIds: string[], depth: number): Record<string, IRNode> {
  const surface = doc.surfaces[surfaceId];
  const out: Record<string, IRNode> = {};
  if (!surface) return out;
  const collect = (id: string, d: number) => {
    const n = surface.components[id];
    if (!n || d > depth) return;
    out[id] = n;
    n.children.forEach((c) => collect(c, d + 1));
  };
  nodeIds.forEach((id) => collect(id, 0));
  return out;
}

const validateInputSchema = z.object({
  baseDoc: z.custom<IRDocument>((v) => typeof v === "object" && v !== null),
  ops: z.array(z.unknown()),
  uiLibraryId: z.string().optional(),
});

export function buildToolRegistry(deps: ToolRegistryDeps = {}): ToolRuntime {
  const runtime = new ToolRuntime();

  // ---------------------------------------------------------------------------
  // 只读上下文(§9.2.2,viewer 即可)
  // ---------------------------------------------------------------------------

  runtime.register(
    defineTool({
      name: "get_project_summary",
      description: "获取项目页面/画框结构与主题预设摘要",
      inputSchema: z.object({ projectId: z.number().int() }),
      outputSchema: z.object({ summary: z.string(), boards: z.number(), frames: z.number() }),
      requiredRole: "viewer",
      execute: async (input) => {
        const db = getDb();
        const boards = db.select().from(pageBoards).all().filter((b) => b.projectId === input.projectId);
        const boardIds = new Set(boards.map((b) => b.id));
        const projectFrames = db.select().from(frames).all().filter((f) => boardIds.has(f.pageBoardId));
        const head = loadHead(input.projectId);
        return {
          summary: [
            `页面 ${boards.length} 个:${boards.map((b) => b.title).join("、") || "(空)"}`,
            `画框 ${projectFrames.length} 个:${projectFrames.map((f) => `${f.title || f.surfaceId}(${f.device})`).join("、") || "(空)"}`,
            `主题预设:${head?.doc.theme.preset ?? "unknown"}`,
          ].join("\n"),
          boards: boards.length,
          frames: projectFrames.length,
        };
      },
    }),
  );

  runtime.register(
    defineTool({
      name: "get_doc_slice",
      description: "获取指定 surface 的组件子树(缺省全量,给定 nodeIds 时向下取 depth 层,默认 2)",
      inputSchema: z.object({
        projectId: z.number().int(),
        surfaceId: z.string().min(1),
        nodeIds: z.array(z.string()).max(50).optional(),
        depth: z.number().int().min(1).max(8).default(2),
      }),
      outputSchema: z.object({ surfaceId: z.string(), nodes: z.record(z.string(), z.unknown()) }),
      requiredRole: "viewer",
      maxOutputBytes: DOC_IO_LIMIT,
      execute: async (input) => {
        const head = loadHead(input.projectId);
        if (!head) throw new Error("项目还没有 Design IR");
        const nodes = input.nodeIds?.length
          ? sliceNodes(head.doc, input.surfaceId, input.nodeIds, input.depth)
          : head.doc.surfaces[input.surfaceId]?.components ?? {};
        return { surfaceId: input.surfaceId, nodes: nodes as Record<string, unknown> };
      },
    }),
  );

  runtime.register(
    defineTool({
      name: "get_design_tokens",
      description: "获取当前 Design IR 主题令牌(preset + tokens)",
      inputSchema: z.object({ projectId: z.number().int() }),
      outputSchema: z.object({ preset: z.string(), tokens: z.record(z.string(), z.union([z.string(), z.number()])) }),
      requiredRole: "viewer",
      execute: async (input) => {
        const head = loadHead(input.projectId);
        if (!head) throw new Error("项目还没有 Design IR");
        return { preset: head.doc.theme.preset, tokens: head.doc.theme.tokens as Record<string, string | number> };
      },
    }),
  );

  runtime.register(
    defineTool({
      name: "list_catalog",
      description: "获取可用组件目录摘要(按分组)",
      inputSchema: z.object({}),
      outputSchema: z.object({ groups: z.array(z.object({ group: z.string(), types: z.array(z.string()) })), total: z.number() }),
      requiredRole: "viewer",
      execute: async () => ({
        groups: CATALOG_GROUPS.map((g) => ({ group: g.group, types: [...g.types] })),
        total: CATALOG_TYPES.length,
      }),
    }),
  );

  runtime.register(
    defineTool({
      name: "get_component_schema",
      description: "获取组件元信息(是否在 Catalog/是否容器类型;完整 props 参考 props-guide)",
      inputSchema: z.object({ componentType: z.string().min(1) }),
      outputSchema: z.object({ componentType: z.string(), known: z.boolean(), container: z.boolean() }),
      requiredRole: "viewer",
      execute: async (input) => ({
        componentType: input.componentType,
        known: CATALOG_TYPES.includes(input.componentType),
        container: CONTAINER_TYPES.has(input.componentType),
      }),
    }),
  );

  runtime.register(
    defineTool({
      name: "get_recent_decisions",
      description: "获取近期设计决策日志(默认 5 条)",
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
      outputSchema: z.object({
        decisions: z.array(
          z.object({ decisionId: z.string(), topic: z.string(), chosen: z.string(), rationale: z.string(), confidence: z.number() }),
        ),
      }),
      requiredRole: "viewer",
      execute: async (input) => {
        const rows = getDb()
          .select()
          .from(designDecisions)
          .orderBy(desc(designDecisions.id))
          .limit(input.limit)
          .all();
        return {
          decisions: rows.map((d) => ({
            decisionId: d.decisionId,
            topic: d.topic,
            chosen: d.chosen,
            rationale: d.rationale,
            confidence: d.confidence / 100,
          })),
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // 校验与评审(§9.2.4;Orchestrator 主调用方)
  // ---------------------------------------------------------------------------

  const validateOutputSchema = z.object({
    issues: z.array(z.custom<ValidationIssue>((v) => typeof v === "object" && v !== null)),
    blocking: z.boolean(),
  });

  runtime.register(
    defineTool({
      name: "validate_ir",
      description: "确定性校验:IR schema/引用/Catalog/布局/数据绑定/Token/安全/Adapter(文档 §13.1 第一层)",
      inputSchema: validateInputSchema,
      outputSchema: validateOutputSchema,
      requiredRole: "viewer",
      maxInputBytes: DOC_IO_LIMIT,
      maxOutputBytes: DOC_IO_LIMIT,
      execute: async (input) => {
        const issues = validateProposal({ baseDoc: input.baseDoc, ops: input.ops as never, uiLibraryId: input.uiLibraryId });
        return { issues, blocking: issues.some((i) => i.severity === "error") };
      },
    }),
  );

  runtime.register(
    defineTool({
      name: "check_accessibility",
      description: "WCAG 确定性子集检查(Image alt/可访问名称/对比度);返回 a11y 层问题",
      inputSchema: validateInputSchema,
      outputSchema: validateOutputSchema,
      requiredRole: "viewer",
      maxInputBytes: DOC_IO_LIMIT,
      maxOutputBytes: DOC_IO_LIMIT,
      execute: async (input) => {
        const issues = validateProposal({ baseDoc: input.baseDoc, ops: input.ops as never, uiLibraryId: input.uiLibraryId }).filter(
          (i) => i.layer === "accessibility",
        );
        return { issues, blocking: issues.some((i) => i.severity === "error") };
      },
    }),
  );

  runtime.register(
    defineTool({
      name: "evaluate_ux",
      description: "LLM 专家评审(Design Critic),输出结构化 UXReviewReport",
      inputSchema: z.object({
        surfaceSummary: z.string().min(1).max(32_000),
        plan: z.custom<DesignPlan>((v) => typeof v === "object" && v !== null).optional(),
      }),
      outputSchema: z.object({ report: z.unknown() }),
      requiredRole: "editor",
      timeoutMs: 180_000,
      execute: async (input) => {
        if (!deps.provider) throw new Error("evaluate_ux 需要 LLM Provider(deps.provider 未注入)");
        const ctx = { request: { userMessage: deps.userMessage ?? "" } } as unknown as AgentContext;
        return { report: await runReview(deps.provider, ctx, input.surfaceSummary, input.plan) };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // Proposal 生成(§9.2.3;LLM 依赖注入,非流式路径)
  // ---------------------------------------------------------------------------

  runtime.register(
    defineTool({
      name: "propose_a2ui_surface",
      description: "按需求生成完整 Surface Proposal(非流式;流式渐进预览由 Orchestrator 承担)",
      inputSchema: z.object({
        requirement: z.string().min(1).max(8000),
        device: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
      }),
      outputSchema: z.object({ docs: z.unknown().optional(), error: z.string().optional() }),
      requiredRole: "editor",
      sideEffect: "proposal",
      idempotent: false,
      timeoutMs: 300_000,
      maxOutputBytes: DOC_IO_LIMIT,
      execute: async (input) => {
        if (!deps.provider) throw new Error("propose_a2ui_surface 需要 LLM Provider(deps.provider 未注入)");
        const raw = await deps.provider.complete({
          system: SURFACE_SYSTEM_PROMPT,
          user: buildCreateUserPrompt(input.requirement, input.device),
          profile: "generation",
        });
        const { docs, error } = tryParseSurfaces(raw);
        return { docs, error };
      },
    }),
  );

  runtime.register(
    defineTool({
      name: "propose_design_ops",
      description: "对指定 surface 生成局部 IR Ops Proposal(非流式)",
      inputSchema: z.object({
        projectId: z.number().int(),
        surfaceId: z.string().min(1),
        instruction: z.string().min(1).max(8000),
        nodeIds: z.array(z.string()).max(50).optional(),
      }),
      outputSchema: z.object({ ops: z.array(z.unknown()) }),
      requiredRole: "editor",
      sideEffect: "proposal",
      idempotent: false,
      timeoutMs: 300_000,
      maxInputBytes: DOC_IO_LIMIT,
      maxOutputBytes: DOC_IO_LIMIT,
      execute: async (input, context) => {
        if (!deps.provider) throw new Error("propose_design_ops 需要 LLM Provider(deps.provider 未注入)");
        const head = loadHead(input.projectId);
        if (!head) throw new Error("项目还没有 Design IR");
        const surface = head.doc.surfaces[input.surfaceId];
        if (!surface) throw new Error(`surface ${input.surfaceId} 不存在`);
        const nodeIds = input.nodeIds ?? [];
        const contextNodes: Record<string, unknown> = {};
        if (nodeIds.length) {
          for (const id of nodeIds) {
            const n = surface.components[id];
            if (n) contextNodes[id] = n;
          }
        } else {
          Object.assign(contextNodes, surface.components);
        }
        const userMsg = buildOpsUserMessage({
          tokens: head.doc.theme.tokens,
          contextNodes,
          selectedDesc: buildSelectedDesc(nodeIds, (a) => surface.components[a]?.type),
          instruction: input.instruction,
          history: "",
        });
        const ops = await kimiGenerateOps(
          { ...deps.provider.cfg, signal: context.abortSignal },
          userMsg,
          { ...surface, theme: head.doc.theme } as never,
          nodeIds,
        );
        return { ops: ops as unknown as unknown[] };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // 项目与事务(§9.2.5)
  // ---------------------------------------------------------------------------

  runtime.register(
    defineTool({
      name: "create_snapshot",
      description: "为当前 head revision 创建命名快照",
      inputSchema: z.object({ projectId: z.number().int(), label: z.string().min(1).max(120), kind: z.enum(["auto", "manual"]).default("manual") }),
      outputSchema: z.object({ revision: z.number() }),
      requiredRole: "editor",
      sideEffect: "transaction",
      idempotent: false,
      execute: async (input) => createSnapshot(input.projectId, input.label, input.kind),
    }),
  );

  runtime.register(
    defineTool({
      name: "commit_ops",
      description: "原子提交 OpsBatch 到 Design IR(单点提交;仅 Orchestrator 可调)",
      inputSchema: z.object({
        projectId: z.number().int(),
        baseRevision: z.number().int().nonnegative(),
        ops: z.array(z.unknown()),
        scope: z.record(z.string(), z.unknown()).optional(),
        provenance: z.record(z.string(), z.unknown()),
        batchId: z.string().optional(),
        boards: z.array(z.record(z.string(), z.unknown())).optional(),
        frames: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
      outputSchema: z.object({ revision: z.number(), batchId: z.string() }),
      requiredRole: "editor",
      orchestratorOnly: true, // 文档 §9.1:Commit 工具只能由 Orchestrator 调用
      sideEffect: "transaction",
      idempotent: false,
      maxInputBytes: DOC_IO_LIMIT,
      maxOutputBytes: DOC_IO_LIMIT,
      execute: async (input) => commitRunChanges(input as unknown as Parameters<typeof commitRunChanges>[0]),
    }),
  );

  runtime.register(
    defineTool({
      name: "rollback_run",
      description: "按 Run 原子回滚全部已提交批次;必须显式传入 userConfirmed=true(HITL)",
      inputSchema: z.object({
        projectId: z.number().int(),
        runId: z.string().min(1),
        userConfirmed: z.literal(true),
      }),
      outputSchema: z.object({ revision: z.number(), batches: z.number() }),
      requiredRole: "editor",
      sideEffect: "transaction",
      idempotent: false,
      execute: async (input) => rollbackRun(input.projectId, input.runId),
    }),
  );

  // ---------------------------------------------------------------------------
  // 工程(§9.2.6)
  // ---------------------------------------------------------------------------

  runtime.register(
    defineTool({
      name: "export_project",
      description: "基于当前 head revision 生成导出工程文件清单(实际打包/门禁走 exports 路由)",
      inputSchema: z.object({
        projectId: z.number().int(),
        projectName: z.string().min(1).max(60),
        adapterId: z.string().default("shadcn-tailwind"),
        surfaceIds: z.array(z.string()).max(50).optional(),
      }),
      outputSchema: z.object({
        fileCount: z.number(),
        paths: z.array(z.string()),
        unmapped: z.array(z.object({ surfaceId: z.string(), type: z.string() })),
      }),
      requiredRole: "editor",
      sideEffect: "external",
      idempotent: false,
      timeoutMs: 120_000,
      maxOutputBytes: DOC_IO_LIMIT,
      execute: async (input) => {
        const head = loadHead(input.projectId);
        if (!head) throw new Error("项目还没有 Design IR");
        const db = getDb();
        const frameRows = db.select().from(frames).all();
        const pages = frameRows
          .filter((f) => !input.surfaceIds?.length || input.surfaceIds.includes(f.surfaceId))
          .map((f) => ({ surfaceId: f.surfaceId, title: f.title || f.surfaceId, device: f.device as DeviceId }));
        const result = generateProject({ projectName: input.projectName, doc: head.doc, pages, adapterId: input.adapterId });
        return { fileCount: result.files.length, paths: result.files.map((f) => f.path), unmapped: result.unmapped };
      },
    }),
  );

  return runtime;
}
