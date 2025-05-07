import type {
  Expression,
  LVal,
  Node,
  ObjectExpression,
  ObjectMethod,
  ObjectProperty,
} from '@babel/types'
import { BindingTypes, isFunctionType, unwrapTSNode } from '@vue/compiler-dom'
import type { ScriptCompileContext } from './context'
import {
  type TypeResolveContext,
  inferRuntimeType,
  resolveTypeElements,
} from './resolveType'
import {
  UNKNOWN_TYPE,
  concatStrings,
  getEscapedPropName,
  isCallOf,
  isLiteralNode,
  resolveObjectKey,
  toRuntimeTypeString,
} from './utils'
import { genModelProps } from './defineModel'
import { getObjectOrArrayExpressionKeys } from './analyzeScriptBindings'
import { processPropsDestructure } from './definePropsDestructure'

// 定义两个常量
export const DEFINE_PROPS = 'defineProps'
export const WITH_DEFAULTS = 'withDefaults'

export interface PropTypeData {
  // prop 的名称（字符串）
  key: string
  // 推导出的运行时类型（如 ['String', 'Number']）
  type: string[]
  // 是否是必填
  required: boolean
  // 是否跳过类型检查（例如存在未知类型但包含 Boolean 或 Function 时）
  skipCheck: boolean
}

// 用于记录 const { a, b: localB } = defineProps() 解构时的绑定信息
// 结构为一个对象（Record）：
// key：prop 的公开名（也就是定义在 defineProps 中的属性名）
// 值：一个对象，包括：
// local：本地变量名，可能与 prop 名不同（如 b: localB）
// default（可选）：对应的默认值表达式 AST 节点
export type PropsDestructureBindings = Record<
  string, // public prop key
  {
    local: string // local identifier, may be different
    default?: Expression
  }
>
// 负责识别并分析 defineProps() 调用，收集类型、运行时声明、变量解构信息等，供后续生成代码使用。
// 检查和记录 defineProps 的调用
// 支持类型参数或运行时参数（不能混用）
// 识别并记录解构绑定（如 const { x } = defineProps()）
// 将绑定变量注册为 PROPS 类型
// 为后续代码生成与类型推导提供依据
export function processDefineProps(
  // 编译上下文
  ctx: ScriptCompileContext,
  // AST 节点（期望是 defineProps(...) 调用表达式）
  node: Node,
  // 宏调用的赋值左侧（如 const { foo } = defineProps() 中的解构）
  declId?: LVal,
  // 是否被包裹在 withDefaults 中
  isWithDefaults = false,
): boolean {
  // 判断是不是 defineProps 调用
  // 如果不是 defineProps，而是可能的 withDefaults 包裹，则交给 processWithDefaults 处理。
  if (!isCallOf(node, DEFINE_PROPS)) {
    return processWithDefaults(ctx, node, declId)
  }

  // 检查是否已经调用过 defineProps，不允许重复调用。
  if (ctx.hasDefinePropsCall) {
    ctx.error(`duplicate ${DEFINE_PROPS}() call`, node)
  }
  ctx.hasDefinePropsCall = true

  // 提取 defineProps 的第一个参数（可能是对象/数组）
  ctx.propsRuntimeDecl = node.arguments[0]

  // register bindings
  // 注册 prop 绑定名到 bindingMetadata 中（供后续 template 编译使用）
  if (ctx.propsRuntimeDecl) {
    for (const key of getObjectOrArrayExpressionKeys(ctx.propsRuntimeDecl)) {
      if (!(key in ctx.bindingMetadata)) {
        ctx.bindingMetadata[key] = BindingTypes.PROPS
      }
    }
  }

  // call has type parameters - infer runtime types from it
  // 处理类型参数。如果传入了类型参数和 runtime 参数同时存在，报错。
  if (node.typeParameters) {
    if (ctx.propsRuntimeDecl) {
      ctx.error(
        `${DEFINE_PROPS}() cannot accept both type and non-type arguments ` +
          `at the same time. Use one or the other.`,
        node,
      )
    }
    ctx.propsTypeDecl = node.typeParameters.params[0]
  }

  // handle props destructure
  // 处理解构写法（如 const { foo } = defineProps()）
  // 前提：不是 withDefaults 包裹
  // declId 是 ObjectPattern（对象解构）
  // 调用 processPropsDestructure 进一步记录变量名与默认值
  if (!isWithDefaults && declId && declId.type === 'ObjectPattern') {
    processPropsDestructure(ctx, declId)
  }

  // 记录 defineProps 调用本身（AST 节点）及其声明 ID（变量或解构）
  ctx.propsCall = node
  ctx.propsDecl = declId

  return true
}

