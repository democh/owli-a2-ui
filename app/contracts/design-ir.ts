import { z } from "zod";
import {
  CATALOG_TYPES,
  DEVICES,
  DEVICE_IDS,
  PRESET_IDS,
  themeTokensSchema,
  catalogTypeSchema,
  type ThemeTokens,
  type PresetId,
} from "./a2ui";

/**
 * Design IR —— 设计文档的单一事实源(共享契约)
 *
 * 边界(文档 §3.2):
 * - IR 必须始终保持完整、可校验、可恢复
 * - LLM 只能产出 Proposal,不能直接写 IR
 * - 所有修改必须通过 OpsBatch + baseRevision + Command Service 原子提交
 *
 * 模型:
 * - IRDocument 按项目组织:surfaces(每 Frame 一个 surface) + dataModels + theme
 * - PageBoard(页面) 分组多个 Frame,Frame ↔ A2UI surfaceId 一一映射
 * - 组件沿用扁平邻接表(类型与风格解耦,渲染器注册表消费)
 */

export { CATALOG_TYPES, DEVICES, DEVICE_IDS, PRESET_IDS };
export type { ThemeTokens, PresetId };
export { themeTokensSchema, catalogTypeSchema };
export type DeviceId = keyof typeof DEVICES;

// ---------------------------------------------------------------------------
// 节点与 Surface
// ---------------------------------------------------------------------------

export const irNodeSchema = z.object({
  type: catalogTypeSchema,
  props: z.record(z.string(), z.unknown()).default({}),
  children: z.array(z.string()).default([]),
  /** M7 组件实例:引用 componentDefs 中的定义;渲染/导出时由 resolveInstances 展开 */
  instanceOf: z.string().optional(),
});
export type IRNode = z.infer<typeof irNodeSchema>;

/** M7 组件定义:从 surface 子树提取的可复用组件(实例节点 instanceOf 指向它) */
export const componentDefSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  /** 定义来源(供逆运算重建) */
  surfaceId: z.string().default(""),
  rootId: z.string().default(""),
  /** 定义内部根 id(= 提取时的 rootId) */
  root: z.string(),
  components: z.record(z.string(), irNodeSchema),
});
export type ComponentDef = z.infer<typeof componentDefSchema>;

export const dataModelDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  /** 简化 schema:字段名 → 类型名(string|number|boolean|array|object),用于确定性类型检查 */
  schema: z.record(z.string(), z.string()).default({}),
  initialValue: z.unknown(),
  mockValue: z.unknown(),
});
export type DataModelDefinition = z.infer<typeof dataModelDefinitionSchema>;

export const irSurfaceSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  components: z.record(z.string(), irNodeSchema),
  root: z.string().min(1),
  /** 关联数据模型(DataModelDefinition.id);缺省表示纯静态 surface */
  dataModelId: z.string().optional(),
});
export type IRSurface = z.infer<typeof irSurfaceSchema>;

export const irThemeSchema = z.object({
  preset: z.enum(PRESET_IDS as [PresetId, ...PresetId[]]).default("shadcn"),
  tokens: themeTokensSchema.default(themeTokensSchema.parse({})),
});
export type IRTheme = z.infer<typeof irThemeSchema>;

export const irDocumentSchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  theme: irThemeSchema.default(irThemeSchema.parse({})),
  surfaces: z.record(z.string(), irSurfaceSchema),
  dataModels: z.record(z.string(), dataModelDefinitionSchema).default({}),
  /** M7 组件定义池(实例节点的 instanceOf 引用) */
  componentDefs: z.record(z.string(), componentDefSchema).default({}),
});
export type IRDocument = z.infer<typeof irDocumentSchema>;

// ---------------------------------------------------------------------------
// 页面与画框(画布布局几何,持久化于 IR 之外的关系表,但同事务提交)
// ---------------------------------------------------------------------------

export const pageBoardSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  title: z.string().min(1),
  posX: z.number().int().default(0),
  posY: z.number().int().default(0),
});
export type PageBoard = z.infer<typeof pageBoardSchema>;

