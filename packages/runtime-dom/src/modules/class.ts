import { type ElementWithTransition, vtcKey } from '../components/Transition'

// compiler should normalize class + :class bindings on the same element
// into a single binding ['staticClass', dynamic]
// 是 DOM 操作中用于处理 class 属性的函数。它在运行时控制 class 的更新，考虑了 transition 类名、SVG 元素的特殊性以及性能优化。
// 正确设置 DOM 元素的 class 属性
// 合并过渡类（<Transition>）的临时类名
// 兼容 SVG（不能使用 className，只能用 setAttribute）
// 清除 null class（removeAttribute）
export function patchClass(
  el: Element,
  value: string | null,
  isSVG: boolean,
): void {
  // directly setting className should be faster than setAttribute in theory
  // if this is an element during a transition, take the temporary transition
  // classes into account.
  const transitionClasses = (el as ElementWithTransition)[vtcKey]
  if (transitionClasses) {
    value = (
      value ? [value, ...transitionClasses] : [...transitionClasses]
    ).join(' ')
  }
  if (value == null) {
    el.removeAttribute('class')
  } else if (isSVG) {
    el.setAttribute('class', value)
  } else {
    el.className = value
  }
}