// 用于处理 <script setup> 中的 withDefaults() 宏调用，它和 defineProps() 配合使用，用于指定 props 的默认值。
function processWithDefaults(
  // ctx：编译上下文
  // node：当前 AST 节点
  // declId：宏调用赋值左值（如 const { foo } = withDefaults(...)）
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  // 判断是否为 withDefaults 调用
  // 如果不是，则返回 false，表示不处理该节点。
  if (!isCallOf(node, WITH_DEFAULTS)) {
    return false
  }
  if (
    // 调用 processDefineProps 处理 withDefaults 的第一个参数
    // 要求必须是 defineProps(...)，否则报错
    !processDefineProps(
      ctx,
      node.arguments[0],
      declId,
      true /* isWithDefaults */,
    )
  ) {
    ctx.error(
      `${WITH_DEFAULTS}' first argument must be a ${DEFINE_PROPS} call.`,
      node.arguments[0] || node,
    )
  }

  // 禁止运行时参数形式的 defineProps 与 withDefaults 一起使用
  // withDefaults 只支持类型参数形式的 defineProps，如：
  // withDefaults(defineProps<{ foo?: number }>(), { foo: 1 })
  // 不能与 defineProps({ foo: Number }) 形式一起使用
  if (ctx.propsRuntimeDecl) {
    ctx.error(
      `${WITH_DEFAULTS} can only be used with type-based ` +
        `${DEFINE_PROPS} declaration.`,
      node,
    )
  }
  // 如果使用了解构写法，发出警告（不是错误）
  // 因为解构写法本身已经支持默认值，无需用 withDefaults，而且 withDefaults 会禁用“响应式解构”
  if (declId && declId.type === 'ObjectPattern') {
    ctx.warn(
      `${WITH_DEFAULTS}() is unnecessary when using destructure with ${DEFINE_PROPS}().\n` +
        `Reactive destructure will be disabled when using withDefaults().\n` +
        `Prefer using destructure default values, e.g. const { foo = 1 } = defineProps(...). `,
      node.callee,
    )
  }
  // 提取第二个参数（默认值对象）
  ctx.propsRuntimeDefaults = node.arguments[1]
  if (!ctx.propsRuntimeDefaults) {
    ctx.error(`The 2nd argument of ${WITH_DEFAULTS} is required.`, node)
  }
  // 记录宏调用节点到 propsCall
  ctx.propsCall = node

  return true
}

// 根据 defineProps、解构默认值（含 withDefaults）、defineModel 等宏调用的分析结果，拼接生成最终的 props 定义字符串，供后续插入到组件导出对象中。
export function genRuntimeProps(ctx: ScriptCompileContext): string | undefined {
  // 初始化结果变量：
  let propsDecls: undefined | string

  // 用户使用了 defineProps 的运行时参数形式（对象字面量）
  if (ctx.propsRuntimeDecl) {
    // 此时提取 defineProps(...) 中的对象字符串内容作为 props
    propsDecls = ctx.getString(ctx.propsRuntimeDecl).trim()
    if (ctx.propsDestructureDecl) {
      // 如果存在解构写法（如 const { foo = 1 } = defineProps()）
      // 说明需要生成默认值逻辑
      // ctx.propsDestructureDecl 表示进行了结构赋值
      // 遍历 ctx.propsDestructuredBindings，调用 genDestructuredDefaultValue 为每个 prop 生成默认值代码
      // 将所有默认值汇总，并包装在 mergeDefaults 函数中
      // 例子：
      // mergeDefaults({ foo: Boolean }, { foo: 1 })
      const defaults: string[] = []
      for (const key in ctx.propsDestructuredBindings) {
        const d = genDestructuredDefaultValue(ctx, key)
        const finalKey = getEscapedPropName(key)
        if (d)
          defaults.push(
            `${finalKey}: ${d.valueString}${
              d.needSkipFactory ? `, __skip_${finalKey}: true` : ``
            }`,
          )
      }
      if (defaults.length) {
        propsDecls = `/*@__PURE__*/${ctx.helper(
          `mergeDefaults`,
        )}(${propsDecls}, {\n  ${defaults.join(',\n  ')}\n})`
      }
    }
  } else if (ctx.propsTypeDecl) {
    // 用户使用的是类型参数形式的 defineProps
    // 从类型中提取出可用于运行时的类型信息，例如：
    // defineProps<{ foo?: number }>()
    // → { foo: Number }
    propsDecls = extractRuntimeProps(ctx)
  }

  // 然后尝试获取 defineModel 生成的 props 定义（如 { modelValue: ... }）
  const modelsDecls = genModelProps(ctx)

  if (propsDecls && modelsDecls) {
    // 如果两者都有，使用 mergeModels 函数合并：
    return `/*@__PURE__*/${ctx.helper(
      'mergeModels',
    )}(${propsDecls}, ${modelsDecls})`
  } else {
    // 否则只返回其中一个：
    return modelsDecls || propsDecls
  }
}

