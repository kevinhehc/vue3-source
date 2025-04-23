import {
  type NodeTransform,
  type TransformContext,
  createStructuralDirectiveTransform,
  traverseNode,
} from '../transform'
import {
  type AttributeNode,
  type BlockCodegenNode,
  type CacheExpression,
  ConstantTypes,
  type DirectiveNode,
  type ElementNode,
  ElementTypes,
  type IfBranchNode,
  type IfConditionalExpression,
  type IfNode,
  type MemoExpression,
  NodeTypes,
  type SimpleExpressionNode,
  convertToBlock,
  createCallExpression,
  createConditionalExpression,
  createObjectExpression,
  createObjectProperty,
  createSimpleExpression,
  createVNodeCall,
  locStub,
} from '../ast'
import { ErrorCodes, createCompilerError } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { cloneLoc } from '../parser'
import { CREATE_COMMENT, FRAGMENT } from '../runtimeHelpers'
import { findDir, findProp, getMemoedVNodeCall, injectProp } from '../utils'
import { PatchFlags } from '@vue/shared'

// 创建处理 v-if / v-else / v-else-if 的结构性指令转换器
export const transformIf: NodeTransform = createStructuralDirectiveTransform(
  // 匹配三个指令
  /^(if|else|else-if)$/,
  (node, dir, context) => {
    // 使用 processIf 创建 AST 节点并处理分支
    return processIf(node, dir, context, (ifNode, branch, isRoot) => {
      // #1587: We need to dynamically increment the key based on the current
      // node's sibling nodes, since chained v-if/else branches are
      // rendered at the same depth
      // 为当前 if 节点分配唯一 key，保证条件分支在同一层级下的区分

      // 获取父节点的所有子节点
      const siblings = context.parent!.children

      // 当前 if 节点在 siblings 中的索引
      let i = siblings.indexOf(ifNode)
      let key = 0
      // 统计当前 if 节点之前所有的 if 分支数量（用于 key 编号偏移）
      while (i-- >= 0) {
        const sibling = siblings[i]
        if (sibling && sibling.type === NodeTypes.IF) {
          key += sibling.branches.length
        }
      }

      // Exit callback. Complete the codegenNode when all children have been
      // transformed.
      // 返回退出回调，在所有子节点处理完后构建 codegenNode
      return () => {
        if (isRoot) {
          // 当前是 v-if 的根分支，直接构建根的 codegenNode
          ifNode.codegenNode = createCodegenNodeForBranch(
            branch,
            key,
            context,
          ) as IfConditionalExpression
        } else {
          // attach this branch's codegen node to the v-if root.
          // 当前是 v-else 或 v-else-if，附加到 v-if 的根节点上
          const parentCondition = getParentCondition(ifNode.codegenNode!)
          parentCondition.alternate = createCodegenNodeForBranch(
            branch,
            key + ifNode.branches.length - 1,
            context,
          )
        }
      }
    })
  },
)

