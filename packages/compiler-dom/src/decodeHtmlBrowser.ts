/* eslint-disable no-restricted-globals */

let decoder: HTMLDivElement

// 依赖浏览器的内置 DOM 解析机制，将 HTML 编码字符串（如 &lt;, &amp;, &#x27; 等）转换为其原始字符。

// raw: 要解码的 HTML 字符串。
// asAttr: 是否作为属性值解码（默认为 false）。
export function decodeHtmlBrowser(raw: string, asAttr = false): string {
  // decoder 是一个 DOM 元素（全局变量，未在此片段中声明，视为模块内缓存变量）。
  // 懒初始化，避免重复创建 DOM 元素，提高性能。
  if (!decoder) {
    decoder = document.createElement('div')
  }
  if (asAttr) {
    // 处理属性上下文的实体解码。
    // 举例：如果 raw = 'a &amp; b'，这段代码相当于构造：
    // <div foo="a &amp; b">
    // 然后获取 foo 属性的值，浏览器自动解码为 a & b。
    // 需要注意对双引号进行手动替换为 &quot;，以避免破坏 HTML 结构。
    decoder.innerHTML = `<div foo="${raw.replace(/"/g, '&quot;')}">`
    return decoder.children[0].getAttribute('foo')!
  } else {
    // 用于解析文本内容中的实体。
    // 举例：如果 raw = 'Tom &amp; Jerry'，设置 innerHTML 后，textContent 自动解码为 Tom & Jerry。
    decoder.innerHTML = raw
    return decoder.textContent!
  }
}