// 生成运行时代码中 props 字段的关键函数。
// 它会将类型信息（如 defineProps<{ foo?: number }>()）转换为等价的运行时代码（如 { foo: Number }），并根据上下文合并默认值。
export function extractRuntimeProps(
  ctx: TypeResolveContext,
): string | undefined {
  // this is only called if propsTypeDecl exists
  // 第一步：从类型中解析出 props 列表
  // 调用 resolveRuntimePropsFromType，分析 ctx.propsTypeDecl 的类型结构，提取出每个 prop 的 key、类型、是否 required 等信息
  // 如果没有任何 prop，直接返回 undefined
  const props = resolveRuntimePropsFromType(ctx, ctx.propsTypeDecl!)
  if (!props.length) {
    return
  }

  const propStrings: string[] = []
  // 第二步：初始化代码字符串列表和默认值检查标志
  // 用于判断是否所有默认值都能在编译期静态获取（如 const 值）
  // propStrings 数组用于保存每个 prop 的代码片段
  const hasStaticDefaults = hasStaticWithDefaults(ctx)

  // 第三步：生成每个 prop 的代码
  for (const prop of props) {
    // genRuntimePropFromType 会根据类型信息生成如下代码片段：
    // "foo": { type: Number, required: false }
    propStrings.push(genRuntimePropFromType(ctx, prop, hasStaticDefaults))
    // register bindings
    if ('bindingMetadata' in ctx && !(prop.key in ctx.bindingMetadata)) {
      // 注册绑定信息（标记为 props 类型）
      ctx.bindingMetadata[prop.key] = BindingTypes.PROPS
    }
  }

  // 第四步：拼接最终 props 对象字面量字符串
  let propsDecls = `{
    ${propStrings.join(',\n    ')}\n  }`

  // 第五步：处理 withDefaults 情况（传入默认值对象）
  // 如果 propsRuntimeDefaults 存在（即使用了 withDefaults），并且不是全静态默认值，就使用 mergeDefaults 包装生成代码
  if (ctx.propsRuntimeDefaults && !hasStaticDefaults) {
    propsDecls = `/*@__PURE__*/${ctx.helper(
      'mergeDefaults',
    )}(${propsDecls}, ${ctx.getString(ctx.propsRuntimeDefaults)})`
  }

  return propsDecls
}

