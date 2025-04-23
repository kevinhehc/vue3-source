// - Parse expressions in templates into compound expressions so that each
//   identifier gets more accurate source-map locations.
//
// - Prefix identifiers with `_ctx.` or `$xxx` (for known binding types) so that
//   they are accessed from the right source
//
// - This transform is only applied in non-browser builds because it relies on
//   an additional JavaScript parser. In the browser, there is no source-map
//   support and the code is wrapped in `with (this) { ... }`.
import type { NodeTransform, TransformContext } from '../transform'
import {
  type CompoundExpressionNode,
  ConstantTypes,
  type ExpressionNode,
  NodeTypes,
  type SimpleExpressionNode,
  createCompoundExpression,
  createSimpleExpression,
} from '../ast'
import {
  isInDestructureAssignment,
  isInNewExpression,
  isStaticProperty,
  isStaticPropertyKey,
  walkIdentifiers,
} from '../babelUtils'
import { advancePositionWithClone, findDir, isSimpleIdentifier } from '../utils'
import {
  genPropsAccessExp,
  hasOwn,
  isGloballyAllowed,
  isString,
  makeMap,
} from '@vue/shared'
import { ErrorCodes, createCompilerError } from '../errors'
import type {
  AssignmentExpression,
  Identifier,
  Node,
  UpdateExpression,
} from '@babel/types'
import { validateBrowserExpression } from '../validateExpression'
import { parseExpression } from '@babel/parser'
import { IS_REF, UNREF } from '../runtimeHelpers'
import { BindingTypes } from '../options'

// 创建一个白名单 map，用于识别 JS 中的字面量关键词（true、false、null、this）
const isLiteralWhitelisted = /*@__PURE__*/ makeMap('true,false,null,this')

// 表达式转换的主函数（NodeTransform 是一个 AST 转换器类型）
// 它会处理模板中的 {{ 表达式 }} 以及指令中的表达式，比如 v-if="a > b"
export const transformExpression: NodeTransform = (node, context) => {
  // 如果节点是插值表达式（例如 {{ msg }}）
  if (node.type === NodeTypes.INTERPOLATION) {
    // 将插值表达式内部内容处理为 JS 表达式
    node.content = processExpression(
      node.content as SimpleExpressionNode,
      context,
    )
  } else if (node.type === NodeTypes.ELEMENT) {
    // 如果节点是元素节点，接下来处理元素上的所有指令表达式

    // handle directives on element
    // 先检查有没有 v-memo 指令，这会在处理 v-for 中使用
    const memo = findDir(node, 'memo')

    // 遍历元素所有属性（可能是绑定、指令、事件等）
    for (let i = 0; i < node.props.length; i++) {
      const dir = node.props[i]
      // do not process for v-on & v-for since they are special handled

      // 只处理指令，跳过 v-for（因为 v-for 在 transformFor 中专门处理）
      if (dir.type === NodeTypes.DIRECTIVE && dir.name !== 'for') {
        const exp = dir.exp
        const arg = dir.arg
        // do not process exp if this is v-on:arg - we need special handling
        // for wrapping inline statements.
        // 对于 v-on:arg 不处理，因为 inline statement 需要特别处理包装
        // 并且，如果是 v-memo 与 v-for 结合时的 key 属性，也不处理
        if (
          exp &&
          exp.type === NodeTypes.SIMPLE_EXPRESSION &&
          !(dir.name === 'on' && arg) &&
          // key has been processed in transformFor(vMemo + vFor)
          !(
            memo &&
            arg &&
            arg.type === NodeTypes.SIMPLE_EXPRESSION &&
            arg.content === 'key'
          )
        ) {
          // 转换表达式，如 v-if="a > b" 中的 "a > b"
          dir.exp = processExpression(
            exp,
            context,
            // slot args must be processed as function params
            // 如果是 v-slot，则表达式需要按函数参数处理（用于作用域插槽）
            dir.name === 'slot',
          )
        }
        // 如果参数存在且是非静态的（例如 v-bind:[dynamicKey]）
        if (arg && arg.type === NodeTypes.SIMPLE_EXPRESSION && !arg.isStatic) {
          // 也要处理动态参数表达式
          dir.arg = processExpression(arg, context)
        }
      }
    }
  }
}

interface PrefixMeta {
  prefix?: string // 可选的前缀信息（用于作用域前缀）
  isConstant: boolean // 是否是常量绑定（如 const 声明）
  start: number // 表达式在原始模板中的起始位置
  end: number // 表达式在原始模板中的结束位置
  scopeIds?: Set<string> // 可选：作用域 id 集合（用于 scoped CSS）
}