// target-agnostic transform used for both Client and SSR
// v-if/v-else/v-else-if 通用处理函数（支持客户端与 SSR）
export function processIf(
  node: ElementNode, // 当前元素节点（带 v-if 等指令）
  dir: DirectiveNode, // 指令节点（v-if / v-else-if / v-else）
  context: TransformContext, // 编译上下文
  processCodegen?: (
    node: IfNode,
    branch: IfBranchNode,
    isRoot: boolean,
  ) => (() => void) | undefined, // 可选：子节点生成结束后调用的回调
): (() => void) | undefined {
  // 非 v-else 且表达式为空，则报错（v-if / v-else-if 必须有表达式）
  if (
    dir.name !== 'else' &&
    (!dir.exp || !(dir.exp as SimpleExpressionNode).content.trim())
  ) {
    const loc = dir.exp ? dir.exp.loc : node.loc
    context.onError(
      createCompilerError(ErrorCodes.X_V_IF_NO_EXPRESSION, dir.loc),
    )
    dir.exp = createSimpleExpression(`true`, false, loc) // fallback 为 true
  }

  // 非浏览器构建时，带标识符前缀的表达式需要处理
  if (!__BROWSER__ && context.prefixIdentifiers && dir.exp) {
    // dir.exp can only be simple expression because vIf transform is applied
    // before expression transform.
    dir.exp = processExpression(dir.exp as SimpleExpressionNode, context)
  }

  // 浏览器开发模式下验证表达式合法性
  if (__DEV__ && __BROWSER__ && dir.exp) {
    validateBrowserExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (dir.name === 'if') {
    // 是 v-if：创建一个新的 ifNode 并替换当前节点
    const branch = createIfBranch(node, dir)
    const ifNode: IfNode = {
      type: NodeTypes.IF,
      loc: cloneLoc(node.loc),
      branches: [branch],
    }
    context.replaceNode(ifNode)
    if (processCodegen) {
      return processCodegen(ifNode, branch, true)
    }
  } else {
    // locate the adjacent v-if
    // 是 v-else / v-else-if，需要找到其前面的 v-if 分支
    const siblings = context.parent!.children
    // 收集空白与注释节点（会附加到 else 分支）
    const comments = []
    let i = siblings.indexOf(node)
    while (i-- >= -1) {
      const sibling = siblings[i]
      // 收集注释节点
      if (sibling && sibling.type === NodeTypes.COMMENT) {
        context.removeNode(sibling)
        __DEV__ && comments.unshift(sibling)
        continue
      }

      // 跳过空白文本节点
      if (
        sibling &&
        sibling.type === NodeTypes.TEXT &&
        !sibling.content.trim().length
      ) {
        context.removeNode(sibling)
        continue
      }

      if (sibling && sibling.type === NodeTypes.IF) {
        // Check if v-else was followed by v-else-if
        // 若 v-else-if 紧跟着一个没有条件的分支（非法情况）
        if (
          dir.name === 'else-if' &&
          sibling.branches[sibling.branches.length - 1].condition === undefined
        ) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc),
          )
        }

        // move the node to the if node's branches
        // 合法：将当前 v-else / v-else-if 合并到前面的 ifNode.branches 中
        context.removeNode()
        const branch = createIfBranch(node, dir)
        // DEV 模式下，添加注释节点（非 transition 中）
        if (
          __DEV__ &&
          comments.length &&
          // #3619 ignore comments if the v-if is direct child of <transition>
          !(
            context.parent &&
            context.parent.type === NodeTypes.ELEMENT &&
            (context.parent.tag === 'transition' ||
              context.parent.tag === 'Transition')
          )
        ) {
          branch.children = [...comments, ...branch.children]
        }

        // check if user is forcing same key on different branches
        // 检查用户是否在多个分支上强制使用相同 key（这会导致 patch 异常）
        if (__DEV__ || !__BROWSER__) {
          const key = branch.userKey
          if (key) {
            sibling.branches.forEach(({ userKey }) => {
              if (isSameKey(userKey, key)) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_IF_SAME_KEY,
                    branch.userKey!.loc,
                  ),
                )
              }
            })
          }
        }

        // 添加分支
        sibling.branches.push(branch)
        // 调用 codegen 回调（如果有的话）
        const onExit = processCodegen && processCodegen(sibling, branch, false)
        // since the branch was removed, it will not be traversed.
        // make sure to traverse here.
        // 由于当前节点被 removeNode 了，不会被自动遍历，这里手动触发遍历
        traverseNode(branch, context)
        // call on exit
        // 手动触发退出回调
        if (onExit) onExit()
        // make sure to reset currentNode after traversal to indicate this
        // node has been removed.
        // 清除 currentNode，表示当前节点已处理完毕
        context.currentNode = null
      } else {
        // 找不到紧邻的 v-if 报错
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc),
        )
      }
      // 成功找到或报错后都跳出 while
      break
    }
  }
}

// 创建 v-if / v-else-if / v-else 的分支节点对象
function createIfBranch(node: ElementNode, dir: DirectiveNode): IfBranchNode {
  const isTemplateIf = node.tagType === ElementTypes.TEMPLATE
  return {
    type: NodeTypes.IF_BRANCH,
    loc: node.loc,
    condition: dir.name === 'else' ? undefined : dir.exp, // v-else 无条件，其他取表达式
    children: isTemplateIf && !findDir(node, 'for') ? node.children : [node], // template 子节点直接保留，否则将节点自身作为子节点
    userKey: findProp(node, `key`), // 提取 key 属性用于检查重复 key
    isTemplateIf, // 是否为 <template v-if>
  }
}

