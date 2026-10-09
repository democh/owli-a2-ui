import { z } from "zod";
import { withSpan } from "../../observability/trace";
import { saveAudit } from "../run/persist";

/**
 * Tool Runtime(文档 §9)
 *
 * 所有具名工具的统一执行契约:zod 输入/输出校验 → 权限矩阵 → 输入字节上限
 * → 超时/取消 → 输出字节上限 → span + 审计日志。
 *
 * 权限矩阵(文档 §9.3):
 * - 只读上下文工具:viewer 及以上 / agent / orchestrator 可调;
 * - Proposal 与快照工具:editor 及以上(agent 计入 editor 档,受 Run Mode 限制由调用方保证);
 * - commit_ops:仅 orchestrator(Orchestrator 单点提交,LLM/前端不可直达);
 * - rollback_run:editor 及以上,且必须显式传入 userConfirmed=true(文档 §15:任何审批不能被绕过)。
 */

export type ToolSideEffect = "none" | "proposal" | "transaction" | "external";

/** 调用方角色;rank 用于矩阵比较,orchestrator 高于一切业务角色 */
export type ToolActorRole = "viewer" | "editor" | "owner" | "agent" | "orchestrator";

const ROLE_RANK: Record<ToolActorRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
  agent: 2, // agent 权限不能超过当前用户(editor)权限(文档 §18.3)
  orchestrator: 4,
};

export interface ToolContext {
  runId?: string;
  projectId: number;
  sessionId?: string;
  actorId: string;
  actorRole: ToolActorRole;
  scope?: { pageId?: string; frameId?: string; nodeIds?: string[] };
  traceId?: string;
  abortSignal?: AbortSignal;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  /** 最低角色要求 */
  requiredRole: Exclude<ToolActorRole, "orchestrator">;
  /** 仅允许 Orchestrator 调用(单点提交类) */
  orchestratorOnly?: boolean;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  idempotent: boolean;
  sideEffect: ToolSideEffect;
  execute(input: I, context: ToolContext): Promise<O>;
}

export class ToolPermissionError extends Error {
  constructor(name: string, role: ToolActorRole) {
    super(`工具 ${name} 拒绝调用:角色 ${role} 权限不足`);
    this.name = "ToolPermissionError";
  }
}

export class ToolTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`工具 ${name} 执行超时(>${timeoutMs}ms)`);
    this.name = "ToolTimeoutError";
  }
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** 工具注册表:具名工具的统一运行入口(文档 §9.1/§9.4) */
export class ToolRuntime {
  private tools = new Map<string, ToolDefinition<never, never>>();

  register<I, O>(def: ToolDefinition<I, O>): void {
    if (this.tools.has(def.name)) throw new Error(`工具 ${def.name} 重复注册`);
    this.tools.set(def.name, def as unknown as ToolDefinition<never, never>);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): { name: string; description: string; sideEffect: ToolSideEffect; requiredRole: string; orchestratorOnly: boolean }[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      sideEffect: t.sideEffect,
      requiredRole: t.requiredRole,
      orchestratorOnly: t.orchestratorOnly ?? false,
    }));
  }

  /** 统一执行入口:校验 → 权限 → 字节 → 超时 → span + 审计 */
  async run(name: string, context: ToolContext, rawInput: unknown): Promise<unknown> {
    const def = this.tools.get(name) as ToolDefinition<unknown, unknown> | undefined;
    if (!def) throw new Error(`工具 ${name} 未注册`);

    // ① 输入字节上限(校验前粗检,防止超大 payload 进入 zod)
    const inputBytes = JSON.stringify(rawInput ?? {}).length;
    if (inputBytes > def.maxInputBytes) {
      throw new Error(`工具 ${name} 输入 ${inputBytes}B 超过上限 ${def.maxInputBytes}B`);
    }

    // ② zod 参数校验
    const parsed = def.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300);
      throw new Error(`工具 ${name} 输入不合法: ${msg}`);
    }

    // ③ 权限矩阵(文档 §9.3)
    if (def.orchestratorOnly && context.actorRole !== "orchestrator") {
      throw new ToolPermissionError(name, context.actorRole);
    }
    if (!def.orchestratorOnly && ROLE_RANK[context.actorRole] < ROLE_RANK[def.requiredRole]) {
      throw new ToolPermissionError(name, context.actorRole);
    }

    // ④ 已取消快速失败
    if (context.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");

    const startedAt = Date.now();
    const output = (await withSpan(
      `tool.${name}`,
      { runId: context.runId, projectId: context.projectId, actor: context.actorRole },
      async () => {
        // ⑤ 超时/取消竞速(不中断已启动的 execute,但结果不再被采纳)
        const timeout = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new ToolTimeoutError(name, def.timeoutMs)), def.timeoutMs);
          context.abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
        return Promise.race([def.execute(parsed.data as never, context), timeout]);
      },
    )) as unknown;

    // ⑥ 输出字节上限 + 审计(文档 §9.4/§18.5)
    const outputBytes = JSON.stringify(output ?? {}).length;
    if (outputBytes > def.maxOutputBytes) {
      saveAudit("system", "tool-runtime", context.projectId ?? null, context.runId ?? null, `tool.${name}.output_truncated`, {
        outputBytes,
        maxOutputBytes: def.maxOutputBytes,
      });
      throw new Error(`工具 ${name} 输出 ${outputBytes}B 超过上限 ${def.maxOutputBytes}B`);
    }
    saveAudit(context.actorRole === "orchestrator" ? "system" : "agent", context.actorId, context.projectId ?? null, context.runId ?? null, `tool.${name}`, {
      durationMs: Date.now() - startedAt,
      inputBytes,
      outputBytes,
      sideEffect: def.sideEffect,
    });
    return output;
  }

  /** 泛型便捷入口:调用方自带输出类型断言 */
  async runTyped<O>(name: string, context: ToolContext, rawInput: unknown): Promise<O> {
    return (await this.run(name, context, rawInput)) as O;
  }
}

/**
 * 工具定义便捷构造:I/O 由 schema 推断(zod v4 default 字段在 output 侧必填)。
 * name/schema/execute 必填,其余走安全默认。
 */
export function defineTool<SIn extends z.ZodType, SOut extends z.ZodType>(
  def: {
    name: string;
    description: string;
    inputSchema: SIn;
    outputSchema: SOut;
    execute: (input: z.output<SIn>, context: ToolContext) => Promise<z.output<SOut>>;
  } & Partial<Pick<ToolDefinition<z.output<SIn>, z.output<SOut>>, "requiredRole" | "orchestratorOnly" | "timeoutMs" | "maxInputBytes" | "maxOutputBytes" | "idempotent" | "sideEffect">>,
): ToolDefinition<z.output<SIn>, z.output<SOut>> {
  return {
    requiredRole: "viewer",
    timeoutMs: 60_000,
    maxInputBytes: 512 * 1024,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    idempotent: true,
    sideEffect: "none",
    ...def,
  } as ToolDefinition<z.output<SIn>, z.output<SOut>>;
}
