import type { NodeTransform } from '../transform'
import {
  type CallExpression,
  type CompoundExpressionNode,
  ConstantTypes,
  ElementTypes,
  NodeTypes,
  createCallExpression,
  createCompoundExpression,
} from '../ast'
import { isText } from '../utils'
import { CREATE_TEXT } from '../runtimeHelpers'
import { PatchFlagNames, PatchFlags } from '@vue/shared'
import { getConstantType } from './cacheStatic'

// Merge adjacent text nodes and expressions into a single expression
// e.g. <div>abc {{ d }} {{ e }}</div> should have a single expression node as child.
// 合并相邻的文本节点与表达式为单个复合表达式节点
// 例如：<div>abc {{ d }} {{ e }}</div> 会变成一个表达式节点： "abc" + d + e
export const transformText: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ROOT || // 根节点
    node.type === NodeTypes.ELEMENT || // 元素节点
    node.type === NodeTypes.FOR || // v-for block
    node.type === NodeTypes.IF_BRANCH // v-if 分支
  ) {
    // perform the transform on node exit so that all expressions have already
    // been processed.
    // 在节点的退出阶段处理，这时表达式已经被 transformExpression 处理过了
    return () => {
      const children = node.children
      let currentContainer: CompoundExpressionNode | undefined = undefined
      let hasText = false

      // 遍历当前节点的子节点
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (isText(child)) {
          hasText = true
          // 向后查找连续的文本或插值节点，合并它们
          for (let j = i + 1; j < children.length; j++) {
            const next = children[j]
            if (isText(next)) {
              if (!currentContainer) {
                // 当前节点转为复合表达式容器
                currentContainer = children[i] = createCompoundExpression(
                  [child],
                  child.loc,
                )
              }
              // merge adjacent text node into current
              // 将相邻的文本插入 currentContainer，并拼接 +
              currentContainer.children.push(` + `, next)
              // 删除已合并的 next 节点
              children.splice(j, 1)
              j--
            } else {
              currentContainer = undefined
              break
            }
          }
        }
      }

      // 若没有文本，或只包含单个纯文本节点且满足以下情况，就不再处理
      if (
        !hasText ||
        // if this is a plain element with a single text child, leave it
        // as-is since the runtime has dedicated fast path for this by directly
        // setting textContent of the element.
        // for component root it's always normalized anyway.
        (children.length === 1 &&
          (node.type === NodeTypes.ROOT ||
            (node.type === NodeTypes.ELEMENT &&
              node.tagType === ElementTypes.ELEMENT &&
              // #3756
              // custom directives can potentially add DOM elements arbitrarily,
              // we need to avoid setting textContent of the element at runtime
              // to avoid accidentally overwriting the DOM elements added
              // by the user through custom directives.
              // 如果有自定义指令，不能替换为 textContent，避免破坏用户 DOM
              !node.props.find(
                p =>
                  p.type === NodeTypes.DIRECTIVE &&
                  !context.directiveTransforms[p.name],
              ) &&
              // in compat mode, <template> tags with no special directives
              // will be rendered as a fragment so its children must be
              // converted into vnodes.
              // 在兼容模式下，<template> 要转为 fragment，不能直接设 textContent
              !(__COMPAT__ && node.tag === 'template'))))
      ) {
        return
      }

      // pre-convert text nodes into createTextVNode(text) calls to avoid
      // runtime normalization.
      // 将文本节点转为 createTextVNode()，避免运行时处理
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (isText(child) || child.type === NodeTypes.COMPOUND_EXPRESSION) {
          const callArgs: CallExpression['arguments'] = []
          // createTextVNode defaults to single whitespace, so if it is a
          // single space the code could be an empty call to save bytes.
          // Vue 内部：createTextVNode 默认值是单个空格，如果是空格可以省略参数
          if (child.type !== NodeTypes.TEXT || child.content !== ' ') {
            callArgs.push(child)
          }
          // mark dynamic text with flag so it gets patched inside a block
          // 如果是动态文本，加 patchFlag，便于后续 diff 优化
          if (
            !context.ssr &&
            getConstantType(child, context) === ConstantTypes.NOT_CONSTANT
          ) {
            callArgs.push(
              PatchFlags.TEXT +
                (__DEV__ ? ` /* ${PatchFlagNames[PatchFlags.TEXT]} */` : ``),
            )
          }
          // 构建 TEXT_CALL 节点，交由 codegen 生成最终代码
          children[i] = {
            type: NodeTypes.TEXT_CALL,
            content: child,
            loc: child.loc,
            codegenNode: createCallExpression(
              context.helper(CREATE_TEXT),
              callArgs,
            ),
          }
        }
      }
    }
  }
}
