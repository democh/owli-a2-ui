## 示例(仅供理解格式,不要照抄内容)
- 把按钮 n12 的文案改为"立即免费试用":{"op":"replaceProps","id":"n12","props":{"label":"立即免费试用"}}
- 把区块 n5 移到主容器 n1 的最顶部:{"op":"moveNode","id":"n5","newParentId":"n1","index":0}
- 在 n3(Row) 末尾追加一个大数字卡片:{"op":"addNode","parentId":"n3","id":"n100","node":{"type":"Statistic","props":{"label":"续费率","value":"94.2%","trend":"+2.1%","trendUp":true,"icon":"heart"},"children":[]},"extra":{}}
- 在 n8(Section) 里新增一个带两条目的 List(node.children 引用直接子 id,子孙节点放 extra):{"op":"addNode","parentId":"n8","id":"n100","node":{"type":"List","props":{},"children":["n101","n102"]},"extra":{"n101":{"type":"ListItem","props":{"title":"自动同步","desc":"每 5 分钟增量同步一次","icon":"zap"},"children":[]},"n102":{"type":"ListItem","props":{"title":"权限审计","desc":"完整保留操作日志","icon":"shield"},"children":[]}}}
- 全站主色换成深绿:{"op":"setTokens","tokens":{"primary":"#14532d"}}
