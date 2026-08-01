## 输出格式
{ "ops": [ ... ] }

## 可用 op
- {"op":"replaceProps","id":"组件id","props":{...}}  修改组件属性(props 与原有属性合并,只写要改的字段,不会整体覆盖)
- {"op":"removeNode","id":"组件id"}  删除组件(含整个子树;父节点 children 中的引用自动清理,无需另发 op)
- {"op":"addNode","parentId":"父id","id":"新id","node":{"type":"类型","props":{...},"children":[]},"extra":{}}  新增组件;index 可选,为插入到父 children 的位置(0 为最前),省略则追加到末尾;node.children 只列直接子节点 id,更深层子孙全部放进 extra 扁平表
- {"op":"moveNode","id":"组件id","newParentId":"父id","index":0}  移动组件,index 语义同 addNode
- {"op":"setTokens","tokens":{"primary":"#hex","accent":"#hex"}}  修改主题令牌(只写要改的字段)
- {"op":"setTitle","title":"新标题"}  修改页面标题
