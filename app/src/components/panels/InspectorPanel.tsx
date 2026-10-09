/**
 * 属性检查器:选中组件的 props 表单编辑。
 * 所有修改走与 AI 编辑完全相同的 op 链路(replaceProps → 持久化 → 可撤销)。
 */
import { useState } from "react";
import { Blocks, Crosshair, MessageSquarePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/stores/workspaceStore";
import { usePageOps } from "@/hooks/usePageOps";
import { trpc } from "@/providers/trpc";

/** 图标库(与 props-guide.md 保持一致) */
const ICON_OPTIONS = "activity, award, arrow-right, chart, bell, bookmark, check, chevron-right, clock, compass, download, eye, flame, gift, globe, grid, heart, home, image, line-chart, lock, map, menu, message, moon, palette, play, plug, plus, plus-circle, rocket, search, settings, shield, shopping-cart, sparkles, star, target, trending-up, user, users, wallet, zap".split(", ");

/** 已知枚举 prop 的可选值(渲染为下拉);未列出的 prop 按值类型通用渲染 */
const PROP_ENUMS: Record<string, Record<string, (string | number)[]>> = {
  Title: { level: [1, 2, 3, 4] },
  Text: { variant: ["lead", "body", "muted", "caption"], weight: ["medium"] },
  Button: { variant: ["primary", "outline", "ghost", "danger"], size: ["sm"], icon: ICON_OPTIONS },
  Row: { align: ["start", "center", "end", "stretch", "baseline"], justify: ["start", "center", "end", "between", "around", "evenly"] },
  Col: { align: ["start", "center", "end", "stretch"] },
  Image: { ratio: ["16:9", "4:3", "1:1"] },
  Alert: { kind: ["info", "success", "warning", "error"] },
  LoginForm: { mode: ["login", "register"] },
  Chart: { kind: ["bar", "line", "area", "pie"] },
  FeatureGrid: { columns: [2, 3, 4] },
  Icon: { name: ICON_OPTIONS },
  Statistic: { icon: ICON_OPTIONS },
  ListItem: { icon: ICON_OPTIONS },
};

/** 常见 prop 的中文标签 */
const PROP_LABELS: Record<string, string> = {
  text: "文本", label: "标签", title: "标题", subtitle: "副标题", placeholder: "占位提示", value: "值",
  links: "链接", items: "条目", options: "选项", columns: "列", rows: "行", level: "层级", variant: "样式",
  size: "尺寸", kind: "类型", icon: "图标", name: "名称", logo: "Logo", cta: "按钮文案", primaryCta: "主按钮",
  secondaryCta: "次按钮", badge: "徽章", gap: "间距", padding: "内边距", align: "对齐", justify: "分布",
  ratios: "宽度比例", center: "居中", hover: "悬停效果", compact: "紧凑", checked: "勾选", on: "开关",
  width: "宽度", height: "高度", alt: "替代文本", ratio: "比例", rounded: "圆角", boxed: "底色块",
  tabs: "页签", menu: "菜单", activeMenu: "当前菜单", user: "用户", fields: "字段", submitLabel: "提交按钮",
  mode: "模式", desc: "描述", extra: "右侧内容", trend: "趋势", trendUp: "上升趋势", quote: "引述",
  role: "职位", price: "价格", tag: "角标", rating: "评分", plans: "方案", features: "特性", stats: "数据",
  logos: "品牌", groups: "链接组", copyright: "版权", series: "系列", categories: "类目", lines: "行数",
  current: "当前步骤", statusKey: "状态列", avatarKey: "头像列", pagination: "分页", minHeight: "最小高度",
  weight: "字重",
};

export function InspectorPanel() {
  const selectedElements = useWorkspace((s) => s.selectedElements);
  const pages = useWorkspace((s) => s.pages);
  const requestHighlight = useWorkspace((s) => s.requestHighlight);
  const applyPageOps = usePageOps();

  if (!selectedElements.length) {
    return (
      <div className="flex-1 px-4 py-10 text-center text-xs leading-relaxed text-neutral-400">
        未选中组件<br />双击画布中的组件,或从「图层」页选择
      </div>
    );
  }
  if (selectedElements.length > 1) {
    return <MultiInspector selectedElements={selectedElements} />;
  }

  const sel = selectedElements[0];
  const page = pages.find((p) => p.id === sel.pageId);
  const node = page?.surface.components[sel.aid];
  if (!page || !node) {
    return <div className="flex-1 px-4 py-10 text-center text-xs text-neutral-400">组件已不存在</div>;
  }

  const commitProps = (patch: Record<string, unknown>) =>
    applyPageOps(page, [{ op: "replaceProps", id: sel.aid, props: patch }]);
  const isRoot = sel.aid === page.surface.root;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* 头部:组件标识 + 操作 */}
      <div className="flex items-center gap-1.5 border-b border-neutral-100 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-neutral-800">{node.type}</div>
          <div className="truncate text-[10px] text-neutral-400">#{sel.aid} · {page.title}</div>
        </div>
        <button
          title="在画布中高亮"
          onClick={() => requestHighlight(page.id, sel.aid)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-indigo-500">
          <Crosshair size={13} />
        </button>
        {!isRoot && (
          <button
            title="删除组件"
            onClick={() => applyPageOps(page, [{ op: "removeNode", id: sel.aid }])}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-500">
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {/* M7 组件实例:定义为组件 + 插入实例清单 */}
      <ComponentDefsSection projectId={page.projectId} surfaceId={page.surfaceId ?? ""} rootId={sel.aid} rootType={node.type} />

      {/* props 表单 */}
      <div className="flex flex-col gap-3 p-3">
        {Object.entries(node.props).map(([prop, value]) => (
          <PropField
            key={`${sel.aid}:${prop}`}
            compType={node.type}
            prop={prop}
            value={value}
            onCommit={(v) => commitProps({ [prop]: v })}
          />
        ))}
        {!Object.keys(node.props).length && (
          <div className="py-4 text-center text-xs text-neutral-400">该组件没有可编辑属性</div>
        )}
      </div>

      {/* M7 协作评论:当前页面/元素评论流(点击条目定位到锚点组件) */}
      <CommentsSection projectId={page.projectId} pageId={page.id} surfaceId={page.surfaceId ?? ""} nodeId={sel.aid} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// M7 组件实例入口:把选中子树定义为组件;从定义清单插入实例
// ---------------------------------------------------------------------------
function ComponentDefsSection({ projectId, surfaceId, rootId, rootType }: {
  projectId: number;
  surfaceId: string;
  rootId: string;
  rootType: string;
}) {
  const utils = trpc.useUtils();
  const listQ = trpc.designDefs.list.useQuery({ projectId });
  const defineMut = trpc.designDefs.define.useMutation({
    onSuccess: (r) => {
      utils.workspace.get.invalidate({ projectId });
      toast.success(`已定义为组件「${r.defId}」(revision ${r.revision})`);
    },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  const insertMut = trpc.designDefs.insertInstance.useMutation({
    onSuccess: (r) => {
      utils.workspace.get.invalidate({ projectId });
      toast.success(`已插入实例 (revision ${r.revision})`);
    },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  const [defName, setDefName] = useState("");
  const [pickDef, setPickDef] = useState("");

  const defs = listQ.data ?? [];
  void rootType;

  return (
    <div className="border-b border-neutral-100 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <input
          value={defName} onChange={(e) => setDefName(e.target.value)}
          placeholder={`组件名(如 ${rootType})`}
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1 text-[11px] outline-none focus:border-indigo-400"
        />
        <button
          title="把该组件子树保存为可复用组件定义"
          disabled={!defName.trim() || defineMut.isPending}
          onClick={() => {
            if (confirm(`把「#${rootId}」及其子树定义为组件「${defName.trim()}」?`)) {
              defineMut.mutate({ projectId, surfaceId, rootId, name: defName.trim() });
            }
          }}
          className="flex items-center gap-1 rounded-lg bg-neutral-800 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40">
          <Blocks size={12} /> 定义为组件
        </button>
      </div>
      {defs.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <select
            value={pickDef} onChange={(e) => setPickDef(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-indigo-400">
            <option value="">插入实例…</option>
            {defs.map((d) => <option key={d.defId} value={d.defId}>{d.name}({d.rootType})</option>)}
          </select>
          <button
            disabled={!pickDef || insertMut.isPending}
            onClick={() => insertMut.mutate({ projectId, surfaceId, instanceOf: pickDef })}
            className="rounded-lg border border-indigo-200 px-2 py-1 text-[11px] font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-40">
            插入
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// M7 协作评论:页面/元素评论流(viewer 可读,editor 可写)
// ---------------------------------------------------------------------------
function CommentsSection({ projectId, pageId, surfaceId, nodeId }: { projectId: number; pageId: number; surfaceId: string; nodeId?: string }) {
  const [draft, setDraft] = useState("");
  /** 讨论串(演进项 §2.1):回复目标 + 展开状态 */
  const [replyTo, setReplyTo] = useState<{ id: number; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const requestHighlight = useWorkspace((s) => s.requestHighlight);
  const utils = trpc.useUtils();
  const invalidate = () => utils.comments.list.invalidate({ projectId, surfaceId });
  const listQ = trpc.comments.list.useQuery({ projectId, surfaceId, nodeId });
  const addMut = trpc.comments.add.useMutation({
    onSuccess: () => { setDraft(""); setReplyTo(null); invalidate(); },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  const resolveMut = trpc.comments.resolve.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });

  const all = listQ.data ?? [];
  const roots = all.filter((c) => !c.parentId);
  const repliesOf = (rootId: number) => all.filter((c) => c.parentId === rootId).sort((a, b) => a.id - b.id);
  const send = () => {
    if (!draft.trim()) return;
    addMut.mutate({
      projectId,
      surfaceId,
      nodeId: replyTo ? all.find((c) => c.id === replyTo.id)?.nodeId ?? nodeId : nodeId,
      body: draft.trim(),
      parentId: replyTo?.id,
    });
  };

  const renderCard = (c: (typeof all)[number], isReply: boolean) => (
    <div
      key={c.id}
      onClick={() => { if (c.nodeId) requestHighlight(pageId, c.nodeId); }}
      className={`cursor-pointer rounded-lg border px-2 py-1.5 text-[11px] transition hover:border-indigo-200 ${c.resolved ? "border-emerald-100 bg-emerald-50/40 text-neutral-400" : "border-neutral-100 bg-neutral-50/60"} ${isReply ? "ml-4 border-dashed" : ""}`}
      title={c.nodeId ? "点击定位到锚点组件" : undefined}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-neutral-600">{c.authorName ?? `用户 ${c.authorId}`}</span>
        {!isReply && (
          <button
            title={c.resolved ? "标记未解决" : "标记已解决"}
            onClick={(e) => { e.stopPropagation(); resolveMut.mutate({ projectId, commentId: c.id, resolved: !c.resolved }); }}
            className="text-[10px] text-indigo-500 transition hover:text-indigo-700">
            {c.resolved ? "未解决" : "解决"}
          </button>
        )}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap text-neutral-600">{c.body}</div>
      {!isReply && (
        <button
          onClick={(e) => { e.stopPropagation(); setReplyTo({ id: c.id, name: c.authorName ?? `用户 ${c.authorId}` }); }}
          className="mt-1 text-[10px] text-neutral-400 transition hover:text-indigo-600">
          回复
        </button>
      )}
    </div>
  );

  return (
    <div className="border-t border-neutral-100 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-neutral-500">
        <MessageSquarePlus size={12} /> 评论
        {roots.length ? <span className="rounded-full bg-neutral-100 px-1.5 text-[10px] text-neutral-400">{roots.length}</span> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        {roots.map((c) => {
          const replies = repliesOf(c.id);
          const open = !!expanded[c.id];
          return (
            <div key={c.id} className="flex flex-col gap-1">
              {renderCard(c, false)}
              {replies.length > 0 && (
                <button
                  onClick={() => setExpanded((m) => ({ ...m, [c.id]: !m[c.id] }))}
                  className="ml-4 self-start text-[10px] text-neutral-400 transition hover:text-indigo-600">
                  {open ? "收起" : ""} {replies.length} 条回复 {open ? "▲" : "▼"}
                </button>
              )}
              {replies.length > 0 && open && replies.map((r) => renderCard(r, true))}
            </div>
          );
        })}
        {!all.length && <div className="py-2 text-center text-[10px] text-neutral-300">暂无评论</div>}
      </div>
      {replyTo && (
        <div className="mt-1.5 flex items-center justify-between rounded-md bg-indigo-50/60 px-2 py-1 text-[10px] text-indigo-600 dark:bg-indigo-950/30">
          <span>回复 @{replyTo.name}</span>
          <button onClick={() => setReplyTo(null)} className="hover:text-indigo-800">取消</button>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) send(); }}
          placeholder={replyTo ? `回复 @${replyTo.name},Enter 发送` : "写下评论,Enter 发送"}
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1 text-[11px] outline-none focus:border-indigo-400" />
        <button
          disabled={!draft.trim() || addMut.isPending}
          onClick={send}
          className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
          发送
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 多选批量编辑:共同 props 交集;值不一致的字段显示「多个值」,提交后统一
// ---------------------------------------------------------------------------
const MIXED = Symbol("mixed");
type MixedValue = unknown | typeof MIXED;

function MultiInspector({ selectedElements }: {
  selectedElements: { pageId: number; aid: string; componentType: string }[];
}) {
  const pages = useWorkspace((s) => s.pages);
  const setSelectedElements = useWorkspace((s) => s.setSelectedElements);
  const applyPageOps = usePageOps();

  // 解析出仍然存在的选中项(page/node 都可能已被删)
  const items = selectedElements
    .map((sel) => {
      const page = pages.find((p) => p.id === sel.pageId);
      const node = page?.surface.components[sel.aid];
      return page && node ? { sel, page, node } : null;
    })
    .filter((it): it is NonNullable<typeof it> => it !== null);

  if (!items.length) {
    return <div className="flex-1 px-4 py-10 text-center text-xs text-neutral-400">组件已不存在</div>;
  }

  const sameType = items.every((it) => it.node.type === items[0].node.type);
  const compType = sameType ? items[0].node.type : "";

  // 共同 prop keys(所有组件都有的 key);各 key 的值全同 → 该值,不同 → MIXED
  const commonKeys = Object.keys(items[0].node.props).filter((k) =>
    items.every((it) => k in it.node.props),
  );
  const values: Record<string, MixedValue> = Object.fromEntries(
    commonKeys.map((k) => {
      const v0 = JSON.stringify(items[0].node.props[k]);
      return [k, items.every((it) => JSON.stringify(it.node.props[k]) === v0) ? items[0].node.props[k] : MIXED];
    }),
  );

  /** 按页分组提交:每个组件一条 op,整个批量操作共享一次 undo 快照(.multi) */
  const commitAll = (prop: string, value: unknown) => {
    const byPage = new Map<number, { page: (typeof items)[0]["page"]; ops: { op: "replaceProps"; id: string; props: Record<string, unknown> }[] }>();
    for (const it of items) {
      const g = byPage.get(it.page.id) ?? { page: it.page, ops: [] };
      g.ops.push({ op: "replaceProps", id: it.sel.aid, props: { [prop]: value } });
      byPage.set(it.page.id, g);
    }
    applyPageOps.multi([...byPage.values()]);
  };

  const deleteAll = () => {
    const byPage = new Map<number, { page: (typeof items)[0]["page"]; ops: { op: "removeNode"; id: string }[] }>();
    for (const it of items) {
      if (it.sel.aid === it.page.surface.root) continue; // root 不可删
      const g = byPage.get(it.page.id) ?? { page: it.page, ops: [] };
      g.ops.push({ op: "removeNode", id: it.sel.aid });
      byPage.set(it.page.id, g);
    }
    applyPageOps.multi([...byPage.values()]);
    setSelectedElements([]);
  };

  const pageCount = new Set(items.map((it) => it.page.id)).size;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center gap-1.5 border-b border-neutral-100 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-neutral-800">
            {items.length} 个组件{sameType ? ` · ${compType}` : ""}
          </div>
          <div className="truncate text-[10px] text-neutral-400">
            {pageCount > 1 ? `分布在 ${pageCount} 个页面` : items[0].page.title}
          </div>
        </div>
        <button
          title="删除全部选中组件"
          onClick={deleteAll}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-500">
          <Trash2 size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {commonKeys.map((prop) => {
          const v = values[prop];
          const mixed = v === MIXED;
          return (
            <PropField
              key={prop}
              compType={compType}
              prop={prop}
              // mixed 时传首组件的值:仅用于决定编辑器类型,显示为「多个值」占位
              value={mixed ? items[0].node.props[prop] : v}
              mixed={mixed}
              onCommit={(nv) => commitAll(prop, nv)}
            />
          );
        })}
        {!commonKeys.length && (
          <div className="py-4 text-center text-xs text-neutral-400">选中组件没有共同属性可批量编辑</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 单个 prop 字段:按类型选择编辑器;mixed 表示多选时值不一致(显示「多个值」)
// ---------------------------------------------------------------------------
function PropField({ compType, prop, value, onCommit, mixed }: {
  compType: string;
  prop: string;
  value: unknown;
  onCommit: (v: unknown) => void;
  mixed?: boolean;
}) {
  const enums = PROP_ENUMS[compType]?.[prop];
  const label = (
    <div className="mb-1 flex items-baseline gap-1.5">
      <span className="text-[11px] font-medium text-neutral-600">{PROP_LABELS[prop] ?? prop}</span>
      {PROP_LABELS[prop] && <span className="text-[9px] text-neutral-300">{prop}</span>}
    </div>
  );

  // 多选值不一致时按首个组件的值类型选编辑器,值显示为「多个值」占位
  if (enums) {
    const numeric = typeof enums[0] === "number";
    return (
      <div>
        {label}
        <select
          className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
          value={mixed ? "__mixed__" : String(value ?? "")}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__mixed__") return;
            onCommit(v === "" ? undefined : numeric ? Number(v) : v);
          }}>
          {mixed && <option value="__mixed__" disabled>多个值</option>}
          <option value="">默认</option>
          {enums.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      </div>
    );
  }
  if (typeof value === "boolean") {
    // mixed 时复选框呈 indeterminate 横线;点击即统一为 true/false
    return (
      <label className="flex cursor-pointer items-center justify-between rounded-lg border border-neutral-200 px-2.5 py-1.5">
        <span className="text-[11px] font-medium text-neutral-600">{PROP_LABELS[prop] ?? prop}</span>
        <input
          type="checkbox"
          ref={(el) => { if (el) el.indeterminate = !!mixed; }}
          checked={mixed ? false : value}
          onChange={(e) => onCommit(e.target.checked)}
          className="accent-indigo-500"
        />
      </label>
    );
  }
  if (typeof value === "number") {
    return (
      <div>
        {label}
        <DraftInput
          value={mixed ? "" : String(value)}
          mixed={mixed}
          placeholder={mixed ? "多个值" : undefined}
          onCommit={(s) => {
            const n = Number(s);
            if (s.trim() === "" || Number.isNaN(n)) { toast.error("请输入数字"); return; }
            onCommit(n);
          }}
        />
      </div>
    );
  }
  if (typeof value === "string") {
    return (
      <div>
        {label}
        <DraftInput
          value={mixed ? "" : value}
          mixed={mixed}
          placeholder={mixed ? "多个值" : undefined}
          multiline={!mixed && (value.length > 40 || value.includes("\n"))}
          onCommit={onCommit}
        />
      </div>
    );
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (
      <div>
        {label}
        <DraftInput
          value={mixed ? "" : (value as string[]).join("\n")}
          mixed={mixed}
          multiline
          placeholder={mixed ? "多个值(每行一条)" : "每行一条"}
          onCommit={(s) => onCommit(s.split("\n").map((x) => x.trim()).filter(Boolean))}
        />
      </div>
    );
  }
  // 对象/嵌套数组:JSON 编辑
  return (
    <div>
      {label}
      <DraftInput
        value={mixed ? "" : JSON.stringify(value, null, 2)}
        mixed={mixed}
        multiline
        mono
        placeholder={mixed ? "多个值(JSON)" : undefined}
        onCommit={(s) => {
          try { onCommit(JSON.parse(s)); } catch { toast.error("JSON 格式不正确,未保存"); }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 草稿输入:本地编辑,失焦/Enter 提交;外部值变化(AI 编辑)时自动重同步。
// mixed(多选值不一致):初始为空、占位提示,空输入不提交(避免误清空)。
// ---------------------------------------------------------------------------
function DraftInput({ value, onCommit, multiline, mono, placeholder, mixed }: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  mono?: boolean;
  placeholder?: string;
  mixed?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value);
  }
  const commit = () => {
    if (mixed && draft === "") return;
    if (draft !== value) onCommit(draft);
  };
  const cls = `w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-400 ${mono ? "font-mono" : ""}`;

  if (multiline) {
    return (
      <textarea
        className={`${cls} min-h-[64px] resize-y leading-relaxed`}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      className={cls}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}
