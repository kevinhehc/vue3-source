import {
  type BlockStatement,
  type IfBranchNode,
  type IfNode,
  type NodeTransform,
  NodeTypes,
  createBlockStatement,
  createCallExpression,
  createIfStatement,
  createStructuralDirectiveTransform,
  processIf,
} from '@vue/compiler-dom'
import {
  type SSRTransformContext,
  processChildrenAsStatement,
} from '../ssrCodegenTransform'

// 将 v-if / v-else-if / v-else 转换为 SSR 中的 if / else if / else 语句，并渲染各条件分支对应的子节点内容。

// Plugin for the first transform pass, which simply constructs the AST node
// 是 transform 阶段，用于构建 AST
// 调用 Vue 的通用工具 createStructuralDirectiveTransform
// 对模板中所有 v-if、v-else-if、v-else 建立 AST 节点：
// 创建 IfNode
// 每个分支变成 IfBranchNode（包含 condition 和 children）
// 此阶段不涉及任何 SSR 特定逻辑。
export const ssrTransformIf: NodeTransform = createStructuralDirectiveTransform(
  /^(if|else|else-if)$/,
  processIf,
)

// This is called during the 2nd transform pass to construct the SSR-specific
// codegen nodes.
// 是 codegen 阶段，用于输出对应的 SSR 条件判断语句
export function ssrProcessIf(
  node: IfNode,
  context: SSRTransformContext,
  disableNestedFragments = false,
  disableComment = false,
): void {
  // 处理第一个分支（v-if）
  const [rootBranch] = node.branches
  const ifStatement = createIfStatement(
    rootBranch.condition!,
    processIfBranch(rootBranch, context, disableNestedFragments),
  )
  context.pushStatement(ifStatement)

  let currentIf = ifStatement
  // 循环处理后续分支
  for (let i = 1; i < node.branches.length; i++) {
    const branch = node.branches[i]
    const branchBlockStatement = processIfBranch(
      branch,
      context,
      disableNestedFragments,
    )
    if (branch.condition) {
      // else-if
      currentIf = currentIf.alternate = createIfStatement(
        branch.condition,
        branchBlockStatement,
      )
    } else {
      // else
      currentIf.alternate = branchBlockStatement
    }
  }

  // 空分支 fallback（如果没有 else）
  // 为了避免 hydration 报错，如果没有命中任何分支，就输出一个空注释：
  // 除非显式关闭 disableComment（如 <transition-group> 中会这样做）。
  if (!currentIf.alternate && !disableComment) {
    currentIf.alternate = createBlockStatement([
      createCallExpression(`_push`, ['`<!---->`']),
    ])
  }
}

// 用于处理每个分支的子节点：
// 若分支中有多个元素或非单个 <element>，会添加：
// <!--[--> ... <!--]-->  // fragment 注释
function processIfBranch(
  branch: IfBranchNode,
  context: SSRTransformContext,
  disableNestedFragments = false,
): BlockStatement {
  const { children } = branch
  const needFragmentWrapper =
    !disableNestedFragments &&
    (children.length !== 1 || children[0].type !== NodeTypes.ELEMENT) &&
    // optimize away nested fragments when the only child is a ForNode
    !(children.length === 1 && children[0].type === NodeTypes.FOR)
  return processChildrenAsStatement(branch, context, needFragmentWrapper)
}
