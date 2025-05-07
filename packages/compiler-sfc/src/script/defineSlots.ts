import type { LVal, Node } from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'

export const DEFINE_SLOTS = 'defineSlots'

// 这个函数处理 Vue <script setup> 中对 defineSlots() 的调用。
// 它的目标是把 defineSlots() 变成运行时调用 useSlots()，以支持类型推导并正确访问 slots。
export function processDefineSlots(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  // 第一步判断传入的 AST 节点是否是 defineSlots() 的调用：
  // 如果不是，返回 false，表示当前节点不是我们要处理的内容。
  if (!isCallOf(node, DEFINE_SLOTS)) {
    return false
  }
  // 如果已经处理过一次 defineSlots()，则报错，因为该函数只能调用一次（每个组件只应定义一次 slots）。
  if (ctx.hasDefineSlotsCall) {
    ctx.error(`duplicate ${DEFINE_SLOTS}() call`, node)
  }
  ctx.hasDefineSlotsCall = true

  // 检查调用是否传入了参数：
  // defineSlots() 不允许有参数，如果有，报错。
  if (node.arguments.length > 0) {
    ctx.error(`${DEFINE_SLOTS}() cannot accept arguments`, node)
  }

  // 如果 defineSlots() 是赋值给某个变量的（即 const slots = defineSlots()），那么：
  // 用 MagicString.overwrite() 把原始调用替换为 useSlots()，例如：
  // 原代码：const slots = defineSlots()
  // 替换后：const slots = useSlots()
  // 返回 true，表示该节点已被成功处理。
  if (declId) {
    ctx.s.overwrite(
      ctx.startOffset! + node.start!,
      ctx.startOffset! + node.end!,
      `${ctx.helper('useSlots')}()`,
    )
  }

  return true
}
