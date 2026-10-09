# Design Token Audit 设计令牌审计

- 颜色必须来自语义 Token(primary/surface/text/mutedText/accent);发现魔法值即 issue 并给 Token 替换方案。
- 间距只用统一档位(4/8/12/16/24/32);检查 padding/margin 离群值。
- 同类组件的圆角、字号、字重必须一致;对比全文档同型节点。
- 状态色不挪用:成功/警告/错误语义不得当装饰色。
- 输出按节点列出:当前值 → 建议 Token → 影响范围;不做整页重设计。
