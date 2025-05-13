import { ShapeFlags } from '@vue/shared'
import type { ComponentInternalInstance } from '../component'
import type { ComponentPublicInstance } from '../componentPublicInstance'
import type { VNode } from '../vnode'
import { DeprecationTypes, assertCompatEnabled } from './compatConfig'

// 该函数模拟 Vue 2 中 vm.$children 的行为，返回当前组件的直接子组件实例列表。
// 在 Vue 3 中，$children 被移除，因为它不再适用于 Fragment、Teleport 等更灵活的组件结构。此函数就是用于在 compat 模式下提供它。
export function getCompatChildren(
  instance: ComponentInternalInstance,
): ComponentPublicInstance[] {
  // 检查是否启用兼容支持
  // 如果 compat 配置关闭了 $children 支持，则报错或警告。
  assertCompatEnabled(DeprecationTypes.INSTANCE_CHILDREN, instance)
  // 获取组件渲染树 subTree
  // Vue 3 中，组件的 subTree 是其渲染的虚拟 DOM；
  // subTree 的 children 才是渲染出来的真实子节点（包括文本节点、元素节点、子组件节点）。
  const root = instance.subTree
  const children: ComponentPublicInstance[] = []
  if (root) {
    walk(root, children)
  }
  return children
}

// 深度遍历 vnode 树，提取子组件实例
// 如果是组件 vnode，取其 .component.proxy 作为 ComponentPublicInstance；
// 如果是普通元素 vnode，递归其子节点；
// 非组件或非数组子节点将被跳过。
function walk(vnode: VNode, children: ComponentPublicInstance[]) {
  if (vnode.component) {
    children.push(vnode.component.proxy!)
  } else if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
    const vnodes = vnode.children as VNode[]
    for (let i = 0; i < vnodes.length; i++) {
      walk(vnodes[i], children)
    }
  }
}

// 📘 Vue 2 中 $children 的含义
// 返回当前组件模板中直接子组件实例的数组；
// 不包含 DOM 节点或文本；
// 顺序取决于渲染顺序；
// 通常用于访问子组件方法或状态（不推荐）。
// 📌 Vue 3 的变化
// Vue 3 中官方不推荐使用 $children，因为：
// 存在结构不确定性（如 Fragment）；
// v-if, v-for 影响结构顺序；
// 推荐使用 ref 和 provide/inject 代替直接访问子组件。

// 示例
// 模板：
// <template>
//   <ChildA />
//   <ChildB />
// </template>

// Vue 2：
// this.$children // → [<ChildA instance>, <ChildB instance>]

// Vue 3 compat：
// getCompatChildren(this.$)
// 会通过遍历 this.$.subTree 来找出子组件 vnode，并返回它们的 .proxy 实例。
