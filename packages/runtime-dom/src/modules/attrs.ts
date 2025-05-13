import {
  NOOP,
  includeBooleanAttr,
  isSpecialBooleanAttr,
  isSymbol,
  makeMap,
} from '@vue/shared'
import {
  type ComponentInternalInstance,
  DeprecationTypes,
  compatUtils,
} from '@vue/runtime-core'

export const xlinkNS = 'http://www.w3.org/1999/xlink'

// 于设置 DOM 属性（attribute） 的函数 patchAttr 的源码实现。它负责在运行时为 HTML 或 SVG 元素正确设置、更新或移除属性，包括：
// 普通 HTML 属性
// 带命名空间的 xlink: 属性（SVG 特有）
// 布尔属性处理
// Vue 2.x 的兼容行为（例如 draggable="true"）
export function patchAttr(
  // key: 属性名
  // value: 要设置的值
  // isSVG: 是否是 SVG 元素（决定是否走 setAttributeNS）
  // isBoolean: 是否是特殊布尔属性（如 checked, selected, disabled）
  el: Element,
  key: string,
  value: any,
  isSVG: boolean,
  instance?: ComponentInternalInstance | null,
  isBoolean: boolean = isSpecialBooleanAttr(key),
): void {
  if (isSVG && key.startsWith('xlink:')) {
    if (value == null) {
      el.removeAttributeNS(xlinkNS, key.slice(6, key.length))
    } else {
      el.setAttributeNS(xlinkNS, key, value)
    }
  } else {
    if (__COMPAT__ && compatCoerceAttr(el, key, value, instance)) {
      return
    }

    // note we are only checking boolean attributes that don't have a
    // corresponding dom prop of the same name here.
    if (value == null || (isBoolean && !includeBooleanAttr(value))) {
      el.removeAttribute(key)
    } else {
      // attribute value is a string https://html.spec.whatwg.org/multipage/dom.html#attributes
      el.setAttribute(
        key,
        isBoolean ? '' : isSymbol(value) ? String(value) : value,
      )
    }
  }
}

// 2.x compat
const isEnumeratedAttr = __COMPAT__
  ? /*@__PURE__*/ makeMap('contenteditable,draggable,spellcheck')
  : NOOP

export function compatCoerceAttr(
  el: Element,
  key: string,
  value: unknown,
  instance: ComponentInternalInstance | null = null,
): boolean {
  if (isEnumeratedAttr(key)) {
    const v2CoercedValue =
      value === null
        ? 'false'
        : typeof value !== 'boolean' && value !== undefined
          ? 'true'
          : null
    if (
      v2CoercedValue &&
      compatUtils.softAssertCompatEnabled(
        DeprecationTypes.ATTR_ENUMERATED_COERCION,
        instance,
        key,
        value,
        v2CoercedValue,
      )
    ) {
      el.setAttribute(key, v2CoercedValue)
      return true
    }
  } else if (
    value === false &&
    !isSpecialBooleanAttr(key) &&
    compatUtils.isCompatEnabled(DeprecationTypes.ATTR_FALSE_VALUE, instance)
  ) {
    compatUtils.warnDeprecation(
      DeprecationTypes.ATTR_FALSE_VALUE,
      instance,
      key,
    )
    el.removeAttribute(key)
    return true
  }
  return false
}
