/**
 * Element UI(Element Plus)风格渲染器
 *
 * 说明:Element 官方实现是 Vue 组件库,React 侧没有维护中的等价物,
 * 这里按 Element Plus 设计令牌手工复刻其视觉语言:
 * - 主色 #409eff,成功 #67c23a,警告 #e6a23c,危险 #f56c6c
 * - 文字 #303133 / #606266 / #909399,边框 #dcdfe6,页面底 #f5f7fa
 * - 圆角 4px,控件高度 32px,字重克制
 * 未覆盖的组件直接复用 shadcn 实现(token 驱动,自动换成 Element 配色)。
 */
import { A2Icon, arr, bool, num, str, gradientFor, strList } from "./shared";
import type { ComponentRenderer, RendererRegistry } from "./shared";
import { shadcnRegistry } from "./shadcnRenderer";

/** Element 基准圆角 4px */
const R4 = "rounded";
const elCard = `bg-white ${R4} border border-[#ebeef5] shadow-[0_2px_12px_rgba(0,0,0,0.06)]`;

// ---------------------------------------------------------------------------
// 布局(头部 / 卡片 / 侧栏)
// ---------------------------------------------------------------------------
const Navbar: ComponentRenderer = (n) => {
  const links = strList(n.props.links);
  return (
    <header className="sticky top-0 z-20 bg-white border-b border-[#ebeef5]">
      <div className="max-w-6xl mx-auto px-6 h-[60px] flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-lg text-[#303133]">
          <span className={`w-7 h-7 ${R4} bg-[var(--a2-primary)] text-white flex items-center justify-center text-sm font-bold`}>
            {str(n.props.logo, "N").slice(0, 1)}
          </span>
          {str(n.props.logo, "Nova")}
        </div>
        <nav className="hidden md:flex items-center gap-7 text-sm text-[#606266]">
          {links.map((l, i) => (
            <a key={i} className="hover:text-[var(--a2-primary)] transition-colors cursor-pointer">{l}</a>
          ))}
        </nav>
        {!!n.props.cta && (
          <button className={`h-8 px-4 text-sm text-white bg-[var(--a2-primary)] ${R4} hover:opacity-85 transition`}>
            {str(n.props.cta)}
          </button>
        )}
      </div>
    </header>
  );
};

const Card: ComponentRenderer = (n, ctx) => (
  <div className={elCard}>
    {!!n.props.title && (
      <div className="px-5 py-3.5 border-b border-[#ebeef5] text-sm font-semibold text-[#303133]">
        {str(n.props.title)}
      </div>
    )}
    <div className="flex flex-col gap-3 p-5">{n.children.map((c) => ctx.render(c))}</div>
  </div>
);

const SidebarLayout: ComponentRenderer = (n, ctx) => {
  const menu = strList(n.props.menu);
  const active = str(n.props.activeMenu);
  return (
    <div className="flex min-h-full" style={{ minHeight: "100vh" }}>
      {/* Element 后台经典深色侧栏 */}
      <aside className="w-[220px] shrink-0 bg-[#001529] flex flex-col">
        <div className="h-[60px] flex items-center gap-2 px-5 border-b border-white/10">
          <span className={`w-7 h-7 ${R4} bg-[var(--a2-primary)] text-white flex items-center justify-center text-sm font-bold`}>
            {str(n.props.logo, "N").slice(0, 1)}
          </span>
          <span className="font-semibold text-white">{str(n.props.logo, "Nova")}</span>
        </div>
        <nav className="flex-1 py-2 flex flex-col">
          {menu.map((m, i) => (
            <a key={i}
              className={`px-5 py-3 text-sm cursor-pointer transition-colors border-l-2 ${
                m === active
                  ? "bg-white/10 text-[var(--a2-primary)] border-[var(--a2-primary)] font-medium"
                  : "text-white/60 border-transparent hover:text-white"
              }`}>
              {m}
            </a>
          ))}
        </nav>
        <div className="p-4 border-t border-white/10 flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center text-xs font-semibold text-white">
            {str(n.props.user, "U").slice(0, 1)}
          </span>
          <span className="text-sm text-white/80">{str(n.props.user, "用户")}</span>
        </div>
      </aside>
      <main className="flex-1 min-w-0 bg-[#f5f7fa]">
        <div className="h-[60px] bg-white border-b border-[#ebeef5] flex items-center px-6">
          <h1 className="text-base font-semibold text-[#303133]">{str(n.props.title)}</h1>
        </div>
        {n.children.map((c) => ctx.render(c))}
      </main>
    </div>
  );
};

