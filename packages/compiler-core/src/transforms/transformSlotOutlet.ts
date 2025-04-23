import type { NodeTransform, TransformContext } from '../transform'
import {
  type CallExpression,
  type ExpressionNode,
  NodeTypes,
  type SlotOutletNode,
  createCallExpression,
  createFunctionExpression,
  createSimpleExpression,
} from '../ast'
import { isSlotOutlet, isStaticArgOf, isStaticExp } from '../utils'
import { type PropsExpression, buildProps } from './transformElement'
import { ErrorCodes, createCompilerError } from '../errors'
import { RENDER_SLOT } from '../runtimeHelpers'
import { camelize } from '@vue/shared'
import { processExpression } from './transformExpression'

// 插槽出口节点转换器：用于处理 <slot> 元素
export const transformSlotOutlet: NodeTransform = (node, context) => {
  if (isSlotOutlet(node)) {
    const { children, loc } = node
    // 提取插槽名称与绑定的 props（如 <slot name="foo" :user="user" />）
    const { slotName, slotProps } = processSlotOutlet(node, context)

    // 构造 renderSlot 的调用参数（即：renderSlot($slots, 'name', props, fallback, true)）
    const slotArgs: CallExpression['arguments'] = [
      context.prefixIdentifiers ? `_ctx.$slots` : `$slots`, // 第一个参数是插槽集合
      slotName, // 插槽名（默认为 "default"）
      '{}', // 插槽 props（默认空对象）
      'undefined', // fallback children（默认无 fallback）
      'true', // 最后参数标记为显式插槽
    ]
    // 最少有两个参数：$slots 和 插槽名
    let expectedLen = 2

    // 如果有 props，作为第三个参数
    if (slotProps) {
      slotArgs[2] = slotProps
      expectedLen = 3
    }

    // 如果有默认插槽内容（<slot>xx</slot>），作为 fallback slot
    if (children.length) {
      slotArgs[3] = createFunctionExpression([], children, false, false, loc)
      expectedLen = 4
    }

    // 如果启用了 scopeId，但不是 slotted 模式，需要传第五个参数
    if (context.scopeId && !context.slotted) {
      expectedLen = 5
    }
    // 多余参数移除（比如 props 或 fallback 没有就剪掉）
    slotArgs.splice(expectedLen) // remove unused arguments

    // 构造最终 codegen 节点 renderSlot(...)
    node.codegenNode = createCallExpression(
      context.helper(RENDER_SLOT),
      slotArgs,
      loc,
    )
  }
}

interface SlotOutletProcessResult {
  slotName: string | ExpressionNode
  slotProps: PropsExpression | undefined
}

// 返回处理后的插槽名称与属性表达式
export function processSlotOutlet(
  node: SlotOutletNode,
  context: TransformContext,
): SlotOutletProcessResult {
  // 默认插槽名
  let slotName: string | ExpressionNode = `"default"`
  let slotProps: PropsExpression | undefined = undefined

  // 除了 name 以外的其他属性
  const nonNameProps = []
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      // 静态属性（如 name="foo"）
      if (p.value) {
        if (p.name === 'name') {
          slotName = JSON.stringify(p.value.content) // 转为 "foo"
        } else {
          // 非 name 的其他属性，转为 camelCase 后处理
          p.name = camelize(p.name)
          nonNameProps.push(p)
        }
      }
    } else {
      // 动态绑定（v-bind）
      if (p.name === 'bind' && isStaticArgOf(p.arg, 'name')) {
        // v-bind:name="xxx"
        if (p.exp) {
          slotName = p.exp
        } else if (p.arg && p.arg.type === NodeTypes.SIMPLE_EXPRESSION) {
          const name = camelize(p.arg.content)
          slotName = p.exp = createSimpleExpression(name, false, p.arg.loc)
          if (!__BROWSER__) {
            // 在服务端或编译环境中进一步处理为带作用域前缀的表达式
            slotName = p.exp = processExpression(p.exp, context)
          }
        }
      } else {
        // 处理其他非 name 的动态绑定
        if (p.name === 'bind' && p.arg && isStaticExp(p.arg)) {
          p.arg.content = camelize(p.arg.content)
        }
        nonNameProps.push(p)
      }
    }
  }

  // 如果有非 name 属性，构建 props 表达式（即 { foo: bar, ... }）
  if (nonNameProps.length > 0) {
    const { props, directives } = buildProps(
      node,
      context,
      nonNameProps,
      false, // 不使用 v-model
      false, // 不使用 SSR
    )
    slotProps = props

    // 不允许 <slot> 上使用指令，报错
    if (directives.length) {
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET,
          directives[0].loc,
        ),
      )
    }
  }

  return {
    slotName,
    slotProps,
  }
}
