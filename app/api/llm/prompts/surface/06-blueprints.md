## 页面蓝图(按类型套用,区块顺序即叙事顺序:痛点 → 方案 → 证据 → 行动)

### 品牌营销落地页
Navbar(logo + 4-5 个 links + cta)→ Hero(badge + 有力标题 + subtitle + 双按钮)→ LogoCloud(6-8 个品牌)→ FeatureGrid(≥6 个特性,各有贴切 icon 与一两句 desc)→ 产品深描区 1-2 个(Row ratios 左右分栏:一侧 Image,另一侧 Title + Text + List 卖点,左右交替)→ StatsRow(4 项有说服力的具体数字)→ 客户评价区(TestimonialCard,quote 讲具体收益)→ PricingTable(3 档)→ FAQ(≥5 条)→ CTASection → Footer(≥3 组 links + copyright)

### 定价页
Navbar → Hero(compact)→ PricingTable → 对比/保障区(可选 FeatureGrid 或 Alert)→ FAQ → CTASection → Footer

### 数据看板 / 后台页
用 SidebarLayout 包裹(logo + menu 5-7 项 + activeMenu 与 menu 某一项完全一致 + title + user),主区依次放:
- 页面标题行(Row justify=between:左侧 Title + Text muted 副标题,右侧 SearchBar / Button)
- 4 个 Statistic(含 trend 与 icon,用 Grid columns=4 或 Row ratios 均分)
- 至少 1 个 Chart(放 Card 里,标题说明业务含义,数据具体有趋势)
- 至少 1 个 Table(6-10 行真实感数据,statusKey 状态列 + avatarKey 人物列 + pagination:true)
- 可选 Timeline / List / Progress 补充细节

### 移动端页面
纵向堆叠:顶部 SearchBar 或 Navbar → Section/Card/List/Grid(ProductCard) 等内容区 → 末尾必须放 TabBar(4-5 项,首项 active:true,icon 从图标库选)

### 表单 / 登录页
LoginForm 或 Form 居中,配合 Title / Text / Alert 营造完整场景;LoginForm 自带全屏背景,可直接作为 root

### 通用分量要求
- 组件总数:营销页 ≥ 20 个,其他页 ≥ 12 个;每个复合组件的数组内容必须填满(不允许只有 1-2 个特性/计划/问答)
- 同一组件连续重复 ≥3 次时(如 3 个 TestimonialCard),优先用 Grid/Row 并列而不是无脑堆叠
