import {
  type DirectiveTransform,
  createObjectProperty,
  createSimpleExpression,
} from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

// 用于处理 v-html 指令的转换器 transformVHtml，它属于平台特定的 DirectiveTransform。
// 这个函数的主要职责是将模板中 <div v-html="rawHtml" /> 的指令，转换为设置 DOM 元素 innerHTML 属性的形式，并在编译时进行合法性检查。
// 将绑定的字符串作为 HTML 插入到元素中。它是对 textContent 的 HTML 等价物，但具有 XSS 风险，因此编译器会限制其使用方式。
export const transformVHtml: DirectiveTransform = (dir, node, context) => {
  // exp: v-html="rawHtml" 中的表达式节点；
  // loc: 源码位置信息，用于报错时指示源代码位置。
  const { exp, loc } = dir
  if (!exp) {
    // v-html 必须绑定一个表达式；
    // 否则会报错：v-html is missing expression。
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_NO_EXPRESSION, loc),
    )
  }
  // v-html 作用的元素不能有子节点；
  // 因为其会覆盖元素内部 HTML，所以编译器会报错并清空子节点；
  // 示例非法用法：
  if (node.children.length) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_WITH_CHILDREN, loc),
    )
    node.children.length = 0
  }
  return {
    // 生成一个 props，设置 DOM 元素的 innerHTML；
    // 如果没有表达式（虽然上面已报错），会 fallback 到空字符串表达式。
    props: [
      createObjectProperty(
        createSimpleExpression(`innerHTML`, true, loc),
        exp || createSimpleExpression('', true),
      ),
    ],
  }
}
