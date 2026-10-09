/**
 * iframe 渲染器根组件
 * - 接收宿主的 setSurface / setInspect 消息
 * - 递归渲染 A2UI 组件树,每个节点包一层 display:contents 的 data-aid 标记
 * - inspect 模式下:悬浮高亮 + 点击回传选中
 */
import { useCallback, useEffect, useMemo, useRef, useState, Component, type ErrorInfo, type ReactNode } from "react";
import type { PresetId, SurfaceDoc } from "@contracts/a2ui";
import { DEFAULT_TOKENS, TEXT_EDITABLE_PROPS } from "@contracts/a2ui";
import { IPC_SOURCE, postToHost, type HostMessage } from "@/lib/a2ui-ipc";
import { REGISTRIES } from "./registry";
import type { RendererRegistry } from "./shared";

/** antd 预设的动态模块:antd 依赖 ~1MB,仅 antd 预设的 iframe 才按需加载(每个 iframe 都要执行一次 JS,省的是 N 倍解析成本) */
interface AntdModule {
  registry: RendererRegistry;
  /** 类型引用(type-only),不引入运行时依赖 */
  ConfigProvider: typeof import("antd").ConfigProvider;
}

interface HoverRect { aid: string; x: number; y: number; w: number; h: number }

/**
 * 渲染错误边界:AI 生成的组件树可能出现意料外的 props 形态,
 * 单个页面渲染失败时显示友好提示,而不是让整个 iframe 白屏崩溃
 */
class RenderErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    // 新文档到达时重置错误态,给修复后的内容一次重新渲染的机会
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[a2ui] 渲染失败:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-2 p-8 text-center">
          <div className="text-sm font-medium text-red-500">页面渲染失败</div>
          <div className="max-w-md rounded-lg bg-red-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-red-400">
            {this.state.error.message.slice(0, 200)}
          </div>
          <div className="text-xs text-neutral-400">请通过对话让 AI 重新生成或修复该页面</div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** M6 视觉回归样例:四预设共用同一结构,体现设计语言差异(props 均为渲染器已知字段) */
const DEMO_SURFACE_DOC: SurfaceDoc = {
  version: "1.0",
  page: { id: "demo", title: "视觉回归样例", device: "desktop" },
  theme: { preset: "shadcn", tokens: { primary: "#4f46e5", background: "#ffffff", surface: "#f4f4f5", text: "#18181b", mutedText: "#71717a", accent: "#0ea5e9", radius: 10, font: "" } },
  components: {
    root: { type: "Section", props: {}, children: ["nav", "hero", "cards", "row"] },
    nav: { type: "Navbar", props: { logo: "A2UI", links: ["产品", "定价", "文档"] }, children: [] },
    hero: { type: "Hero", props: { title: "AI 原生 UI 设计工作台", subtitle: "从一句话到可交付的界面设计", cta: "开始设计" }, children: [] },
    cards: { type: "Grid", props: { columns: 3 }, children: ["c1", "c2", "c3"] },
    c1: { type: "Card", props: { title: "结构生成", text: "信息架构与组件树" }, children: [] },
    c2: { type: "Card", props: { title: "专业评审", text: "UX 评分与修复建议" }, children: [] },
    c3: { type: "Card", props: { title: "工程交付", text: "可构建的 React 工程" }, children: [] },
    row: { type: "Row", props: {}, children: ["b1", "b2"] },
    b1: { type: "Button", props: { text: "主操作", variant: "primary" }, children: [] },
    b2: { type: "Button", props: { text: "次操作" }, children: [] },
  },
  root: "root",
};

