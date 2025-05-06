import type {
  ArrayPattern,
  Identifier,
  LVal,
  Node,
  ObjectPattern,
  RestElement,
} from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'
import {
  type TypeResolveContext,
  resolveTypeElements,
  resolveUnionType,
} from './resolveType'

export const DEFINE_EMITS = 'defineEmits'

// 用于在 <script setup> 中识别和分析 defineEmits() 的调用，并将相关信息记录到编译上下文中。
// processDefineEmits() 的作用是：
// 判断传入的 AST 节点是否是 defineEmits() 的调用；
// 检查是否重复调用；
// 提取类型参数（<EmitType>）或运行时参数（{ emitOptions }）；
// 记录相关节点，供后续代码生成或类型分析使用。
export function processDefineEmits(
  // ctx	编译上下文 ScriptCompileContext
  // node	当前 AST 节点（需判断是否为 defineEmits(...)）
  // declId	defineEmits 的赋值标识符，例如：const emit = defineEmits() 中的 emit
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  // 使用 isCallOf(node, 'defineEmits') 判断是否是宏函数调用
  // 若不是，直接返回 false，表示此节点不是目标
  if (!isCallOf(node, DEFINE_EMITS)) {
    return false
  }
  // Vue <script setup> 中 defineEmits() 只能调用一次，否则报错
  if (ctx.hasDefineEmitCall) {
    ctx.error(`duplicate ${DEFINE_EMITS}() call`, node)
  }
  ctx.hasDefineEmitCall = true
  // 提取运行时参数和类型参数
  ctx.emitsRuntimeDecl = node.arguments[0]
  if (node.typeParameters) {
    if (ctx.emitsRuntimeDecl) {
      ctx.error(
        // 不能同时有类型参数和运行时参数
        `${DEFINE_EMITS}() cannot accept both type and non-type arguments ` +
          `at the same time. Use one or the other.`,
        node,
      )
    }
    ctx.emitsTypeDecl = node.typeParameters.params[0]
  }

  // 记录变量绑定（赋值左侧的变量）
  ctx.emitDecl = declId

  return true
}

// 在 <script setup> 的编译阶段，根据宏调用 defineEmits（以及可能的 defineModel）的分析结果，生成传给组件选项中的 emits 字段的 运行时代码字符串。
export function genRuntimeEmits(ctx: ScriptCompileContext): string | undefined {
  let emitsDecl = ''
  // 如果使用了运行时参数：
  if (ctx.emitsRuntimeDecl) {
    // 直接提取用户传入的内容文本，例如生成：['foo', 'bar']
    emitsDecl = ctx.getString(ctx.emitsRuntimeDecl).trim()
  } else if (ctx.emitsTypeDecl) {
    // 从类型参数推导 emits 列表（类型编译为运行时）

    // 如果是类型参数形式：
    // 就会调用 extractRuntimeEmits() 从类型中提取事件名，转成数组字符串：
    const typeDeclaredEmits = extractRuntimeEmits(ctx)
    emitsDecl = typeDeclaredEmits.size
      ? `[${Array.from(typeDeclaredEmits)
          .map(k => JSON.stringify(k))
          .join(', ')}]`
      : ``
  }

  // 如果使用了 defineModel()，追加相关的事件名
  // Vue 3.4+ 中支持 defineModel()，它会自动生成 update:<prop> 形式的事件绑定
  // 这些事件也需要合并进 emits 列表
  // 如果 defineEmits() 已经存在，则使用 helper 函数 mergeModels() 合并两个数组
  if (ctx.hasDefineModelCall) {
    let modelEmitsDecl = `[${Object.keys(ctx.modelDecls)
      .map(n => JSON.stringify(`update:${n}`))
      .join(', ')}]`
    emitsDecl = emitsDecl
      ? `/*@__PURE__*/${ctx.helper(
          'mergeModels',
        )}(${emitsDecl}, ${modelEmitsDecl})`
      : modelEmitsDecl
  }
  return emitsDecl
}

