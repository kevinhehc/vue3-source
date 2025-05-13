import type { ObjectDirective } from '@vue/runtime-core'

export const vShowOriginalDisplay: unique symbol = Symbol('_vod')
export const vShowHidden: unique symbol = Symbol('_vsh')

export interface VShowElement extends HTMLElement {
  // _vod = vue original display
  [vShowOriginalDisplay]: string
  [vShowHidden]: boolean
}

// 一个标准的 Vue 自定义指令对象，包含指令的生命周期钩子（beforeMount, mounted, updated, beforeUnmount）：
export const vShow: ObjectDirective<VShowElement> & { name?: 'show' } = {
  beforeMount(el, { value }, { transition }) {
    // 缓存元素原始 display 值，避免之后直接清空导致破坏布局。
    el[vShowOriginalDisplay] =
      el.style.display === 'none' ? '' : el.style.display
    // 若有过渡动画且当前为显示状态，调用 transition.beforeEnter
    // 否则直接通过 setDisplay() 设定显示状态。
    if (transition && value) {
      transition.beforeEnter(el)
    } else {
      setDisplay(el, value)
    }
  },
  mounted(el, { value }, { transition }) {
    if (transition && value) {
      // 装载后若有动画，调用 enter() 过渡显示元素。
      transition.enter(el)
    }
  },
  updated(el, { value, oldValue }, { transition }) {
    // 当新旧值都是 true 或都是 false，跳过更新。
    if (!value === !oldValue) return
    if (transition) {
      // 有过渡时：显现就先 beforeEnter → display → enter()，隐藏则 leave() 后再隐藏。
      if (value) {
        transition.beforeEnter(el)
        setDisplay(el, true)
        transition.enter(el)
      } else {
        transition.leave(el, () => {
          setDisplay(el, false)
        })
      }
    } else {
      // 没有过渡时：直接 setDisplay
      setDisplay(el, value)
    }
  },
  beforeUnmount(el, { value }) {
    // 卸载前设置正确的 display 值，便于清理。
    setDisplay(el, value)
  },
}

if (__DEV__) {
  vShow.name = 'show'
}

// 如果 value 为假，就隐藏元素；
// 否则恢复原始 display；
// 同时标记隐藏状态 el._vsh = true/false
function setDisplay(el: VShowElement, value: unknown): void {
  el.style.display = value ? el[vShowOriginalDisplay] : 'none'
  el[vShowHidden] = !value
}

// SSR vnode transforms, only used when user includes client-oriented render
// function in SSR
// 当用户将 v-show 用在 SSR 上（即模板中），而组件仍以客户端渲染为主，这个 getSSRProps 钩子用于提前注入初始样式，确保隐藏的元素从 SSR 渲染时就隐藏。
export function initVShowForSSR(): void {
  vShow.getSSRProps = ({ value }) => {
    if (!value) {
      return { style: { display: 'none' } }
    }
  }
}