const Tabs: ComponentRenderer = (n) => {
  const tabs = strList(n.props.tabs);
  return (
    <div className="flex gap-7 border-b border-[#e4e7ed]">
      {tabs.map((t, i) => (
        <button key={i}
          className={`py-2.5 text-sm -mb-px border-b-2 transition-colors ${
            i === 0
              ? "border-[var(--a2-primary)] text-[var(--a2-primary)] font-medium"
              : "border-transparent text-[#606266] hover:text-[var(--a2-primary)]"
          }`}>
          {t}
        </button>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 表单(Element 控件:32px 高、#dcdfe6 边框、focus 变主色)
// ---------------------------------------------------------------------------
const Button: ComponentRenderer = (n) => {
  const variant = str(n.props.variant, "primary");
  const size = str(n.props.size) === "sm" ? "h-7 px-3 text-xs" : "h-8 px-4 text-sm";
  const cls =
    variant === "outline" ? `bg-white border border-[var(--a2-primary)] text-[var(--a2-primary)] hover:bg-[#ecf5ff]`
    : variant === "ghost" ? `bg-white border border-[#dcdfe6] text-[#606266] hover:text-[var(--a2-primary)] hover:border-[#c6e2ff] hover:bg-[#ecf5ff]`
    : variant === "danger" ? `bg-[#f56c6c] border border-[#f56c6c] text-white hover:opacity-85`
    : variant === "success" ? `bg-[#67c23a] border border-[#67c23a] text-white hover:opacity-85`
    : `bg-[var(--a2-primary)] border border-[var(--a2-primary)] text-white hover:opacity-85`;
  return (
    <button className={`inline-flex items-center gap-1.5 font-medium ${R4} transition ${size} ${cls}`}>
      {!!n.props.icon && <A2Icon name={n.props.icon} size={14} />}
      {str(n.props.label, "按钮")}
    </button>
  );
};

const inputCls = `w-full h-8 px-3 text-sm ${R4} border border-[#dcdfe6] bg-white outline-none transition placeholder:text-[#a8abb2] hover:border-[#c0c4cc] focus:border-[var(--a2-primary)] text-[#606266]`;

const Input: ComponentRenderer = (n) => (
  <input className={inputCls} placeholder={str(n.props.placeholder, "请输入…")} defaultValue={str(n.props.value)} readOnly />
);

const Textarea: ComponentRenderer = (n) => (
  <textarea
    className={`w-full px-3 py-2 text-sm ${R4} border border-[#dcdfe6] bg-white outline-none transition placeholder:text-[#a8abb2] hover:border-[#c0c4cc] focus:border-[var(--a2-primary)] min-h-[80px] text-[#606266]`}
    placeholder={str(n.props.placeholder, "请输入…")}
    defaultValue={str(n.props.value)}
    readOnly
  />
);

const Select: ComponentRenderer = (n) => {
  const options = strList(n.props.options);
  return (
    <select className={inputCls} defaultValue={str(n.props.value, options[0])}>
      {options.map((o, i) => <option key={i}>{o}</option>)}
    </select>
  );
};

const Checkbox: ComponentRenderer = (n) => (
  <label className="inline-flex items-center gap-2 text-sm text-[#606266] cursor-pointer">
    <span className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${bool(n.props.checked, true) ? "bg-[var(--a2-primary)] border-[var(--a2-primary)]" : "border-[#dcdfe6] bg-white"}`}>
      {bool(n.props.checked, true) && <A2Icon name="check" size={10} className="text-white" />}
    </span>
    {str(n.props.label)}
  </label>
);

const Switch: ComponentRenderer = (n) => {
  const on = bool(n.props.on, true);
  return (
    <span className={`relative inline-flex w-10 h-5 rounded-full transition-colors cursor-pointer ${on ? "bg-[var(--a2-primary)]" : "bg-[#dcdfe6]"}`}>
      <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-[2px]"}`} />
    </span>
  );
};

const SearchBar: ComponentRenderer = (n) => (
  <div className={`flex items-center gap-2 h-8 px-3 ${R4} border border-[#dcdfe6] bg-white hover:border-[#c0c4cc] transition`}
    style={{ width: num(n.props.width) || "100%" }}>
    <A2Icon name="search" size={15} className="text-[#a8abb2] shrink-0" />
    <input className="flex-1 text-sm outline-none bg-transparent placeholder:text-[#a8abb2] text-[#606266]"
      placeholder={str(n.props.placeholder, "搜索…")} readOnly />
  </div>
);

// ---------------------------------------------------------------------------
// 数据(表格是 Element 的招牌)
// ---------------------------------------------------------------------------
const Table: ComponentRenderer = (n) => {
  const columns = arr<{ key: string; title: string }>(n.props.columns);
  const rows = arr<unknown[]>(n.props.rows);
  const statusIdx = columns.findIndex((c) => c.key === str(n.props.statusKey));
  const avatarIdx = columns.findIndex((c) => c.key === str(n.props.avatarKey));
  const tagColor = (s: string) =>
    /支付|在职|成功|active|完成/.test(s) ? "bg-[#f0f9eb] text-[#67c23a] border border-[#e1f3d8]"
    : /待|试用|pending/.test(s) ? "bg-[#fdf6ec] text-[#e6a23c] border border-[#faecd8]"
    : /退|休假|失败/.test(s) ? "bg-[#fef0f0] text-[#f56c6c] border border-[#fde2e2]"
    : "bg-[#f4f4f5] text-[#909399] border border-[#e9e9eb]";
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[#f5f7fa] border-b border-[#ebeef5]">
            {columns.map((c, i) => (
              <th key={i} className="text-left font-medium text-[#909399] px-3 py-2.5 whitespace-nowrap">{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-[#ebeef5] hover:bg-[#f5f7fa] transition-colors">
              {columns.map((_c, ci) => {
                const v = r[ci];
                return (
                  <td key={ci} className="px-3 py-3 text-[#606266] whitespace-nowrap">
                    {ci === statusIdx ? (
                      <span className={`px-2 py-0.5 rounded text-xs ${tagColor(String(v))}`}>{String(v)}</span>
                    ) : ci === avatarIdx ? (
                      <span className="flex items-center gap-2.5">
                        <span className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
                          style={{ background: gradientFor(String(v)) }}>{String(v).slice(0, 1)}</span>
                        {String(v)}
                      </span>
                    ) : (
                      String(v ?? "")
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {bool(n.props.pagination) && (
        <div className="flex items-center justify-between px-3 pt-3 text-xs text-[#909399]">
          <span>共 {rows.length} 条</span>
          <span className="flex gap-1">
            {[1, 2, 3, "…", 12].map((p, i) => (
              <span key={i} className={`min-w-7 h-7 px-1 flex items-center justify-center ${R4} cursor-pointer ${
                i === 0 ? "bg-[var(--a2-primary)] text-white" : "bg-[#f4f4f5] text-[#606266] hover:text-[var(--a2-primary)]"
              }`}>{p}</span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
};

const Statistic: ComponentRenderer = (n) => {
  const up = bool(n.props.trendUp, true);
  return (
    <div className={`${elCard} p-5`}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-[#909399]">{str(n.props.label)}</span>
        {!!n.props.icon && (
          <span className={`w-8 h-8 ${R4} flex items-center justify-center bg-[#ecf5ff] text-[var(--a2-primary)]`}>
            <A2Icon name={n.props.icon} size={16} />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold text-[#303133]">{str(n.props.value)}</div>
      {!!n.props.trend && (
        <div className={`mt-1 text-xs font-medium flex items-center gap-1 ${up ? "text-[#67c23a]" : "text-[#f56c6c]"}`}>
          <A2Icon name="trending-up" size={13} style={up ? undefined : { transform: "scaleY(-1)" }} />
          {str(n.props.trend)} <span className="text-[#909399] font-normal">较上周</span>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 导航 / 反馈
// ---------------------------------------------------------------------------
const Tag: ComponentRenderer = (n) => (
  <span className="inline-flex w-fit items-center px-2 py-0.5 text-xs rounded border border-[#d9ecff] bg-[#ecf5ff] text-[var(--a2-primary)]">
    {str(n.props.label)}
  </span>
);

const Badge: ComponentRenderer = (n) => (
  <span className={`inline-flex items-center px-2 py-0.5 text-xs ${R4} bg-[#f4f4f5] text-[#606266] border border-[#e9e9eb]`}>
    {str(n.props.label)}
  </span>
);

const Pagination: ComponentRenderer = () => (
  <div className="flex gap-1.5 justify-center">
    {["‹", 1, 2, 3, "…", 9, "›"].map((p, i) => (
      <span key={i} className={`min-w-8 h-8 px-1.5 flex items-center justify-center text-sm ${R4} cursor-pointer ${
        p === 1 ? "bg-[var(--a2-primary)] text-white" : "bg-[#f4f4f5] text-[#606266] hover:text-[var(--a2-primary)]"
      }`}>{p}</span>
    ))}
  </div>
);

const Alert: ComponentRenderer = (n) => {
  const kind = str(n.props.kind, "info");
  const cls = kind === "warning" ? "bg-[#fdf6ec] text-[#b88230] border-[#faecd8]"
    : kind === "error" ? "bg-[#fef0f0] text-[#f56c6c] border-[#fde2e2]"
    : kind === "success" ? "bg-[#f0f9eb] text-[#529b2e] border-[#e1f3d8]"
    : "bg-[#ecf5ff] text-[var(--a2-primary)] border-[#d9ecff]";
  return (
    <div className={`px-4 py-2.5 text-sm ${R4} border ${cls}`}>
      <span className="font-medium">{str(n.props.title)}</span> {str(n.props.text)}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 注册表:Element 化关键组件,其余复用 shadcn(token 驱动自动换色)
// ---------------------------------------------------------------------------
export const elementRegistry: RendererRegistry = {
  ...shadcnRegistry,
  Navbar, Card, SidebarLayout, Tabs,
  Button, Input, Textarea, Select, Checkbox, Switch, SearchBar,
  Table, Statistic,
  Tag, Badge, Pagination, Alert,
};
