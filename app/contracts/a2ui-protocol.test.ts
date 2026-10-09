import { describe, expect, it } from "vitest";
import {
  A2UI_PROTOCOL_VERSION,
  createEnvelope,
  isAllowedAction,
  isAllowedUrl,
  parseEnvelope,
} from "./a2ui-protocol";

const base = {
  projectId: "prj_1",
  sessionId: "ses_1",
  runId: "run_1",
  seq: 0,
};

describe("A2UI v0.9.1 Transport Envelope", () => {
  it("构造并通过解析回读", () => {
    const env = createEnvelope({
      ...base,
      message: { kind: "createSurface", surfaceId: "frame_home", root: "root" },
    });
    expect(env.type).toBe("a2ui.message");
    expect(env.payload.version).toBe(A2UI_PROTOCOL_VERSION);
    expect(parseEnvelope(env)).toEqual(env);
  });

  it("拒绝非法消息", () => {
    expect(() => parseEnvelope({ type: "a2ui.message" })).toThrow();
    const env = createEnvelope({ ...base, message: { kind: "createSurface", surfaceId: "s" } });
    const broken: Record<string, unknown> = { ...env, transportVersion: "transport/9" };
    expect(() => parseEnvelope(broken)).toThrow();
    const good = createEnvelope({
      ...base,
      message: {
        kind: "updateComponents",
        surfaceId: "s",
        components: [{ id: "root", type: "Section", props: {}, children: [] }],
        batchEnd: false,
      },
    });
    const badPayload: Record<string, unknown> = JSON.parse(JSON.stringify(good));
    (badPayload.payload as Record<string, unknown>).message = {
      kind: "updateComponents",
      surfaceId: "s",
      components: [],
    };
    // 空 components 违反 min(1)
    expect(() => parseEnvelope(badPayload)).toThrow();
  });

  it("客户端消息 action/error 同样受信封约束", () => {
    const env = createEnvelope({
      ...base,
      message: { kind: "action", surfaceId: "frame_home", componentId: "btn_ok", actionName: "submit" },
    });
    expect(parseEnvelope(env).payload.message.kind).toBe("action");
  });
});

describe("安全白名单", () => {
  it("URL 仅允许 https 与位图 data:image", () => {
    expect(isAllowedUrl("https://example.com/a.png")).toBe(true);
    expect(isAllowedUrl("data:image/png;base64,xxx")).toBe(true);
    expect(isAllowedUrl("data:image/svg+xml;base64,xxx")).toBe(false);
    expect(isAllowedUrl("http://example.com")).toBe(false);
    expect(isAllowedUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedUrl(123)).toBe(false);
  });

  it("action 名称白名单", () => {
    expect(isAllowedAction("submit")).toBe(true);
    expect(isAllowedAction("eval")).toBe(false);
  });
});
