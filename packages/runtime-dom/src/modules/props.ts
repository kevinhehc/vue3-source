import { DeprecationTypes, compatUtils, warn } from '@vue/runtime-core'
import { includeBooleanAttr } from '@vue/shared'
import { unsafeToTrustedHTML } from '../nodeOps'

// functions. The user is responsible for using them with only trusted content.
// Vue 3 的 DOM 渲染器内部用于 设置 DOM 原生属性（prop） 的实现。它与 patchAttr 和 patchStyle 一起构成 Vue 的平台特化 patch 系统。
// 它区别于 patchAttr 的关键点是：它直接操作 DOM 对象的属性，而不是通过 setAttribute()。
// 用于设置元素的 原生属性（如 value, innerHTML, checked, multiple, type, …）：
// 安全设置 innerHTML / textContent（使用 trusted types）
// 设置 value 时自动处理 null、checkbox 默认值等
// 遇到不支持设置的属性时捕获异常（避免崩溃）
// Vue 兼容性模式支持 :prop="false" 特殊处理
// 若 value === null | undefined 时尝试自动删除 attribute
export function patchDOMProp(
  el: any,
  key: string,
  value: any,
  parentComponent: any,
  attrName?: string,
): void {
  // __UNSAFE__
  // Reason: potentially setting innerHTML.
  // This can come from explicit usage of v-html or innerHTML as a prop in render
  // 避免 XSS：innerHTML 需包裹为 TrustedHTML
  // 此处是由用户主动使用 v-html、渲染函数等触发
  if (key === 'innerHTML' || key === 'textContent') {
    // null value case is handled in renderer patchElement before patching
    // children
    if (value != null) {
      el[key] = key === 'innerHTML' ? unsafeToTrustedHTML(value) : value
    }
    return
  }

  const tag = el.tagName

  if (
    key === 'value' &&
    tag !== 'PROGRESS' &&
    // custom elements may use _value internally
    !tag.includes('-')
  ) {
    // 处理 input/option 等的 value：
    // Option 的 value 默认会 fallback 到文本内容 → 需要特别对比 getAttribute('value')
    // null/undefined 自动转为空字符串，但 checkbox 除外（默认值是 "on"）
    // 使用 _value 保留原始值（非字符串时）
    // 遇到 null → 删除 attribute（而不是 prop）
    // #4956: <option> value will fallback to its text content so we need to
    // compare against its attribute value instead.
    const oldValue =
      tag === 'OPTION' ? el.getAttribute('value') || '' : el.value
    const newValue =
      value == null
        ? // #11647: value should be set as empty string for null and undefined,
          // but <input type="checkbox"> should be set as 'on'.
          el.type === 'checkbox'
          ? 'on'
          : ''
        : String(value)
    if (oldValue !== newValue || !('_value' in el)) {
      el.value = newValue
    }
    if (value == null) {
      el.removeAttribute(key)
    }
    // store value as _value as well since
    // non-string values will be stringified.
    el._value = value
    return
  }

  let needRemove = false
  if (value === '' || value == null) {
    const type = typeof el[key]
    if (type === 'boolean') {
      // e.g. <select multiple> compiles to { multiple: '' }
      value = includeBooleanAttr(value)
    } else if (value == null && type === 'string') {
      // e.g. <div :id="null">
      value = ''
      needRemove = true
    } else if (type === 'number') {
      // e.g. <img :width="null">
      value = 0
      needRemove = true
    }
  } else {
    if (
      // 向后兼容：v-bind="false" 兼容 v2
      // 旧版本 Vue 会把 :id="false" 编译成 id=""，Vue 3 默认不支持，但可以开启兼容模式。
      __COMPAT__ &&
      value === false &&
      compatUtils.isCompatEnabled(
        DeprecationTypes.ATTR_FALSE_VALUE,
        parentComponent,
      )
    ) {
      const type = typeof el[key]
      if (type === 'string' || type === 'number') {
        __DEV__ &&
          compatUtils.warnDeprecation(
            DeprecationTypes.ATTR_FALSE_VALUE,
            parentComponent,
            key,
          )
        value = type === 'number' ? 0 : ''
        needRemove = true
      }
    }
  }

  // some properties perform value validation and throw,
  // some properties has getter, no setter, will error in 'use strict'
  // eg. <select :type="null"></select> <select :willValidate="null"></select>
  // 安全 try-catch 设置属性
  // 某些只读属性会抛错（如 <select type="...">）
  // 某些 getter-only 属性在 strict 模式下会崩溃
  try {
    el[key] = value
  } catch (e: any) {
    // do not warn if value is auto-coerced from nullish values
    if (__DEV__ && !needRemove) {
      warn(
        `Failed setting prop "${key}" on <${tag.toLowerCase()}>: ` +
          `value ${value} is invalid.`,
        e,
      )
    }
  }
  // 补充：根据标记删除 attribute
  // value == null
  // 或特定兼容模式下强制删除
  needRemove && el.removeAttribute(attrName || key)
}
