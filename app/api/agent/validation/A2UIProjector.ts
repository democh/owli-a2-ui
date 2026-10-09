import type { A2UIServerPayload } from "@contracts/a2ui-protocol";
import {
  type DataModelDefinition,
  type IRDocument,
  type IRSurface,
  type IROperation,
} from "@contracts/design-ir";
import type { ProposalBuffer } from "../runtime/ProposalBuffer";

/**
 * A2UI Projector(文档 §3.2 步骤 5)
 *
 * 把 Proposal Buffer 中已闭合的 A2UI 消息投影为 OpsBatch 的 IROperation 序列:
 * - createSurface + updateComponents → 新建 surface(结构性 addFrame 走 Orchestrator,此处产 surface 数据)
 * - 对既有 surface 的 updateComponents → replaceProps/addNode 语义
 * - updateDataModel → upsertDataModel
 */

export interface ProjectionResult {
  /** surface 快照(create 路径:整面新建) */
  newSurfaces: IRSurface[];
  /** 局部修改 ops(对既有 surface) */
  ops: IROperation[];
  dataModels: DataModelDefinition[];
}

export class ProjectionError extends Error {}

/**
 * 将 Buffer 内容投影为 ops。
 * 投影策略:createSurface 新建的 surface 走 newSurfaces(整面上架,由 Orchestrator 组装 addFrame op);
 * 命中既有 surface 的消息:若 buffer 中该 surface 是从 createSurface 开始的完整生成,仍归入 newSurfaces;
 * 否则按"组件 upsert 集合 → replaceProps(已存在)/addNode(新增,挂 root)"投影。
 */
export function projectBuffer(buffer: ProposalBuffer, currentDoc: IRDocument): ProjectionResult {
  const result: ProjectionResult = { newSurfaces: [], ops: [], dataModels: [] };
  for (const surfaceId of buffer.surfaceIds) {
    const s = buffer.getSurface(surfaceId);
    if (!s || s.components.size === 0) continue;

    // 数据模型投影
    for (const dm of s.dataModels.values()) {
      const schema: Record<string, string> = {};
      const v = dm.value;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          schema[k] = Array.isArray(val) ? "array" : val === null ? "object" : typeof val;
        }
      }
      result.dataModels.push({
        id: dm.modelId,
        name: dm.modelId,
        schema,
        initialValue: dm.value,
        mockValue: dm.value,
      });
    }

    const existed = !!currentDoc.surfaces[surfaceId];
    if (!existed) {
      // 新建 surface:整面上架
      const root = s.root ?? [...s.components.keys()][0];
      if (!root || !s.components.has(root)) {
        throw new ProjectionError(`surface "${surfaceId}" 闭合性校验失败:root 缺失`);
      }
      result.newSurfaces.push({
        id: surfaceId,
        title: s.title ?? "",
        root,
        components: Object.fromEntries(s.components),
      });
      continue;
    }

    // 既有 surface 的局部修改投影
    const cur = currentDoc.surfaces[surfaceId];
    for (const [id, comp] of s.components) {
      if (cur.components[id]) {
        result.ops.push({
          op: "replaceProps",
          surfaceId,
          id,
          props: comp.props ?? {},
        });
      } else {
        // 新增组件:挂到 root 末尾(Proposal 生成方应显式给出挂载点;此处为保守兜底)
        result.ops.push({
          op: "addNode",
          surfaceId,
          parentId: cur.root,
          id,
          node: { type: comp.type, props: comp.props ?? {}, children: comp.children ?? [] },
          extra: {},
        });
      }
    }
  }
  return result;
}

/** 从 LLM 原始输出解析 A2UI 消息序列(JSONL 或 JSON 数组,文档 §11.10.9) */
export function parseA2uiMessageStream(raw: string): A2UIServerPayload[] {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const messages: A2UIServerPayload[] = [];
  // 优先按 JSON 数组解析
  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const arr = JSON.parse(cleaned.slice(arrStart, arrEnd + 1)) as unknown[];
      for (const item of arr) messages.push(normalizeMessage(item));
      return messages;
    } catch {
      /* 落入 JSONL 解析 */
    }
  }
  // JSONL:逐行解析 {kind:...}
  for (const line of cleaned.split("\n")) {
    const t = line.trim().replace(/,$/, "");
    if (!t.startsWith("{")) continue;
    try {
      messages.push(normalizeMessage(JSON.parse(t)));
    } catch {
      /* 跳过半行 */
    }
  }
  if (messages.length === 0) {
    // 兜底:整体按单个 JSON 对象解析
    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      messages.push(normalizeMessage(JSON.parse(cleaned.slice(objStart, objEnd + 1))));
    }
  }
  return messages;
}

interface RawMessage {
  kind?: string;
  surfaceId?: string;
  root?: string;
  title?: string;
  components?: unknown;
  batchEnd?: boolean;
  modelId?: string;
  value?: unknown;
  path?: string;
}

function normalizeMessage(item: unknown): A2UIServerPayload {
  const m = (item ?? {}) as RawMessage;
  switch (m.kind) {
    case "createSurface":
      return { kind: "createSurface", surfaceId: m.surfaceId ?? "", root: m.root, title: m.title };
    case "updateComponents":
      return {
        kind: "updateComponents",
        surfaceId: m.surfaceId ?? "",
        components: (m.components ?? []) as never,
        batchEnd: m.batchEnd ?? false,
      };
    case "updateDataModel":
      return {
        kind: "updateDataModel",
        surfaceId: m.surfaceId ?? "",
        modelId: m.modelId ?? "",
        value: m.value,
        path: m.path,
      };
    case "deleteSurface":
      return { kind: "deleteSurface", surfaceId: m.surfaceId ?? "" };
    default:
      throw new ProjectionError(`未知的 A2UI 消息类型: ${String(m.kind)}`);
  }
}
