import {
  ConstantTypes,
  type NodeTransform,
  NodeTypes,
  type SimpleExpressionNode,
  type SourceLocation,
  createSimpleExpression,
} from '@vue/compiler-core'
import { parseStringStyle } from '@vue/shared'

// Parse inline CSS strings for static style attributes into an object.
// This is a NodeTransform since it works on the static `style` attribute and
// converts it into a dynamic equivalent:
// style="color: red" -> :style='{ "color": "red" }'
// It is then processed by `transformElement` and included in the generated
// props.

// 将元素上的内联 style 字符串属性转换成对应的 v-bind:style 表达式属性。
// 这样处理的主要动机是统一 style 处理方式，让静态 style 也走运行时绑定，从而利于后续的优化、patch 和 SSR。
export const transformStyle: NodeTransform = node => {
  if (node.type === NodeTypes.ELEMENT) {
    node.props.forEach((p, i) => {
      // 只处理静态的 style 属性，如：<div style="color: red; font-size: 14px;" />
      if (p.type === NodeTypes.ATTRIBUTE && p.name === 'style' && p.value) {
        // replace p with an expression node
        // 替换为 v-bind:style 形式
        node.props[i] = {
          type: NodeTypes.DIRECTIVE,
          name: `bind`,
          arg: createSimpleExpression(`style`, true, p.loc),
          exp: parseInlineCSS(p.value.content, p.loc),
          modifiers: [],
          loc: p.loc,
        }
        // 转换后的等价语法为：<div :style="{ color: 'red', fontSize: '14px' }" />
      }
    })
  }
}

// parseStringStyle 是 Vue 内部的 CSS 字符串解析函数，
// 将 style 字符串解析为对象：'color: red; font-size: 14px;' → { color: 'red', fontSize: '14px' }
const parseInlineCSS = (
  cssText: string,
  loc: SourceLocation,
): SimpleExpressionNode => {
  const normalized = parseStringStyle(cssText)
  return createSimpleExpression(
    JSON.stringify(normalized),
    false,
    loc,
    ConstantTypes.CAN_STRINGIFY,
  )
}
