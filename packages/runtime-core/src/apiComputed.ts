import { type ComputedRefImpl, computed as _computed } from '@vue/reactivity'
import { getCurrentInstance, isInSSRComponentSetup } from './component'

// computed 响应式 API 的导出封装实现。它对内部的 _computed 做了一层包装，并添加了一些开发环境下的逻辑。
export const computed: typeof _computed = (
  getterOrOptions: any,
  debugOptions?: any,
) => {
  // computed 是用户使用的 API。
  // 它本质上调用的是内部实现 _computed（通常来自 @vue/reactivity）。
  // 参数 getterOrOptions 可以是：
  // 一个 getter 函数（只读计算属性）；
  // 一个对象 { get, set }（可写计算属性）。
  // @ts-expect-error

  // 调用 _computed 并传入 SSR 上下文标志
  // 第三个参数是 isInSSRComponentSetup：一个布尔值，表示当前是否在 SSR 组件 setup 中。
  // 这个参数 _computed 会用来决定是否跳过某些缓存逻辑，以避免 SSR 时的响应性不一致问题。
  // 这里用 @ts-expect-error 是因为 _computed 通常只接收两个参数，这是 Vue 内部扩展的隐藏参数。
  const c = _computed(getterOrOptions, debugOptions, isInSSRComponentSetup)
  if (__DEV__) {
    // 开发环境调试配置
    const i = getCurrentInstance()
    if (i && i.appContext.config.warnRecursiveComputed) {
      // 如果在开发环境：
      // 获取当前组件实例；
      // 如果应用配置中启用了 warnRecursiveComputed：
      // 就在 computed 对象上打上 _warnRecursive 标记；
      // Vue 在运行时可能用这个标记来检测递归调用计算属性的问题（比如 A 依赖 B，B 又依赖 A）。
      ;(c as unknown as ComputedRefImpl<any>)._warnRecursive = true
    }
  }
  return c as any
}
