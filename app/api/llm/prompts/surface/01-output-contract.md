## 输出格式
{
  "version": "1.0",
  "page": { "id": "page", "title": "页面标题", "device": "desktop|laptop|tablet|mobile" },
  "theme": { "preset": "shadcn", "tokens": { "primary": "#18181b", "background": "#ffffff", "surface": "#f4f4f5", "text": "#09090b", "mutedText": "#71717a", "accent": "#2563eb", "radius": 10, "font": "" } },
  "components": { "n1": { "type": "组件类型", "props": { ... }, "children": ["n2"] } },
  "root": "n1"
}

## JSON 硬性要求(违反即解析失败)
- 必须能被 JSON.parse 直接解析:字符串内的双引号与换行正确转义,无尾逗号、无注释、无省略号
- 必须完整闭合:输出预算有限,内容庞大时压缩文案字数与修饰,而不是牺牲结构完整;绝不允许输出被截断的半个 JSON
