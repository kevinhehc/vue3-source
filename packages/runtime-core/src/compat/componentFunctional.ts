import {
  type ComponentOptions,
  type FunctionalComponent,
  getCurrentInstance,
} from '../component'
import { resolveInjections } from '../componentOptions'
import type { InternalSlots } from '../componentSlots'
import { getCompatListeners } from './instanceListeners'
import { compatH } from './renderFn'

const normalizedFunctionalComponentMap = new WeakMap<
  ComponentOptions,
  FunctionalComponent
>()
export const legacySlotProxyHandlers: ProxyHandler<InternalSlots> = {
  get(target, key: string) {
    const slot = target[key]
    return slot && slot()
  },
}
// 定义了 Vue 3 compat build 中用于 兼容 Vue 2 函数式组件（functional component） 的转换器函数
// 将 Vue 2 的函数式组件（functional: true 的组件对象）转换为 Vue 3 兼容的标准函数式组件形式（纯函数 + setup-less）。

// 在 Vue 2 中你可以写：
// export default {
//   functional: true,
//   props: ['msg'],
//   render(h, context) {
//     return h('div', context.props.msg)
//   }
// }

// 在 Vue 3 中，这种 functional: true 的写法已被移除，推荐写法是：
// const MyComponent = (props, { slots }) => {
//   return h('div', props.msg)
// }

// Vue 3 compat build 会通过 convertLegacyFunctionalComponent() 实现对旧组件的自动适配。
export function convertLegacyFunctionalComponent(
  comp: ComponentOptions,
): FunctionalComponent {
  // 缓存机制（避免重复转换）
  // 防止同一个组件对象被重复转换。
  if (normalizedFunctionalComponentMap.has(comp)) {
    return normalizedFunctionalComponentMap.get(comp)!
  }

  // 获取原始 render 函数
  const legacyFn = comp.render as any

  // Vue 2 函数式组件通过 render(h, ctx) 描述，h 是 Vue 2 的 createElement，ctx 是包含 props, slots, data 等内容的上下文对象。
  const Func: FunctionalComponent = (props, ctx) => {
    // 使用 Vue 3 的函数式组件 API（(props, ctx) => VNode）；
    // 构造兼容的 legacyCtx 传给旧的 render 函数；
    // compatH 是 Vue 3 中模拟 Vue 2 的 h() 版本；
    // 使用 Vue 3 的 getCurrentInstance() 拿到运行时实例数据，构造伪 context。
    const instance = getCurrentInstance()!

    // 构造出 Vue 2 函数式组件 render 的第二个参数 context 的等价结构：
    const legacyCtx = {
      props,
      children: instance.vnode.children || [],
      data: instance.vnode.props || {},
      scopedSlots: ctx.slots,
      parent: instance.parent && instance.parent.proxy,
      slots() {
        return new Proxy(ctx.slots, legacySlotProxyHandlers)
      },
      get listeners() {
        return getCompatListeners(instance)
      },
      get injections() {
        if (comp.inject) {
          const injections = {}
          resolveInjections(comp.inject, injections)
          return injections
        }
        return {}
      },
    }
    return legacyFn(compatH, legacyCtx)
  }
  // 属性	意义
  // props	传入的 props
  // children	默认插槽内容
  // scopedSlots	Vue 2 的作用域插槽
  // data	vnode 的属性集合（不等于 props）
  // parent	父组件实例
  // slots()	返回 Proxy 包装的 slots（兼容 slot 函数调用）
  // listeners	Vue 2 的 $listeners，通过 compat 实现
  // injections	兼容 Vue 2 的 inject API
  Func.props = comp.props
  Func.displayName = comp.name
  Func.compatConfig = comp.compatConfig
  // v2 functional components do not inherit attrs
  Func.inheritAttrs = false

  normalizedFunctionalComponentMap.set(comp, Func)
  return Func
}
