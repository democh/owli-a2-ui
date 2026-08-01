/**
 * Ant Design 风格渲染器
 */
import { Button as AButton, Card as ACard, Input as AInput, Select as ASelect,
  Checkbox as ACheckbox, Switch as ASwitch, Table as ATable, Avatar as AAvatar,
  Statistic as AStatistic, Progress as AProgress, Timeline as ATimeline,
  Rate, Empty as AEmpty, Breadcrumb as ABreadcrumb, Pagination as APagination,
  Steps as ASteps, Alert as AAlert, Skeleton as ASkeleton, Tag as ATag,
  Typography, Layout, Menu, Space, Divider as ADivider, Form as AForm,
} from "antd";
import { A2Icon, arr, bool, num, str, gradientFor, SvgChart, strList, textOf } from "./shared";
import type { ComponentRenderer, RendererRegistry } from "./shared";

const { Title: ATitle, Text: AText, Paragraph } = Typography;
const { Header, Sider, Content, Footer: AFooter } = Layout;

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------
const Navbar: ComponentRenderer = (n) => (
  <Header style={{ background: "#fff", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 32px", position: "sticky", top: 0, zIndex: 20 }}>
    <Space size={10}>
      <AAvatar shape="square" size={30} style={{ background: "var(--a2-primary)", fontWeight: 700 }}>
        {str(n.props.logo, "N").slice(0, 1)}
      </AAvatar>
      <ATitle level={4} style={{ margin: 0 }}>{str(n.props.logo, "Nova")}</ATitle>
    </Space>
    <Space size={28}>
      {strList(n.props.links).map((l, i) => <a key={i} style={{ color: "#595959", fontSize: 14 }}>{l}</a>)}
    </Space>
    {!!n.props.cta && <AButton type="primary">{str(n.props.cta)}</AButton>}
  </Header>
);

const Hero: ComponentRenderer = (n) => {
  const compact = bool(n.props.compact);
  return (
    <div style={{ textAlign: "center", padding: compact ? "48px 24px" : "96px 24px", background: "linear-gradient(180deg, #f8faff, #fff)" }}>
      {!!n.props.badge && <ATag color="geekblue" style={{ marginBottom: 20, borderRadius: 999 }}>{str(n.props.badge)}</ATag>}
      <ATitle style={{ fontSize: compact ? 36 : 52, lineHeight: 1.15, margin: "0 auto", maxWidth: 800, whiteSpace: "pre-line" }}>
        {str(n.props.title)}
      </ATitle>
      {!!n.props.subtitle && (
        <Paragraph style={{ fontSize: 17, color: "#595959", maxWidth: 640, margin: "20px auto 0" }}>
          {str(n.props.subtitle)}
        </Paragraph>
      )}
      <Space size={12} style={{ marginTop: 32 }}>
        {!!n.props.primaryCta && <AButton type="primary" size="large">{str(n.props.primaryCta)}</AButton>}
        {!!n.props.secondaryCta && <AButton size="large">{str(n.props.secondaryCta)}</AButton>}
      </Space>
    </div>
  );
};

const Section: ComponentRenderer = (n, ctx) => (
  <div style={{
    display: "flex", flexDirection: "column", width: "100%",
    gap: num(n.props.gap, 24), padding: num(n.props.padding, 24),
    ...(bool(n.props.center) ? { alignItems: "center", justifyContent: "center" } : {}),
    ...(n.props.minHeight ? { minHeight: "100vh" } : {}),
  }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const Container: ComponentRenderer = (n, ctx) => (
  <div style={{ maxWidth: 1120, margin: "0 auto", width: "100%", padding: num(n.props.padding, 0) }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const Row: ComponentRenderer = (n, ctx) => {
  const ratios = arr<number>(n.props.ratios);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: num(n.props.gap, 12), width: "100%", alignItems: str(n.props.align, "flex-start"), justifyContent: str(n.props.justify, "flex-start"), padding: num(n.props.padding, 0) }}>
      {n.children.map((c, i) => (
        <div key={c} style={ratios[i] ? { flex: ratios[i], minWidth: 0 } : { display: "contents" }}>{ctx.render(c)}</div>
      ))}
    </div>
  );
};

const Col: ComponentRenderer = (n, ctx) => (
  <div style={{ display: "flex", flexDirection: "column", gap: num(n.props.gap, 8), alignItems: str(n.props.align, "stretch") }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const Grid: ComponentRenderer = (n, ctx) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(${num(n.props.columns, 3)}, minmax(0,1fr))`, gap: num(n.props.gap, 16), width: "100%", padding: num(n.props.padding, 0) }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const Card: ComponentRenderer = (n, ctx) => (
  <ACard title={n.props.title ? str(n.props.title) : undefined} hoverable={bool(n.props.hover)}
    styles={{ body: { padding: num(n.props.padding, 20), display: "flex", flexDirection: "column", gap: 12 } }}>
    {n.children.map((c) => ctx.render(c))}
  </ACard>
);

const Footer: ComponentRenderer = (n) => (
  <AFooter style={{ background: "#fff", borderTop: "1px solid #f0f0f0", marginTop: 32 }}>
    <div style={{ maxWidth: 1120, margin: "0 auto", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 32 }}>
      <div>
        <ATitle level={4} style={{ marginBottom: 4 }}>{str(n.props.logo, "Nova")}</ATitle>
        <AText type="secondary" style={{ fontSize: 12 }}>{str(n.props.copyright)}</AText>
      </div>
      <Space size={64} align="start">
        {arr<{ title: string; links: unknown[] }>(n.props.groups).map((g, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <AText strong>{g.title}</AText>
            {(g.links ?? []).map((l, j) => <a key={j} style={{ color: "#8c8c8c", fontSize: 13 }}>{textOf(l)}</a>)}
          </div>
        ))}
      </Space>
    </div>
  </AFooter>
);

const Divider: ComponentRenderer = () => <ADivider style={{ margin: "4px 0" }} />;

const SidebarLayout: ComponentRenderer = (n, ctx) => {
  const menu = strList(n.props.menu);
  const active = str(n.props.activeMenu);
  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider width={220} theme="light" style={{ borderRight: "1px solid #f0f0f0" }}>
        <div style={{ height: 64, display: "flex", alignItems: "center", gap: 10, padding: "0 20px", borderBottom: "1px solid #f0f0f0" }}>
          <AAvatar shape="square" size={28} style={{ background: "var(--a2-primary)", fontWeight: 700 }}>
            {str(n.props.logo, "N").slice(0, 1)}
          </AAvatar>
          <AText strong style={{ fontSize: 16 }}>{str(n.props.logo, "Nova")}</AText>
        </div>
        <Menu mode="inline" selectedKeys={[active]} style={{ border: "none", padding: 8 }}
          items={menu.map((m) => ({ key: m, label: m }))} />
        <div style={{ padding: 16, borderTop: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 10 }}>
          <AAvatar style={{ background: gradientFor(str(n.props.user, "U")) }}>{str(n.props.user, "U").slice(0, 1)}</AAvatar>
          <AText>{str(n.props.user, "用户")}</AText>
        </div>
      </Sider>
      <Layout>
        <Header style={{ background: "#fff", borderBottom: "1px solid #f0f0f0", padding: "0 24px", display: "flex", alignItems: "center" }}>
          <ATitle level={4} style={{ margin: 0 }}>{str(n.props.title)}</ATitle>
        </Header>
        <Content style={{ background: "#f5f6fa" }}>{n.children.map((c) => ctx.render(c))}</Content>
      </Layout>
    </Layout>
  );
};

const Tabs: ComponentRenderer = (n) => (
  <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #f0f0f0" }}>
    {strList(n.props.tabs).map((t, i) => (
      <div key={i} style={{
        padding: "10px 16px", fontSize: 14, cursor: "pointer", marginBottom: -1,
        borderBottom: i === 0 ? "2px solid var(--a2-primary)" : "2px solid transparent",
        color: i === 0 ? "var(--a2-primary)" : "#595959", fontWeight: i === 0 ? 500 : 400,
      }}>{t}</div>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// 排版 / 表单
// ---------------------------------------------------------------------------
const Title: ComponentRenderer = (n) => (
  <ATitle level={Math.min(5, num(n.props.level, 2)) as 1 | 2 | 3 | 4 | 5} style={{ margin: 0 }}>
    {str(n.props.text)}
  </ATitle>
);

const Text: ComponentRenderer = (n) => {
  const variant = str(n.props.variant);
  if (variant === "lead") return <Paragraph style={{ fontSize: 16, color: "#595959", margin: 0 }}>{str(n.props.text)}</Paragraph>;
  if (variant === "muted") return <AText type="secondary">{str(n.props.text)}</AText>;
  if (variant === "caption") return <AText type="secondary" style={{ fontSize: 12 }}>{str(n.props.text)}</AText>;
  return <AText style={{ fontWeight: str(n.props.weight) === "medium" ? 500 : 400 }}>{str(n.props.text)}</AText>;
};

const Link: ComponentRenderer = (n) => <a style={{ fontSize: 14, color: "var(--a2-accent)" }}>{str(n.props.label, str(n.props.text))} →</a>;
const Badge: ComponentRenderer = (n) => <ATag>{str(n.props.label)}</ATag>;
const Tag: ComponentRenderer = (n) => <ATag color="blue" style={{ borderRadius: 999, width: "fit-content" }}>{str(n.props.label)}</ATag>;

const Button: ComponentRenderer = (n) => {
  const variant = str(n.props.variant, "primary");
  return (
    <AButton
      type={variant === "primary" ? "primary" : variant === "ghost" ? "text" : "default"}
      danger={variant === "danger"}
      size={str(n.props.size) === "sm" ? "small" : "middle"}
      icon={n.props.icon ? <A2Icon name={n.props.icon} size={14} /> : undefined}
    >
      {str(n.props.label, "按钮")}
    </AButton>
  );
};

const Input: ComponentRenderer = (n) => <AInput placeholder={str(n.props.placeholder, "请输入…")} defaultValue={str(n.props.value)} />;
const Textarea: ComponentRenderer = (n) => <AInput.TextArea placeholder={str(n.props.placeholder)} defaultValue={str(n.props.value)} rows={3} />;
const Select: ComponentRenderer = (n) => (
  <ASelect style={{ width: "100%" }} defaultValue={str(n.props.value, strList(n.props.options)[0])}
    options={strList(n.props.options).map((o) => ({ label: o, value: o }))} />
);
const Checkbox: ComponentRenderer = (n) => <ACheckbox defaultChecked={bool(n.props.checked, true)}>{str(n.props.label)}</ACheckbox>;
const Switch: ComponentRenderer = (n) => <ASwitch defaultChecked={bool(n.props.on, true)} />;
const SearchBar: ComponentRenderer = (n) => (
  <AInput.Search placeholder={str(n.props.placeholder, "搜索…")} style={{ width: num(n.props.width) || "100%" }} />
);

const Form: ComponentRenderer = (n) => (
  <AForm layout="vertical">
    {arr<{ label: string; type: string; value?: string; options?: string[] }>(n.props.fields).map((f, i) => (
      <AForm.Item key={i} label={f.label} style={{ marginBottom: 16 }}>
        {f.type === "textarea" ? <AInput.TextArea defaultValue={f.value} rows={3} />
          : f.type === "select" ? <ASelect defaultValue={f.value} options={(f.options ?? []).map((o) => ({ label: o, value: o }))} />
          : <AInput defaultValue={f.value} />}
      </AForm.Item>
    ))}
    {!!n.props.submitLabel && <AButton type="primary">{str(n.props.submitLabel)}</AButton>}
  </AForm>
);

const LoginForm: ComponentRenderer = (n) => {
  const isLogin = str(n.props.mode, "login") === "login";
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #eef2ff, #f5f6fa)" }}>
      <ACard style={{ width: 360 }} styles={{ body: { padding: 32 } }}>
        <AAvatar shape="square" size={44} style={{ background: "var(--a2-primary)", marginBottom: 16 }}>
          <A2Icon name="sparkles" size={20} />
        </AAvatar>
        <ATitle level={3} style={{ marginBottom: 4 }}>{str(n.props.title, "欢迎")}</ATitle>
        <AText type="secondary">{str(n.props.subtitle)}</AText>
        <AForm layout="vertical" style={{ marginTop: 24 }}>
          {!isLogin && <AForm.Item label="昵称" style={{ marginBottom: 14 }}><AInput /></AForm.Item>}
          <AForm.Item label="邮箱" style={{ marginBottom: 14 }}><AInput /></AForm.Item>
          <AForm.Item label="密码" style={{ marginBottom: 18 }}><AInput.Password /></AForm.Item>
          <AButton type="primary" block size="large">{str(n.props.submitLabel, "登 录")}</AButton>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 12 }}>
            <ACheckbox defaultChecked>记住我</ACheckbox>
            <a style={{ color: "var(--a2-accent)" }}>忘记密码？</a>
          </div>
        </AForm>
      </ACard>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------
const Table: ComponentRenderer = (n) => {
  const columns = arr<{ key: string; title: string }>(n.props.columns);
  const statusKey = str(n.props.statusKey);
  const avatarKey = str(n.props.avatarKey);
  return (
    <ATable
      size="middle"
      pagination={bool(n.props.pagination) ? { pageSize: 6 } : false}
      dataSource={arr<unknown[]>(n.props.rows).map((r, i) => {
        const row: Record<string, unknown> = { key: i };
        columns.forEach((c, ci) => (row[c.key] = r[ci]));
        return row;
      })}
      columns={columns.map((c) => ({
        title: c.title,
        dataIndex: c.key,
        render: (v: string) =>
          c.key === statusKey ? (
            <ATag color={/支付|在职|成功|完成/.test(v) ? "green" : /待|试用/.test(v) ? "orange" : /退|休假|失败/.test(v) ? "red" : "default"}>{v}</ATag>
          ) : c.key === avatarKey ? (
            <Space><AAvatar size={28} style={{ background: gradientFor(v), fontSize: 12 }}>{v?.slice(0, 1)}</AAvatar>{v}</Space>
          ) : (
            v
          ),
      }))}
    />
  );
};

const List: ComponentRenderer = (n, ctx) => (
  <div style={{ display: "flex", flexDirection: "column", gap: num(n.props.gap, 4), padding: num(n.props.padding, 0) }}>
    {n.children.map((c) => ctx.render(c))}
  </div>
);

const ListItem: ComponentRenderer = (n) => {
  const extra = str(n.props.extra);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 8px" }}>
      {!!n.props.icon && <AAvatar shape="square" size={38} style={{ background: "#f5f5f5", color: "#595959" }} icon={<A2Icon name={n.props.icon} size={17} />} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <AText strong style={{ display: "block" }}>{str(n.props.title)}</AText>
        {!!n.props.desc && <AText type="secondary" style={{ fontSize: 12 }}>{str(n.props.desc)}</AText>}
      </div>
      {extra.startsWith("switch") && <ASwitch defaultChecked={extra.endsWith("on")} />}
      {extra.startsWith("text") && <a style={{ fontSize: 12, color: "var(--a2-accent)" }}>{extra.split(":")[1] ?? "查看"}</a>}
    </div>
  );
};

const Avatar: ComponentRenderer = (n) => (
  <AAvatar size={num(n.props.size, 40)} style={{ background: gradientFor(str(n.props.name, "U")) }}>
    {str(n.props.name, "U").slice(0, 1)}
  </AAvatar>
);

const Statistic: ComponentRenderer = (n) => (
  <ACard>
    <AStatistic title={str(n.props.label)} value={str(n.props.value)} />
    {!!n.props.trend && (
      <AText style={{ fontSize: 12, color: bool(n.props.trendUp, true) ? "#52c41a" : "#ff4d4f" }}>
        {str(n.props.trend)} <AText type="secondary" style={{ fontSize: 12 }}>较上周</AText>
      </AText>
    )}
  </ACard>
);

const Progress: ComponentRenderer = (n) => <AProgress percent={num(n.props.value, 60)} />;
const Chart: ComponentRenderer = (n, ctx) => (
  <SvgChart kind={n.props.kind} categories={n.props.categories} series={n.props.series} height={n.props.height} accent={ctx.tokens.accent} />
);

const Timeline: ComponentRenderer = (n) => (
  <ATimeline items={arr<{ time: string; title: string; desc?: string }>(n.props.items).map((it) => ({
    children: (
      <div>
        <AText type="secondary" style={{ fontSize: 12 }}>{it.time}</AText>
        <div><AText strong>{it.title}</AText></div>
        {!!it.desc && <AText type="secondary" style={{ fontSize: 12 }}>{it.desc}</AText>}
      </div>
    ),
  }))} />
);

const Rating: ComponentRenderer = (n) => <Rate disabled defaultValue={num(n.props.value, 4)} />;
const Empty: ComponentRenderer = (n) => <AEmpty description={str(n.props.text, "暂无数据")} />;

// ---------------------------------------------------------------------------
// 导航 / 反馈 / 媒体
// ---------------------------------------------------------------------------
const NavLinks: ComponentRenderer = (n) => (
  <Space size={24}>{strList(n.props.links).map((l, i) => <a key={i} style={{ color: "#595959", fontSize: 14 }}>{l}</a>)}</Space>
);
const Breadcrumb: ComponentRenderer = (n) => (
  <ABreadcrumb items={strList(n.props.items).map((t) => ({ title: t }))} />
);
const Pagination: ComponentRenderer = () => <APagination defaultCurrent={1} total={86} size="small" />;
const Steps: ComponentRenderer = (n) => (
  <ASteps current={num(n.props.current, 1)} items={strList(n.props.items).map((t) => ({ title: t }))} />
);

const TabBar: ComponentRenderer = (n) => (
  <div style={{ position: "sticky", bottom: 0, marginTop: "auto", background: "#fff", borderTop: "1px solid #f0f0f0", display: "flex", justifyContent: "space-around", padding: "6px 0", zIndex: 20 }}>
    {arr<{ icon: string; label: string; active?: boolean }>(n.props.items).map((it, i) => (
      <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 10px", color: it.active ? "var(--a2-accent)" : "#8c8c8c", cursor: "pointer" }}>
        <A2Icon name={it.icon} size={20} />
        <span style={{ fontSize: 10 }}>{it.label}</span>
      </div>
    ))}
  </div>
);

const Alert: ComponentRenderer = (n) => {
  const kind = str(n.props.kind, "info");
  return <AAlert type={kind === "error" ? "error" : kind === "warning" ? "warning" : kind === "success" ? "success" : "info"}
    message={str(n.props.title)} description={str(n.props.text)} showIcon />;
};
const Skeleton: ComponentRenderer = () => <ASkeleton active paragraph={{ rows: num(3) }} />;

const Image: ComponentRenderer = (n) => {
  const ratio = str(n.props.ratio, "16:9");
  const [rw, rh] = ratio.split(":").map(Number);
  return (
    <div style={{
      width: num(n.props.width) || "100%", aspectRatio: `${rw || 16}/${rh || 9}`,
      background: gradientFor(str(n.props.alt, "img")), borderRadius: bool(n.props.rounded) ? 8 : 0,
      display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.85)",
    }}>
      <A2Icon name="image" size={26} />
    </div>
  );
};

const IconComp: ComponentRenderer = (n) => {
  if (bool(n.props.boxed))
    return (
      <AAvatar shape="square" size={44} style={{ background: "#eef2ff", color: "var(--a2-accent)" }}
        icon={<A2Icon name={n.props.name} size={num(n.props.size, 20)} />} />
    );
  return <A2Icon name={n.props.name} size={num(n.props.size, 20)} />;
};

const LogoCloud: ComponentRenderer = (n) => (
  <div style={{ padding: "40px 24px", borderTop: "1px solid #f0f0f0", borderBottom: "1px solid #f0f0f0", textAlign: "center" }}>
    <AText type="secondary" style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>{str(n.props.title)}</AText>
    <Space size={48} wrap style={{ marginTop: 20, justifyContent: "center", display: "flex" }}>
      {strList(n.props.logos).map((l, i) => (
        <span key={i} style={{ fontSize: 18, fontWeight: 700, color: "rgba(0,0,0,0.22)" }}>{l}</span>
      ))}
    </Space>
  </div>
);

// ---------------------------------------------------------------------------
// 营销组合
// ---------------------------------------------------------------------------
const FeatureGrid: ComponentRenderer = (n) => (
  <div style={{ padding: "72px 24px", maxWidth: 1120, margin: "0 auto" }}>
    <div style={{ textAlign: "center", maxWidth: 640, margin: "0 auto 48px" }}>
      <ATitle level={2}>{str(n.props.title)}</ATitle>
      {!!n.props.subtitle && <Paragraph type="secondary">{str(n.props.subtitle)}</Paragraph>}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${num(n.props.columns, 3)}, minmax(0,1fr))`, gap: 20 }}>
      {arr<{ icon: string; title: string; desc: string }>(n.props.features).map((f, i) => (
        <ACard key={i} hoverable>
          <AAvatar shape="square" size={40} style={{ background: "#eef2ff", color: "var(--a2-accent)", marginBottom: 14 }} icon={<A2Icon name={f.icon} size={19} />} />
          <ATitle level={5} style={{ marginBottom: 6 }}>{f.title}</ATitle>
          <AText type="secondary" style={{ fontSize: 13 }}>{f.desc}</AText>
        </ACard>
      ))}
    </div>
  </div>
);

const PricingTable: ComponentRenderer = (n) => (
  <div style={{ padding: "0 24px 72px", maxWidth: 1024, margin: "0 auto", display: "grid", gap: 20, gridTemplateColumns: `repeat(${arr(n.props.plans).length}, minmax(0,1fr))` }}>
    {arr<{ name: string; price: string; unit?: string; desc?: string; features: string[]; cta: string; highlight?: boolean }>(n.props.plans).map((p, i) => (
      <ACard key={i} style={p.highlight ? { border: "2px solid var(--a2-primary)", transform: "scale(1.03)", boxShadow: "0 12px 32px rgba(0,0,0,0.1)" } : {}}>
        {p.highlight && <ATag color="blue" style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)", borderRadius: 999 }}>最受欢迎</ATag>}
        <ATitle level={4}>{p.name}</ATitle>
        <AText type="secondary" style={{ fontSize: 12 }}>{p.desc}</AText>
        <div style={{ margin: "16px 0" }}>
          <span style={{ fontSize: 30, fontWeight: 800 }}>{p.price}</span>
          <AText type="secondary"> {p.unit}</AText>
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          {p.features.map((f, j) => (
            <li key={j} style={{ display: "flex", gap: 8, fontSize: 13 }}>
              <A2Icon name="check" size={14} className="text-green-500" /> {f}
            </li>
          ))}
        </ul>
        <AButton type={p.highlight ? "primary" : "default"} block>{p.cta}</AButton>
      </ACard>
    ))}
  </div>
);

const TestimonialCard: ComponentRenderer = (n) => (
  <div style={{ padding: "72px 24px", textAlign: "center", maxWidth: 720, margin: "0 auto" }}>
    <Paragraph style={{ fontSize: 22, fontWeight: 500, lineHeight: 1.6 }}>"{str(n.props.quote)}"</Paragraph>
    <Space style={{ marginTop: 24 }}>
      <AAvatar size={42} style={{ background: gradientFor(str(n.props.name, "U")) }}>{str(n.props.name, "U").slice(0, 1)}</AAvatar>
      <div style={{ textAlign: "left" }}>
        <AText strong style={{ display: "block" }}>{str(n.props.name)}</AText>
        <AText type="secondary" style={{ fontSize: 12 }}>{str(n.props.role)}</AText>
      </div>
    </Space>
  </div>
);

const StatsRow: ComponentRenderer = (n) => (
  <div style={{ background: "var(--a2-primary)", padding: "48px 24px" }}>
    <div style={{ maxWidth: 1120, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 32, textAlign: "center" }}>
      {arr<{ value: string; label: string }>(n.props.stats).map((s, i) => (
        <div key={i}>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#fff" }}>{s.value}</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginTop: 4 }}>{s.label}</div>
        </div>
      ))}
    </div>
  </div>
);

const CTASection: ComponentRenderer = (n) => {
  const compact = bool(n.props.compact);
  return (
    <div style={compact ? {} : { padding: "0 24px 72px" }}>
      <div style={{
        maxWidth: compact ? undefined : 1024, margin: "0 auto", borderRadius: 12,
        background: "linear-gradient(120deg, var(--a2-primary), var(--a2-accent))",
        textAlign: "center", padding: compact ? "28px 20px" : "56px 32px",
      }}>
        <ATitle level={compact ? 3 : 2} style={{ color: "#fff", margin: 0 }}>{str(n.props.title)}</ATitle>
        {!!n.props.subtitle && <Paragraph style={{ color: "rgba(255,255,255,0.75)", marginTop: 10, marginBottom: 0, fontSize: compact ? 12 : 14 }}>{str(n.props.subtitle)}</Paragraph>}
        {!!n.props.cta && <AButton size={compact ? "middle" : "large"} style={{ marginTop: 20 }}>{str(n.props.cta)}</AButton>}
      </div>
    </div>
  );
};

const FAQ: ComponentRenderer = (n) => (
  <div style={{ padding: "0 24px 72px", maxWidth: 720, margin: "0 auto" }}>
    <ATitle level={3} style={{ textAlign: "center", marginBottom: 24 }}>{str(n.props.title, "常见问题")}</ATitle>
    {arr<{ q: string; a: string }>(n.props.items).map((it, i) => (
      <ACard key={i} size="small" style={{ marginBottom: 10 }} title={it.q}>
        <AText type="secondary" style={{ fontSize: 13 }}>{it.a}</AText>
      </ACard>
    ))}
  </div>
);

const ProductCard: ComponentRenderer = (n) => {
  const name = str(n.props.name, "商品");
  return (
    <ACard hoverable styles={{ body: { padding: 14 } }}
      cover={
        <div style={{ aspectRatio: "1/1", background: gradientFor(name), display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.85)", position: "relative" }}>
          <A2Icon name="image" size={28} />
          {!!n.props.tag && <ATag style={{ position: "absolute", top: 10, left: 10 }} color="red">{str(n.props.tag)}</ATag>}
        </div>
      }>
      <AText strong style={{ fontSize: 13, display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</AText>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <span style={{ color: "#ff4d4f", fontWeight: 700, fontSize: 15 }}>{str(n.props.price)}</span>
        <AText type="secondary" style={{ fontSize: 12 }}>★ {str(n.props.rating, "4.8")}</AText>
      </div>
    </ACard>
  );
};

export const antdRegistry: RendererRegistry = {
  Navbar, Hero, Section, Container, Row, Col, Grid, Card, Footer, Divider, Tabs, SidebarLayout,
  Title, Text, Link, Badge, Tag,
  Button, Input, Textarea, Select, Checkbox, Switch, SearchBar, LoginForm, Form,
  Table, List, ListItem, Avatar, Statistic, Progress, Chart, Timeline, Rating, Empty,
  NavLinks, Breadcrumb, Pagination, Steps, TabBar,
  Alert, Skeleton,
  Image, Icon: IconComp, LogoCloud,
  FeatureGrid, PricingTable, TestimonialCard, StatsRow, CTASection, FAQ, ProductCard,
};
