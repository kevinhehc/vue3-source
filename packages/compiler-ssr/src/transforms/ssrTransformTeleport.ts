import {
  type ComponentNode,
  type ExpressionNode,
  NodeTypes,
  createCallExpression,
  createFunctionExpression,
  createSimpleExpression,
  findProp,
} from '@vue/compiler-dom'
import {
  type SSRTransformContext,
  processChildrenAsStatement,
} from '../ssrCodegenTransform'
import { SSRErrorCodes, createSSRCompilerError } from '../errors'
import { SSR_RENDER_TELEPORT } from '../runtimeHelpers'

// 在 SSR 中为 <teleport> 生成正确的渲染调用 ssrRenderTeleport(...)，包括内容渲染函数、目标、禁用状态等。
// 背景：Teleport 的 SSR 行为
// 在客户端，<teleport to="#target"> 表示把子内容挂载到另一个 DOM 节点。但在 SSR 中：
// 内容仍然需要渲染到最终 HTML 字符串中
// 但要记录目标位置和内容区域
// Vue 提供 ssrRenderTeleport() helper 来完成这一目标

// Note: this is a 2nd-pass codegen transform.
// 只在 第二阶段（codegen） 执行，<teleport> 不参与 transform 阶段。
export function ssrProcessTeleport(
  node: ComponentNode,
  context: SSRTransformContext,
): void {
  // 查找 to 属性（必须）
  const targetProp = findProp(node, 'to')
  if (!targetProp) {
    // 如果没有 to，报错：
    context.onError(
      createSSRCompilerError(SSRErrorCodes.X_SSR_NO_TELEPORT_TARGET, node.loc),
    )
    return
  }

  // 支持两种写法：
  // <teleport to="#foo" />
  // <teleport :to="dynamicTarget" />

  let target: ExpressionNode | undefined
  // 获取目标表达式
  if (targetProp.type === NodeTypes.ATTRIBUTE) {
    target =
      targetProp.value && createSimpleExpression(targetProp.value.content, true)
  } else {
    target = targetProp.exp
  }
  if (!target) {
    context.onError(
      createSSRCompilerError(
        SSRErrorCodes.X_SSR_NO_TELEPORT_TARGET,
        targetProp.loc,
      ),
    )
    return
  }

  // 三种情况：
  //
  // 写法	                          结果
  // <teleport disabled />	          "true"
  // <teleport :disabled="x" />	      x
  // 未写 disabled	                  "false"

  const disabledProp = findProp(node, 'disabled', false, true /* allow empty */)
  // 判断是否 disabled
  const disabled = disabledProp
    ? disabledProp.type === NodeTypes.ATTRIBUTE
      ? `true`
      : disabledProp.exp || `false`
    : `false`

  // 构建内容渲染函数
  const contentRenderFn = createFunctionExpression(
    [`_push`],
    undefined, // Body is added later
    true, // newline
    false, // isSlot
    node.loc,
  )
  contentRenderFn.body = processChildrenAsStatement(node, context)
  context.pushStatement(
    createCallExpression(context.helper(SSR_RENDER_TELEPORT), [
      `_push`,
      contentRenderFn,
      target,
      disabled,
      `_parent`,
    ]),
  )
}
