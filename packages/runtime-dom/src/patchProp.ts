import { patchClass } from './modules/class'
import { patchStyle } from './modules/style'
import { patchAttr } from './modules/attrs'
import { patchDOMProp } from './modules/props'
import { patchEvent } from './modules/events'
import {
  camelize,
  isFunction,
  isModelListener,
  isOn,
  isString,
} from '@vue/shared'
import type { RendererOptions } from '@vue/runtime-core'
import type { VueElement } from './apiCustomElement'

// 判断是否为原生事件（onClick, oninput 等）
// 用于判断是否有 XSS 风险的字符串事件处理绑定
const isNativeOn = (key: string) =>
  key.charCodeAt(0) === 111 /* o */ &&
  key.charCodeAt(1) === 110 /* n */ &&
  // lowercase letter
  key.charCodeAt(2) > 96 &&
  key.charCodeAt(2) < 123

type DOMRendererOptions = RendererOptions<Node, Element>

// Virtual DOM patch 阶段设置 DOM 元素属性的统一入口。
// Vue 内部平台特定模块（DOM）的最关键部分之一。
// 负责处理以下属性更新：
// class / style
// 事件（如 onClick）
// DOM property（如 value, checked, selected）
// attribute（如 id, aria-*, data-*）
export const patchProp: DOMRendererOptions['patchProp'] = (
  // 参数	含义
  // el	要操作的 DOM 元素
  // key	属性名（如 "id"、"onClick"）
  // prevValue	旧值
  // nextValue	新值
  // namespace	命名空间（如 SVG）
  // parentComponent	当前组件上下文
  el,
  key,
  prevValue,
  nextValue,
  namespace,
  parentComponent,
) => {
  const isSVG = namespace === 'svg'
  if (key === 'class') {
    // 设置 .className 或 SVG 下的 .setAttribute("class", ...)
    patchClass(el, nextValue, isSVG)
  } else if (key === 'style') {
    // 对象或字符串样式的 patch 处理（增删改）
    patchStyle(el, prevValue, nextValue)
  } else if (isOn(key)) {
    // ignore v-model listeners
    if (!isModelListener(key)) {
      // onXxx 被认为是事件
      // v-model 生成的监听器会被跳过（自动内部处理）
      patchEvent(el, key, prevValue, nextValue, parentComponent)
    }
  } else if (
    // 普通属性 → 先判断是 property 还是 attribute
    key[0] === '.'
      ? ((key = key.slice(1)), true)
      : key[0] === '^'
        ? ((key = key.slice(1)), false)
        : shouldSetAsProp(el, key, nextValue, isSVG) // shouldSetAsProp(...) 为 true → 用 prop 设置
  ) {
    patchDOMProp(el, key, nextValue, parentComponent)
    // #6007 also set form state as attributes so they work with
    // <input type="reset"> or libs / extensions that expect attributes
    // #11163 custom elements may use value as an prop and set it as object
    if (
      !el.tagName.includes('-') &&
      // 特殊处理：form 控件同步属性到属性
      // 为 <input type="reset">、浏览器插件等保留属性值。
      (key === 'value' || key === 'checked' || key === 'selected')
    ) {
      patchAttr(el, key, nextValue, isSVG, parentComponent, key !== 'value')
    }
  } else if (
    // #11081 force set props for possible async custom element
    (el as VueElement)._isVueCE &&
    (/[A-Z]/.test(key) || !isString(nextValue))
  ) {
    // 对于异步 Custom Element：强制用 prop
    patchDOMProp(el, camelize(key), nextValue, parentComponent, key)
  } else {
    // special case for <input v-model type="checkbox"> with
    // :true-value & :false-value
    // store value as dom properties since non-string values will be
    // stringified.
    // 特殊 case：true-value, false-value（v-model 的辅助值）
    if (key === 'true-value') {
      ;(el as any)._trueValue = nextValue
    } else if (key === 'false-value') {
      ;(el as any)._falseValue = nextValue
    }
    // fallback → 使用 attribute 设置
    patchAttr(el, key, nextValue, isSVG, parentComponent)
  }
}

// 决定走 prop 还是 attr 的核心规则
// SVG：
// innerHTML、textContent、函数事件 → 用 prop
// 其他都用 attr
// 常规元素中，一些特殊属性强制走 attr，例如：
// spellcheck, draggable, translate, autocorrect
// form（某些元素中为只读）
// input.list, textarea.type
// 媒体标签的 width, height
// 原生事件（如 onclick）绑定字符串 → 必须用 attr（防 XSS）
function shouldSetAsProp(
  el: Element,
  key: string,
  value: unknown,
  isSVG: boolean,
) {
  if (isSVG) {
    // most keys must be set as attribute on svg elements to work
    // ...except innerHTML & textContent
    if (key === 'innerHTML' || key === 'textContent') {
      return true
    }
    // or native onclick with function values
    if (key in el && isNativeOn(key) && isFunction(value)) {
      return true
    }
    return false
  }

  // these are enumerated attrs, however their corresponding DOM properties
  // are actually booleans - this leads to setting it with a string "false"
  // value leading it to be coerced to `true`, so we need to always treat
  // them as attributes.
  // Note that `contentEditable` doesn't have this problem: its DOM
  // property is also enumerated string values.
  if (
    key === 'spellcheck' ||
    key === 'draggable' ||
    key === 'translate' ||
    key === 'autocorrect'
  ) {
    return false
  }

  // #1787, #2840 form property on form elements is readonly and must be set as
  // attribute.
  if (key === 'form') {
    return false
  }

  // #1526 <input list> must be set as attribute
  if (key === 'list' && el.tagName === 'INPUT') {
    return false
  }

  // #2766 <textarea type> must be set as attribute
  if (key === 'type' && el.tagName === 'TEXTAREA') {
    return false
  }

  // #8780 the width or height of embedded tags must be set as attribute
  if (key === 'width' || key === 'height') {
    const tag = el.tagName
    if (
      tag === 'IMG' ||
      tag === 'VIDEO' ||
      tag === 'CANVAS' ||
      tag === 'SOURCE'
    ) {
      return false
    }
  }

  // native onclick with string value, must be set as attribute
  if (isNativeOn(key) && isString(value)) {
    return false
  }

  return key in el
}
