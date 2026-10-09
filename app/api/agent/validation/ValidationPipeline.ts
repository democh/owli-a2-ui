import {
  CATALOG_TYPES,
  applyIRops,
  validateIR,
  type IRDocument,
  type IROperation,
} from "@contracts/design-ir";
import { isAllowedAction, isAllowedUrl, type A2UIComponent } from "@contracts/a2ui-protocol";
import { adapterCompatFor } from "@contracts/adapter-matrix";
import type { ValidationIssue } from "@contracts/agent";

/**
 * Validation Pipeline(文档 §5.2.6 / §13.1 第一层)
 *
 * 固定校验顺序(全部确定性检查,不依赖模型):
 * IR Schema → Catalog Compatibility → Reference Integrity → Layout → Data Binding
 * → Token → Accessibility(确定性子集) → Security(URL scheme / 事件白名单) → Adapter 兼容
 * 每层输出 ValidationIssue[];error 级阻断提交,warning 提示。
 */

export interface ValidationContext {
  /** 基于哪个文档投影(既有 surface 的修改会先应用 ops 再整体校验) */
  baseDoc: IRDocument;
  ops: IROperation[];
  /** 目标渲染 Adapter id(校验组件可实现性) */
  uiLibraryId?: string;
}

/** 遍历 props 深度收集 URL 与 action 引用 */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, depth + 1);
  }
}

function issue(partial: Omit<ValidationIssue, "repairOps"> & { repairOps?: ValidationIssue["repairOps"] }): ValidationIssue {
  return { repairOps: [], ...partial };
}

