import type { DirectiveTransform, DirectiveTransformResult } from '../transform'
import {
  type DirectiveNode,
  ElementTypes,
  type ExpressionNode,
  NodeTypes,
  type SimpleExpressionNode,
  createCompoundExpression,
  createObjectProperty,
  createSimpleExpression,
} from '../ast'
import { camelize, toHandlerKey } from '@vue/shared'
import { ErrorCodes, createCompilerError } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { hasScopeRef, isFnExpression, isMemberExpression } from '../utils'
import { TO_HANDLER_KEY } from '../runtimeHelpers'

export interface VOnDirectiveNode extends DirectiveNode {
  // v-on without arg is handled directly in ./transformElement.ts due to its affecting
  // codegen for the entire props object. This transform here is only for v-on
  // *with* args.
  arg: ExpressionNode
  // exp is guaranteed to be a simple expression here because v-on w/ arg is
  // skipped by transformExpression as a special case.
  exp: SimpleExpressionNode | undefined
}

// 处理 v-on 的转换器（仅处理带参数的 v-on）
export const transformOn: DirectiveTransform = (
  dir,
  node,
  context,
  augmentor,
) => {
  const { loc, modifiers, arg } = dir as VOnDirectiveNode

  // 1. v-on 无表达式也无修饰符时，报错
  if (!dir.exp && !modifiers.length) {
    context.onError(createCompilerError(ErrorCodes.X_V_ON_NO_EXPRESSION, loc))
  }

  // 2. 处理事件名（如 @click -> onClick）
  let eventName: ExpressionNode
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
    if (arg.isStatic) {
      let rawName = arg.content
      // 禁止直接使用 vnode 钩子
      if (__DEV__ && rawName.startsWith('vnode')) {
        context.onError(createCompilerError(ErrorCodes.X_VNODE_HOOKS, arg.loc))
      }
      if (rawName.startsWith('vue:')) {
        rawName = `vnode-${rawName.slice(4)}`
      }
      const eventString =
        node.tagType !== ElementTypes.ELEMENT ||
        rawName.startsWith('vnode') ||
        !/[A-Z]/.test(rawName)
          ? // for non-element and vnode lifecycle event listeners, auto convert
            // it to camelCase. See issue #2249
            toHandlerKey(camelize(rawName)) // 转为 onClick 等
          : // preserve case for plain element listeners that have uppercase
            // letters, as these may be custom elements' custom events
            `on:${rawName}` // 保留大小写
      eventName = createSimpleExpression(eventString, true, arg.loc)
    } else {
      // #2388
      // 动态事件名：@["my-event"]
      eventName = createCompoundExpression([
        `${context.helperString(TO_HANDLER_KEY)}(`,
        arg,
        `)`,
      ])
    }
  } else {
    // already a compound expression.
    // 复杂表达式：已是复合表达式
    eventName = arg
    eventName.children.unshift(`${context.helperString(TO_HANDLER_KEY)}(`)
    eventName.children.push(`)`)
  }

  // handler processing
  // 3. 处理表达式（事件处理函数）
  let exp: ExpressionNode | undefined = dir.exp as
    | SimpleExpressionNode
    | undefined
  if (exp && !exp.content.trim()) {
    exp = undefined
  }
  let shouldCache: boolean = context.cacheHandlers && !exp && !context.inVOnce
  if (exp) {
    const isMemberExp = isMemberExpression(exp, context)
    const isInlineStatement = !(isMemberExp || isFnExpression(exp, context))
    const hasMultipleStatements = exp.content.includes(`;`)

    // process the expression since it's been skipped
    // 非浏览器构建环境，开启标识符前缀时要处理作用域标识符
    if (!__BROWSER__ && context.prefixIdentifiers) {
      isInlineStatement && context.addIdentifiers(`$event`)
      exp = dir.exp = processExpression(
        exp,
        context,
        false,
        hasMultipleStatements,
      )
      isInlineStatement && context.removeIdentifiers(`$event`)
      // with scope analysis, the function is hoistable if it has no reference
      // to scope variables.
      // 决定是否缓存
      shouldCache =
        context.cacheHandlers &&
        // unnecessary to cache inside v-once
        !context.inVOnce &&
        // runtime constants don't need to be cached
        // (this is analyzed by compileScript in SFC <script setup>)
        !(exp.type === NodeTypes.SIMPLE_EXPRESSION && exp.constType > 0) &&
        // #1541 bail if this is a member exp handler passed to a component -
        // we need to use the original function to preserve arity,
        // e.g. <transition> relies on checking cb.length to determine
        // transition end handling. Inline function is ok since its arity
        // is preserved even when cached.
        !(isMemberExp && node.tagType === ElementTypes.COMPONENT) &&
        // bail if the function references closure variables (v-for, v-slot)
        // it must be passed fresh to avoid stale values.
        !hasScopeRef(exp, context.identifiers)
      // If the expression is optimizable and is a member expression pointing
      // to a function, turn it into invocation (and wrap in an arrow function
      // below) so that it always accesses the latest value when called - thus
      // avoiding the need to be patched.
      // 如果可缓存且是成员表达式，则转为调用表达式
      if (shouldCache && isMemberExp) {
        if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          exp.content = `${exp.content} && ${exp.content}(...args)`
        } else {
          exp.children = [...exp.children, ` && `, ...exp.children, `(...args)`]
        }
      }
    }

    // 浏览器开发模式下校验表达式合法性
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        exp as SimpleExpressionNode,
        context,
        false,
        hasMultipleStatements,
      )
    }

    // 如果是内联语句或需要缓存的成员表达式，将其包装为箭头函数
    if (isInlineStatement || (shouldCache && isMemberExp)) {
      // wrap inline statement in a function expression
      exp = createCompoundExpression([
        `${
          isInlineStatement
            ? !__BROWSER__ && context.isTS
              ? `($event: any)`
              : `$event`
            : `${
                !__BROWSER__ && context.isTS ? `\n//@ts-ignore\n` : ``
              }(...args)`
        } => ${hasMultipleStatements ? `{` : `(`}`,
        exp,
        hasMultipleStatements ? `}` : `)`,
      ])
    }
  }

  // 4. 构建最终返回值
  let ret: DirectiveTransformResult = {
    props: [
      createObjectProperty(
        eventName,
        exp || createSimpleExpression(`() => {}`, false, loc),
      ),
    ],
  }

  // apply extended compiler augmentor
  // 应用额外的增强器（如 transition 处理等）
  if (augmentor) {
    ret = augmentor(ret)
  }

  // 缓存处理函数（适用于组件防止重复渲染）
  if (shouldCache) {
    // cache handlers so that it's always the same handler being passed down.
    // this avoids unnecessary re-renders when users use inline handlers on
    // components.
    ret.props[0].value = context.cache(ret.props[0].value)
  }

  // mark the key as handler for props normalization check
  // 标记这是 handler，用于后续 props 合并/检查
  ret.props.forEach(p => (p.key.isHandlerKey = true))
  return ret
}
