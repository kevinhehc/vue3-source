import type { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { type ElementNode, type ForNode, type IfNode, NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

// 处理 v-once 指令的转换器 —— 表示元素只渲染一次，不参与后续更新
const seen = new WeakSet()

export const transformOnce: NodeTransform = (node, context) => {
  // 仅处理元素节点，且包含 v-once 指令（第三个参数 true 表示跳过修饰符匹配）
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    // 已处理过、当前在 v-once 中，或在 SSR 中，不重复处理
    if (seen.has(node) || context.inVOnce || context.inSSR) {
      return
    }
    // 标记已处理
    seen.add(node)
    // 设置 v-once 作用中标记
    context.inVOnce = true
    // 注册运行时 helper（用于追踪 block 状态）
    context.helper(SET_BLOCK_TRACKING)
    // 返回退出回调，等子节点转换完成后处理缓存逻辑
    return () => {
      // 退出 v-once 状态
      context.inVOnce = false
      const cur = context.currentNode as ElementNode | IfNode | ForNode
      // 对当前节点生成的 codegenNode 进行缓存包裹
      if (cur.codegenNode) {
        cur.codegenNode = context.cache(
          cur.codegenNode,
          true /* isVNode */, // isVNode：是否为 vnode
          true /* inVOnce */, // inVOnce：此缓存为 v-once 专用
        )
      }
    }
  }
}
