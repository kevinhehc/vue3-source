import {
  type ComponentInternalInstance,
  getCurrentInstance,
} from '../component'
import { warn } from '../warning'

// 主要用于：
// 在 SSR 和客户端 hydration 一致性中为组件生成稳定的唯一 ID；
// 用于 <label for>, <input id> 这类 DOM 结构中生成组件隔离 ID；
// 支持嵌套组件、异步组件的唯一前缀追踪；
// 避免 hydration 不一致、SSR 缺失等问题。
export function useId(): string {
  const i = getCurrentInstance()
  // i.ids = [prefix, counter1, counter2]
  // ids[0]: 是当前组件或异步边界累积下来的前缀；
  // ids[1]: 是当前组件内的局部 ID 计数器；
  // 每次调用 useId()，都会生成带前缀的唯一 ID，并自增 ids[1]。
  if (i) {
    return (i.appContext.config.idPrefix || 'v') + '-' + i.ids[0] + i.ids[1]++
  } else if (__DEV__) {
    warn(
      `useId() is called when there is no active component ` +
        `instance to be associated with.`,
    )
  }
  return ''
}

/**
 * There are 3 types of async boundaries:
 * - async components
 * - components with async setup()
 * - components with serverPrefetch
 */
// 用于异步边界组件打标记
// 在 3 类异步边界上调用：
// 异步组件 (defineAsyncComponent)
// async setup() 函数的组件
// 使用 serverPrefetch() 的组件
export function markAsyncBoundary(instance: ComponentInternalInstance): void {
  // 增加一个新层级的 ID 前缀；
  // 例如从 'v-' → 'v-0-' → 'v-0-0-'；
  // 用于嵌套组件生成稳定的 ID 命名空间；
  // ids[2] 是嵌套异步组件的分支计数器（分叉标识）。
  instance.ids = [instance.ids[0] + instance.ids[2]++ + '-', 0, 0]
}
