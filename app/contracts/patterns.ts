/**
 * 设计模式库(文档 §10.4)
 *
 * 可检索的设计模式:按页面类型/用例关键词匹配,取 Top-N 注入规划与生成上下文。
 * 模式是"经过验证的结构骨架",供 Agent 参考取舍,不是模板照搬;组件引用受 Catalog 约束。
 */

export interface DesignPattern {
  patternId: string;
  name: string;
  /** 适用的页面类型(检索键之一,如 login/dashboard/form) */
  pageTypes: string[];
  /** 适用的用例关键词(中文检索键) */
  useCases: string[];
  /** 推荐结构(信息架构骨架) */
  structure: string;
  /** 建议组件(必须在 Catalog 内) */
  components: string[];
  dataRequirements: string[];
  interactionNotes: string[];
  accessibilityNotes: string[];
}

export const BUILTIN_PATTERNS: DesignPattern[] = [
  {
    patternId: "saas-dashboard",
    name: "SaaS 数据看板",
    pageTypes: ["dashboard", "工作台", "看板"],
    useCases: ["看板", "监控", "概览", "统计", "数据", "指标"],
    structure: "顶部 KPI 统计行(3-4 卡) → 中部趋势图区 → 底部明细表格;异常与告警优先于总量展示",
    components: ["Statistic", "Chart", "Table", "Badge", "Progress"],
    dataRequirements: ["关键指标当前值与同比", "时间序列数据", "明细行数据与分页"],
    interactionNotes: ["卡片可点击下钻明细", "时间范围筛选", "表格行内快捷操作", "异常数据徽章提示"],
    accessibilityNotes: ["图表需附文本摘要", "状态不只靠颜色(加图标/文字)", "数字使用等宽字体对齐"],
  },
  {
    patternId: "user-table",
    name: "数据表格管理页",
    pageTypes: ["table", "列表", "管理"],
    useCases: ["表格", "列表", "管理", "订单", "用户", "库存", "审计", "日志"],
    structure: "顶部筛选区(搜索 + 状态筛选) → 工具栏(批量操作/新建) → 数据表格 → 底部分页",
    components: ["Table", "Input", "Select", "Button", "Pagination", "Badge", "Empty"],
    dataRequirements: ["列字段定义", "筛选维度", "分页参数", "行状态"],
    interactionNotes: ["行内编辑或查看", "批量选择与操作", "危险操作二次确认", "空态提供新建入口"],
    accessibilityNotes: ["表头语义化 th", "操作按钮有可访问名称", "行状态不用颜色作为唯一载体"],
  },
  {
    patternId: "login-form",
    name: "登录/注册",
    pageTypes: ["login", "register", "登录", "注册"],
    useCases: ["登录", "注册", "认证", "验证码", "密码"],
    structure: "居中窄卡片:标题 + 输入组 + 主操作按钮 + 辅助链接;第三方登录分隔线下置",
    components: ["Input", "Button", "Checkbox", "Alert", "Link"],
    dataRequirements: ["字段校验规则", "错误消息文案", "记住我/协议勾选"],
    interactionNotes: ["提交 loading 与禁用", "字段级错误提示与输入关联", "密码可见性切换", "失败保留输入"],
    accessibilityNotes: ["每个输入有可见 label", "错误信息 aria 关联", "按钮文本说明会发生什么"],
  },
  {
    patternId: "onboarding-wizard",
    name: "多步骤向导",
    pageTypes: ["wizard", "向导", "流程"],
    useCases: ["多步骤", "向导", "开户", "预订", "安装", "流程"],
    structure: "顶部步骤指示(Steps) → 当前步骤表单区 → 底部 上一步/下一步;最后一步为确认摘要",
    components: ["Steps", "Button", "Input", "Progress", "Form"],
    dataRequirements: ["分步字段定义", "步骤间依赖", "草稿暂存"],
    interactionNotes: ["下一步校验当前步骤", "支持返回不丢数据", "提交前确认摘要", "进度可视"],
    accessibilityNotes: ["步骤状态文本化(已完成/进行中)", "焦点随步骤切换", "键盘可完成全部步骤"],
  },
  {
    patternId: "settings-page",
    name: "设置页",
    pageTypes: ["settings", "设置", "偏好"],
    useCases: ["设置", "偏好", "通知", "安全", "账户", "外观"],
    structure: "左侧或顶部导航分组 → 分组卡片:标题 + 说明 + 控件行(Switch/Select/Input);危险区独立置底",
    components: ["Switch", "Select", "Input", "Button", "Card", "Alert"],
    dataRequirements: ["设置项与默认值", "保存粒度(即时/整组)"],
    interactionNotes: ["即时生效项有成功反馈", "整组保存有脏状态提示", "危险操作独立确认"],
    accessibilityNotes: ["开关有明确文本说明", "分组标题层级正确", "说明文字与控件关联"],
  },
  {
    patternId: "detail-page",
    name: "详情页",
    pageTypes: ["detail", "详情"],
    useCases: ["详情", "商品", "订单", "文章", "工单", "房源"],
    structure: "标题区(名称/状态/关键操作) → 主体信息区(媒体/参数/描述) → 侧栏或底部的辅助信息与操作",
    components: ["Title", "Image", "Steps", "Table", "Timeline", "Button", "Badge"],
    dataRequirements: ["主体字段", "状态流转", "关联列表"],
    interactionNotes: ["主操作唯一且常驻", "状态步骤条可视化", "返回路径明确"],
    accessibilityNotes: ["图片有 alt", "标题层级有序", "价格等关键信息文本化不只靠样式"],
  },
  {
    patternId: "landing-hero",
    name: "营销落地页",
    pageTypes: ["landing", "落地页", "营销"],
    useCases: ["落地页", "产品介绍", "活动", "下载", "品牌", "案例"],
    structure: "Hero(大标题 + 副标题 + 主 CTA) → 三列功能/特性卡 → 社会证明(Logo 云/评价) → 底部 CTA 与页脚",
    components: ["Hero", "FeatureGrid", "LogoCloud", "TestimonialCard", "Button", "Footer"],
    dataRequirements: ["价值主张文案", "功能点 3-6 条", "客户/评价素材"],
    interactionNotes: ["首屏一个主 CTA", "滚动叙事节奏", "转化路径不超 3 步"],
    accessibilityNotes: ["对比度达标", "装饰图空 alt", "CTA 按钮文本动词开头"],
  },
  {
    patternId: "empty-error-state",
    name: "空态/错误态",
    pageTypes: ["empty", "error", "空态", "错误"],
    useCases: ["空态", "无结果", "错误", "失败", "权限不足", "引导"],
    structure: "居中插画/图标 + 一句话说明原因 + 明确的下一步动作(1-2 个);可选帮助链接",
    components: ["Empty", "Alert", "Button", "Skeleton", "Link"],
    dataRequirements: ["空态原因", "建议动作", "错误码/帮助文档"],
    interactionNotes: ["动作按钮直接解决用户问题", "错误提供重试", "避免只有'暂无数据'"],
    accessibilityNotes: ["状态用文本完整表达", "重试按钮可聚焦", "不用颜色单独表达错误"],
  },
  {
    patternId: "dense-ops-console",
    name: "高密度运营后台",
    pageTypes: ["console", "后台", "工作台"],
    useCases: ["风控", "审核", "拣货", "对账", "质检", "高密度", "批量"],
    structure: "三栏布局:左队列/列表、中详情表单、右操作记录;紧凑间距 + 分组折叠",
    components: ["Table", "Form", "Input", "Badge", "Timeline", "SidebarLayout"],
    dataRequirements: ["队列实时性", "详情字段", "操作留痕"],
    interactionNotes: ["键盘快捷流转", "批量操作", "每步有留痕反馈", "减少弹层跳转"],
    accessibilityNotes: ["紧凑但不小于最小触控目标", "焦点顺序符合阅读顺序", "高对比状态色"],
  },
  {
    patternId: "mobile-feed",
    name: "移动端信息流",
    pageTypes: ["mobile", "移动端", "feed"],
    useCases: ["移动端", "信息流", "聊天", "日历", "播放", "扫码"],
    structure: "全屏内容区(卡片流/气泡流) + 底部固定操作栏(TabBar 或输入栏) + 悬浮主操作",
    components: ["TabBar", "Card", "Input", "Button", "Avatar", "Progress"],
    dataRequirements: ["分页/懒加载列表", "底部操作项"],
    interactionNotes: ["底部主操作拇指可达", "下拉刷新/上拉加载", "悬浮操作避让内容"],
    accessibilityNotes: ["触控目标 ≥44px", "手势提供按钮替代", "安全区适配"],
  },
];

/** 按用户消息关键词与 Run 模式检索 Top-N 模式(零依赖词面匹配,确定性) */
export function retrievePatterns(userMessage: string, limit = 2): DesignPattern[] {
  const text = (userMessage ?? "").toLowerCase();
  const scored = BUILTIN_PATTERNS.map((p) => {
    let score = 0;
    for (const kw of [...p.useCases, ...p.pageTypes]) {
      if (kw && text.includes(kw.toLowerCase())) score += 2;
    }
    return { p, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.p);
}

/** 面向 LLM 的模式摘要(注入 DesignPlan / Brief 上下文) */
export function patternsDigest(patterns: DesignPattern[]): string {
  return patterns
    .map((p) =>
      `【${p.name}】结构:${p.structure}\n组件:${p.components.join("/")}\n交互:${p.interactionNotes.join(";")}\n无障碍:${p.accessibilityNotes.join(";")}`,
    )
    .join("\n\n");
}