export const frameSchema = z.object({
  id: z.number().int(),
  pageId: z.number().int(),
  surfaceId: z.string().min(1),
  title: z.string().default(""),
  device: z.enum(DEVICE_IDS as [DeviceId, ...DeviceId[]]).default("desktop"),
  width: z.number().int().default(DEVICES.desktop.width),
  height: z.number().int().default(DEVICES.desktop.height),
  posX: z.number().int().default(0),
  posY: z.number().int().default(0),
});
export type Frame = z.infer<typeof frameSchema>;

// ---------------------------------------------------------------------------
// IROperation —— 一组原子 IR 修改(文档 §8.5 OpsBatch 的 ops 项)
// ---------------------------------------------------------------------------

export const irOperationSchema = z.discriminatedUnion("op", [
  // 组件树(局部修改路径)
  z.object({
    op: z.literal("replaceProps"),
    surfaceId: z.string(),
    id: z.string(),
    props: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal("addNode"),
    surfaceId: z.string(),
    parentId: z.string(),
    index: z.number().int().optional(),
    id: z.string(),
    node: irNodeSchema,
    /** 附带的子孙节点 */
    extra: z.record(z.string(), irNodeSchema).default({}),
  }),
  z.object({ op: z.literal("removeNode"), surfaceId: z.string(), id: z.string() }),
  z.object({
    op: z.literal("moveNode"),
    surfaceId: z.string(),
    id: z.string(),
    newParentId: z.string(),
    index: z.number().int().optional(),
  }),
  // 主题与标题
  z.object({ op: z.literal("setTokens"), tokens: themeTokensSchema.partial() }),
  z.object({ op: z.literal("setSurfaceTitle"), surfaceId: z.string(), title: z.string() }),
  // 数据模型
  z.object({ op: z.literal("upsertDataModel"), model: dataModelDefinitionSchema }),
  // 结构性修改(创建页面 / Frame 走 Proposal → Command)
  z.object({ op: z.literal("addPage"), page: pageBoardSchema }),
  z.object({ op: z.literal("removePage"), pageId: z.number().int() }),
  z.object({ op: z.literal("updatePage"), pageId: z.number().int(), patch: pageBoardSchema.partial() }),
  z.object({
    op: z.literal("addFrame"),
    frame: frameSchema,
    /** 同批创建的 surface(数据进 doc.surfaces,保证 IR 完整性) */
    surface: irSurfaceSchema,
  }),
  z.object({
    op: z.literal("updateFrame"),
    frameId: z.number().int(),
    patch: frameSchema.partial(),
    surfaceId: z.string().optional(),
  }),
  z.object({
    op: z.literal("removeFrame"),
    frameId: z.number().int(),
    /** 同步从 IR 删除的 surface(frame ↔ surface 一一映射) */
    surfaceId: z.string().optional(),
  }),
  // M7 组件定义/实例
  z.object({
    op: z.literal("defineComponent"),
    defId: z.string(),
    name: z.string().optional(),
    surfaceId: z.string(),
    rootId: z.string(),
    /** 显式快照(undo 重建用);缺省时从当前 surface 提取 rootId 子树 */
    snapshot: z.object({ root: z.string(), components: z.record(z.string(), irNodeSchema) }).optional(),
  }),
  z.object({ op: z.literal("removeComponentDef"), defId: z.string() }),
]);
export type IROperation = z.infer<typeof irOperationSchema>;

// ---------------------------------------------------------------------------
// OpsBatch(文档 §8.5)
// ---------------------------------------------------------------------------

export const designScopeSchema = z.object({
  pageId: z.string().optional(),
  frameId: z.string().optional(),
  nodeIds: z.array(z.string()).optional(),
});
export type DesignScope = z.infer<typeof designScopeSchema>;

export const opsBatchSchema = z.object({
  batchId: z.string().min(1),
  projectId: z.number().int(),
  baseRevision: z.number().int().nonnegative(),
  scope: designScopeSchema.default({}),
  ops: z.array(irOperationSchema),
  inverseOps: z.array(irOperationSchema).optional(),
  provenance: z.object({
    actorType: z.enum(["user", "agent", "system", "import"]),
    actorId: z.string(),
    runId: z.string().optional(),
    proposalId: z.string().optional(),
    promptVersion: z.string().optional(),
    model: z.string().optional(),
  }),
  createdAt: z.string(),
});
export type OpsBatch = z.infer<typeof opsBatchSchema>;

