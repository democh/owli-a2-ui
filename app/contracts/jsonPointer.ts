/**
 * RFC 6901 JSON Pointer 工具(共享契约层)
 *
 * 文档要求:不允许简单 path.split('/'),必须支持:
 * - `/` 根路径
 * - `~0`(→~) `~1`(→/) 转义
 * - 数组下标与 `-`(追加)
 * - 路径存在性检查与类型推断
 * - 防原型链污染(__proto__ / constructor / prototype 一律拒绝)
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 解析指针字符串为未转义的段数组;根指针("")返回 [] */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`非法 JSON Pointer: "${pointer}"(必须以 / 开头或为空串)`);
  return pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** 将段数组编码为指针字符串 */
export function stringifyPointer(segments: (string | number)[]): string {
  if (segments.length === 0) return "";
  return "/" + segments.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) throw new Error(`禁止的路径段: "${key}"(防原型链污染)`);
}

/** 按指针读取值;路径不存在返回 undefined(区别于显式 undefined 需调用 hasPointer) */
export function getAtPointer(doc: unknown, pointer: string): unknown {
  const segments = parsePointer(pointer);
  let cur: unknown = doc;
  for (const raw of segments) {
    assertSafeKey(raw);
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[raw];
    }
  }
  return cur;
}

/** 路径是否存在(值为 undefined 但容器持有该键也算存在) */
export function hasPointer(doc: unknown, pointer: string): boolean {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return true;
  const parent = getAtPointer(doc, stringifyPointer(segments.slice(0, -1)));
  const last = segments[segments.length - 1];
  if (parent === null || typeof parent !== "object") return false;
  if (Array.isArray(parent)) {
    const idx = Number(last);
    return Number.isInteger(idx) && idx >= 0 && idx < parent.length;
  }
  return Object.prototype.hasOwnProperty.call(parent, last);
}

/**
 * 按指针写入值(就地修改)。缺失的中间对象段自动补建;数组段必须已存在;
 * `-` 表示数组追加。返回是否写入成功。
 */
export function setAtPointer(doc: unknown, pointer: string, value: unknown): boolean {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return false;
  let cur: unknown = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const raw = segments[i];
    assertSafeKey(raw);
    if (cur === null || typeof cur !== "object") return false;
    const container = cur as Record<string, unknown>;
    if (Array.isArray(cur)) {
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return false;
      cur = cur[idx];
    } else {
      const next = container[raw];
      if (next === null || typeof next !== "object") {
        // 中间段缺失:按下一段形态补建(数字段 → 数组,否则对象)
        if (typeof segments[i + 1] === "string" && !Number.isNaN(Number(segments[i + 1]))) return false;
        container[raw] = {};
        cur = container[raw];
      } else {
        cur = next;
      }
    }
  }
  const last = segments[segments.length - 1];
  assertSafeKey(last);
  if (cur === null || typeof cur !== "object") return false;
  if (Array.isArray(cur)) {
    if (last === "-") {
      cur.push(value);
      return true;
    }
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx > cur.length) return false;
    cur[idx] = value;
    return true;
  }
  (cur as Record<string, unknown>)[last] = value;
  return true;
}
