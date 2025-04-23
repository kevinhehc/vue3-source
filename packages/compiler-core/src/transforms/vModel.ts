import type { DirectiveTransform } from '../transform'
import {
  ConstantTypes,
  ElementTypes,
  type ExpressionNode,
  NodeTypes,
  type Property,
  createCompoundExpression,
  createObjectProperty,
  createSimpleExpression,
} from '../ast'
import { ErrorCodes, createCompilerError } from '../errors'
import {
  hasScopeRef,
  isMemberExpression,
  isSimpleIdentifier,
  isStaticExp,
} from '../utils'
import { IS_REF } from '../runtimeHelpers'
import { BindingTypes } from '../options'
import { camelize } from '@vue/shared'

// v-model 指令转换函数（应用于组件和原生元素的双向绑定）
export const transformModel: DirectiveTransform = (dir, node, context) => {
  const { exp, arg } = dir
  // 1. v-model 没有表达式：报错
  if (!exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_NO_EXPRESSION, dir.loc),
    )
    return createTransformProps()
  }

  // we assume v-model directives are always parsed
  // (not artificially created by a transform)
  // 原始表达式（字符串形式）
  const rawExp = exp.loc.source.trim()
  const expString =
    exp.type === NodeTypes.SIMPLE_EXPRESSION ? exp.content : rawExp

  // im SFC <script setup> inline mode, the exp may have been transformed into
  // _unref(exp)
  // 2. 获取当前表达式的绑定类型
  const bindingType = context.bindingMetadata[rawExp]

  // check props
  // 3. 禁止绑定到 props 上
  if (
    bindingType === BindingTypes.PROPS ||
    bindingType === BindingTypes.PROPS_ALIASED
  ) {
    context.onError(createCompilerError(ErrorCodes.X_V_MODEL_ON_PROPS, exp.loc))
    return createTransformProps()
  }

  // 4. 是否为可能的 ref（仅在 SFC 的 <script setup> 模式下）
  const maybeRef =
    !__BROWSER__ &&
    context.inline &&
    (bindingType === BindingTypes.SETUP_LET ||
      bindingType === BindingTypes.SETUP_REF ||
      bindingType === BindingTypes.SETUP_MAYBE_REF)

  // 5. 表达式不合法：必须是成员表达式或 ref
  if (!expString.trim() || (!isMemberExpression(exp, context) && !maybeRef)) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_MALFORMED_EXPRESSION, exp.loc),
    )
    return createTransformProps()
  }

  // 6. 不允许绑定作用域变量
  if (
    !__BROWSER__ &&
    context.prefixIdentifiers &&
    isSimpleIdentifier(expString) &&
    context.identifiers[expString]
  ) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_ON_SCOPE_VARIABLE, exp.loc),
    )
    return createTransformProps()
  }

  // 7. 确定绑定的属性名（默认是 modelValue）
  const propName = arg ? arg : createSimpleExpression('modelValue', true)
  const eventName = arg
    ? isStaticExp(arg)
      ? `onUpdate:${camelize(arg.content)}`
      : createCompoundExpression(['"onUpdate:" + ', arg])
    : `onUpdate:modelValue`

  // 8. 构建事件处理函数表达式（赋值表达式）
  let assignmentExp: ExpressionNode
  const eventArg = context.isTS ? `($event: any)` : `$event`
  if (maybeRef) {
    if (bindingType === BindingTypes.SETUP_REF) {
      // v-model used on known ref.
      // v-model 绑定到 ref：直接设置 .value
      assignmentExp = createCompoundExpression([
        `${eventArg} => ((`,
        createSimpleExpression(rawExp, false, exp.loc),
        `).value = $event)`,
      ])
    } else {
      // v-model used on a potentially ref binding in <script setup> inline mode.
      // the assignment needs to check whether the binding is actually a ref.
      // 可能是 ref：运行时判断
      const altAssignment =
        bindingType === BindingTypes.SETUP_LET ? `${rawExp} = $event` : `null`
      assignmentExp = createCompoundExpression([
        `${eventArg} => (${context.helperString(IS_REF)}(${rawExp}) ? (`,
        createSimpleExpression(rawExp, false, exp.loc),
        `).value = $event : ${altAssignment})`,
      ])
    }
  } else {
    // 普通表达式：直接赋值
    assignmentExp = createCompoundExpression([
      `${eventArg} => ((`,
      exp,
      `) = $event)`,
    ])
  }

  // 9. 构建最终 props：双向绑定 = value + update handler
  const props = [
    // modelValue: foo
    createObjectProperty(propName, dir.exp!),
    // "onUpdate:modelValue": $event => (foo = $event)
    createObjectProperty(eventName, assignmentExp),
  ]

  // cache v-model handler if applicable (when it doesn't refer any scope vars)
  // 10. 对事件处理函数进行缓存（仅当不依赖作用域变量时）
  if (
    !__BROWSER__ &&
    context.prefixIdentifiers &&
    !context.inVOnce &&
    context.cacheHandlers &&
    !hasScopeRef(exp, context.identifiers)
  ) {
    props[1].value = context.cache(props[1].value)
  }

  // modelModifiers: { foo: true, "bar-baz": true }
  // 11. 处理修饰符（仅组件有效）
  if (dir.modifiers.length && node.tagType === ElementTypes.COMPONENT) {
    const modifiers = dir.modifiers
      .map(m => m.content)
      .map(m => (isSimpleIdentifier(m) ? m : JSON.stringify(m)) + `: true`)
      .join(`, `)
    const modifiersKey = arg
      ? isStaticExp(arg)
        ? `${arg.content}Modifiers`
        : createCompoundExpression([arg, ' + "Modifiers"'])
      : `modelModifiers`
    props.push(
      createObjectProperty(
        modifiersKey,
        createSimpleExpression(
          `{ ${modifiers} }`,
          false,
          dir.loc,
          ConstantTypes.CAN_CACHE,
        ),
      ),
    )
  }

  // 工具函数：包装 props 数组返回
  return createTransformProps(props)
}

function createTransformProps(props: Property[] = []) {
  return { props }
}
