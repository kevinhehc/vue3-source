import type { DirectiveTransform } from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'
import { V_SHOW } from '../runtimeHelpers'

// dir: 当前的 v-show 指令对象，包括表达式 exp 和源码位置 loc。
// node: 应用于该指令的元素 AST 节点。
// context: 编译上下文，用于报错和注册运行时辅助函数等。
export const transformShow: DirectiveTransform = (dir, node, context) => {
  // v-show 必须绑定一个表达式，如 <div v-show="isVisible">；
  // 如果没有绑定表达式，将触发编译错误；
  // 错误码为 X_V_SHOW_NO_EXPRESSION。
  const { exp, loc } = dir
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_SHOW_NO_EXPRESSION, loc),
    )
  }

  // v-show 不会在编译阶段生成任何 props 属性，而是完全依赖运行时逻辑；
  // needRuntime 字段指定需要引入运行时辅助函数 V_SHOW；
  // 编译器生成的渲染代码会在运行时使用 vShow() 函数控制元素的 display 样式；
  // 实现的是：如果表达式为 false，就设置 display: none；否则不干预。
  return {
    props: [],
    needRuntime: context.helper(V_SHOW),
  }
}
