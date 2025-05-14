import { inject } from '../apiInject'
import { warn } from '../warning'

// 1. 定义 SSR 注入 key
// 使用 Symbol.for() 创建共享的 symbol key；
// 所有 inject(ssrContextKey) 都能访问统一的 SSR 上下文；
// 被用于服务端构建时由 Vue 内部注入。
export const ssrContextKey: unique symbol = Symbol.for('v-scx')

// 在服务端渲染时，从当前组件上下文中获取 SSR 上下文对象。
// 返回值为在 renderToString() 或 renderToWebStream() 时提供的上下文对象。
export const useSSRContext = <T = Record<string, any>>(): T | undefined => {
  if (!__GLOBAL__) {
    // 分支一：非浏览器构建（即服务端构建）
    // 使用 inject() 获取 SSR context；
    // 如果没获取到，提示警告（比如用户误在客户端代码中调用）；
    // 正常返回 context 对象供操作。
    const ctx = inject<T>(ssrContextKey)
    if (!ctx) {
      __DEV__ &&
        warn(
          `Server rendering context not provided. Make sure to only call ` +
            `useSSRContext() conditionally in the server build.`,
        )
    }
    return ctx
  } else if (__DEV__) {
    // 分支二：浏览器构建（__GLOBAL__ === true）
    // useSSRContext() 不可用；
    // 会发出 dev-only 警告。
    warn(`useSSRContext() is not supported in the global build.`)
  }
}
