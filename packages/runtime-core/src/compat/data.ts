import { isPlainObject } from '@vue/shared'
import { DeprecationTypes, warnDeprecation } from './compatConfig'

// 在 Vue 3 中模拟 Vue 2 的 data() 合并行为（用于 mixins/extends 的 data 选项合并），并在合并嵌套对象时做深度递归。

// 为什么需要这个函数？
// Vue 2 的 data() 合并行为（通过 Vue.extend, mixins 等）：
// Vue 2 会深度合并多个 data() 函数的返回对象；
//
// 如果 key 冲突，Vue 2 默认将对象字段合并，而不是直接覆盖。
// Vue 3 的行为：
// Vue 3 中合并 data() 的逻辑是浅合并；
// 不再默认深合并（设计更简单，推荐你手动控制合并策略）；
// 所以 compat build 提供此函数来恢复旧行为。
export function deepMergeData(to: any, from: any): any {
  for (const key in from) {
    const toVal = to[key]
    const fromVal = from[key]
    if (key in to && isPlainObject(toVal) && isPlainObject(fromVal)) {
      __DEV__ && warnDeprecation(DeprecationTypes.OPTIONS_DATA_MERGE, null, key)
      deepMergeData(toVal, fromVal)
    } else {
      to[key] = fromVal
    }
  }
  return to
}
