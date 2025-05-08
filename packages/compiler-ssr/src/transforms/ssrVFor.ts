import {
  type ForNode,
  type NodeTransform,
  NodeTypes,
  createCallExpression,
  createForLoopParams,
  createFunctionExpression,
  createStructuralDirectiveTransform,
  processFor,
} from '@vue/compiler-dom'
import {
  type SSRTransformContext,
  processChildrenAsStatement,
} from '../ssrCodegenTransform'
import { SSR_RENDER_LIST } from '../runtimeHelpers'

// 将模板中的 v-for="(item, i) in list" 编译为
// SSR 可执行的 ssrRenderList(list, (item, i) => { ... })，并根据场景自动包裹 fragment 注释 <!--[--> 和 <!--]-->。

// Plugin for the first transform pass, which simply constructs the AST node
// 阶段一：ssrTransformFor
// 使用 Vue 编译器内置的工具函数 createStructuralDirectiveTransform 注册 v-for
// 这一步构建的是通用的 AST 结构：ForNode
// SSR-specific 的逻辑还没有涉及
export const ssrTransformFor: NodeTransform =
  createStructuralDirectiveTransform('for', processFor)

// This is called during the 2nd transform pass to construct the SSR-specific
// codegen nodes.
// 阶段二：ssrProcessFor
// 该函数是真正进行 SSR 输出的阶段
export function ssrProcessFor(
  node: ForNode,
  context: SSRTransformContext,
  disableNestedFragments = false,
): void {
  // 是否需要 fragment 注释？
  // 判断是否要在渲染结果中插入：
  // <!--[--> ... <!--]-->  // SSR fragment boundary
  const needFragmentWrapper =
    !disableNestedFragments &&
    (node.children.length !== 1 || node.children[0].type !== NodeTypes.ELEMENT)
  const renderLoop = createFunctionExpression(
    createForLoopParams(node.parseResult),
  )
  // 默认需要（除非只有一个元素子节点）
  // 或者显式禁用 disableNestedFragments = true

  // 创建遍历函数表达式
  renderLoop.body = processChildrenAsStatement(
    node,
    context,
    needFragmentWrapper,
  )
  // v-for always renders a fragment unless explicitly disabled
  if (!disableNestedFragments) {
    context.pushStringPart(`<!--[-->`)
  }
  context.pushStatement(
    createCallExpression(context.helper(SSR_RENDER_LIST), [
      node.source,
      renderLoop,
    ]),
  )
  if (!disableNestedFragments) {
    context.pushStringPart(`<!--]-->`)
  }
}
