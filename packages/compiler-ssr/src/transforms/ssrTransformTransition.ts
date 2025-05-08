import {
  type ComponentNode,
  NodeTypes,
  type TransformContext,
  findProp,
} from '@vue/compiler-dom'
import {
  type SSRTransformContext,
  processChildren,
} from '../ssrCodegenTransform'

// 在 SSR 渲染中正确处理 <transition> 标签的子节点，并根据是否存在 appear 属性，选择是否包裹 <template> 标签。

// 为什么 SSR 中 <transition> 要这么处理？
// 客户端行为：
// <transition> 会自动处理进入/离开动画
// appear 控制首次渲染是否触发 enter 动画
// SSR 中：
// 实际 不会输出任何 <transition> 包裹元素
// 所以 SSR 只渲染其 子内容
// 但 appear 情况下，需要一个合法节点作为挂载点，因此用 <template> 包裹保持合法性
// 编译前后示例
// <transition appear>
//   <div>Hello</div>
// </transition>
// SSR 输出：
// <template><div>Hello</div></template>

const wipMap = new WeakMap<ComponentNode, Boolean>()

// 仅判断是否有 appear 属性，并记录下来。
export function ssrTransformTransition(
  node: ComponentNode,
  context: TransformContext,
) {
  return (): void => {
    // <transition appear> 会被标记为 true
    // 其他情况为 false（或 undefined）
    // 存入 wipMap<ComponentNode, boolean>，供第二阶段使用。
    const appear = findProp(node, 'appear', false, true)
    wipMap.set(node, !!appear)
  }
}

// 实际输出字符串。
export function ssrProcessTransition(
  node: ComponentNode,
  context: SSRTransformContext,
): void {
  // #5351: filter out comment children inside transition
  // 清除注释节点
  // 这避免 SSR 输出中出现不必要的注释节点（如模板空行导致的注释）。
  node.children = node.children.filter(c => c.type !== NodeTypes.COMMENT)

  // 判断 appear 包裹 <template>
  // 据是否设置了 appear：
  // 如果有，使用 <template> 标签包裹子内容
  // 如果没有，直接输出子内容
  const appear = wipMap.get(node)
  if (appear) {
    context.pushStringPart(`<template>`)
    processChildren(node, context, false, true)
    context.pushStringPart(`</template>`)
  } else {
    processChildren(node, context, false, true)
  }
}
