import { describe, expect, it } from "vitest";
import { getAtPointer, hasPointer, parsePointer, setAtPointer, stringifyPointer } from "./jsonPointer";

describe("jsonPointer(RFC 6901)", () => {
  it("解析根指针与转义段", () => {
    expect(parsePointer("")).toEqual([]);
    expect(parsePointer("/data/users/0/name")).toEqual(["data", "users", "0", "name"]);
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(stringifyPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
    expect(() => parsePointer("data/x")).toThrow();
  });

  it("读取嵌套值与数组下标", () => {
    const doc = { data: { users: [{ name: "张三" }] } };
    expect(getAtPointer(doc, "/data/users/0/name")).toBe("张三");
    expect(getAtPointer(doc, "/data/missing")).toBeUndefined();
    expect(getAtPointer(doc, "/data/users/5")).toBeUndefined();
    expect(hasPointer(doc, "/data/users/0/name")).toBe(true);
    expect(hasPointer(doc, "/data/missing")).toBe(false);
  });

  it("写入值、数组追加与中间补建", () => {
    const doc: { data: { list: number[]; deep?: Record<string, unknown> } } = { data: { list: [1, 2] } };
    expect(setAtPointer(doc, "/data/list/-", 3)).toBe(true);
    expect(doc.data.list).toEqual([1, 2, 3]);
    expect(setAtPointer(doc, "/data/list/1", 9)).toBe(true);
    expect(doc.data.list).toEqual([1, 9, 3]);
    expect(setAtPointer(doc, "/data/deep/x", "v")).toBe(true);
    expect(getAtPointer(doc, "/data/deep/x")).toBe("v");
    // 数组中间段缺失时不得凭空造数组
    expect(setAtPointer(doc, "/nope/0/x", 1)).toBe(false);
  });

  it("拒绝原型链污染路径", () => {
    const doc: Record<string, unknown> = {};
    expect(() => setAtPointer(doc, "/__proto__/polluted", true)).toThrow();
    expect(() => getAtPointer(doc, "/constructor/prototype")).toThrow();
  });
});
