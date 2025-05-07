import type { Node } from '@babel/types'
import { unwrapTSNode } from '@vue/compiler-dom'
import type { ScriptCompileContext } from './context'
import { isCallOf } from './utils'
import { DEFINE_PROPS } from './defineProps'
import { DEFINE_EMITS } from './defineEmits'
import { DEFINE_EXPOSE } from './defineExpose'
import { DEFINE_SLOTS } from './defineSlots'

export const DEFINE_OPTIONS = 'defineOptions'

// 是在编译阶段解析 defineOptions() 调用，并限制用户误用它声明 props、emits 等内容。
// 判断是否是 defineOptions() 宏调用
// 检查是否重复调用
// 禁止使用类型参数
// 提取运行时选项对象
// 检查是否误用了 props、emits、expose、slots 字段 —— 如果使用了，会报错提示正确的宏函数
export function processDefineOptions(
  ctx: ScriptCompileContext,
  node: Node,
): boolean {
  //  判断是否为 defineOptions() 调用
  if (!isCallOf(node, DEFINE_OPTIONS)) {
    return false
  }
  // 不允许重复调用
  if (ctx.hasDefineOptionsCall) {
    ctx.error(`duplicate ${DEFINE_OPTIONS}() call`, node)
  }
  // 不允许使用类型参数
  if (node.typeParameters) {
    ctx.error(`${DEFINE_OPTIONS}() cannot accept type arguments`, node)
  }
  if (!node.arguments[0]) return true

  // 提取第一个参数
  // 把第一个参数（配置对象）保存到上下文中，供后续代码生成使用
  // unwrapTSNode 是工具函数，用于跳过类型断言表达式（如 as const）
  ctx.hasDefineOptionsCall = true
  ctx.optionsRuntimeDecl = unwrapTSNode(node.arguments[0])

  let propsOption = undefined
  let emitsOption = undefined
  let exposeOption = undefined
  let slotsOption = undefined
  if (ctx.optionsRuntimeDecl.type === 'ObjectExpression') {
    // 遍历 defineOptions({ ... }) 中的字段，找到不允许出现的字段
    for (const prop of ctx.optionsRuntimeDecl.properties) {
      if (
        (prop.type === 'ObjectProperty' || prop.type === 'ObjectMethod') &&
        prop.key.type === 'Identifier'
      ) {
        switch (prop.key.name) {
          case 'props':
            propsOption = prop
            break

          case 'emits':
            emitsOption = prop
            break

          case 'expose':
            exposeOption = prop
            break

          case 'slots':
            slotsOption = prop
            break
        }
      }
    }
  }

  // 报错禁止使用不允许的字段
  if (propsOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare props. Use ${DEFINE_PROPS}() instead.`,
      propsOption,
    )
  }
  // 报错禁止使用不允许的字段
  if (emitsOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare emits. Use ${DEFINE_EMITS}() instead.`,
      emitsOption,
    )
  }
  // 报错禁止使用不允许的字段
  if (exposeOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare expose. Use ${DEFINE_EXPOSE}() instead.`,
      exposeOption,
    )
  }
  // 报错禁止使用不允许的字段
  if (slotsOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare slots. Use ${DEFINE_SLOTS}() instead.`,
      slotsOption,
    )
  }

  return true
}
