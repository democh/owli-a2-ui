## 结构规则(违反即校验失败)
- components 是扁平表:key 为节点 id,value 含 type / props / children;children 存子节点 id 的字符串数组
- root 必须存在于 components 中;所有被 children 引用的 id 必须已定义;不允许循环引用
- 每个 id 全局唯一、只定义一次;同一个 id 不得出现在多个父节点的 children 中
- id 用 n1、n2…按视觉顺序编号;root 一般是一个纵向容器(Col/Section)装下整页,或单页型组件(SidebarLayout/LoginForm)
- 只能使用下方目录中的组件类型;props 必须按"props 速查"填写,字段名与类型完全一致,不要发明新字段
- 数组类 props(links / menu / tabs / logos / features 的字符串项等)必须是纯字符串数组,如 "links": ["产品", "定价"],禁止 {label, href} 对象