// ---------------------------------------------------------------------------
// 应用 ops(不可变,返回新 doc)
// ---------------------------------------------------------------------------

/** 递归收集 rootId 子树(components 深拷贝) */
function extractSubtree(components: Record<string, IRNode>, rootId: string): Record<string, IRNode> {
  const out: Record<string, IRNode> = {};
  const collect = (id: string): void => {
    const n = components[id];
    if (!n || out[id]) return;
    out[id] = clone(n);
    n.children.forEach(collect);
  };
  collect(rootId);
  return out;
}

/**
 * M7 实例展开:把 instanceOf 节点替换为其定义的子树(def 内部 id 重映射为
 * `${instanceId}__${defNodeId}`,实例节点自身成为 def 根位置,props 覆盖 def 根 props)。
 * 未定义引用的 instanceOf 节点原样保留。读侧(workspace 投影 / codegen)统一调用,
 * 渲染器与导出器无需感知组件实例。
 */
export function resolveInstances(doc: IRDocument): IRDocument {
  if (!Object.keys(doc.componentDefs ?? {}).length) return doc;
  const next: IRDocument = JSON.parse(JSON.stringify(doc));
  for (const surface of Object.values(next.surfaces)) {
    for (const [id, node] of Object.entries(surface.components)) {
      const defId = node.instanceOf;
      if (!defId) continue;
      const def = next.componentDefs[defId];
      if (!def) continue;
      const mapId = (k: string) => (k === def.root ? id : `${id}__${k}`);
      for (const [k, defNode] of Object.entries(def.components)) {
        const mapped = mapId(k);
        if (mapped === id || surface.components[mapped]) continue;
        const copy = clone(defNode);
        copy.children = copy.children.map(mapId);
        surface.components[mapped] = copy;
      }
      // 实例节点替换为 def 根内容:props 覆盖,children = def 根 children(重映射) + 实例自有 children
      surface.components[id]!.props = { ...def.components[def.root]?.props, ...node.props };
      surface.components[id]!.children = [
        ...(def.components[def.root]?.children ?? []).map(mapId),
        ...node.children,
      ];
      delete surface.components[id]!.instanceOf;
    }
  }
  return next;
}

