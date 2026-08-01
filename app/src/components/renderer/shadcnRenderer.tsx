/**
 * shadcn/ui 风格渲染器(Tailwind + CSS 变量令牌)
 */
import type { CSSProperties } from "react";
import { A2Icon, arr, bool, num, str, gradientFor, SvgChart, strList, textOf } from "./shared";
import type { ComponentRenderer, RenderCtx, RendererRegistry } from "./shared";

const R = "rounded-[var(--a2-radius)]";
const card = `bg-white ${R} border border-black/[0.06] shadow-[0_1px_3px_rgba(0,0,0,0.05)]`;

/** 以函数方式调用渲染器(供组合型组件内部复用) */
const call = (R2: ComponentRenderer, props: Record<string, unknown>, ctx: RenderCtx) =>
  R2({ type: "", props, children: [] }, ctx);

/** align/justify 语义值 → CSS flex 值(避免动态 Tailwind 类名被裁剪) */
const flexAlign = (v: string): CSSProperties["alignItems"] =>
  v === "center" ? "center" : v === "end" ? "flex-end" : v === "stretch" ? "stretch" : v === "baseline" ? "baseline" : "flex-start";
const flexJustify = (v: string): CSSProperties["justifyContent"] =>
  v === "center" ? "center" : v === "end" ? "flex-end" : v === "between" ? "space-between" : v === "around" ? "space-around" : v === "evenly" ? "space-evenly" : "flex-start";

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------
const Navbar: ComponentRenderer = (n) => {
  const links = strList(n.props.links);
  return (
    <header className="sticky top-0 z-20 backdrop-blur bg-white/80 border-b border-black/[0.06]">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight text-[var(--a2-text)]">
          <span className={`w-7 h-7 ${R} bg-[var(--a2-primary)] text-white flex items-center justify-center text-sm`}>
            {str(n.props.logo, "N").slice(0, 1)}
          </span>
          {str(n.props.logo, "Nova")}
        </div>
        <nav className="hidden md:flex items-center gap-7 text-sm text-[var(--a2-muted)]">
          {links.map((l, i) => (
            <a key={i} className="hover:text-[var(--a2-text)] transition-colors cursor-pointer">{l}</a>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          {!!n.props.cta && (
            <button className={`px-4 py-2 text-sm font-medium text-white bg-[var(--a2-primary)] ${R} hover:opacity-90 transition`}>
              {str(n.props.cta)}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

const Hero: ComponentRenderer = (n) => {
  const compact = bool(n.props.compact);
  return (
    <section className={`relative overflow-hidden ${compact ? "py-14" : "py-24 md:py-32"}`}>
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: `radial-gradient(60% 50% at 50% 0%, color-mix(in srgb, var(--a2-accent) 12%, transparent), transparent)` }} />
      <div className="relative max-w-4xl mx-auto px-6 text-center">
        {!!n.props.badge && (
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium ${R} border border-black/10 bg-white/70 text-[var(--a2-text)] mb-6`}>
            {str(n.props.badge)}
          </span>
        )}
        <h1 className={`${compact ? "text-3xl md:text-5xl" : "text-4xl md:text-6xl"} font-extrabold tracking-tight leading-[1.12] text-[var(--a2-text)] whitespace-pre-line`}>
          {str(n.props.title)}
        </h1>
        {!!n.props.subtitle && (
          <p className="mt-5 text-base md:text-lg text-[var(--a2-muted)] max-w-2xl mx-auto leading-relaxed">
            {str(n.props.subtitle)}
          </p>
        )}
        <div className="mt-8 flex items-center justify-center gap-3">
          {!!n.props.primaryCta && (
            <button className={`px-6 py-3 text-sm font-semibold text-white bg-[var(--a2-primary)] ${R} hover:opacity-90 transition shadow-lg shadow-black/10`}>
              {str(n.props.primaryCta)}
            </button>
          )}
          {!!n.props.secondaryCta && (
            <button className={`px-6 py-3 text-sm font-semibold ${R} border border-black/10 bg-white hover:bg-black/[0.03] transition text-[var(--a2-text)] flex items-center gap-2`}>
              <A2Icon name="play" size={15} /> {str(n.props.secondaryCta)}
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

const Section: ComponentRenderer = (n, ctx) => (
  <section
    className={`flex flex-col w-full ${bool(n.props.center) ? "items-center justify-center" : ""} ${bool(n.props.minHeight) || n.props.minHeight === "screen" ? "min-h-screen" : ""}`}
    style={{ gap: num(n.props.gap, 24), padding: num(n.props.padding, 24) }}
  >
    {n.children.map((c) => ctx.render(c))}
  </section>
);

const Container: ComponentRenderer = (n, ctx) => (
  <div className="max-w-6xl mx-auto w-full" style={{ padding: num(n.props.padding, 0) }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const Row: ComponentRenderer = (n, ctx) => {
  const ratios = arr<number>(n.props.ratios);
  return (
    <div
      className="flex w-full flex-row flex-wrap"
      style={{
        gap: num(n.props.gap, 12),
        padding: num(n.props.padding, 0),
        alignItems: flexAlign(str(n.props.align, "start")),
        justifyContent: flexJustify(str(n.props.justify, "start")),
      }}
    >
      {n.children.map((c, i) => (
        <div key={c} style={ratios[i] ? { flex: ratios[i] } : undefined} className={ratios[i] ? "min-w-0" : "contents"}>
          {ctx.render(c)}
        </div>
      ))}
    </div>
  );
};

const Col: ComponentRenderer = (n, ctx) => (
  <div className="flex flex-col" style={{ gap: num(n.props.gap, 8), alignItems: flexAlign(str(n.props.align, "stretch")) }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const Grid: ComponentRenderer = (n, ctx) => (
  <div
    className="grid w-full"
    style={{
      gridTemplateColumns: `repeat(${num(n.props.columns, 3)}, minmax(0,1fr))`,
      gap: num(n.props.gap, 16),
      padding: num(n.props.padding, 0),
    }}
  >
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const Card: ComponentRenderer = (n, ctx) => (
  <div className={`${card} ${bool(n.props.hover) ? "hover:shadow-[0_8px_30px_rgba(0,0,0,0.08)] hover:-translate-y-0.5 transition-all cursor-pointer" : ""}`}
    style={{ padding: num(n.props.padding, 20) }}>
    {!!n.props.title && (
      <div className="font-semibold text-[15px] text-[var(--a2-text)] mb-3">{str(n.props.title)}</div>
    )}
    <div className="flex flex-col gap-3">{n.children.map((c) => ctx.render(c))}</div>
  </div>
);

const Footer: ComponentRenderer = (n) => {
  const groups = arr<{ title: string; links: unknown[] }>(n.props.groups);
  return (
    <footer className="border-t border-black/[0.06] bg-white mt-8">
      <div className="max-w-6xl mx-auto px-6 py-12 flex flex-wrap gap-10 justify-between">
        <div className="flex flex-col gap-2">
          <span className="font-bold text-lg text-[var(--a2-text)]">{str(n.props.logo, "Nova")}</span>
          {!!n.props.copyright && <span className="text-xs text-[var(--a2-muted)]">{str(n.props.copyright)}</span>}
        </div>
        <div className="flex gap-16">
          {groups.map((g, i) => (
            <div key={i} className="flex flex-col gap-2.5">
              <span className="text-sm font-semibold text-[var(--a2-text)]">{textOf(g?.title)}</span>
              {(g?.links ?? []).map((l, j) => (
                <a key={j} className="text-sm text-[var(--a2-muted)] hover:text-[var(--a2-text)] cursor-pointer">{textOf(l)}</a>
              ))}
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
};

const Divider: ComponentRenderer = () => <hr className="border-black/[0.07] w-full" />;

const SidebarLayout: ComponentRenderer = (n, ctx) => {
  const menu = strList(n.props.menu);
  const active = str(n.props.activeMenu);
  return (
    <div className="flex min-h-full" style={{ minHeight: "100vh" }}>
      <aside className="w-[220px] shrink-0 bg-white border-r border-black/[0.06] flex flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b border-black/[0.06]">
          <span className={`w-7 h-7 ${R} bg-[var(--a2-primary)] text-white flex items-center justify-center text-sm font-bold`}>
            {str(n.props.logo, "N").slice(0, 1)}
          </span>
          <span className="font-bold text-[var(--a2-text)]">{str(n.props.logo, "Nova")}</span>
        </div>
        <nav className="flex-1 p-3 flex flex-col gap-1">
          {menu.map((m, i) => (
            <a key={i}
              className={`px-3 py-2 text-sm ${R} cursor-pointer transition-colors ${
                m === active
                  ? "bg-[var(--a2-primary)] text-white font-medium"
                  : "text-[var(--a2-muted)] hover:bg-black/[0.04] hover:text-[var(--a2-text)]"
              }`}>
              {m}
            </a>
          ))}
        </nav>
        <div className="p-4 border-t border-black/[0.06] flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-full bg-[var(--a2-surface)] flex items-center justify-center text-xs font-semibold text-[var(--a2-text)]">
            {str(n.props.user, "U").slice(0, 1)}
          </span>
          <span className="text-sm text-[var(--a2-text)]">{str(n.props.user, "用户")}</span>
        </div>
      </aside>
      <main className="flex-1 min-w-0 bg-[var(--a2-bg)]">
        <div className="h-16 bg-white border-b border-black/[0.06] flex items-center px-6">
          <h1 className="text-lg font-semibold text-[var(--a2-text)]">{str(n.props.title)}</h1>
        </div>
        {n.children.map((c) => ctx.render(c))}
      </main>
    </div>
  );
};

const Tabs: ComponentRenderer = (n) => {
  const tabs = strList(n.props.tabs);
  return (
    <div className="flex gap-1 border-b border-black/[0.08]">
      {tabs.map((t, i) => (
        <button key={i}
          className={`px-4 py-2.5 text-sm -mb-px border-b-2 transition-colors ${
            i === 0
              ? "border-[var(--a2-primary)] text-[var(--a2-text)] font-medium"
              : "border-transparent text-[var(--a2-muted)] hover:text-[var(--a2-text)]"
          }`}>
          {t}
        </button>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 排版
// ---------------------------------------------------------------------------
const Title: ComponentRenderer = (n) => {
  const level = num(n.props.level, 2);
  const cls: Record<number, string> = {
    1: "text-4xl font-extrabold tracking-tight",
    2: "text-2xl font-bold tracking-tight",
    3: "text-xl font-semibold",
    4: "text-base font-semibold",
  };
  return <h2 className={`${cls[level] ?? cls[2]} text-[var(--a2-text)]`}>{str(n.props.text)}</h2>;
};

const Text: ComponentRenderer = (n) => {
  const variant = str(n.props.variant);
  const cls =
    variant === "lead" ? "text-lg text-[var(--a2-muted)]"
    : variant === "muted" ? "text-sm text-[var(--a2-muted)]"
    : variant === "caption" ? "text-xs text-[var(--a2-muted)]"
    : "text-sm text-[var(--a2-text)] leading-relaxed";
  const weight = str(n.props.weight) === "medium" ? "font-medium" : "";
  return <p className={`${cls} ${weight}`}>{str(n.props.text)}</p>;
};

const Link: ComponentRenderer = (n) => (
  <a className="text-sm font-medium text-[var(--a2-accent)] hover:underline cursor-pointer inline-flex items-center gap-1">
    {str(n.props.label, str(n.props.text))} <A2Icon name="arrow-right" size={14} />
  </a>
);

const Badge: ComponentRenderer = (n) => (
  <span className={`inline-flex items-center px-2.5 py-0.5 text-xs font-medium ${R} bg-[var(--a2-surface)] text-[var(--a2-text)]`}>
    {str(n.props.label)}
  </span>
);

const Tag: ComponentRenderer = (n) => (
  <span className={`inline-flex w-fit items-center px-2.5 py-0.5 text-xs font-medium rounded-full`}
    style={{ background: "color-mix(in srgb, var(--a2-accent) 12%, transparent)", color: "var(--a2-accent)" }}>
    {str(n.props.label)}
  </span>
);

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------
const Button: ComponentRenderer = (n) => {
  const variant = str(n.props.variant, "primary");
  const size = str(n.props.size) === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";
  const cls =
    variant === "outline" ? `border border-black/12 bg-white text-[var(--a2-text)] hover:bg-black/[0.03]`
    : variant === "ghost" ? `text-[var(--a2-text)] hover:bg-black/[0.05]`
    : variant === "danger" ? `bg-red-600 text-white hover:opacity-90`
    : variant === "success" ? `bg-green-600 text-white hover:opacity-90`
    : `bg-[var(--a2-primary)] text-white hover:opacity-90 shadow-sm`;
  return (
    <button className={`inline-flex items-center gap-1.5 font-medium ${R} transition ${size} ${cls}`}>
      {!!n.props.icon && <A2Icon name={n.props.icon} size={15} />}
      {str(n.props.label, "按钮")}
    </button>
  );
};

const Input: ComponentRenderer = (n) => (
  <input
    className={`w-full px-3.5 py-2.5 text-sm ${R} border border-black/10 bg-white outline-none focus:border-[var(--a2-accent)] focus:ring-2 transition placeholder:text-[var(--a2-muted)]`}
    style={{ ["--tw-ring-color" as string]: "color-mix(in srgb, var(--a2-accent) 20%, transparent)" }}
    placeholder={str(n.props.placeholder, "请输入…")}
    defaultValue={str(n.props.value)}
    readOnly
  />
);

const Textarea: ComponentRenderer = (n) => (
  <textarea
    className={`w-full px-3.5 py-2.5 text-sm ${R} border border-black/10 bg-white outline-none focus:border-[var(--a2-accent)] min-h-[90px] placeholder:text-[var(--a2-muted)]`}
    placeholder={str(n.props.placeholder, "请输入…")}
    defaultValue={str(n.props.value)}
    readOnly
  />
);

const Select: ComponentRenderer = (n) => {
  const options = strList(n.props.options);
  return (
    <select className={`w-full px-3.5 py-2.5 text-sm ${R} border border-black/10 bg-white outline-none text-[var(--a2-text)]`}
      defaultValue={str(n.props.value, options[0])}>
      {options.map((o, i) => <option key={i}>{o}</option>)}
    </select>
  );
};

const Checkbox: ComponentRenderer = (n) => (
  <label className="inline-flex items-center gap-2 text-sm text-[var(--a2-text)] cursor-pointer">
    <span className={`w-4 h-4 rounded border ${bool(n.props.checked, true) ? "bg-[var(--a2-primary)] border-[var(--a2-primary)]" : "border-black/20 bg-white"} flex items-center justify-center`}>
      {bool(n.props.checked, true) && <A2Icon name="check" size={12} className="text-white" />}
    </span>
    {str(n.props.label)}
  </label>
);

const Switch: ComponentRenderer = (n) => {
  const on = bool(n.props.on, true);
  return (
    <span className={`relative inline-flex w-10 h-[22px] rounded-full transition-colors cursor-pointer ${on ? "bg-[var(--a2-primary)]" : "bg-black/15"}`}>
      <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${on ? "left-[21px]" : "left-[3px]"}`} />
    </span>
  );
};

const SearchBar: ComponentRenderer = (n) => (
  <div className={`flex items-center gap-2 px-3.5 py-2.5 ${R} border border-black/10 bg-white`}
    style={{ width: num(n.props.width) || "100%" }}>
    <A2Icon name="search" size={16} className="text-[var(--a2-muted)] shrink-0" />
    <input className="flex-1 text-sm outline-none bg-transparent placeholder:text-[var(--a2-muted)]"
      placeholder={str(n.props.placeholder, "搜索…")} readOnly />
  </div>
);

const Form: ComponentRenderer = (n, ctx) => {
  const fields = arr<{ label: string; type: string; value?: string; options?: string[] }>(n.props.fields);
  return (
    <div className="flex flex-col gap-4">
      {fields.map((f, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-[var(--a2-text)]">{f.label}</label>
          {f.type === "textarea" ? call(Textarea, { value: f.value }, ctx)
            : f.type === "select" ? call(Select, { options: f.options ?? [], value: f.value }, ctx)
            : call(Input, { value: f.value }, ctx)}
        </div>
      ))}
      {!!n.props.submitLabel && (
        <button className={`self-start px-5 py-2.5 text-sm font-medium text-white bg-[var(--a2-primary)] ${R} hover:opacity-90 transition`}>
          {str(n.props.submitLabel)}
        </button>
      )}
    </div>
  );
};

const LoginForm: ComponentRenderer = (n, ctx) => {
  const isLogin = str(n.props.mode, "login") === "login";
  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6"
      style={{ background: `linear-gradient(135deg, color-mix(in srgb, var(--a2-accent) 10%, var(--a2-bg)), var(--a2-bg))` }}>
      <div className={`w-full max-w-sm ${card} p-8`}>
        <div className={`w-11 h-11 ${R} bg-[var(--a2-primary)] text-white flex items-center justify-center mb-5`}>
          <A2Icon name="sparkles" size={20} />
        </div>
        <h2 className="text-xl font-bold text-[var(--a2-text)]">{str(n.props.title, "欢迎")}</h2>
        <p className="text-sm text-[var(--a2-muted)] mt-1 mb-6">{str(n.props.subtitle)}</p>
        <div className="flex flex-col gap-3.5">
          {!isLogin && call(Input, { placeholder: "昵称" }, ctx)}
          {call(Input, { placeholder: "邮箱" }, ctx)}
          {call(Input, { placeholder: "密码" }, ctx)}
          <button className={`w-full py-2.5 text-sm font-semibold text-white bg-[var(--a2-primary)] ${R} hover:opacity-90 transition mt-1`}>
            {str(n.props.submitLabel, "登 录")}
          </button>
          <div className="flex items-center justify-between text-xs text-[var(--a2-muted)]">
            {call(Checkbox, { label: "记住我", checked: true }, ctx)}
            <a className="hover:text-[var(--a2-accent)] cursor-pointer">忘记密码？</a>
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------
const Table: ComponentRenderer = (n) => {
  const columns = arr<{ key: string; title: string }>(n.props.columns);
  const rows = arr<unknown[]>(n.props.rows);
  const statusKey = str(n.props.statusKey);
  const avatarKey = str(n.props.avatarKey);
  const statusIdx = columns.findIndex((c) => c.key === statusKey);
  const avatarIdx = columns.findIndex((c) => c.key === avatarKey);
  const statusColor = (s: string) =>
    /支付|在职|成功|active|完成/.test(s) ? "bg-green-50 text-green-700"
    : /待|试用|pending/.test(s) ? "bg-amber-50 text-amber-700"
    : /退|休假|失败/.test(s) ? "bg-red-50 text-red-600"
    : "bg-black/[0.05] text-[var(--a2-muted)]";
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/[0.07]">
            {columns.map((c, i) => (
              <th key={i} className="text-left font-medium text-[var(--a2-muted)] px-3 py-2.5 whitespace-nowrap">{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-black/[0.04] hover:bg-black/[0.02] transition-colors">
              {columns.map((_c, ci) => {
                const v = r[ci];
                return (
                  <td key={ci} className="px-3 py-3 text-[var(--a2-text)] whitespace-nowrap">
                    {ci === statusIdx ? (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(String(v))}`}>{String(v)}</span>
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
        <div className="flex items-center justify-between px-3 pt-3 text-xs text-[var(--a2-muted)]">
          <span>共 {rows.length} 条</span>
          <span className="flex gap-1">
            {[1, 2, 3, "…", 12].map((p, i) => (
              <span key={i} className={`w-7 h-7 flex items-center justify-center ${R} cursor-pointer ${i === 0 ? "bg-[var(--a2-primary)] text-white" : "hover:bg-black/[0.05]"}`}>{p}</span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
};

const List: ComponentRenderer = (n, ctx) => (
  <div className="flex flex-col" style={{ gap: num(n.props.gap, 4), padding: num(n.props.padding, 0) }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const ListItem: ComponentRenderer = (n, ctx) => {
  const extra = str(n.props.extra);
  return (
    <div className={`flex items-center gap-3.5 px-2 py-3 ${R} hover:bg-black/[0.02] transition`}>
      {!!n.props.icon && (
        <span className={`w-9 h-9 ${R} bg-[var(--a2-surface)] flex items-center justify-center text-[var(--a2-text)] shrink-0`}>
          <A2Icon name={n.props.icon} size={17} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-[var(--a2-text)]">{str(n.props.title)}</div>
        {!!n.props.desc && <div className="text-xs text-[var(--a2-muted)] mt-0.5">{str(n.props.desc)}</div>}
      </div>
      {extra.startsWith("switch") && call(Switch, { on: extra.endsWith("on") }, ctx)}
      {extra.startsWith("text") && (
        <a className="text-xs text-[var(--a2-accent)] cursor-pointer hover:underline">{extra.split(":")[1] ?? "查看"}</a>
      )}
      {!extra && <A2Icon name="chevron-right" size={16} className="text-[var(--a2-muted)]" />}
    </div>
  );
};

const Avatar: ComponentRenderer = (n) => {
  const size = num(n.props.size, 40);
  const name = str(n.props.name, "U");
  return (
    <span className="rounded-full flex items-center justify-center font-semibold text-white shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.38, background: gradientFor(name) }}>
      {name.slice(0, 1)}
    </span>
  );
};

const Statistic: ComponentRenderer = (n) => {
  const up = bool(n.props.trendUp, true);
  return (
    <div className={`${card} p-5`}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--a2-muted)]">{str(n.props.label)}</span>
        {!!n.props.icon && (
          <span className={`w-8 h-8 ${R} flex items-center justify-center`}
            style={{ background: "color-mix(in srgb, var(--a2-accent) 10%, transparent)", color: "var(--a2-accent)" }}>
            <A2Icon name={n.props.icon} size={16} />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--a2-text)]">{str(n.props.value)}</div>
      {!!n.props.trend && (
        <div className={`mt-1 text-xs font-medium flex items-center gap-1 ${up ? "text-green-600" : "text-red-500"}`}>
          <A2Icon name="trending-up" size={13} style={up ? undefined : { transform: "scaleY(-1)" }} />
          {str(n.props.trend)} <span className="text-[var(--a2-muted)] font-normal">较上周</span>
        </div>
      )}
    </div>
  );
};

const Progress: ComponentRenderer = (n) => {
  const value = num(n.props.value, 60);
  return (
    <div className="w-full">
      {!!n.props.label && (
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-[var(--a2-text)]">{str(n.props.label)}</span>
          <span className="text-[var(--a2-muted)]">{value}%</span>
        </div>
      )}
      <div className="h-2 rounded-full bg-black/[0.07] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--a2-accent)] transition-all" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
};

const Chart: ComponentRenderer = (n, ctx) => (
  <SvgChart kind={n.props.kind} categories={n.props.categories} series={n.props.series}
    height={n.props.height} accent={ctx.tokens.accent} />
);

const Timeline: ComponentRenderer = (n) => {
  const items = arr<{ time: string; title: string; desc?: string }>(n.props.items);
  return (
    <div className="flex flex-col">
      {items.map((it, i) => (
        <div key={i} className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--a2-accent)] mt-1.5" />
            {i < items.length - 1 && <span className="w-px flex-1 bg-black/10" />}
          </div>
          <div className="pb-5">
            <div className="text-xs text-[var(--a2-muted)]">{it.time}</div>
            <div className="text-sm font-medium text-[var(--a2-text)] mt-0.5">{it.title}</div>
            {!!it.desc && <div className="text-xs text-[var(--a2-muted)] mt-1">{it.desc}</div>}
          </div>
        </div>
      ))}
    </div>
  );
};

const Rating: ComponentRenderer = (n) => {
  const value = num(n.props.value, 4);
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <A2Icon key={i} name="star" size={15}
          className={i <= value ? "text-amber-400 fill-amber-400" : "text-black/15"} />
      ))}
    </span>
  );
};

const Empty: ComponentRenderer = (n) => (
  <div className="flex flex-col items-center justify-center py-14 gap-2 text-[var(--a2-muted)]">
    <A2Icon name="image" size={36} className="opacity-40" />
    <span className="text-sm">{str(n.props.text, "暂无数据")}</span>
  </div>
);

// ---------------------------------------------------------------------------
// 导航 / 反馈 / 媒体
// ---------------------------------------------------------------------------
const NavLinks: ComponentRenderer = (n) => (
  <nav className="flex gap-6">
    {strList(n.props.links).map((l, i) => (
      <a key={i} className="text-sm text-[var(--a2-muted)] hover:text-[var(--a2-text)] cursor-pointer">{l}</a>
    ))}
  </nav>
);

const Breadcrumb: ComponentRenderer = (n) => (
  <div className="flex items-center gap-1.5 text-sm text-[var(--a2-muted)]">
    {strList(n.props.items).map((it, i, a) => (
      <span key={i} className="flex items-center gap-1.5">
        <span className={i === a.length - 1 ? "text-[var(--a2-text)] font-medium" : ""}>{it}</span>
        {i < a.length - 1 && <A2Icon name="chevron-right" size={13} />}
      </span>
    ))}
  </div>
);

const Pagination: ComponentRenderer = () => (
  <div className="flex gap-1 justify-center">
    {["‹", 1, 2, 3, "…", 9, "›"].map((p, i) => (
      <span key={i} className={`w-8 h-8 flex items-center justify-center text-sm ${R} cursor-pointer ${p === 1 ? "bg-[var(--a2-primary)] text-white" : "text-[var(--a2-muted)] hover:bg-black/[0.05]"}`}>{p}</span>
    ))}
  </div>
);

const Steps: ComponentRenderer = (n) => (
  <div className="flex items-center w-full">
    {strList(n.props.items).map((s, i, a) => {
      const current = num(n.props.current, 1);
      const done = i < current;
      return (
        <div key={i} className="flex items-center flex-1 last:flex-none">
          <div className="flex flex-col items-center gap-1.5">
            <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold ${done ? "bg-[var(--a2-primary)] text-white" : "bg-black/[0.07] text-[var(--a2-muted)]"}`}>
              {done ? <A2Icon name="check" size={13} /> : i + 1}
            </span>
            <span className={`text-xs ${done ? "text-[var(--a2-text)]" : "text-[var(--a2-muted)]"}`}>{s}</span>
          </div>
          {i < a.length - 1 && <span className={`flex-1 h-px mx-2 mb-5 ${i < current - 1 ? "bg-[var(--a2-primary)]" : "bg-black/10"}`} />}
        </div>
      );
    })}
  </div>
);

const TabBar: ComponentRenderer = (n) => {
  const items = arr<{ icon: string; label: string; active?: boolean }>(n.props.items);
  return (
    <nav className="sticky bottom-0 mt-auto bg-white border-t border-black/[0.07] px-2 py-1.5 flex justify-around z-20">
      {items.map((it, i) => (
        <div key={i} className={`flex flex-col items-center gap-0.5 py-1 px-3 cursor-pointer ${it.active ? "text-[var(--a2-accent)]" : "text-[var(--a2-muted)]"}`}>
          <A2Icon name={it.icon} size={20} />
          <span className="text-[10px]">{it.label}</span>
        </div>
      ))}
    </nav>
  );
};

const Alert: ComponentRenderer = (n) => {
  const kind = str(n.props.kind, "info");
  const cls = kind === "warning" ? "bg-amber-50 text-amber-800 border-amber-200"
    : kind === "error" ? "bg-red-50 text-red-700 border-red-200"
    : kind === "success" ? "bg-green-50 text-green-700 border-green-200"
    : "bg-blue-50 text-blue-700 border-blue-200";
  return (
    <div className={`px-4 py-3 text-sm ${R} border ${cls}`}>
      <span className="font-medium">{str(n.props.title)}</span> {str(n.props.text)}
    </div>
  );
};

const Skeleton: ComponentRenderer = (n) => (
  <div className="flex flex-col gap-2.5 w-full">
    {Array.from({ length: num(n.props.lines, 3) }).map((_, i) => (
      <div key={i} className="h-3.5 rounded bg-black/[0.07] animate-pulse" style={{ width: `${90 - i * 15}%` }} />
    ))}
  </div>
);

const Image: ComponentRenderer = (n) => {
  const width = num(n.props.width, 0);
  const ratio = str(n.props.ratio, "16:9");
  const [rw, rh] = ratio.split(":").map(Number);
  return (
    <div className={`${bool(n.props.rounded) ? R : ""} overflow-hidden shrink-0 flex items-center justify-center text-white/80`}
      style={{
        width: width || "100%",
        aspectRatio: `${rw || 16}/${rh || 9}`,
        background: gradientFor(str(n.props.alt, "img")),
      }}>
      <A2Icon name="image" size={26} />
    </div>
  );
};

const IconComp: ComponentRenderer = (n) => {
  const boxed = bool(n.props.boxed);
  const size = num(n.props.size, 20);
  if (boxed)
    return (
      <span className={`w-11 h-11 ${R} flex items-center justify-center`}
        style={{ background: "color-mix(in srgb, var(--a2-accent) 10%, transparent)", color: "var(--a2-accent)" }}>
        <A2Icon name={n.props.name} size={size} />
      </span>
    );
  return <A2Icon name={n.props.name} size={size} className="text-[var(--a2-text)]" />;
};

const LogoCloud: ComponentRenderer = (n) => (
  <section className="py-10 border-y border-black/[0.05] bg-white/60">
    <div className="max-w-6xl mx-auto px-6 flex flex-col items-center gap-6">
      <span className="text-xs font-medium tracking-widest uppercase text-[var(--a2-muted)]">{str(n.props.title)}</span>
      <div className="flex flex-wrap justify-center gap-x-12 gap-y-4">
        {strList(n.props.logos).map((l, i) => (
          <span key={i} className="text-lg font-bold text-black/25 tracking-tight">{l}</span>
        ))}
      </div>
    </div>
  </section>
);

// ---------------------------------------------------------------------------
// 营销组合
// ---------------------------------------------------------------------------
const FeatureGrid: ComponentRenderer = (n) => {
  const features = arr<{ icon: string; title: string; desc: string }>(n.props.features);
  return (
    <section className="py-20">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <h2 className="text-3xl font-bold tracking-tight text-[var(--a2-text)]">{str(n.props.title)}</h2>
          {!!n.props.subtitle && <p className="mt-3 text-[var(--a2-muted)]">{str(n.props.subtitle)}</p>}
        </div>
        <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(${num(n.props.columns, 3)}, minmax(0,1fr))` }}>
          {features.map((f, i) => (
            <div key={i} className={`${card} p-6 hover:shadow-[0_8px_30px_rgba(0,0,0,0.07)] transition-shadow`}>
              <span className={`w-10 h-10 ${R} flex items-center justify-center mb-4`}
                style={{ background: "color-mix(in srgb, var(--a2-accent) 10%, transparent)", color: "var(--a2-accent)" }}>
                <A2Icon name={f.icon} size={19} />
              </span>
              <h3 className="font-semibold text-[var(--a2-text)]">{f.title}</h3>
              <p className="mt-1.5 text-sm text-[var(--a2-muted)] leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

const PricingTable: ComponentRenderer = (n) => {
  const plans = arr<{ name: string; price: string; unit?: string; desc?: string; features: string[]; cta: string; highlight?: boolean }>(n.props.plans);
  return (
    <section className="pb-20 px-6">
      <div className="max-w-5xl mx-auto grid gap-6" style={{ gridTemplateColumns: `repeat(${plans.length}, minmax(0,1fr))` }}>
        {plans.map((p, i) => (
          <div key={i}
            className={`${R} p-7 flex flex-col gap-5 transition-transform ${
              p.highlight
                ? "bg-[var(--a2-primary)] text-white shadow-xl scale-[1.03] relative"
                : `${card}`
            }`}>
            {p.highlight && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 text-xs font-semibold rounded-full bg-[var(--a2-accent)] text-white">最受欢迎</span>
            )}
            <div>
              <h3 className={`font-semibold ${p.highlight ? "text-white" : "text-[var(--a2-text)]"}`}>{p.name}</h3>
              <p className={`text-xs mt-1 ${p.highlight ? "text-white/70" : "text-[var(--a2-muted)]"}`}>{p.desc}</p>
            </div>
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-extrabold tracking-tight ${p.highlight ? "text-white" : "text-[var(--a2-text)]"}`}>{p.price}</span>
              <span className={`text-sm ${p.highlight ? "text-white/70" : "text-[var(--a2-muted)]"}`}>{p.unit}</span>
            </div>
            <ul className="flex flex-col gap-2.5 flex-1">
              {p.features.map((f, j) => (
                <li key={j} className={`flex items-center gap-2 text-sm ${p.highlight ? "text-white/90" : "text-[var(--a2-text)]"}`}>
                  <A2Icon name="check" size={14} className={p.highlight ? "text-white" : "text-[var(--a2-accent)]"} /> {f}
                </li>
              ))}
            </ul>
            <button className={`w-full py-2.5 text-sm font-semibold ${R} transition ${
              p.highlight ? "bg-white text-[var(--a2-text)] hover:opacity-90" : "bg-[var(--a2-primary)] text-white hover:opacity-90"
            }`}>{p.cta}</button>
          </div>
        ))}
      </div>
    </section>
  );
};

const TestimonialCard: ComponentRenderer = (n) => (
  <section className="py-20">
    <div className="max-w-3xl mx-auto px-6 text-center">
      <div className="text-5xl leading-none text-[var(--a2-accent)] font-serif">"</div>
      <p className="text-xl md:text-2xl font-medium leading-relaxed text-[var(--a2-text)] -mt-3">
        {str(n.props.quote)}
      </p>
      <div className="mt-6 flex items-center justify-center gap-3">
        <span className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold"
          style={{ background: gradientFor(str(n.props.name, "U")) }}>
          {str(n.props.name, "U").slice(0, 1)}
        </span>
        <div className="text-left">
          <div className="text-sm font-semibold text-[var(--a2-text)]">{str(n.props.name)}</div>
          <div className="text-xs text-[var(--a2-muted)]">{str(n.props.role)}</div>
        </div>
      </div>
    </div>
  </section>
);

const StatsRow: ComponentRenderer = (n) => (
  <section className="py-14 bg-[var(--a2-primary)]">
    <div className="max-w-6xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8">
      {arr<{ value: string; label: string }>(n.props.stats).map((s, i) => (
        <div key={i} className="text-center">
          <div className="text-3xl font-extrabold tracking-tight text-white">{s.value}</div>
          <div className="mt-1 text-sm text-white/60">{s.label}</div>
        </div>
      ))}
    </div>
  </section>
);

const CTASection: ComponentRenderer = (n) => {
  const compact = bool(n.props.compact);
  return (
    <section className={compact ? "px-0" : "px-6 pb-20"}>
      <div className={`${compact ? "" : "max-w-5xl mx-auto"} ${R} overflow-hidden relative`}
        style={{ background: `linear-gradient(120deg, var(--a2-primary), color-mix(in srgb, var(--a2-accent) 70%, var(--a2-primary)))` }}>
        <div className={`relative text-center ${compact ? "py-8 px-6" : "py-16 px-8"}`}>
          <h2 className={`${compact ? "text-xl" : "text-3xl"} font-bold tracking-tight text-white`}>{str(n.props.title)}</h2>
          {!!n.props.subtitle && <p className={`mt-2.5 text-white/75 ${compact ? "text-xs" : "text-sm"}`}>{str(n.props.subtitle)}</p>}
          {!!n.props.cta && (
            <button className={`mt-5 px-6 py-2.5 ${compact ? "text-xs py-2" : "text-sm"} font-semibold bg-white text-[var(--a2-text)] ${R} hover:opacity-90 transition shadow-lg`}>
              {str(n.props.cta)}
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

const FAQ: ComponentRenderer = (n) => (
  <section className="pb-20 px-6">
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-bold tracking-tight text-center mb-8 text-[var(--a2-text)]">{str(n.props.title, "常见问题")}</h2>
      <div className="flex flex-col gap-3">
        {arr<{ q: string; a: string }>(n.props.items).map((it, i) => (
          <details key={i} className={`${card} px-5 py-4 group`} open={i === 0}>
            <summary className="flex items-center justify-between cursor-pointer text-sm font-medium text-[var(--a2-text)] list-none">
              {it.q}
              <A2Icon name="chevron-right" size={15} className="text-[var(--a2-muted)] group-open:rotate-90 transition-transform" />
            </summary>
            <p className="mt-2.5 text-sm text-[var(--a2-muted)] leading-relaxed">{it.a}</p>
          </details>
        ))}
      </div>
    </div>
  </section>
);

const ProductCard: ComponentRenderer = (n) => {
  const name = str(n.props.name, "商品");
  return (
    <div className={`${card} overflow-hidden hover:shadow-[0_10px_36px_rgba(0,0,0,0.09)] hover:-translate-y-1 transition-all cursor-pointer`}>
      <div className="aspect-square flex items-center justify-center text-white/85 relative"
        style={{ background: gradientFor(name) }}>
        <A2Icon name="image" size={30} />
        {!!n.props.tag && (
          <span className="absolute top-3 left-3 px-2 py-0.5 text-xs font-semibold rounded-full bg-white/90 text-[var(--a2-text)]">
            {str(n.props.tag)}
          </span>
        )}
      </div>
      <div className="p-4">
        <h3 className="text-sm font-medium text-[var(--a2-text)] truncate">{name}</h3>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-base font-bold text-red-600">{str(n.props.price)}</span>
          <span className="flex items-center gap-1 text-xs text-[var(--a2-muted)]">
            <A2Icon name="star" size={12} className="text-amber-400 fill-amber-400" />
            {str(n.props.rating, "4.8")}
          </span>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------
export const shadcnRegistry: RendererRegistry = {
  Navbar, Hero, Section, Container, Row, Col, Grid, Card, Footer, Divider, Tabs, SidebarLayout,
  Title, Text, Link, Badge, Tag,
  Button, Input, Textarea, Select, Checkbox, Switch, SearchBar, LoginForm, Form,
  Table, List, ListItem, Avatar, Statistic, Progress, Chart, Timeline, Rating, Empty,
  NavLinks, Breadcrumb, Pagination, Steps, TabBar,
  Alert, Skeleton,
  Image, Icon: IconComp, LogoCloud,
  FeatureGrid, PricingTable, TestimonialCard, StatsRow, CTASection, FAQ, ProductCard,
};
