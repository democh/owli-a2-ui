## 组件 props 速查(渲染器只认这些字段,务必按此填写;? 表示可选)

### 布局
- Navbar: { logo, links: string[], cta }  吸顶导航,cta 为右侧按钮文案;logo 自动取首字符做方块标
- Hero: { badge, title, subtitle, primaryCta, secondaryCta, compact? }  首屏;title 可用 \n 分行;compact 用于定价页等次级页
- Section: { gap?, padding?, center?, minHeight?: true|"screen" }  纵向容器,用 children 装内容;padding 48-96
- Container: { padding? }  居中限宽容器(max-w-6xl),长正文限宽用
- Row: { gap?, padding?, align?: start|center|end|stretch|baseline, justify?: start|center|end|between|around|evenly, ratios?: number[] }  横向布局;ratios 按子节点顺序分配宽度比例,如 [2,1]
- Col: { gap?, align?: start|center|end|stretch }  纵向布局,默认拉伸
- Grid: { columns, gap?, padding? }  网格,columns 2-4
- Card: { title?, padding?, hover? }  卡片容器,children 装内容;padding 20-28,hover 带浮起效果
- Footer: { logo, copyright, groups: [{ title, links: string[] }] }  页脚,≥3 组,每组 3-5 条
- Divider: {}  水平分割线,无 props
- Tabs: { tabs: string[] }  页签,首项自动高亮
- SidebarLayout: { logo, menu: string[], activeMenu, title?, user? }  后台外壳,自带全屏侧边栏,可直接作 root;activeMenu 必须与 menu 中某一项完全一致;children 为主区内容

### 排版
- Title: { text, level?: 1|2|3|4 }  level=1 全页只用一次
- Text: { text, variant?: lead|body|muted|caption, weight?: medium }  lead 为导语大号灰字;次要信息用 muted 退后
- Link: { label }  带箭头的强调链接 / Badge: { label }  中性徽章 / Tag: { label }  accent 色胶囊标签

### 表单
- Button: { label, variant?: primary|outline|ghost|danger, icon?, size?: sm }  icon 从图标库选
- Input: { placeholder, value? } / Textarea: { placeholder, value? }
- Select: { options: string[], value? }
- Checkbox: { label, checked? }  默认勾选 / Switch: { on? }  默认开
- SearchBar: { placeholder, width? }
- LoginForm: { title, subtitle?, mode?: login|register, submitLabel? }  自带全屏渐变背景,可直接作 root
- Form: { fields: [{ label, type: text|email|password|textarea|select|number, options?, value? }], submitLabel? }  select 类型必须给 options

### 数据
- Table: { columns: [{ key, title }], rows: any[][], statusKey?, avatarKey?, pagination? }  rows 每行长度必须与 columns 一致;statusKey 列渲染为状态徽章(含 支付/在职/成功/完成 → 绿,待/试用 → 黄,退/失败 → 红);avatarKey 列自动加姓名头像;pagination:true 显示分页条
- List: { gap?, padding? } 容器,children 放 ListItem
- ListItem: { title, desc?, icon?, extra? }  extra 为协议字符串:"switch:on"|"switch:off" 右侧渲染开关,"text:查看" 右侧渲染文字链接,不传则渲染右箭头
- Avatar: { name, size? }  自动取首字符 + 渐变底色
- Statistic: { label, value, trend?, trendUp?, icon? }  自带卡片样式,不要再包 Card;如 { label:"月活用户", value:"128,400", trend:"+12.5%", trendUp:true, icon:"users" }
- Progress: { label, value: 0-100 }
- Chart: { kind: bar|line|area|pie, categories: string[], series: [{ name, data: number[] }], height? }  data 长度与 categories 一致,6-12 个类目;pie 只读 series[0];建议放 Card 里并配标题
- Timeline: { items: [{ time, title, desc? }] }  4-6 项
- Rating: { value: 0-5 }  整数 / Empty: { text } / Skeleton: { lines? }

### 导航
- NavLinks: { links: string[] } / Breadcrumb: { items: string[] }  末项自动高亮
- Pagination: {}  分页条,无 props
- Steps: { items: string[], current }  current 为已完成的步骤数
- TabBar: { items: [{ icon, label, active? }] }  移动端底部吸底导航,4-5 项,首项 active:true

### 反馈
- Alert: { kind: info|success|warning|error, title, text? }

### 媒体
- Image: { alt, ratio?: "16:9"|"4:3"|"1:1", rounded?, width? }  渐变占位图(按 alt 取色),无需真实图片;注意比例用冒号
- Icon: { name, size?, boxed? }  name 只能从下图标库选;boxed:true 渲染为 accent 底色圆角方块
- LogoCloud: { title?, logos: string[] }  品牌墙,6-8 个知名感品牌名

### 营销组合
- FeatureGrid: { title, subtitle?, columns?: 2|3|4, features: [{ icon, title, desc }] }  特性 ≥6 个,icon 贴切
- PricingTable: { plans: [{ name, price, unit?, desc?, features: string[], cta, highlight? }] }  3 档,中间档 highlight:true;price 带货币符号("¥99"),unit 如 "/月",features 每档 ≥5 条,desc 一句人群定位
- TestimonialCard: { quote, name, role }  整幅居中大引述;评价要有真实感姓名与"公司 · 职位"
- StatsRow: { stats: [{ value, label }] }  深色横幅一排大数字,4 项最佳;value 如 "12,000+"、"99.99%"
- CTASection: { title, subtitle?, cta, compact? }  渐变横幅收尾行动召唤,一页只用一个
- FAQ: { title?, items: [{ q, a }] }  ≥5 条
- ProductCard: { name, price, tag?, rating? }  电商卡片;price 带 ¥,tag 如 "新品"/"热卖"

## 可用图标(Icon/FeatureGrid/ListItem/Statistic/Button/TabBar 的 icon 字段,只能用这些)
activity, award, arrow-right, chart, bell, bookmark, check, chevron-right, clock, compass, download, eye, flame, gift, globe, grid, heart, home, image, line-chart, lock, map, menu, message, moon, palette, play, plug, plus, plus-circle, rocket, search, settings, shield, shopping-cart, sparkles, star, target, trending-up, user, users, wallet, zap