//  Vue <script setup> 编译器中将 TypeScript 类型参数转换为运行时代码 props 定义的关键一步。
function resolveRuntimePropsFromType(
  // ctx：类型分析上下文，包含当前作用域、类型工具等
  // node：用户在 defineProps<T>() 中传入的类型节点
  // 返回值：一个 PropTypeData[] 数组，每个元素表示一个 prop 的运行时信息
  ctx: TypeResolveContext,
  node: Node,
): PropTypeData[] {
  const props: PropTypeData[] = []
  // 第一步：获取 props 类型成员
  // 调用 resolveTypeElements(ctx, node) 从类型字面量或接口中提取出属性签名，返回形式为：
  // {
  // props: {
  // foo: TypeElement,
  // bar: TypeElement,
  // ...
  // }
  // }
  // 每个 TypeElement 表示一个属性及其类型结构、可选标志等。
  const elements = resolveTypeElements(ctx, node)
  // 第二步：遍历每个 prop，生成运行时类型数据
  for (const key in elements.props) {
    const e = elements.props[key]
    // 第三步：推导运行时类型
    // 这一步会将类型转换为字符串形式的 Vue 类型，如：
    // string → 'String'
    // number → 'Number'
    // () => void → 'Function'
    // boolean → 'Boolean'
    // unknown → 'UNKNOWN_TYPE'
    let type = inferRuntimeType(ctx, e)
    let skipCheck = false
    // skip check for result containing unknown types
    // 第四步：处理类型中包含 unknown 的情况
    // if (type 包含 Boolean 或 Function) {
    // 说明这是组合类型（如 boolean | unknown），保留安全部分，移除 unknown
    // 同时标记 skipCheck 为 true，表示不应进行严格校验
    // } else {
    // type = ['null']
    // }
    // }
    // 这样做的目的是避免生成非法或不可识别的 Vue 类型
    if (type.includes(UNKNOWN_TYPE)) {
      if (type.includes('Boolean') || type.includes('Function')) {
        type = type.filter(t => t !== UNKNOWN_TYPE)
        skipCheck = true
      } else {
        type = ['null']
      }
    }
    // 第五步：构造每个 prop 的描述对象
    // props.push({
    // key, // prop 名
    // required: !e.optional, // 是否必填
    // type: type || ['null'], // 推导后的运行时类型数组
    // skipCheck, // 是否跳过类型校验
    // })
    props.push({
      key,
      required: !e.optional,
      type: type || [`null`],
      skipCheck,
    })
  }
  return props
}

// 根据类型信息和默认值生成运行时代码中对应的 prop 配置对象字符串。
// 它用于 Vue 等框架编译过程中，把 props 的类型声明、是否必填、默认值等信息，转换成最终要写入运行时代码中的格式。
function genRuntimePropFromType(
  // ctx: 类型处理上下文对象，提供一系列工具和配置。
  // { key, required, type, skipCheck }: 当前 prop 的数据对象，包括名字、是否必填、类型数组、是否跳过类型检查。
  // hasStaticDefaults: 表示 props 默认值是否是一个静态对象字面量（由前面的 hasStaticWithDefaults() 判断）。
  ctx: TypeResolveContext,
  { key, required, type, skipCheck }: PropTypeData,
  hasStaticDefaults: boolean,
): string {
  let defaultString: string | undefined
  // 尝试从解构中获取默认值
  // 如果用户是用了解构赋值的默认值（比如 const { msg = "hello" } = props），就从中提取。
  const destructured = genDestructuredDefaultValue(ctx, key, type)
  if (destructured) {
    // 如果有解构默认值：
    // default: xxx, skipFactory: true（如果需要跳过包装）
    defaultString = `default: ${destructured.valueString}${
      destructured.needSkipFactory ? `, skipFactory: true` : ``
    }`
  } else if (hasStaticDefaults) {
    // 如果没有解构默认值、但 hasStaticDefaults 为 true：
    // 就从 ctx.propsRuntimeDefaults 对象字面量中提取静态默认值。
    // 可能是属性值，也可能是一个方法（如 default() {}）。
    const prop = (ctx.propsRuntimeDefaults as ObjectExpression).properties.find(
      node => {
        if (node.type === 'SpreadElement') return false
        return resolveObjectKey(node.key, node.computed) === key
      },
    ) as ObjectProperty | ObjectMethod
    if (prop) {
      if (prop.type === 'ObjectProperty') {
        // prop has corresponding static default value
        defaultString = `default: ${ctx.getString(prop.value)}`
      } else {
        defaultString = `${prop.async ? 'async ' : ''}${
          prop.kind !== 'method' ? `${prop.kind} ` : ''
        }default() ${ctx.getString(prop.body)}`
      }
    }
  }

  // 使用 getEscapedPropName(key) 处理属性名（转义特殊字符）。
  // 接下来根据是否是生产环境，来决定输出内容。
  const finalKey = getEscapedPropName(key)
  if (!ctx.options.isProd) {
    // 输出完整信息（开发环境调试用）：
    // propName: {
    //   type: [String, Number],
    //   required: true,
    //   skipCheck: true,
    //   default: () => (xxx)
    // }
    return `${finalKey}: { ${concatStrings([
      `type: ${toRuntimeTypeString(type)}`,
      `required: ${required}`,
      skipCheck && 'skipCheck: true',
      defaultString,
    ])} }`
  } else if (
    // Boolean 类型：必须保留 type 声明，因为在 Vue 内部会自动处理布尔属性（如存在即为 true）。
    type.some(
      el =>
        el === 'Boolean' ||
        ((!hasStaticDefaults || defaultString) && el === 'Function'),
    )
  ) {
    // #4783 for boolean, should keep the type
    // #7111 for function, if default value exists or it's not static, should keep it
    // in production
    // Function 类型：
    // 如果有默认值，或者默认值不是静态的，也要保留 type。
    // 否则会导致在运行时解析失误。
    return `${finalKey}: { ${concatStrings([
      `type: ${toRuntimeTypeString(type)}`,
      defaultString,
    ])} }`
  } else {
    // #8989 for custom element, should keep the type
    // 自定义元素模式（ctx.isCE）：
    // 这时也要保留 type 字段，因为自定义元素的 props 没有类型推导机制。
    if (ctx.isCE) {
      if (defaultString) {
        return `${finalKey}: ${`{ ${defaultString}, type: ${toRuntimeTypeString(
          type,
        )} }`}`
      } else {
        // 如果没有默认值，那就生成一个空对象 {}。
        // 如果有默认值但不是以上几种特殊类型，可以省略 type，仅保留默认值。
        return `${finalKey}: {type: ${toRuntimeTypeString(type)}}`
      }
    }

    // production: checks are useless
    return `${finalKey}: ${defaultString ? `{ ${defaultString} }` : `{}`}`
  }
}

