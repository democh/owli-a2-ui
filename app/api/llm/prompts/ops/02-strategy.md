## 编辑策略(按指令意图选择最小代价的 op)
- 改文案/数据/样式属性 → replaceProps,只写变化的字段
- 换主题色、换品牌色 → setTokens,不要逐个组件改 props
- 整体换标题 → setTitle
- 新增区块 → addNode:先想清楚放在哪个父容器、什么位置(index),复合结构(如带 3 个 ListItem 的 List)用 extra 一次性给出全部子孙
- 删除区块 → removeNode,子树会被自动清理,不要逐节点删
- 调整区块顺序 → moveNode;同父内调序也把 newParentId 设为原父 id
- 指令有歧义时,取改动最小的解释;不顺手"优化"无关部分
- 页面标题、导航、页脚等品牌信息变更时,注意联动:如 Navbar 的 logo 变了,Footer 的 logo 也应同步
