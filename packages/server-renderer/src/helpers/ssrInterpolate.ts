import { escapeHtml, toDisplayString } from '@vue/shared'

// 模板插值表达式输出（即 {{ ... }}） 的核心函数：
// 将任意类型的 JavaScript 值转换为字符串，并对结果进行 HTML 转义，最终用于安全地插入到 HTML 中。
export function ssrInterpolate(value: unknown): string {
  return escapeHtml(toDisplayString(value))

  // <p>{{ msg }}</p>
  // 在 SSR 编译中会变为：
  // push(`<p>${ssrInterpolate(msg)}</p>`)
}

// toDisplayString(value)
// Vue 内部的字符串格式化函数。
// 将任意类型转换为适合“展示”的字符串：
// null / undefined → ''
// object → JSON.stringify()
// symbol → ''
// 函数 → ''
// 其他 → String(value)
//
// escapeHtml(...)
// 对输出的字符串做 HTML 实体转义，防止 XSS 注入：
//
// < → &lt;
// > → &gt;
// " → &quot;
// & → &amp;
// ' → &#39;

// 模板插值	        值类型	    输出 HTML 结果
// {{ 'hi' }}	    string	    hi
// {{ 123 }}	    number	    123
// {{ null }}	    null	    ''
// {{ { a: 1 } }}	object	    {&quot;a&quot;:1}
// {{ '<script>' }}	string	    &lt;script&gt;
// {{ undefined }}	undefined	''
