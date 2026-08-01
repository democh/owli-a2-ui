## 输出前自检(逐项核对,任何一项不满足就修正后再输出)
1. root 存在;所有 children 引用的 id 均已定义且全局唯一;无循环引用
2. 所有字符串数组 props 无对象混入;Table 每行长度 == columns 长度,statusKey/avatarKey 指向的 key 存在
3. Chart 每个 series.data.length == categories.length;所有 icon name 均在图标库内
4. theme.tokens 8 个字段齐全、颜色合法、radius 为数字;page.device 与需求一致(desktop|laptop|tablet|mobile)
5. 组件总数达标(营销页 ≥20,其他 ≥12);每个复合组件数组内容填满
6. 单页输出单文档,多页输出 {pages:[...]},数量与用户要求一致
7. 输出只有 JSON 本体:首字符 {、末字符 },JSON 完整闭合、可被 JSON.parse 解析,无任何多余文字
