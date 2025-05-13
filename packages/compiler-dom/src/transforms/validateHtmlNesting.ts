import {
  type CompilerError,
  ElementTypes,
  type NodeTransform,
  NodeTypes,
} from '@vue/compiler-core'
import { isValidHTMLNesting } from '../htmlNesting'

// 用于在编译阶段验证 HTML 标签的嵌套是否合法。它结合你之前提供的 isValidHTMLNesting 函数，在 AST（抽象语法树）构建过程中对节点进行结构检查。
// 这是一个 NodeTransform 函数，用于在遍历 AST 节点时执行逻辑。
// node: 当前 AST 节点。
// context: 转换上下文，包含父节点等环境信息。
export const validateHtmlNesting: NodeTransform = (node, context) => {
  // 这段条件确保只处理以下情况：
  // 当前节点和父节点都是普通 HTML 元素节点（排除组件、插槽、模板指令等）。
  // 利用 isValidHTMLNesting 检查当前节点是否可以作为父节点的子节点。
  if (
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.ELEMENT &&
    context.parent &&
    context.parent.type === NodeTypes.ELEMENT &&
    context.parent.tagType === ElementTypes.ELEMENT &&
    !isValidHTMLNesting(context.parent.tag, node.tag)
  ) {
    // 构造一个 SyntaxError，并强制断言为 CompilerError。
    // 报错信息明确指出 HTML 嵌套非法，并说明其潜在影响（如 hydration 错误、未来功能破坏）。
    const error = new SyntaxError(
      `<${node.tag}> cannot be child of <${context.parent.tag}>, ` +
        'according to HTML specifications. ' +
        'This can cause hydration errors or ' +
        'potentially disrupt future functionality.',
    ) as CompilerError
    // 错误对象附加了源代码位置（node.loc），方便调试和定位问题。
    // 通过编译器上下文的 onWarn 方法发出警告，而不是抛出异常（保持编译不中断）。
    error.loc = node.loc
    context.onWarn(error)
  }
}
