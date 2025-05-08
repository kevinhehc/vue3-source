import {
  ElementTypes,
  type NodeTransform,
  NodeTypes,
  type SlotOutletNode,
  TRANSITION,
  TRANSITION_GROUP,
  createCallExpression,
  createFunctionExpression,
  isSlotOutlet,
  processSlotOutlet,
  resolveComponentType,
} from '@vue/compiler-dom'
import { SSR_RENDER_SLOT, SSR_RENDER_SLOT_INNER } from '../runtimeHelpers'
import {
  type SSRTransformContext,
  processChildrenAsStatement,
} from '../ssrCodegenTransform'

// 生成插槽调用代码 ssrRenderSlot(...)（未含 fallback）
// 该函数会在第一次遍历 <slot> 标签时触发：
export const ssrTransformSlotOutlet: NodeTransform = (node, context) => {
  if (isSlotOutlet(node)) {
    const { slotName, slotProps } = processSlotOutlet(node, context)

    // const args = [
    //   _ctx.$slots,   // 插槽容器
    //   slotName,      // 插槽名（默认为 "default"）
    //   slotProps || {}, // 传递给插槽的 props
    //   null,          // fallback content 占位（第二阶段替换）
    //   _push, _parent // SSR 必需参数
    // ]
    const args = [
      `_ctx.$slots`,
      slotName,
      slotProps || `{}`,
      // fallback content placeholder. will be replaced in the process phase 。args[3] = fallback 会在 ssrProcessSlotOutlet 中再填充。
      `null`,
      `_push`,
      `_parent`,
    ]

    // inject slot scope id if current template uses :slotted
    if (context.scopeId && context.slotted !== false) {
      args.push(`"${context.scopeId}-s"`)
    }

    let method = SSR_RENDER_SLOT

    // #3989, #9933
    // check if this is a single slot inside a transition wrapper - since
    // transition/transition-group will unwrap the slot fragment into vnode(s)
    // at runtime, we need to avoid rendering the slot as a fragment.
    let parent = context.parent!
    if (parent) {
      const children = parent.children
      // #10743 <slot v-if> in <Transition>
      if (parent.type === NodeTypes.IF_BRANCH) {
        parent = context.grandParent!
      }
      let componentType
      if (
        parent.type === NodeTypes.ELEMENT &&
        parent.tagType === ElementTypes.COMPONENT &&
        ((componentType = resolveComponentType(parent, context, true)) ===
          TRANSITION ||
          componentType === TRANSITION_GROUP) &&
        children.filter(c => c.type === NodeTypes.ELEMENT).length === 1
      ) {
        method = SSR_RENDER_SLOT_INNER
        if (!(context.scopeId && context.slotted !== false)) {
          args.push('null')
        }
        args.push('true')
      }
    }

    node.ssrCodegenNode = createCallExpression(context.helper(method), args)
  }
}

// 若有 fallback，补充 fallback 函数体，最终输出调用
export function ssrProcessSlotOutlet(
  node: SlotOutletNode,
  context: SSRTransformContext,
): void {
  const renderCall = node.ssrCodegenNode!

  // has fallback content
  // fallback 内容
  if (node.children.length) {
    // 如果 <slot> 中有默认内容：
    // 则构建一个 render 函数：
    const fallbackRenderFn = createFunctionExpression([])
    fallbackRenderFn.body = processChildrenAsStatement(node, context)
    // _renderSlot(slots, name, props, fallback, ...)
    renderCall.arguments[3] = fallbackRenderFn
  }

  // Forwarded <slot/>. Merge slot scope ids
  // 插槽作用域叠加（forwarded slot）
  if (context.withSlotScopeId) {
    const slotScopeId = renderCall.arguments[6]
    renderCall.arguments[6] = slotScopeId
      ? `${slotScopeId as string} + _scopeId`
      : `_scopeId`
  }

  context.pushStatement(node.ssrCodegenNode!)
}