// 根据分支节点创建 codegenNode：条件表达式或子节点块
function createCodegenNodeForBranch(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext,
): IfConditionalExpression | BlockCodegenNode | MemoExpression {
  if (branch.condition) {
    // v-if 或 v-else-if，构造条件表达式（cond ? block : comment）
    return createConditionalExpression(
      branch.condition,
      createChildrenCodegenNode(branch, keyIndex, context),
      // make sure to pass in asBlock: true so that the comment node call
      // closes the current block.
      createCallExpression(context.helper(CREATE_COMMENT), [
        __DEV__ ? '"v-if"' : '""',
        'true',
      ]),
    ) as IfConditionalExpression
  } else {
    // v-else 直接返回其子节点 block
    return createChildrenCodegenNode(branch, keyIndex, context)
  }
}

// 生成分支的具体 children codegen block
function createChildrenCodegenNode(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext,
): BlockCodegenNode | MemoExpression {
  const { helper } = context
  const keyProperty = createObjectProperty(
    `key`,
    createSimpleExpression(
      `${keyIndex}`,
      false,
      locStub,
      ConstantTypes.CAN_CACHE,
    ),
  )
  const { children } = branch
  const firstChild = children[0]
  const needFragmentWrapper =
    children.length !== 1 || firstChild.type !== NodeTypes.ELEMENT
  if (needFragmentWrapper) {
    // 多子节点或非元素，需要使用 Fragment 包裹
    if (children.length === 1 && firstChild.type === NodeTypes.FOR) {
      // optimize away nested fragments when child is a ForNode
      // 特殊情况：唯一子节点是 v-for，可优化，避免嵌套 Fragment
      const vnodeCall = firstChild.codegenNode!
      injectProp(vnodeCall, keyProperty, context)
      return vnodeCall
    } else {
      let patchFlag = PatchFlags.STABLE_FRAGMENT
      // check if the fragment actually contains a single valid child with
      // the rest being comments
      // DEV 环境：若仅一个有效子节点（忽略注释），添加额外标志
      if (
        __DEV__ &&
        !branch.isTemplateIf &&
        children.filter(c => c.type !== NodeTypes.COMMENT).length === 1
      ) {
        patchFlag |= PatchFlags.DEV_ROOT_FRAGMENT
      }

      return createVNodeCall(
        context,
        helper(FRAGMENT),
        createObjectExpression([keyProperty]),
        children,
        patchFlag,
        undefined,
        undefined,
        true, // isBlock
        false, // disableTracking
        false /* isComponent */,
        branch.loc,
      )
    }
  } else {
    // 单个子元素，使用其 codegenNode，注入 key
    const ret = (firstChild as ElementNode).codegenNode as
      | BlockCodegenNode
      | MemoExpression
    const vnodeCall = getMemoedVNodeCall(ret)
    // Change createVNode to createBlock.
    // 转换为 block vnode
    if (vnodeCall.type === NodeTypes.VNODE_CALL) {
      convertToBlock(vnodeCall, context)
    }
    // inject branch key
    // 注入 key
    injectProp(vnodeCall, keyProperty, context)
    return ret
  }
}

// 比较两个 key 是否相同，用于检测多个分支使用相同 key
function isSameKey(
  a: AttributeNode | DirectiveNode | undefined,
  b: AttributeNode | DirectiveNode,
): boolean {
  if (!a || a.type !== b.type) {
    return false
  }
  if (a.type === NodeTypes.ATTRIBUTE) {
    if (a.value!.content !== (b as AttributeNode).value!.content) {
      return false
    }
  } else {
    // directive
    const exp = a.exp!
    const branchExp = (b as DirectiveNode).exp!
    if (exp.type !== branchExp.type) {
      return false
    }
    if (
      exp.type !== NodeTypes.SIMPLE_EXPRESSION ||
      exp.isStatic !== (branchExp as SimpleExpressionNode).isStatic ||
      exp.content !== (branchExp as SimpleExpressionNode).content
    ) {
      return false
    }
  }
  return true
}

// 找到 v-if 结构中嵌套条件表达式的“父条件表达式”，用于挂载 else/else-if
function getParentCondition(
  node: IfConditionalExpression | CacheExpression,
): IfConditionalExpression {
  while (true) {
    if (node.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
      if (node.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
        node = node.alternate
      } else {
        return node
      }
    } else if (node.type === NodeTypes.JS_CACHE_EXPRESSION) {
      node = node.value as IfConditionalExpression
    }
  }
}