/**
 * check defaults. If the default object is an object literal with only
 * static properties, we can directly generate more optimized default
 * declarations. Otherwise we will have to fallback to runtime merging.
 */
// 判断 ctx.propsRuntimeDefaults 是否是一个完全静态的对象字面量，如果是，返回 true；否则返回 false。这样可以决定是否在编译阶段直接生成默认值，或者推迟到运行时合并。
function hasStaticWithDefaults(ctx: TypeResolveContext) {
  return !!(
    // 首先确保 propsRuntimeDefaults 存在，并且它是一个对象字面量（AST 中的 ObjectExpression 节点）。
    (
      ctx.propsRuntimeDefaults &&
      ctx.propsRuntimeDefaults.type === 'ObjectExpression' &&
      // 遍历对象字面量的每一个属性，要求满足两个条件：
      // 不能是扩展运算符属性（即不能是 ...obj，AST 中为 SpreadElement）。
      // 如果是计算属性（即属性名是 [...] 的形式），那么其 key 必须是一个字面量类型（比如 'foo'、123 等），不能是变量或表达式。
      // 这表示我们只接受如下结构的对象：
      // {
      //   foo: 1,
      //   "bar": 2,
      //   123: "hello"
      // }
      // 而以下这些都会导致返回 false：
      // {
      //   [someVar]: 1
      // }
      // {
      //   ...otherDefaults
      // }
      ctx.propsRuntimeDefaults.properties.every(
        node =>
          node.type !== 'SpreadElement' &&
          (!node.computed || node.key.type.endsWith('Literal')),
      )
    )
  )
}