export default function RendererRoot() {
  const [doc, setDoc] = useState<SurfaceDoc | null>(null);
  const [preset, setPreset] = useState<PresetId>("shadcn");
  const [inspect, setInspect] = useState(false);
  const [hover, setHover] = useState<HoverRect | null>(null);
  // 多选:inspect 模式下点击切换选中,可一次性选中多个组件与 AI 对话
  const [selectedAids, setSelectedAids] = useState<string[]>([]);
  const [selectedRects, setSelectedRects] = useState<HoverRect[]>([]);
  // 图层树/检查器触发的闪烁高亮(非 inspect 模式也生效,1.6s 后自动消失)
  const [flashAid, setFlashAid] = useState<string | null>(null);
  const [flashRect, setFlashRect] = useState<HoverRect | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // M7 逐节点持久 Diff 着色:最近一次提交的增/改/删组件
  const [diff, setDiff] = useState<{ added: string[]; updated: string[]; removed: string[] } | null>(null);
  // M7 评论锚点气泡:未解决评论(按 nodeId 定位)
  const [commentMarks, setCommentMarks] = useState<{ id: number; nodeId: string; body: string; authorName: string | null }[]>([]);
  // 供事件回调读取最新 doc(避免闭包过期);不在渲染期读写
  const docRef = useRef<SurfaceDoc | null>(null);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    // M6 视觉回归 demo 模式:/render?preset=x&demo=1 → 内置静态样例,不注册 IPC(基线对象稳定)
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") {
      const p = params.get("preset");
      if (p === "shadcn" || p === "antd" || p === "element" || p === "custom") setPreset(p);
      setDoc(DEMO_SURFACE_DOC);
      return;
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const msg = e.data as HostMessage;
      if (msg?.source !== IPC_SOURCE) return;
      if (msg.type === "setSurface") {
        setDoc(msg.doc);
        setPreset(msg.preset);
        setSelectedAids([]);
        setHover(null);
      } else if (msg.type === "setInspect") {
        setInspect(msg.on);
        if (!msg.on) { setHover(null); setSelectedAids([]); }
      } else if (msg.type === "highlight") {
        setFlashAid(msg.aid);
        if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = msg.aid
          ? window.setTimeout(() => setFlashAid(null), 1600)
          : null;
      } else if (msg.type === "setDiff") {
        setDiff(msg.diff);
      } else if (msg.type === "setComments") {
        setCommentMarks(msg.comments.filter((c) => c.nodeId));
      }
    };
    window.addEventListener("message", onMessage);
    postToHost({ source: IPC_SOURCE, type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const aidOf = useCallback((target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest("[data-aid]");
  }, []);

  const rectOfAid = useCallback((el: HTMLElement): HoverRect | null => {
    const box = (el.firstElementChild ?? el).getBoundingClientRect();
    const container = rootRef.current?.getBoundingClientRect();
    if (!container) return null;
    return {
      aid: el.dataset.aid!,
      x: box.left - container.left,
      y: box.top - container.top,
      w: box.width,
      h: box.height,
    };
  }, []);

  // inspect 模式:悬浮高亮 + 点击切换多选
  useEffect(() => {
    if (!inspect) return;
    const onMove = (e: MouseEvent) => {
      const el = aidOf(e.target);
      setHover(el ? rectOfAid(el) : null);
    };
    const onClick = (e: MouseEvent) => {
      const el = aidOf(e.target);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const aid = el.dataset.aid!;
      setSelectedAids((prev) => {
        const next = prev.includes(aid) ? prev.filter((a) => a !== aid) : [...prev, aid];
        postToHost({
          source: IPC_SOURCE,
          type: "select",
          aids: next,
          items: next.map((a) => ({ aid: a, componentType: docRef.current?.components[a]?.type ?? "Unknown" })),
        });
        return next;
      });
    };
    // 双击文本类组件(Title/Text/Button/Link/Badge/Tag):回传当前文本与位置,宿主弹出内联编辑器
    const onDblClick = (e: MouseEvent) => {
      const el = aidOf(e.target);
      if (!el) return;
      const aid = el.dataset.aid!;
      const node = docRef.current?.components[aid];
      const prop = node ? TEXT_EDITABLE_PROPS[node.type] : undefined;
      if (!node || !prop) return;
      const rect = rectOfAid(el);
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      const raw = node.props[prop];
      postToHost({
        source: IPC_SOURCE,
        type: "textEdit",
        aid,
        prop,
        value: typeof raw === "string" ? raw : "",
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      });
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("dblclick", onDblClick, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("dblclick", onDblClick, true);
    };
  }, [inspect, aidOf, rectOfAid]);

  // 选中组件高亮框(多选):在渲染提交后量测,避免渲染期访问 ref
  useEffect(() => {
    if (!inspect || !selectedAids.length) {
      setSelectedRects([]);
      return;
    }
    const rects = selectedAids
      .map((aid) => {
        const el = rootRef.current?.querySelector(`[data-aid="${CSS.escape(aid)}"]`) as HTMLElement | null;
        return el ? rectOfAid(el) : null;
      })
      .filter(Boolean) as HoverRect[];
    setSelectedRects(rects);
  }, [inspect, selectedAids, doc, rectOfAid]);

  // 闪烁高亮量测(与选中框同法,提交后量测)
  useEffect(() => {
    if (!flashAid) {
      setFlashRect(null);
      return;
    }
    const el = rootRef.current?.querySelector(`[data-aid="${CSS.escape(flashAid)}"]`) as HTMLElement | null;
    setFlashRect(el ? rectOfAid(el) : null);
  }, [flashAid, doc, rectOfAid]);

  // 卸载时清理闪烁计时器
  useEffect(() => () => {
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
  }, []);

  // antd 预设:动态加载渲染器与 ConfigProvider(其余预设零 antd 成本)
  const [antdModule, setAntdModule] = useState<AntdModule | null>(null);
  const [antdFailed, setAntdFailed] = useState(false);
  useEffect(() => {
    if (preset !== "antd" || antdModule || antdFailed) return;
    let alive = true;
    Promise.all([import("./antdRenderer"), import("antd")])
      .then(([r, a]) => {
        if (alive) setAntdModule({ registry: r.antdRegistry, ConfigProvider: a.ConfigProvider });
      })
      .catch((e) => {
        // chunk 加载失败(常见于部署更新后旧页面引用旧 chunk):给出重试入口而非永久卡住
        console.error("[renderer] antd 渲染器加载失败:", e);
        if (alive) setAntdFailed(true);
      });
    return () => { alive = false; };
  }, [preset, antdModule, antdFailed]);

  const tokens = doc?.theme.tokens ?? DEFAULT_TOKENS;
  const registry = preset === "antd" ? antdModule?.registry : (REGISTRIES[preset] ?? REGISTRIES.shadcn);

  // 命名函数表达式:递归渲染时通过内部名 render 自引用,避免引用未完成的 const
  const renderNode = useCallback(
    function render(id: string): React.ReactNode {
      if (!doc || !registry) return null;
      const node = doc.components[id];
      if (!node) return null;
      const renderer = registry[node.type];
      const content = renderer
        ? renderer(node, { render, tokens })
        : (
          <div className="m-2 rounded border border-dashed border-red-300 bg-red-50 px-2 py-1 text-xs text-red-500">
            未知组件 {node.type}
          </div>
        );
      return (
        <div key={id} data-aid={id} style={{ display: "contents" }}>
          {content}
        </div>
      );
    },
    [doc, registry, tokens],
  );

  const tree = useMemo(() => (doc && registry ? renderNode(doc.root) : null), [doc, registry, renderNode]);

  // 评论气泡定位:doc/评论变化后测量锚点位置(上一帧 DOM 测量,差一帧可接受)
  const [commentRects, setCommentRects] = useState<{ c: (typeof commentMarks)[number]; rect: HoverRect }[]>([]);
  useEffect(() => {
    if (!commentMarks.length || !rootRef.current) { setCommentRects([]); return; }
    const container = rootRef.current.getBoundingClientRect();
    const rects = commentMarks.flatMap((c) => {
      const el = rootRef.current?.querySelector(`[data-aid="${CSS.escape(c.nodeId)}"]`) as HTMLElement | null;
      if (!el) return [];
      const box = (el.firstElementChild ?? el).getBoundingClientRect();
      return [{ c, rect: { aid: c.nodeId, x: box.left - container.left, y: box.top - container.top, w: box.width, h: box.height } }];
    });
    setCommentRects(rects);
  }, [commentMarks, doc]);
  // 同锚点多条评论聚合为一个气泡,显示条数
  const commentBubbles = useMemo(() => {
    const byNode = new Map<string, { nodeId: string; count: number; first: (typeof commentMarks)[number]; rect: HoverRect }>();
    for (const { c, rect } of commentRects) {
      const g = byNode.get(c.nodeId);
      if (g) g.count += 1;
      else byNode.set(c.nodeId, { nodeId: c.nodeId, count: 1, first: c, rect });
    }
    return [...byNode.values()];
  }, [commentRects]);

  const overlay = (rect: HoverRect, color: string, dashed = false) => (
    <div
      key={`${rect.aid}-${dashed}`}
      className="pointer-events-none absolute z-50 transition-all duration-75"
      style={{
        left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        outline: `2px ${dashed ? "dashed" : "solid"} ${color}`,
        outlineOffset: -1,
        background: `color-mix(in srgb, ${color} 6%, transparent)`,
      }}
    />
  );

  const empty = (
    <div className="flex h-screen items-center justify-center text-sm text-neutral-400">
      等待宿主下发页面…
    </div>
  );

  // M7 Diff 着色样式:wrapper 为 display:contents,outline 应用到其内部实际盒子上
  const diffCss = diff
    ? [
        ...diff.added.map((aid) => `[data-aid="${CSS.escape(aid)}"] > * { outline: 2px solid rgba(34,197,94,.55); outline-offset: 2px; border-radius: 4px; }`),
        ...diff.updated.map((aid) => `[data-aid="${CSS.escape(aid)}"] > * { outline: 2px solid rgba(59,130,246,.55); outline-offset: 2px; border-radius: 4px; }`),
        ...diff.removed.map((aid) => `[data-aid="${CSS.escape(aid)}"] > * { outline: 2px dashed rgba(239,68,68,.6); outline-offset: 2px; border-radius: 4px; opacity: .55; }`),
      ].join("\n")
    : "";

  const body = (
    <div
      ref={rootRef}
      className="relative min-h-screen w-full"
      style={{
        ["--a2-primary" as string]: tokens.primary,
        ["--a2-bg" as string]: tokens.background,
        ["--a2-surface" as string]: tokens.surface,
        ["--a2-text" as string]: tokens.text,
        ["--a2-muted" as string]: tokens.mutedText,
        ["--a2-accent" as string]: tokens.accent,
        ["--a2-radius" as string]: `${tokens.radius}px`,
        background: tokens.background,
        color: tokens.text,
        fontFamily: tokens.font || undefined,
        cursor: inspect ? "crosshair" : undefined,
      }}
    >
      {diffCss ? <style>{diffCss}</style> : null}
      <RenderErrorBoundary resetKey={doc}>
        {tree ?? empty}
      </RenderErrorBoundary>
      {inspect && hover && !selectedAids.includes(hover.aid) && overlay(hover, "#6366f1", true)}
      {inspect && selectedRects.map((r) => overlay(r, "#4f46e5"))}
      {flashRect && overlay(flashRect, "#6366f1")}
      {commentBubbles.map(({ nodeId, count, first, rect }) => (
        <div
          key={first.id}
          className="pointer-events-auto absolute z-40 -translate-y-1/2"
          style={{ left: rect.x + rect.w - 10, top: rect.y }}
          title={`${first.authorName ?? "评论"}:${first.body}${count > 1 ? `(共 ${count} 条)` : ""}`}
          onClick={() => postToHost({ source: IPC_SOURCE, type: "commentClick", nodeId })}
        >
          <span className="flex h-5 min-w-5 cursor-pointer items-center justify-center rounded-full rounded-bl-none bg-amber-400 px-1 text-[10px] font-bold text-white shadow transition hover:scale-110">
            {count > 1 ? count : "💬"}
          </span>
        </div>
      ))}
    </div>
  );

  // antd 预设:模块未就绪时显示加载态(避免组件树被当作未知组件渲染)
  if (preset === "antd") {
    if (antdFailed) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-2 text-sm text-neutral-400">
          <span>Ant Design 渲染器加载失败</span>
          <button
            onClick={() => setAntdFailed(false)}
            className="rounded-lg border border-neutral-200 px-3 py-1 text-xs text-neutral-500 transition hover:bg-neutral-50">
            重试
          </button>
        </div>
      );
    }
    if (!antdModule) {
      return (
        <div className="flex h-screen items-center justify-center text-sm text-neutral-400">
          加载 Ant Design 渲染器…
        </div>
      );
    }
    const { ConfigProvider } = antdModule;
    return (
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: tokens.primary,
            colorInfo: tokens.accent,
            colorLink: tokens.accent,
            borderRadius: tokens.radius,
          },
        }}
      >
        {body}
      </ConfigProvider>
    );
  }
  return body;
}