// Important: since this function uses Node.js only dependencies, it should
// always be used with a leading !__BROWSER__ check so that it can be
// tree-shaken from the browser build.
// ⚠️ 重要：由于此函数依赖 Node.js 模块，需加 `!__BROWSER__` 条件来避免被打包到浏览器端
export function processExpression(
  node: SimpleExpressionNode, // 要处理的表达式节点
  context: TransformContext, // 转换上下文（包含绑定信息等）
  // some expressions like v-slot props & v-for aliases should be parsed as
  // function params
  asParams = false, // 是否按函数参数解析（如 v-slot、v-for）
  // v-on handler values may contain multiple statements
  asRawStatements = false, // 是否为原始语句（如 v-on 多语句处理）
  localVars: Record<string, number> = Object.create(context.identifiers), // 本地变量集合
): ExpressionNode {
  if (__BROWSER__) {
    if (__DEV__) {
      // simple in-browser validation (same logic in 2.x)
      // 浏览器环境下的检查（仅开发环境有效）
      validateBrowserExpression(node, context, asParams, asRawStatements)
    }
    return node // 浏览器端直接返回原节点
  }

  // 不开启前缀模式，或表达式为空，直接返回原节点
  if (!context.prefixIdentifiers || !node.content.trim()) {
    return node
  }

  const { inline, bindingMetadata } = context
  // 定义如何重写每个标识符的函数
  const rewriteIdentifier = (
    raw: string, // 原始标识符
    parent?: Node | null, // 上层父节点
    id?: Identifier, // 当前标识符节点
  ) => {
    // 获取绑定类型
    const type = hasOwn(bindingMetadata, raw) && bindingMetadata[raw]
    if (inline) {
      // 当前编译模式为 inline（即不使用作用域对象，如 _ctx）

      // x = y
      // 判断是否是赋值左值，如 `x = y` 中的 x
      const isAssignmentLVal =
        parent && parent.type === 'AssignmentExpression' && parent.left === id
      // x++
      // 是否是更新操作，如 x++、--x
      const isUpdateArg =
        parent && parent.type === 'UpdateExpression' && parent.argument === id
      // ({ x } = y)
      // 是否是解构赋值中的变量，如 `{ x } = y`
      const isDestructureAssignment =
        parent && isInDestructureAssignment(parent, parentStack)
      const isNewExpression = parent && isInNewExpression(parentStack)
      // 包装为 unref 调用
      const wrapWithUnref = (raw: string) => {
        const wrapped = `${context.helperString(UNREF)}(${raw})`
        return isNewExpression ? `(${wrapped})` : wrapped
      }

      if (
        isConst(type) ||
        type === BindingTypes.SETUP_REACTIVE_CONST ||
        localVars[raw]
      ) {
        // 常量或本地变量不加前缀
        return raw
      } else if (type === BindingTypes.SETUP_REF) {
        // ref 类型要访问其 .value
        return `${raw}.value`
      } else if (type === BindingTypes.SETUP_MAYBE_REF) {
        // const binding that may or may not be ref
        // if it's not a ref, then assignments don't make sense -
        // so we ignore the non-ref assignment case and generate code
        // that assumes the value to be a ref for more efficiency
        // 如果可能是 ref（setup 中推断不确定），根据使用场景判断是否加 .value
        return isAssignmentLVal || isUpdateArg || isDestructureAssignment
          ? `${raw}.value`
          : wrapWithUnref(raw)
      } else if (type === BindingTypes.SETUP_LET) {
        if (isAssignmentLVal) {
          // let binding.
          // this is a bit more tricky as we need to cover the case where
          // let is a local non-ref value, and we need to replicate the
          // right hand side value.
          // x = y --> isRef(x) ? x.value = y : x = y
          // 如果是 let 声明 + 赋值，需要生成兼容 ref 的判断代码
          const { right: rVal, operator } = parent as AssignmentExpression
          const rExp = rawExp.slice(rVal.start! - 1, rVal.end! - 1)
          const rExpString = stringifyExpression(
            processExpression(
              createSimpleExpression(rExp, false),
              context,
              false,
              false,
              knownIds,
            ),
          )
          return `${context.helperString(IS_REF)}(${raw})${
            context.isTS ? ` //@ts-ignore\n` : ``
          } ? ${raw}.value ${operator} ${rExpString} : ${raw}`
        } else if (isUpdateArg) {
          // let 变量递增或递减处理
          // make id replace parent in the code range so the raw update operator
          // is removed
          id!.start = parent!.start
          id!.end = parent!.end
          const { prefix: isPrefix, operator } = parent as UpdateExpression
          const prefix = isPrefix ? operator : ``
          const postfix = isPrefix ? `` : operator
          // let binding.
          // x++ --> isRef(a) ? a.value++ : a++
          return `${context.helperString(IS_REF)}(${raw})${
            context.isTS ? ` //@ts-ignore\n` : ``
          } ? ${prefix}${raw}.value${postfix} : ${prefix}${raw}${postfix}`
        } else if (isDestructureAssignment) {
          // TODO
          // let binding in a destructure assignment - it's very tricky to
          // handle both possible cases here without altering the original
          // structure of the code, so we just assume it's not a ref here
          // for now
          // 解构赋值暂不处理，假设非 ref
          return raw
        } else {
          return wrapWithUnref(raw)
        }
      } else if (type === BindingTypes.PROPS) {
        // setup 中的 props，用 __props 引用，带类型提示支持
        // use __props which is generated by compileScript so in ts mode
        // it gets correct type
        return genPropsAccessExp(raw)
      } else if (type === BindingTypes.PROPS_ALIASED) {
        // prop with a different local alias (from defineProps() destructure)
        return genPropsAccessExp(bindingMetadata.__propsAliases![raw])
      }
    } else {
      // 非 inline 模式（使用作用域对象，如 $setup、$props 等）
      if (
        (type && type.startsWith('setup')) ||
        type === BindingTypes.LITERAL_CONST
      ) {
        // setup bindings in non-inline mode
        return `$setup.${raw}`
      } else if (type === BindingTypes.PROPS_ALIASED) {
        return `$props['${bindingMetadata.__propsAliases![raw]}']`
      } else if (type) {
        return `$${type}.${raw}`
      }
    }

    // fallback to ctx
    // fallback：兜底加 _ctx 前缀
    return `_ctx.${raw}`
  }

  // fast path if expression is a simple identifier.
  // 快速路径：如果是简单标识符（如 `msg`）
  const rawExp = node.content

  let ast = node.ast

  if (ast === false) {
    // ast being false means it has caused an error already during parse phase
    // ast 为 false 表示在前一阶段已经抛出错误，直接返回
    return node
  }

  if (ast === null || (!ast && isSimpleIdentifier(rawExp))) {
    // 如果没有解析 AST，且是简单标识符（如 msg），直接尝试处理

    // 是否是作用域变量
    const isScopeVarReference = context.identifiers[rawExp]
    // 是否是全局变量
    const isAllowedGlobal = isGloballyAllowed(rawExp)
    // 是否是字面量
    const isLiteral = isLiteralWhitelisted(rawExp)
    if (
      !asParams &&
      !isScopeVarReference &&
      !isLiteral &&
      (!isAllowedGlobal || bindingMetadata[rawExp])
    ) {
      // 如果不是参数、不是作用域变量、不是字面量，也不是全局变量或全局中有绑定信息

      // const bindings exposed from setup can be skipped for patching but
      // cannot be hoisted to module scope
      if (isConst(bindingMetadata[rawExp])) {
        // 是 const 常量，可跳过 patch
        node.constType = ConstantTypes.CAN_SKIP_PATCH
      }
      // 替换标识符为加前缀的形式（如 _ctx.msg）
      node.content = rewriteIdentifier(rawExp)
    } else if (!isScopeVarReference) {
      // 非作用域变量
      if (isLiteral) {
        // 可字符串化常量
        node.constType = ConstantTypes.CAN_STRINGIFY
      } else {
        // 可缓存表达式
        node.constType = ConstantTypes.CAN_CACHE
      }
    }
    return node
  }

  if (!ast) {
    // 若没有 AST，需要先解析表达式

    // exp needs to be parsed differently:
    // 1. Multiple inline statements (v-on, with presence of `;`): parse as raw
    //    exp, but make sure to pad with spaces for consistent ranges
    // 2. Expressions: wrap with parens (for e.g. object expressions)
    // 3. Function arguments (v-for, v-slot): place in a function argument position
    // 根据上下文决定是否加包裹（函数参数 / 表达式 / 多语句处理）
    const source = asRawStatements
      ? ` ${rawExp} `
      : `(${rawExp})${asParams ? `=>{}` : ``}`
    try {
      // 调用 babel 解析器解析表达式为 AST
      ast = parseExpression(source, {
        sourceType: 'module',
        plugins: context.expressionPlugins,
      })
    } catch (e: any) {
      // 解析失败报错
      context.onError(
        createCompilerError(
          ErrorCodes.X_INVALID_EXPRESSION,
          node.loc,
          undefined,
          e.message,
        ),
      )
      return node
    }
  }

  type QualifiedId = Identifier & PrefixMeta
  // 存储需要加前缀的变量
  const ids: QualifiedId[] = []
  // 父节点栈，用于定位作用
  const parentStack: Node[] = []
  // 作用域变量集合
  const knownIds: Record<string, number> = Object.create(context.identifiers)

  // 遍历 AST 中的每个标识符
  walkIdentifiers(
    ast,
    (node, parent, _, isReferenced, isLocal) => {
      if (isStaticPropertyKey(node, parent!)) {
        // 跳过静态 key
        return
      }
      // v2 wrapped filter call
      if (__COMPAT__ && node.name.startsWith('_filter_')) {
        // v2 filter 兼容跳过
        return
      }

      const needPrefix = isReferenced && canPrefix(node)
      if (needPrefix && !isLocal) {
        if (isStaticProperty(parent!) && parent.shorthand) {
          // property shorthand like { foo }, we need to add the key since
          // we rewrite the value
          // 如 { foo } 简写形式，prefix 加前缀修正：`foo: `
          ;(node as QualifiedId).prefix = `${node.name}: `
        }
        // 重写标识符名（加上 _ctx 或 $setup 等前缀）
        node.name = rewriteIdentifier(node.name, parent, node)
        ids.push(node as QualifiedId)
      } else {
        // The identifier is considered constant unless it's pointing to a
        // local scope variable (a v-for alias, or a v-slot prop)
        // 不需要加前缀的情况
        if (
          !(needPrefix && isLocal) &&
          (!parent ||
            (parent.type !== 'CallExpression' &&
              parent.type !== 'NewExpression' &&
              parent.type !== 'MemberExpression'))
        ) {
          // 可标记为常量（不变的变量）
          ;(node as QualifiedId).isConstant = true
        }
        // also generate sub-expressions for other identifiers for better
        // source map support. (except for property keys which are static)
        // 其他标识符也推入 ids 便于生成子表达式用于源码映射
        ids.push(node as QualifiedId)
      }
    },
    true, // invoke on ALL identifiers // 遍历所有标识符
    parentStack,
    knownIds,
  )

  // We break up the compound expression into an array of strings and sub
  // expressions (for identifiers that have been prefixed). In codegen, if
  // an ExpressionNode has the `.children` property, it will be used instead of
  // `.content`.

  // 接下来构建 children，拆解出表达式中所有带前缀的变量作为 AST 子节点
  const children: CompoundExpressionNode['children'] = []
  ids.sort((a, b) => a.start - b.start) // 排序确保按照出现顺序拼接
  ids.forEach((id, i) => {
    // range is offset by -1 due to the wrapping parens when parsed
    // 减 1 是因为表达式外层包裹了 ()
    const start = id.start - 1
    const end = id.end - 1
    const last = ids[i - 1]
    const leadingText = rawExp.slice(last ? last.end - 1 : 0, start)
    if (leadingText.length || id.prefix) {
      // 如果变量前有字符串片段（空格、符号等），或有前缀
      children.push(leadingText + (id.prefix || ``))
    }
    const source = rawExp.slice(start, end)
    children.push(
      createSimpleExpression(
        id.name,
        false,
        {
          start: advancePositionWithClone(node.loc.start, source, start),
          end: advancePositionWithClone(node.loc.start, source, end),
          source,
        },
        id.isConstant
          ? ConstantTypes.CAN_STRINGIFY
          : ConstantTypes.NOT_CONSTANT,
      ),
    )
    if (i === ids.length - 1 && end < rawExp.length) {
      // 添加最后一个变量后的文本片段
      children.push(rawExp.slice(end))
    }
  })

  // 最终返回的节点：复合表达式节点或原节点
  let ret
  if (children.length) {
    ret = createCompoundExpression(children, node.loc)
    ret.ast = ast
  } else {
    ret = node
    ret.constType = ConstantTypes.CAN_STRINGIFY
  }
  // 所有变量标识符
  ret.identifiers = Object.keys(knownIds)
  return ret
}

// 判断是否可以为某个标识符加作用域前缀（如 _ctx.xx）
// 主要用于模板编译阶段判断变量是否需要从上下文中访问
function canPrefix(id: Identifier) {
  // skip whitelisted globals
  // 如果是允许的全局变量（如 `Math`、`Date`、`Infinity` 等），则不加前缀
  if (isGloballyAllowed(id.name)) {
    return false
  }
  // special case for webpack compilation
  // 特殊情况：Webpack 构建中有 require，不加前缀
  if (id.name === 'require') {
    return false
  }
  // 其余情况默认可以加前缀
  return true
}

// 将表达式 AST 节点（或字符串）转换为字符串
// 用于将 AST 转成最终代码字符串
export function stringifyExpression(exp: ExpressionNode | string): string {
  if (isString(exp)) {
    // 如果已经是字符串，直接返回
    return exp
  } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
    // 简单表达式（如标识符、字面量）直接返回内容
    return exp.content
  } else {
    // 否则是复合表达式，递归处理子节点并拼接为字符串
    return (exp.children as (ExpressionNode | string)[])
      .map(stringifyExpression)
      .join('')
  }
}

// 判断变量是否是 const 类型（不可被更新）
// 常用于 <script setup> 中标记为 const 的变量
function isConst(type: unknown) {
  return (
    // setup 中 const 声明的变量
    type === BindingTypes.SETUP_CONST ||
    // 字面量常量
    type === BindingTypes.LITERAL_CONST
  )
}