// 在处理组件或函数中的解构默认值时，生成对应的默认值字符串，并根据情况判断是否需要用工厂函数（即 () => value）包装这个默认值，同时还可以校验默认值是否符合推断的类型。
// 简单举例：
// 假如你有一个组件 props 解构语句：
// const { title = "默认标题" } = props
// 如果 title 被推断为类型 number，这个函数会抛出错误，因为默认值是字符串。
// 如果类型是 string，并且默认值是 "默认标题"（字符串字面量），那么就不需要包装。
// 但如果默认值是一个对象 {}，因为对象是引用类型，为了避免在每次调用时共享对象，就需要包成 () => ({})。
//
// 这个函数主要用于确保在编译期生成的代码在运行时行为是正确的，并且符合开发者在类型上声明的意图。
function genDestructuredDefaultValue(
  // ctx：上下文对象，提供一些工具方法，比如获取节点的字符串表示、抛出错误等。
  // key：要处理的属性名。
  // inferredType（可选）：这个属性被推断出的类型数组，比如 ["string"]、["number", "null"] 等。
  ctx: TypeResolveContext,
  key: string,
  inferredType?: string[],
):
  | {
      valueString: string
      needSkipFactory: boolean
    }
  | undefined {
  // 从上下文的 propsDestructuredBindings 中找到对应属性的默认值节点。如果没有默认值，函数直接返回 undefined。
  const destructured = ctx.propsDestructuredBindings[key]
  const defaultVal = destructured && destructured.default
  if (defaultVal) {
    // 使用 ctx.getString 获取默认值的字符串表示。
    // 使用 unwrapTSNode 去掉 TypeScript 特有的包装，得到一个“裸”的 AST 节点。
    const value = ctx.getString(defaultVal)
    const unwrapped = unwrapTSNode(defaultVal)

    // 如果提供了 inferredType，并且这个类型数组中不包含 "null"，函数会进一步检查默认值的实际类型（比如是字符串、数字、布尔值等）是否在推断类型中。如果不匹配，就抛出错误。
    if (inferredType && inferredType.length && !inferredType.includes('null')) {
      // 如果没有推断出类型，并且默认值是函数类型或者是一个标识符（例如引用了某个变量），就不进行工厂包装。原因是，在运行时我们无法判断 prop 的类型是不是函数，因此要保留原样。
      const valueType = inferValueType(unwrapped)
      if (valueType && !inferredType.includes(valueType)) {
        ctx.error(
          `Default value of prop "${key}" does not match declared type.`,
          unwrapped,
        )
      }
    }

    // If the default value is a function or is an identifier referencing
    // external value, skip factory wrap. This is needed when using
    // destructure w/ runtime declaration since we cannot safely infer
    // whether the expected runtime prop type is `Function`.
    // 如果不是上面需要跳过包装的情况，同时默认值不是一个字面量（如字符串、数字、布尔值等），并且也不是函数类型，那就需要包装。
    const needSkipFactory =
      !inferredType &&
      (isFunctionType(unwrapped) || unwrapped.type === 'Identifier')

    const needFactoryWrap =
      !needSkipFactory &&
      !isLiteralNode(unwrapped) &&
      !inferredType?.includes('Function')

    return {
      // valueString 是最终的字符串形式，可能是原样的值，也可能是 () => (value) 的形式。
      // needSkipFactory 表示是否跳过了工厂包装。
      valueString: needFactoryWrap ? `() => (${value})` : value,
      needSkipFactory,
    }
  }
}

// non-comprehensive, best-effort type infernece for a runtime value
// this is used to catch default value / type declaration mismatches
// when using props destructure.
// 这是一个“非全面”的、尽力而为的运行时值类型推导过程。
// 也就是说，它不是类型系统级别的严格推导，只是根据已有信息尽可能猜测一个值的类型。

// 这个逻辑的作用之一是检测默认值和类型声明之间是否不一致。
// 比如：
// 如果 defineProps<{ foo: string }>() 中，使用了 const { foo = 123 } = defineProps()，则 123 是 number，和 string 不匹配，这就可以被检测出来

// 上述行为主要针对 props 使用结构赋值时的情况，例如：
// const { foo = 'hello' } = defineProps<{ foo?: number }>()
// 此时会检查默认值 'hello' 是否与 number 类型一致。
function inferValueType(node: Node): string | undefined {
  switch (node.type) {
    case 'StringLiteral':
      return 'String'
    case 'NumericLiteral':
      return 'Number'
    case 'BooleanLiteral':
      return 'Boolean'
    case 'ObjectExpression':
      return 'Object'
    case 'ArrayExpression':
      return 'Array'
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return 'Function'
  }
}