export function applyIRops(doc: IRDocument, ops: IROperation[]): IRDocument {
  const next: IRDocument = JSON.parse(JSON.stringify(doc));
  for (const op of ops) {
    switch (op.op) {
      case "replaceProps": {
        const s = next.surfaces[op.surfaceId];
        const n = s?.components[op.id];
        if (n) n.props = { ...n.props, ...op.props };
        break;
      }
      case "addNode": {
        const s = next.surfaces[op.surfaceId];
        const parent = s?.components[op.parentId];
        if (!s || !parent) break;
        s.components[op.id] = op.node;
        for (const [k, v] of Object.entries(op.extra ?? {})) s.components[k] = v;
        const idx = op.index ?? parent.children.length;
        parent.children = [
          ...parent.children.slice(0, idx),
          op.id,
          ...parent.children.slice(idx),
        ].filter((c, i, arr) => arr.indexOf(c) === i);
        break;
      }
      case "removeNode": {
        const s = next.surfaces[op.surfaceId];
        if (!s) break;
        const removeRecursive = (id: string) => {
          const n = s.components[id];
          if (!n) return;
          n.children.forEach(removeRecursive);
          delete s.components[id];
        };
        removeRecursive(op.id);
        for (const n of Object.values(s.components)) {
          n.children = n.children.filter((c) => c !== op.id);
        }
        break;
      }
      case "moveNode": {
        const s = next.surfaces[op.surfaceId];
        const target = s?.components[op.id];
        const newParent = s?.components[op.newParentId];
        if (!s || !target || !newParent) break;
        for (const n of Object.values(s.components)) {
          n.children = n.children.filter((c) => c !== op.id);
        }
        const idx = op.index ?? newParent.children.length;
        newParent.children.splice(idx, 0, op.id);
        break;
      }
      case "setTokens":
        next.theme.tokens = { ...next.theme.tokens, ...op.tokens };
        break;
      case "defineComponent": {
        // 从 surface 提取 rootId 子树快照(或使用显式快照),存入 componentDefs
        const s = next.surfaces[op.surfaceId];
        const comps = op.snapshot?.components ?? (s ? extractSubtree(s.components, op.rootId) : {});
        if (Object.keys(comps).length) {
          next.componentDefs[op.defId] = {
            id: op.defId,
            name: op.name ?? op.defId,
            surfaceId: op.surfaceId,
            rootId: op.rootId,
            root: op.snapshot?.root ?? op.rootId,
            components: comps,
          };
        }
        break;
      }
      case "removeComponentDef":
        delete next.componentDefs[op.defId];
        break;
      case "setSurfaceTitle": {
        const s = next.surfaces[op.surfaceId];
        if (s) s.title = op.title;
        break;
      }
      case "upsertDataModel":
        next.dataModels[op.model.id] = op.model;
        break;
      case "addPage":
        // 页面/画框几何存关系表,此处仅作占位;Command Service 负责真正落库
        break;
      case "addFrame":
        // surface 随 addFrame 进入 IR(frame ↔ surface 一一映射)
        next.surfaces[op.frame.surfaceId] = clone(op.surface);
        break;
      case "removeFrame":
        if (op.surfaceId) delete next.surfaces[op.surfaceId];
        break;
      case "removePage":
      case "updatePage":
      case "updateFrame":
        break;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// 反向 ops(Undo / Run 回滚;每条 op 相对"应用前状态"求逆,最终逆序应用)
// ---------------------------------------------------------------------------

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** 单条 op 的逆操作;返回 null 表示该 op 相对当前状态无效(如目标不存在) */
function invertOne(cur: IRDocument, op: IROperation): IROperation | null {
  switch (op.op) {
    case "replaceProps": {
      const n = cur.surfaces[op.surfaceId]?.components[op.id];
      if (!n) return null;
      const restore: Record<string, unknown> = {};
      for (const k of Object.keys(op.props)) restore[k] = k in n.props ? clone(n.props[k]) : null;
      // null 语义:恢复"键不存在"。applyIRops 的 merge 会把 null 写进去,因此用 delete 标记:
      // 这里生成 removeProps 不可行(op 集无此语义),改为恢复快照整键值;对不存在的键用 null 占位并在 apply 端跳过
      return { op: "replaceProps", surfaceId: op.surfaceId, id: op.id, props: restore };
    }
    case "addNode": {
      const s = cur.surfaces[op.surfaceId];
      if (!s?.components[op.parentId]) return null;
      return { op: "removeNode", surfaceId: op.surfaceId, id: op.id };
    }
    case "removeNode": {
      const s = cur.surfaces[op.surfaceId];
      const n = s?.components[op.id];
      if (!s || !n) return null;
      // 找到当前父节点与位置
      const parentId = Object.keys(s.components).find((k) => s.components[k].children.includes(op.id));
      if (!parentId) return null;
      const index = s.components[parentId].children.indexOf(op.id);
      // 收集整个子树作为 extra
      const extra: Record<string, IRNode> = {};
      const collect = (id: string) => {
        const node = s.components[id];
        if (!node) return;
        extra[id] = clone(node);
        node.children.forEach(collect);
      };
      collect(op.id);
      const root = extra[op.id];
      delete extra[op.id];
      return { op: "addNode", surfaceId: op.surfaceId, parentId, index, id: op.id, node: root, extra };
    }
    case "moveNode": {
      const s = cur.surfaces[op.surfaceId];
      if (!s?.components[op.id]) return null;
      const oldParentId = Object.keys(s.components).find((k) => s.components[k].children.includes(op.id));
      if (!oldParentId) return null;
      const oldIndex = s.components[oldParentId].children.indexOf(op.id);
      return { op: "moveNode", surfaceId: op.surfaceId, id: op.id, newParentId: oldParentId, index: oldIndex };
    }
    case "setTokens": {
      const restore: Record<string, string | number> = {};
      for (const k of Object.keys(op.tokens)) restore[k] = cur.theme.tokens[k as keyof ThemeTokens];
      return { op: "setTokens", tokens: restore as Partial<ThemeTokens> };
    }
    case "setSurfaceTitle": {
      const s = cur.surfaces[op.surfaceId];
      if (!s) return null;
      return { op: "setSurfaceTitle", surfaceId: op.surfaceId, title: s.title };
    }
    case "upsertDataModel": {
      const prev = cur.dataModels[op.model.id];
      if (!prev) return null; // 新建模型的回滚需要删除语义;保留为不可逆(自动快照兜底)
      return { op: "upsertDataModel", model: clone(prev) };
    }
    case "defineComponent": {
      const prev = cur.componentDefs[op.defId];
      if (!prev) return { op: "removeComponentDef", defId: op.defId }; // 新建定义:撤销即删除
      // 覆盖已有定义:撤销恢复旧快照
      return {
        op: "defineComponent",
        defId: op.defId,
        name: prev.name,
        surfaceId: prev.surfaceId,
        rootId: prev.rootId,
        snapshot: { root: prev.root, components: clone(prev.components) },
      };
    }
    case "removeComponentDef": {
      const prev = cur.componentDefs[op.defId];
      if (!prev) return null;
      return {
        op: "defineComponent",
        defId: op.defId,
        name: prev.name,
        surfaceId: prev.surfaceId,
        rootId: prev.rootId,
        snapshot: { root: prev.root, components: clone(prev.components) },
      };
    }
    default:
      // 结构性 op(addPage/updatePage/addFrame 等)由关系表事务回滚,不走 IR 逆运算
      return null;
  }
}

/**
 * 计算 ops 的逆序列(可直接按数组顺序应用到"前向应用完成后的 doc"上实现 Undo)。
 * 无法求逆的 op(结构性修改/目标缺失)被跳过,由 Command Service 的快照机制兜底。
 */
export function invertIRops(docBefore: IRDocument, ops: IROperation[]): IROperation[] {
  const inverses: IROperation[] = [];
  let cur = docBefore;
  for (const op of ops) {
    const inv = invertOne(cur, op);
    if (inv) inverses.unshift(inv);
    cur = applyIRops(cur, [op]);
  }
  return inverses;
}

// ---------------------------------------------------------------------------
// 深度校验:每个 surface root 存在、引用闭合、无环、悬空组件
// ---------------------------------------------------------------------------

export function validateIR(doc: IRDocument): string[] {
  const errors: string[] = [];
  const surfaceIds = Object.keys(doc.surfaces);
  if (surfaceIds.length === 0) errors.push("文档没有任何 surface");

  for (const sid of surfaceIds) {
    const s = doc.surfaces[sid];
    if (!s.components[s.root]) errors.push(`surface "${sid}" 的 root "${s.root}" 不存在`);
    const visited = new Set<string>();
    const walk = (id: string, stack: string[]) => {
      const node = s.components[id];
      if (!node) {
        errors.push(`surface "${sid}":组件 "${id}" 被引用但不存在`);
        return;
      }
      if (stack.includes(id)) {
        errors.push(`surface "${sid}":检测到循环引用: ${[...stack, id].join(" → ")}`);
        return;
      }
      if (visited.has(id)) return;
      visited.add(id);
      node.children.forEach((c) => walk(c, [...stack, id]));
    };
    walk(s.root, []);
    // 引用完整性:所有组件必须从 root 可达(提交态 IR 不允许悬空节点)
    const reachable = new Set<string>();
    const collect = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      s.components[id]?.children.forEach(collect);
    };
    if (s.components[s.root]) collect(s.root);
    for (const id of Object.keys(s.components)) {
      if (!reachable.has(id)) errors.push(`surface "${sid}":组件 "${id}" 不可达(不在 root 子树内)`);
    }
    if (s.dataModelId && !doc.dataModels[s.dataModelId]) {
      errors.push(`surface "${sid}" 引用的数据模型 "${s.dataModelId}" 不存在`);
    }
  }
  for (const mid of Object.keys(doc.dataModels)) {
    const m = doc.dataModels[mid];
    if (m.initialValue !== undefined && m.initialValue !== null && typeof m.initialValue !== "object") {
      errors.push(`数据模型 "${mid}" 的 initialValue 必须是对象/数组`);
    }
  }
  return errors;
}

/** 取 surface 的浅投影(供渲染 IPC 下发) */
export function getSurface(doc: IRDocument, surfaceId: string): IRSurface | undefined {
  return doc.surfaces[surfaceId];
}
