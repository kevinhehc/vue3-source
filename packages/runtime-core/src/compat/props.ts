import { isArray } from '@vue/shared'
import { inject } from '../apiInject'
import type { ComponentInternalInstance, Data } from '../component'
import {
  type ComponentOptions,
  resolveMergedOptions,
} from '../componentOptions'
import { DeprecationTypes, warnDeprecation } from './compatConfig'

// 用于 兼容 Vue 2 中 props 默认值函数中访问 this 的实现逻辑。
// 返回一个 Proxy 对象，作为 Vue 2 兼容的 this，供 props.default() 调用时使用。
export function createPropsDefaultThis(
  instance: ComponentInternalInstance,
  rawProps: Data,
  propKey: string,
): object {
  return new Proxy(
    {},
    {
      // 当 default() 函数中访问 this.someKey，将进入 get() 拦截器，处理逻辑如下：
      get(_, key: string) {
        __DEV__ &&
          // 说明你正在使用已弃用的行为：props 默认值函数中使用 this。
          warnDeprecation(DeprecationTypes.PROPS_DEFAULT_THIS, null, propKey)
        // $options
        // 支持访问 $options
        // 兼容 Vue 2 中的写法：
        if (key === '$options') {
          return resolveMergedOptions(instance)
        }
        // props
        // 访问组件的 props
        if (key in rawProps) {
          return rawProps[key]
        }
        // injections
        const injections = (instance.type as ComponentOptions).inject
        // 支持访问 inject
        if (injections) {
          if (isArray(injections)) {
            if (injections.includes(key)) {
              return inject(key)
            }
          } else if (key in injections) {
            return inject(key)
          }
        }
      },
    },
  )
}

// 示例
// props: {
//   theme: {
//     type: String,
//     default() {
//       return this.$options.name + '-dark'
//     },
//   },
// }
// 在 Vue 3 compat build 中会变成：
// theme.default.call(createPropsDefaultThis(instance, rawProps, 'theme'))

// 背景说明：Vue 2 中的行为
// 在 Vue 2 中，你可以在 props 的默认值函数中使用 this，例如：
// props: {
//   msg: {
//     type: String,
//     default() {
//       return this.$options.name + '-default'
//     },
//   },
// }
// 这里的 this 指向的是 组件实例；
// 这在 Vue 3 中已被移除；
// 在 Vue 3 中，default() 函数必须是无副作用的纯函数。
// 🚫 Vue 3 的变化
// Vue 3 中 this 不再自动注入到 props.default() 中。
// 为保持兼容，Vue 3 compat build 提供了一个特殊对象（this 的模拟）：
