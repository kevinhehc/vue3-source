import {
  escapeHtml,
  isRenderableAttrValue,
  isSVGTag,
  stringifyStyle,
} from '@vue/shared'
import {
  includeBooleanAttr,
  isBooleanAttr,
  isOn,
  isSSRSafeAttrName,
  isString,
  makeMap,
  normalizeClass,
  normalizeStyle,
  propsToAttrMap,
} from '@vue/shared'

// leading comma for empty string ""
// 忽略特定属性名
// makeMap() 创建一个哈希集合用于快速查找（字符串以逗号分隔）。
// 被忽略的属性包括：
// key, ref, ref_key, ref_for（用于虚拟 DOM diff）
// innerHTML, textContent（这些属性内容在 SSR 其他地方处理）
// 这些属性不会被当作 DOM 属性输出。
const shouldIgnoreProp = /*@__PURE__*/ makeMap(
  `,key,ref,innerHTML,textContent,ref_key,ref_for`,
)

// 将组件或元素的 props 转换为字符串形式的 HTML 属性，类似于：
export function ssrRenderAttrs(
  props: Record<string, unknown>,
  tag?: string,
): string {
  let ret = ''
  // 遍历所有 props 属性
  for (const key in props) {
    // isOn(key) 判断是否是事件监听器（如 onClick），这类不会出现在 SSR 输出中。
    // 特殊处理 textarea：
    // <textarea :value="val"> 在 SSR 中，val 会写入内容部分，而不是 value 属性。
    if (
      shouldIgnoreProp(key) ||
      isOn(key) ||
      (tag === 'textarea' && key === 'value')
    ) {
      continue
    }
    const value = props[key]
    if (key === 'class') {
      // 会使用 ssrRenderClass() 将 class 处理为字符串（兼容数组、对象形式）。
      ret += ` class="${ssrRenderClass(value)}"`
    } else if (key === 'style') {
      // 使用 ssrRenderStyle() 将对象或字符串样式格式化为内联样式字符串。
      ret += ` style="${ssrRenderStyle(value)}"`
    } else if (key === 'className') {
      // Vue 内部有时为了兼容 DOM 渲染可能存在 className，在 SSR 中同样要映射为 class。
      ret += ` class="${String(value)}"`
    } else {
      // 使用 ssrRenderDynamicAttr() 渲染通用属性，例如：
      // 布尔属性（如 disabled)
      // 动态属性（如 data-*, aria-*）
      // 特殊字符编码等
      ret += ssrRenderDynamicAttr(key, value, tag)
    }
  }
  return ret
}

// render an attr with dynamic (unknown) key.
// 用于处理 v-bind:[key]="value" 这样的动态属性名。
// 会做完整的属性名合法性判断，并格式化输出。
export function ssrRenderDynamicAttr(
  key: string,
  value: unknown,
  tag?: string,
): string {
  // 判断值是否可渲染（例如函数、undefined 会被跳过）：
  if (!isRenderableAttrValue(value)) {
    return ``
  }
  // 决定属性名格式：
  // 对于自定义元素或 SVG → 保留原样。
  // 其他 → 映射 camelCase（如 htmlFor → for）。
  const attrKey =
    tag && (tag.indexOf('-') > 0 || isSVGTag(tag))
      ? key // preserve raw name on custom elements and svg
      : propsToAttrMap[key] || key.toLowerCase()
  if (isBooleanAttr(attrKey)) {
    // 如 disabled, checked 只需要出现即可生效，不加值。
    return includeBooleanAttr(value) ? ` ${attrKey}` : ``
  } else if (isSSRSafeAttrName(attrKey)) {
    // 合法属性名判断 + HTML 转义：输出标准属性格式。
    return value === '' ? ` ${attrKey}` : ` ${attrKey}="${escapeHtml(value)}"`
  } else {
    // 非法属性名（如 on<...>）会警告并跳过：
    console.warn(
      `[@vue/server-renderer] Skipped rendering unsafe attribute name: ${attrKey}`,
    )
    return ``
  }
}

// Render a v-bind attr with static key. The key is pre-processed at compile
// time and we only need to check and escape value.
// 用于静态编译时 v-bind:staticKey="value"。
// 与 ssrRenderDynamicAttr 不同：
// 不处理布尔属性。
// 不判断属性合法性。
// 只负责 值的可渲染性判断 + 转义输出。
export function ssrRenderAttr(key: string, value: unknown): string {
  if (!isRenderableAttrValue(value)) {
    return ``
  }
  return ` ${key}="${escapeHtml(value)}"`
}

// 用于渲染 class 属性值，支持数组、对象、字符串：
export function ssrRenderClass(raw: unknown): string {
  return escapeHtml(normalizeClass(raw))
}

// 用于渲染 style 属性值。
// 支持：
// 字符串（原样）
// 对象（会被转换为 CSS 字符串）
// 数组（嵌套 style 对象）
export function ssrRenderStyle(raw: unknown): string {
  if (!raw) {
    return ''
  }
  if (isString(raw)) {
    return escapeHtml(raw)
  }
  const styles = normalizeStyle(raw)
  return escapeHtml(stringifyStyle(styles))
}
