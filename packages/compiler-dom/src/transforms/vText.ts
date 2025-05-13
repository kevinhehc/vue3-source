import {
  type DirectiveTransform,
  TO_DISPLAY_STRING,
  createCallExpression,
  createObjectProperty,
  createSimpleExpression,
  getConstantType,
} from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

// dir: 当前的 v-text 指令节点对象，包含表达式 exp 等信息。
// node: 应用于该指令的元素节点（AST 节点）。
// context: 转换上下文，包含报错、helper 方法等编译器信息。
export const transformVText: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir
  // 检查 v-text 是否有绑定表达式
  // v-text 必须有表达式，如 <span v-text="msg">；
  // 没有表达式会报错：v-text is missing expression。
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_TEXT_NO_EXPRESSION, loc),
    )
  }
  // 检查是否使用了子节点（这在 v-text 中是无效的）
  // v-text 会替换元素的文本内容，因此元素 不能有子节点；
  // 编译器会发出警告，并清空 children 数组。
  if (node.children.length) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_TEXT_WITH_CHILDREN, loc),
    )
    node.children.length = 0
  }
  // v-text 的本质是设置 DOM 元素的 textContent 属性。
  return {
    props: [
      createObjectProperty(
        createSimpleExpression(`textContent`, true),
        // 如果表达式是 常量类型（字符串、数字等），可直接赋值；
        // 如果是复杂表达式，则使用 helper 函数 toDisplayString() 包装（相当于 String()）；
        // 如果表达式缺失，生成空字符串表达式。
        exp
          ? getConstantType(exp, context) > 0
            ? exp
            : createCallExpression(
                context.helperString(TO_DISPLAY_STRING),
                [exp],
                loc,
              )
          : createSimpleExpression('', true),
      ),
    ],
  }
}
