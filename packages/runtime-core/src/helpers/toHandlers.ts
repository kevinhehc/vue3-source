import { isObject, toHandlerKey } from '@vue/shared'
import { warn } from '../warning'

/**
 * For prefixing keys in v-on="obj" with "on"
 * @private
 */
// 用于将一个事件对象 { click: fn } 转换成组件 props 能识别的 onClick: fn 或 on:click: fn 形式，支持 camelCase 和 kebab-case。
export function toHandlers(
  obj: Record<string, any>,
  preserveCaseIfNecessary?: boolean,
): Record<string, any> {
  const ret: Record<string, any> = {}
  // 1. 类型检查（仅限 dev）
  if (__DEV__ && !isObject(obj)) {
    // 防止 v-on="123" 这样的错误用法；
    // 只在开发模式下警告。
    warn(`v-on with no argument expects an object value.`)
    return ret
  }
  // 2. 遍历对象每个事件名
  for (const key in obj) {
    // 如果 preserveCaseIfNecessary === true
    // 且事件名中含有大写字母（即 camelCase）：
    // 不使用默认的 onClick 形式；
    // 而生成 on:click 形式（冒号分隔）；
    // 用于组件事件的多态处理（如 Web Components 自定义事件）。
    ret[
      preserveCaseIfNecessary && /[A-Z]/.test(key)
        ? `on:${key}`
        : toHandlerKey(key) // 否则，统一调用：
    ] = obj[key]
  }
  return ret
}
