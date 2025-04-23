import type { NodeTransform } from '../transform'
import { findDir } from '../utils'
import {
  ElementTypes,
  type MemoExpression,
  NodeTypes,
  type PlainElementNode,
  convertToBlock,
  createCallExpression,
  createFunctionExpression,
} from '../ast'
import { WITH_MEMO } from '../runtimeHelpers'

// 用于处理 v-memo 的节点转换器，避免重复 patch 相同节点
const seen = new WeakSet()

export const transformMemo: NodeTransform = (node, context) => {
  // 仅处理普通元素节点（不处理 template、text、comment 等）
  if (node.type === NodeTypes.ELEMENT) {
    // 查找是否存在 v-memo 指令
    const dir = findDir(node, 'memo')
    if (!dir || seen.has(node)) {
      // 没有 v-memo 或已经处理过了，跳过
      return
    }
    // 标记节点已处理，避免重复
    seen.add(node)
    // 返回退出回调，等所有子节点 codegen 完成后再包裹 memo 逻辑
    return () => {
      const codegenNode =
        node.codegenNode ||
        (context.currentNode as PlainElementNode).codegenNode
      // 如果当前节点生成了 codegenNode，且是 vnode 类型
      if (codegenNode && codegenNode.type === NodeTypes.VNODE_CALL) {
        // non-component sub tree should be turned into a block
        // 非组件元素，强制转换为 block（组件本身默认就是 block）
        if (node.tagType !== ElementTypes.COMPONENT) {
          convertToBlock(codegenNode, context)
        }
        // 包裹 memo 表达式，最终结构：
        // withMemo(memoExp, () => vnode, _cache, index)
        node.codegenNode = createCallExpression(context.helper(WITH_MEMO), [
          dir.exp!, // v-memo 的表达式内容
          createFunctionExpression(undefined, codegenNode), // 函数体是原来的 vnode
          `_cache`, // 缓存对象
          String(context.cached.length), // 当前缓存索引
        ]) as MemoExpression
        // increment cache count
        // 缓存列表填充一个占位符
        context.cached.push(null)
      }
    }
  }
}
