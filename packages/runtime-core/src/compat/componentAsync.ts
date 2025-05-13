import { isArray, isObject, isPromise } from '@vue/shared'
import { defineAsyncComponent } from '../apiAsyncComponent'
import type { Component } from '../component'
import { isVNode } from '../vnode'

interface LegacyAsyncOptions {
  component: Promise<Component>
  loading?: Component
  error?: Component
  delay?: number
  timeout?: number
}

type LegacyAsyncReturnValue = Promise<Component> | LegacyAsyncOptions

type LegacyAsyncComponent = (
  resolve?: (res: LegacyAsyncReturnValue) => void,
  reject?: (reason?: any) => void,
) => LegacyAsyncReturnValue | undefined

const normalizedAsyncComponentMap = new WeakMap<
  LegacyAsyncComponent,
  Component
>()

// 将 Vue 2 式的异步组件定义（即经典的工厂函数风格）转换为 Vue 3 的 defineAsyncComponent() 异步组件格式，以保证兼容性。
export function convertLegacyAsyncComponent(
  comp: LegacyAsyncComponent,
): Component {
  // 缓存已转换结果
  // 避免重复转换同一个异步组件。
  if (normalizedAsyncComponentMap.has(comp)) {
    return normalizedAsyncComponentMap.get(comp)!
  }

  // we have to call the function here due to how v2's API won't expose the
  // options until we call it
  // 准备手动调用异步工厂函数
  // 在 Vue 2 中，你必须调用该工厂函数才能知道它是返回 promise 还是配置对象；
  // resolve, reject 是兼容 Vue 2 的 async API（callback 式）；
  // res 可能是：
  // Promise<Component>
  // LegacyAsyncOptions
  // undefined
  let resolve: (res: LegacyAsyncReturnValue) => void
  let reject: (reason?: any) => void
  const fallbackPromise = new Promise<Component>((r, rj) => {
    ;(resolve = r), (reject = rj)
  })

  const res = comp(resolve!, reject!)

  let converted: Component
  //  兼容处理多种返回值
  if (isPromise(res)) {
    // 表示组件是标准懒加载模块，包装成 Vue 3 defineAsyncComponent()：
    converted = defineAsyncComponent(() => res)
  } else if (isObject(res) && !isVNode(res) && !isArray(res)) {
    // 返回配置对象（LegacyAsyncOptions）：
    // 包含 loading/error 等属性，用新格式封装。
    converted = defineAsyncComponent({
      loader: () => res.component,
      loadingComponent: res.loading,
      errorComponent: res.error,
      delay: res.delay,
      timeout: res.timeout,
    })
  } else if (res == null) {
    // 返回 undefined/null（非常规）：
    // 此时依赖外部 resolve() 被调用后才有值——继续使用 fallbackPromise 兜底。
    converted = defineAsyncComponent(() => fallbackPromise)
  } else {
    // 作为 fallback，按普通组件处理。
    converted = comp as any // probably a v3 functional comp
  }
  // 缓存并返回结果
  normalizedAsyncComponentMap.set(comp, converted)
  return converted
}
