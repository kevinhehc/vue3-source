import {
  DOMErrorCodes,
  type DirectiveTransform,
  createConditionalExpression,
  createDOMCompilerError,
  createObjectExpression,
  createObjectProperty,
  createSimpleExpression,
} from '@vue/compiler-dom'

// 在服务端根据表达式的真假，决定是否为元素加上 style="display:none"，从而控制显示/隐藏状态。
export const ssrTransformShow: DirectiveTransform = (dir, node, context) => {
  if (!dir.exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_SHOW_NO_EXPRESSION),
    )
  }
  // 如果 expr 为真，服务端不会加上 style（展示元素）
  // 如果为假，SSR 会输出：style="display:none"
  return {
    props: [
      createObjectProperty(
        `style`,
        createConditionalExpression(
          dir.exp!,
          createSimpleExpression(`null`, false),
          createObjectExpression([
            createObjectProperty(
              `display`,
              createSimpleExpression(`none`, true),
            ),
          ]),
          false /* no newline */,
        ),
      ),
    ],
  }
}
