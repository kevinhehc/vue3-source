import { getGlobalThis, isString } from '@vue/shared'
import { DOMNodeTypes, isComment } from './hydration'

// 懒水合（Lazy Hydration）策略系统，用于 延迟异步组件的 hydration，从而提升首次渲染性能，特别适合 SSR + 异步组件组合场景。
// 当一个异步组件被 SSR 预渲染到页面上，Vue 可以选择 不立即激活它（hydrate），而是等到某些条件满足后再激活，从而降低页面首次负载成本。

// Polyfills for Safari support
// see https://caniuse.com/requestidlecallback
const requestIdleCallback: Window['requestIdleCallback'] =
  getGlobalThis().requestIdleCallback || (cb => setTimeout(cb, 1))
const cancelIdleCallback: Window['cancelIdleCallback'] =
  getGlobalThis().cancelIdleCallback || (id => clearTimeout(id))

/**
 * A lazy hydration strategy for async components.
 * @param hydrate - call this to perform the actual hydration.
 * @param forEachElement - iterate through the root elements of the component's
 *                         non-hydrated DOM, accounting for possible fragments.
 * @returns a teardown function to be called if the async component is unmounted
 *          before it is hydrated. This can be used to e.g. remove DOM event
 *          listeners.
 */
export type HydrationStrategy = (
  // hydrate: 激活组件 DOM 的函数
  // forEachElement: 遍历组件根 DOM 节点的方法（可能为 Fragment）
  hydrate: () => void,
  forEachElement: (cb: (el: Element) => any) => void,
) => (() => void) | void

export type HydrationStrategyFactory<Options> = (
  options?: Options,
) => HydrationStrategy

// 空闲时水合
// 使用 requestIdleCallback 调度 hydrate
// fallback 到 setTimeout
// 若组件在水合前被卸载，调用 cancelIdleCallback
export const hydrateOnIdle: HydrationStrategyFactory<number> =
  (timeout = 10000) =>
  hydrate => {
    const id = requestIdleCallback(hydrate, { timeout })
    return () => cancelIdleCallback(id)
  }

function elementIsVisibleInViewport(el: Element) {
  const { top, left, bottom, right } = el.getBoundingClientRect()
  // eslint-disable-next-line no-restricted-globals
  const { innerHeight, innerWidth } = window
  return (
    ((top > 0 && top < innerHeight) || (bottom > 0 && bottom < innerHeight)) &&
    ((left > 0 && left < innerWidth) || (right > 0 && right < innerWidth))
  )
}

// 元素出现在视口时水合
// 使用 IntersectionObserver 监听组件 DOM 是否进入视口
// 可立即检测是否已可见（兼容旧浏览器）
// 若组件卸载则 disconnect
export const hydrateOnVisible: HydrationStrategyFactory<
  IntersectionObserverInit
> = opts => (hydrate, forEach) => {
  const ob = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      ob.disconnect()
      hydrate()
      break
    }
  }, opts)
  forEach(el => {
    if (!(el instanceof Element)) return
    if (elementIsVisibleInViewport(el)) {
      hydrate()
      ob.disconnect()
      return false
    }
    ob.observe(el)
  })
  return () => ob.disconnect()
}

// 媒体查询条件满足时水合
export const hydrateOnMediaQuery: HydrationStrategyFactory<string> =
  query => hydrate => {
    if (query) {
      const mql = matchMedia(query)
      if (mql.matches) {
        hydrate()
      } else {
        mql.addEventListener('change', hydrate, { once: true })
        return () => mql.removeEventListener('change', hydrate)
      }
    }
  }

// 交互时水合
// 监听 DOM 元素上的事件（如 click、focus）
// 首次触发时执行 hydrate，并 重新派发该事件 以不影响用户体验
// 组件卸载前自动解绑事件
export const hydrateOnInteraction: HydrationStrategyFactory<
  keyof HTMLElementEventMap | Array<keyof HTMLElementEventMap>
> =
  (interactions = []) =>
  (hydrate, forEach) => {
    if (isString(interactions)) interactions = [interactions]
    let hasHydrated = false
    const doHydrate = (e: Event) => {
      if (!hasHydrated) {
        hasHydrated = true
        teardown()
        hydrate()
        // replay event
        e.target!.dispatchEvent(new (e.constructor as any)(e.type, e))
      }
    }
    const teardown = () => {
      forEach(el => {
        for (const i of interactions) {
          el.removeEventListener(i, doHydrate)
        }
      })
    }
    forEach(el => {
      for (const i of interactions) {
        el.addEventListener(i, doHydrate, { once: true })
      }
    })
    return teardown
  }

export function forEachElement(
  node: Node,
  cb: (el: Element) => void | false,
): void {
  // fragment
  if (isComment(node) && node.data === '[') {
    let depth = 1
    let next = node.nextSibling
    while (next) {
      if (next.nodeType === DOMNodeTypes.ELEMENT) {
        const result = cb(next as Element)
        if (result === false) {
          break
        }
      } else if (isComment(next)) {
        if (next.data === ']') {
          if (--depth === 0) break
        } else if (next.data === '[') {
          depth++
        }
      }
      next = next.nextSibling
    }
  } else {
    cb(node as Element)
  }
}
