import { isOn } from '@vue/shared'
import type { ComponentInternalInstance } from '../component'
import { DeprecationTypes, assertCompatEnabled } from './compatConfig'

// 模拟 Vue 2 中的 vm.$listeners，即：从组件的 props 中提取父组件传递的事件监听器，返回一个 { [eventName]: handler } 对象。
export function getCompatListeners(
  instance: ComponentInternalInstance,
): Record<string, Function | Function[]> {
  assertCompatEnabled(DeprecationTypes.INSTANCE_LISTENERS, instance)

  const listeners: Record<string, Function | Function[]> = {}
  const rawProps = instance.vnode.props
  if (!rawProps) {
    return listeners
  }
  for (const key in rawProps) {
    if (isOn(key)) {
      listeners[key[2].toLowerCase() + key.slice(3)] = rawProps[key]
    }
  }
  return listeners
}

// 🔍 Vue 2 中的 $listeners 是什么？
// 在 Vue 2 中：
// this.$listeners // 返回所有通过 v-on 绑定到当前组件上的事件监听器
// 例如：
// <MyComponent @click="handleClick" @input="handleInput" />
// 在 MyComponent 内部：
// this.$listeners // { click: handleClick, input: handleInput }
// 可以手动绑定到子元素或 $emit 触发等。
//
// 🔁 Vue 3 的变化
// Vue 3 移除了 $listeners，把所有非 props 的 attributes（包括事件）统一收进了 $attrs；
// 事件和非 prop attribute 不再区分；
// Vue 3 推荐使用 emits 配置来声明事件。
// 🔧 该函数在 compat 中的做法
// 1. 断言是否启用了兼容项
// assertCompatEnabled(DeprecationTypes.INSTANCE_LISTENERS, instance)
// 否则抛出或警告。
//
// 2. 从 vnode 的 props 中提取事件
// const rawProps = instance.vnode.props
// Vue 3 中组件接收的 props（包括 props 和事件）都保存在 vnode.props 中。
//
// 3. 筛选出事件：
// for (const key in rawProps) {
//   if (isOn(key)) {
//     listeners[key[2].toLowerCase() + key.slice(3)] = rawProps[key]
//   }
// }
// isOn(key) 是判断是否为事件（即以 on 开头）；
// 将 onClick 转换为 click，onUpdate:modelValue → update:modelValue；
// 放入返回对象中。
//
// ✅ 返回示例
// 对于传入的组件：
// <MyComp @click="onClick" @update:modelValue="onUpdate" />
// vnode.props 为：
// {
//   onClick: onClick,
//   onUpdate:modelValue: onUpdate
// }
// 最终 getCompatListeners() 返回：
// {
//   click: onClick,
//   'update:modelValue': onUpdate
// }
// 📌 在哪里被使用？
// 它被注入到组件实例中，作为 $listeners：
// installCompatInstanceProperties(map) // 其中包含：
//
// $listeners: getCompatListeners
// 所以最终你可以在模板或脚本中访问：
// this.$listeners // 与 Vue 2 保持一致
