import type { Node } from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'

export const DEFINE_EXPOSE = 'defineExpose'

// 防止重复调用，并在编译上下文中打标记以触发后续处理逻辑。
export function processDefineExpose(
  // ctx：编译上下文 ScriptCompileContext，用于记录宏调用状态
  // node：当前遍历的 AST 节点
  ctx: ScriptCompileContext,
  node: Node,
): boolean {
  // isCallOf(node, DEFINE_EXPOSE) 是一个工具函数，用于判断当前节点是否是名为 defineExpose 的函数调用。
  if (isCallOf(node, DEFINE_EXPOSE)) {
    if (ctx.hasDefineExposeCall) {
      ctx.error(`duplicate ${DEFINE_EXPOSE}() call`, node)
    }
    // 记录状态并返回成功标记
    ctx.hasDefineExposeCall = true
    return true
  }
  return false
}
