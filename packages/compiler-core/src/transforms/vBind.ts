import type { DirectiveTransform, TransformContext } from '../transform'
import {
  type DirectiveNode,
  type ExpressionNode,
  NodeTypes,
  type SimpleExpressionNode,
  createObjectProperty,
  createSimpleExpression,
} from '../ast'
import { ErrorCodes, createCompilerError } from '../errors'
import { camelize } from '@vue/shared'
import { CAMELIZE } from '../runtimeHelpers'
import { processExpression } from './transformExpression'

// v-bind without arg is handled directly in ./transformElement.ts due to its affecting
// codegen for the entire props object. This transform here is only for v-bind
// *with* args.
// v-bind 无参数的情况（如 v-bind="obj"）在 transformElement.ts 中处理
// 这里仅处理带参数的 v-bind（如 :foo="bar" 或 :[key]="val"）
export const transformBind: DirectiveTransform = (dir, _node, context) => {
  const { modifiers, loc } = dir
  // 参数是绑定的属性名，如 "foo" 或动态表达式
  const arg = dir.arg!

  // 表达式部分，如 bar、val
  let { exp } = dir

  // handle empty expression
  // 处理空表达式的情况
  if (exp && exp.type === NodeTypes.SIMPLE_EXPRESSION && !exp.content.trim()) {
    if (!__BROWSER__) {
      // #10280 only error against empty expression in non-browser build
      // because :foo in in-DOM templates will be parsed into :foo="" by the
      // browser
      // 非浏览器编译环境下报错
      context.onError(
        createCompilerError(ErrorCodes.X_V_BIND_NO_EXPRESSION, loc),
      )
      return {
        // 返回空字符串作为默认值
        props: [
          createObjectProperty(arg, createSimpleExpression('', true, loc)),
        ],
      }
    } else {
      // 浏览器下视为未定义，浏览器会补 ""
      exp = undefined
    }
  }

  // same-name shorthand - :arg is expanded to :arg="arg"
  // 同名简写语法：如 :foo 被扩展为 :foo="foo"
  if (!exp) {
    if (arg.type !== NodeTypes.SIMPLE_EXPRESSION || !arg.isStatic) {
      // only simple expression is allowed for same-name shorthand
      // 同名简写只能用于静态属性名
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_BIND_INVALID_SAME_NAME_ARGUMENT,
          arg.loc,
        ),
      )
      return {
        props: [
          createObjectProperty(arg, createSimpleExpression('', true, loc)),
        ],
      }
    }

    // 转换为 :foo="foo"
    transformBindShorthand(dir, context)
    exp = dir.exp!
  }

  // 动态参数：加 fallback 值，避免属性名为空
  if (arg.type !== NodeTypes.SIMPLE_EXPRESSION) {
    arg.children.unshift(`(`)
    arg.children.push(`) || ""`)
  } else if (!arg.isStatic) {
    arg.content = `${arg.content} || ""`
  }

  // .sync is replaced by v-model:arg
  // camel 修饰符：将属性名驼峰化
  if (modifiers.some(mod => mod.content === 'camel')) {
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      if (arg.isStatic) {
        arg.content = camelize(arg.content)
      } else {
        arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`
      }
    } else {
      arg.children.unshift(`${context.helperString(CAMELIZE)}(`)
      arg.children.push(`)`)
    }
  }

  // SSR 环境下不加 . / ^ 前缀
  if (!context.inSSR) {
    if (modifiers.some(mod => mod.content === 'prop')) {
      injectPrefix(arg, '.') // .prop 修饰符 → .foo
    }
    if (modifiers.some(mod => mod.content === 'attr')) {
      injectPrefix(arg, '^') // .attr 修饰符 → ^foo
    }
  }

  return {
    props: [createObjectProperty(arg, exp)], // 返回构建好的绑定属性
  }
}

// 处理同名简写绑定
export const transformBindShorthand = (
  dir: DirectiveNode,
  context: TransformContext,
): void => {
  const arg = dir.arg!

  const propName = camelize((arg as SimpleExpressionNode).content)
  dir.exp = createSimpleExpression(propName, false, arg.loc) // 创建表达式 "foo"
  // 非浏览器下进行表达式作用域处理
  if (!__BROWSER__) {
    dir.exp = processExpression(dir.exp, context)
  }
}

// 根据修饰符为属性名加前缀
const injectPrefix = (arg: ExpressionNode, prefix: string) => {
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
    if (arg.isStatic) {
      // 静态：直接加前缀
      arg.content = prefix + arg.content
    } else {
      // 动态：转为模板字符串形式
      arg.content = `\`${prefix}\${${arg.content}}\``
    }
  } else {
    // 非简单表达式，改写 AST 子节点结构
    arg.children.unshift(`'${prefix}' + (`)
    arg.children.push(`)`)
  }
}