// 用于从类型声明中提取出事件名称字符串，以便在编译阶段生成组件的 emits 配置。
// ctx：类型解析上下文（包含 type AST 和作用域信息）
// 返回值：提取到的事件名字符串集合（无重复）
export function extractRuntimeEmits(ctx: TypeResolveContext): Set<string> {
  const emits = new Set<string>()
  const node = ctx.emitsTypeDecl!

  if (node.type === 'TSFunctionType') {
    // 如果类型是函数形式：
    // (e: 'foo') => void
    // 判断为 node.type === 'TSFunctionType'，则从参数中提取第一个参数的字面量值：
    // extractEventNames(ctx, node.parameters[0], emits)
    // 例如 e: 'click' → 提取 'click'
    extractEventNames(ctx, node.parameters[0], emits)
    return emits
  }

  // 否则是对象语法形式：
  // {
  //   foo: null,
  //   bar?: (id: number) => void,
  //   (e: 'baz'): void
  // }
  // 先解析为 props 和 calls：
  // const { props, calls } = resolveTypeElements(ctx, node)
  // props 是对象属性型的事件定义，如 foo: null
  // calls 是函数签名型的事件定义，如 (e: 'bar'): void
  const { props, calls } = resolveTypeElements(ctx, node)

  let hasProperty = false
  // 遍历 props，添加事件名
  for (const key in props) {
    emits.add(key)
    hasProperty = true
  }

  // 如果存在 props 的同时又存在 calls（函数签名），则报错：
  // defineEmits() type cannot mixed call signature and property syntax.
  if (calls) {
    if (hasProperty) {
      ctx.error(
        `defineEmits() type cannot mixed call signature and property syntax.`,
        node,
      )
    }
    // 遍历 calls 中的第一个参数，提取事件名
    for (const call of calls) {
      extractEventNames(ctx, call.parameters[0], emits)
    }
  }

  return emits
}

// 从形如 defineEmits<(e: 'submit' | 'cancel') => void>() 的 第一个参数的类型注解中提取字符串字面量类型（即事件名），并添加到 emits 集合中。
function extractEventNames(
  // ctx：类型分析上下文，包含作用域和类型节点
  // eventName：函数参数节点，一般为 Identifier 类型，形如 e: 'submit' | 'cancel'
  // emits：收集事件名的集合
  ctx: TypeResolveContext,
  eventName: ArrayPattern | Identifier | ObjectPattern | RestElement,
  emits: Set<string>,
) {
  // 确保第一个参数是一个带有类型注解的标识符（e: 'foo' | 'bar'）
  if (
    eventName.type === 'Identifier' &&
    eventName.typeAnnotation &&
    eventName.typeAnnotation.type === 'TSTypeAnnotation'
  ) {
    // 把联合类型 'click' | 'submit' 拆成两个 TSLiteralType 类型的节点
    const types = resolveUnionType(ctx, eventName.typeAnnotation.typeAnnotation)

    // 遍历这些类型，提取字符串字面量值
    for (const type of types) {
      if (type.type === 'TSLiteralType') {
        if (
          type.literal.type !== 'UnaryExpression' &&
          type.literal.type !== 'TemplateLiteral'
        ) {
          // 如果字面量是普通字符串（如 'foo'），提取其值并加入 emits 集合
          // 忽略 UnaryExpression 和 TemplateLiteral（目前 Vue 不支持这种类型作为事件名）
          emits.add(String(type.literal.value))
        }
      }
    }
  }
  // 示例：
  // defineEmits<(e: 'save' | 'cancel' | 42) => void>()
  // AST 结构中：
  // 参数 e 是 Identifier
  // 注解是 TSTypeAnnotation，里面是联合类型 'save' | 'cancel' | 42
  // resolveUnionType 展开为多个 TSLiteralType
  // 提取其中的 save, cancel, 42 添加到 emits 集合中（注意：数字也会被转为字符串）
  //
  // 最终效果：
  // 输入类型参数：
  // < (e: 'click' | 'submit' | 'reset') => void >
  // 调用此函数后：
  // emits = Set { 'click', 'submit', 'reset' }
}