export function validateProposal(ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { baseDoc, ops } = ctx;

  // 1. IR Schema / 2. Reference Integrity:应用 ops 后整体深度校验
  const projected = applyIRops(baseDoc, ops);
  for (const err of validateIR(projected)) {
    issues.push(issue({ code: "ir_integrity", severity: "error", layer: "ir", message: err }));
  }

  // 3. Catalog Compatibility + Layout + A11y + Security:逐 op 检查
  for (const op of ops) {
    switch (op.op) {
      case "addNode": {
        if (!CATALOG_TYPES.includes(op.node.type)) {
          issues.push(
            issue({
              code: "catalog_unknown_type",
              severity: "error",
              layer: "catalog",
              surfaceId: op.surfaceId,
              nodeId: op.id,
              message: `组件类型 "${op.node.type}" 不在 Catalog 中`,
              expected: CATALOG_TYPES.slice(0, 10).join("/"),
              actual: op.node.type,
            }),
          );
        }
        issues.push(...validateNodeSecurity(op.surfaceId, op.id, op.node.type, op.node.props));
        for (const [id, node] of Object.entries(op.extra ?? {})) {
          if (!CATALOG_TYPES.includes(node.type)) {
            issues.push(
              issue({
                code: "catalog_unknown_type",
                severity: "error",
                layer: "catalog",
                surfaceId: op.surfaceId,
                nodeId: id,
                message: `组件类型 "${node.type}" 不在 Catalog 中`,
              }),
            );
          }
          issues.push(...validateNodeSecurity(op.surfaceId, id, node.type, node.props));
        }
        break;
      }
      case "replaceProps": {
        const node = projected.surfaces[op.surfaceId]?.components[op.id];
        if (node) {
          issues.push(...validateNodeSecurity(op.surfaceId, op.id, node.type, { ...node.props, ...op.props }));
        } else {
          // Data 层:修改目标不存在(悬空引用)
          issues.push(
            issue({
              code: "data_missing_target",
              severity: "error",
              layer: "data",
              surfaceId: op.surfaceId,
              nodeId: op.id,
              message: `replaceProps 目标节点 ${op.id} 不存在(引用悬空)`,
            }),
          );
        }
        break;
      }
      case "removeNode": {
        const node = projected.surfaces[op.surfaceId]?.components[op.id];
        if (!node && baseDoc.surfaces[op.surfaceId]?.components[op.id]) {
          // 目标本就不在投影中(重复删除):warning
          issues.push(
            issue({
              code: "data_redundant_remove",
              severity: "warning",
              layer: "data",
              surfaceId: op.surfaceId,
              nodeId: op.id,
              message: `removeNode 目标 ${op.id} 不存在于投影结果(可能重复删除)`,
            }),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  // 4. Token 校验:setTokens 的键必须属于 ThemeTokens
  for (const op of ops) {
    if (op.op === "setTokens") {
      const allowed = new Set([
        "primary", "background", "surface", "text", "mutedText", "accent", "radius", "font",
      ]);
      for (const k of Object.keys(op.tokens)) {
        if (!allowed.has(k)) {
          issues.push(
            issue({
              code: "token_unknown_key",
              severity: "error",
              layer: "ir",
              message: `未知主题令牌 "${k}"`,
            }),
          );
        }
      }
    }
  }

  // 5. Layout + Accessibility(确定性子集,对投影后全量组件扫描) + Data Binding
  issues.push(...validateDocA11yLayout(projected));
  issues.push(...validateDataBindings(projected));

  // 6. Adapter 兼容(§23.3 矩阵:未注册回退 shadcn,并提示已知限制)
  if (ctx.uiLibraryId) {
    const compat = adapterCompatFor(ctx.uiLibraryId);
    if (compat.adapterId === "shadcn" && ctx.uiLibraryId !== "shadcn-tailwind" && ctx.uiLibraryId !== "shadcn") {
      issues.push(
        issue({
          code: "adapter_unknown",
          severity: "warning",
          layer: "codegen",
          message: `UI 库 "${ctx.uiLibraryId}" 未注册,回退 shadcn 渲染;已知限制:${compat.limitations.join(";")}`,
        }),
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// §5.2.6 补层:Layout Rules / Accessibility / Data Binding(全部确定性检查)
// ---------------------------------------------------------------------------

/** 可包含子节点的容器类型(契约层共用;其余 Catalog 类型视为叶子) */
export { CONTAINER_TYPES } from "@contracts/a2ui";
import { CONTAINER_TYPES as CONTAINER_SET } from "@contracts/a2ui";

const INTERACTIVE_TYPES = new Set(["Button", "Link", "Input", "Textarea", "Select", "Checkbox", "Switch", "SearchBar"]);

/** Layout 层:叶子组件声明 children(渲染器会忽略)或挂载到叶子父节点 → warning */
function validateNodeLayout(surfaceId: string, nodeId: string, type: string, node: { children?: string[] }): ValidationIssue[] {
  if (CONTAINER_SET.has(type)) return [];
  if (node.children && node.children.length > 0) {
    return [
      issue({
        code: "layout_leaf_children",
        severity: "warning",
        layer: "layout",
        surfaceId,
        nodeId,
        message: `叶子组件 ${type}#${nodeId} 声明了 ${node.children.length} 个子节点,渲染时将被忽略`,
        expected: "子节点应挂载到容器类型(Section/Row/Col/Grid/Card…)",
        actual: type,
      }),
    ];
  }
  return [];
}

/** #RGB/#RRGGBB/rgb() → [r,g,b];无法解析返回 null */
function parseColor(input: string): [number, number, number] | null {
  const s = input.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** WCAG 相对亮度 */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 对比度(1~21);任一颜色无法解析返回 null */
export function contrastRatio(fg: string, bg: string): number | null {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (!a || !b) return null;
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** A11y 确定性子集:Image alt / 交互组件可访问名称 / 前景-背景对比度 */
function validateNodeA11y(surfaceId: string, nodeId: string, type: string, props: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const text = typeof props.text === "string" ? props.text.trim() : "";
  const label = typeof props.ariaLabel === "string" ? props.ariaLabel.trim() : "";

  if (type === "Image" && !label && !props.alt) {
    issues.push(
      issue({
        code: "a11y_image_missing_alt",
        severity: "error",
        layer: "accessibility",
        surfaceId,
        nodeId,
        message: `Image#${nodeId} 缺少 alt 替代文本`,
        repairHint: "为 Image props 增加 alt(或 ariaLabel)描述图片内容",
      }),
    );
  }
  if (INTERACTIVE_TYPES.has(type) && !text && !label) {
    issues.push(
      issue({
        code: "a11y_control_missing_name",
        severity: "warning",
        layer: "accessibility",
        surfaceId,
        nodeId,
        message: `交互组件 ${type}#${nodeId} 无可访问名称(text/ariaLabel 均为空)`,
        repairHint: "补充可见文本或 ariaLabel",
      }),
    );
  }
  // 对比度:props 同时声明前景/背景颜色时做 WCAG 检查
  const fg = typeof props.color === "string" ? props.color : "";
  const bg = typeof (props.backgroundColor ?? props.background) === "string" ? String(props.backgroundColor ?? props.background) : "";
  if (fg && bg) {
    const ratio = contrastRatio(fg, bg);
    if (ratio != null) {
      if (ratio < 3) {
        issues.push(
          issue({
            code: "a11y_contrast_fail",
            severity: "error",
            layer: "accessibility",
            surfaceId,
            nodeId,
            message: `${type}#${nodeId} 文本对比度 ${ratio.toFixed(2)}:1,低于 3:1 底线`,
            expected: ">= 4.5:1(AA 正文)",
            actual: `${ratio.toFixed(2)}:1`,
          }),
        );
      } else if (ratio < 4.5) {
        issues.push(
          issue({
            code: "a11y_contrast_low",
            severity: "warning",
            layer: "accessibility",
            surfaceId,
            nodeId,
            message: `${type}#${nodeId} 文本对比度 ${ratio.toFixed(2)}:1,未达 AA 正文 4.5:1`,
            expected: ">= 4.5:1",
            actual: `${ratio.toFixed(2)}:1`,
          }),
        );
      }
    }
  }
  return issues;
}

/** 深度收集数据模型值中的 JSON Pointer 路径 */
function collectDataPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = `${prefix}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    out.add(p);
    collectDataPaths(v, p, out);
  }
}

/** Layout + A11y:对投影后文档全部组件做确定性扫描(空 ops 也覆盖既有内容) */
function validateDocA11yLayout(doc: IRDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [sid, surface] of Object.entries(doc.surfaces)) {
    for (const [nid, node] of Object.entries(surface.components)) {
      issues.push(...validateNodeLayout(sid, nid, node.type, node));
      issues.push(...validateNodeA11y(sid, nid, node.type, node.props ?? {}));
    }
  }
  return issues;
}

/** Data 层:{{/path}} 绑定路径必须在 surface 关联数据模型(initialValue/mockValue)中存在 */
function validateDataBindings(doc: IRDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [sid, surface] of Object.entries(doc.surfaces)) {
    const model = surface.dataModelId ? doc.dataModels[surface.dataModelId] : undefined;
    if (!model) continue;
    const paths = new Set<string>();
    collectDataPaths(model.initialValue, "", paths);
    collectDataPaths(model.mockValue, "", paths);
    if (paths.size === 0) continue;
    for (const [nid, node] of Object.entries(surface.components)) {
      for (const v of Object.values(node.props ?? {})) {
        if (typeof v !== "string") continue;
        const m = v.match(/^\{\{(.+)\}\}$/);
        if (!m) continue;
        const pointer = m[1].startsWith("/") ? m[1] : `/${m[1]}`;
        if (!paths.has(pointer)) {
          issues.push(
            issue({
              code: "data_binding_missing_path",
              severity: "warning",
              layer: "data",
              surfaceId: sid,
              nodeId: nid,
              message: `组件 ${node.type}#${nid} 绑定路径 ${pointer} 不在数据模型 "${model.id}" 中`,
              expected: `存在路径,如 [${[...paths].slice(0, 3).join(", ")}…]`,
              actual: pointer,
            }),
          );
        }
      }
    }
  }
  return issues;
}

function validateNodeSecurity(surfaceId: string, nodeId: string, type: string, props: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const strings: string[] = [];
  collectStrings(props, strings);
  for (const s of strings) {
    if (/^(https?:|data:|javascript:|blob:)/i.test(s) && !isAllowedUrl(s)) {
      issues.push(
        issue({
          code: "security_url",
          severity: "error",
          layer: "security",
          surfaceId,
          nodeId,
          message: `组件 ${type}#${nodeId} 的 URL 不在白名单内(仅允许 https 与位图 data:image)`,
          actual: s.slice(0, 80),
        }),
      );
    }
  }
  const action = props.action ?? props.onClick ?? props.onAction;
  if (typeof action === "string" && !isAllowedAction(action)) {
    issues.push(
      issue({
        code: "security_action",
        severity: "error",
        layer: "security",
        surfaceId,
        nodeId,
        message: `事件/动作 "${action}" 不在白名单内`,
      }),
    );
  }
  return issues;
}

/** 是否存在阻断问题(error 级) */
export function hasBlocking(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

export type { A2UIComponent };
