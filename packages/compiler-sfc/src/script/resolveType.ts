import type {
  Expression,
  Identifier,
  Node,
  Statement,
  TSCallSignatureDeclaration,
  TSEnumDeclaration,
  TSExpressionWithTypeArguments,
  TSFunctionType,
  TSImportType,
  TSIndexedAccessType,
  TSInterfaceDeclaration,
  TSMappedType,
  TSMethodSignature,
  TSModuleBlock,
  TSModuleDeclaration,
  TSPropertySignature,
  TSQualifiedName,
  TSType,
  TSTypeAnnotation,
  TSTypeElement,
  TSTypeLiteral,
  TSTypeQuery,
  TSTypeReference,
  TemplateLiteral,
} from '@babel/types'
import {
  UNKNOWN_TYPE,
  createGetCanonicalFileName,
  getId,
  getImportedName,
  joinPaths,
  normalizePath,
} from './utils'
import { type ScriptCompileContext, resolveParserPlugins } from './context'
import type { ImportBinding, SFCScriptCompileOptions } from '../compileScript'
import { capitalize, hasOwn } from '@vue/shared'
import { parse as babelParse } from '@babel/parser'
import { parse } from '../parse'
import { createCache } from '../cache'
import type TS from 'typescript'
import { dirname, extname, join } from 'path'
import { minimatch as isMatch } from 'minimatch'
import * as process from 'process'

// 定义了类型解析的最简配置选项，允许只提供局部的编译配置：
// globalTypeFiles: 全局类型文件路径
// fs: 文件系统（用于读取全局类型）
// babelParserPlugins: Babel 插件（支持解析更多 TS/JS 特性）
// isProd: 是否生产环境
export type SimpleTypeResolveOptions = Partial<
  Pick<
    SFCScriptCompileOptions,
    'globalTypeFiles' | 'fs' | 'babelParserPlugins' | 'isProd'
  >
>

/**
 * TypeResolveContext is compatible with ScriptCompileContext
 * but also allows a simpler version of it with minimal required properties
 * when resolveType needs to be used in a non-SFC context, e.g. in a babel
 * plugin. The simplest context can be just:
 * ```ts
 * const ctx: SimpleTypeResolveContext = {
 *   filename: '...',
 *   source: '...',
 *   options: {},
 *   error() {},
 *   ast: []
 * }
 * ```
 */
// 是 TypeResolveContext 的简化版本，用于非 SFC 的上下文下也能解析类型，比如在 Babel 插件中使用类型分析时。
// 最小的示例可以是：
// const ctx: SimpleTypeResolveContext = {
//   filename: 'MyComponent.vue',
//   source: 'const { foo } = defineProps<{ foo: string }>()',
//   options: {},
//   error() {},
//   ast: []
// }
// 包含的字段：
// 来自 ScriptCompileContext 的字段，如 source、filename、error、helper、getString
// props/emits 相关的 propsTypeDecl、propsRuntimeDefaults、propsDestructuredBindings、emitsTypeDecl
// isCE 表示是否是自定义元素模式
// ast: 当前代码的语法树（Statement[]）
// options: 配置项（上面的 SimpleTypeResolveOptions）
export type SimpleTypeResolveContext = Pick<
  ScriptCompileContext,
  // file
  | 'source'
  | 'filename'

  // utils
  | 'error'
  | 'helper'
  | 'getString'

  // props
  | 'propsTypeDecl'
  | 'propsRuntimeDefaults'
  | 'propsDestructuredBindings'

  // emits
  | 'emitsTypeDecl'

  // customElement
  | 'isCE'
> &
  Partial<
    Pick<ScriptCompileContext, 'scope' | 'globalScopes' | 'deps' | 'fs'>
  > & {
    ast: Statement[]
    options: SimpleTypeResolveOptions
  }

export type TypeResolveContext = ScriptCompileContext | SimpleTypeResolveContext

type Import = Pick<ImportBinding, 'source' | 'imported'>

// 表示这个节点具有 _ownerScope 属性，即属于某个 TypeScope
interface WithScope {
  _ownerScope: TypeScope
}

// scope types always has ownerScope attached
// 是附加 _ownerScope 的 Node，可选 _ns（表示是模块命名空间类型）
type ScopeTypeNode = Node &
  WithScope & { _ns?: TSModuleDeclaration & WithScope }

// TypeScope 是类型系统中的“作用域”结构，用于记录在某个文件或模块中声明的类型信息。构造函数接收如下参数：
// filename: 当前文件名
// source: 当前源代码
// offset: 偏移量，通常为 0
// imports: 记录已导入的类型
// types: 当前作用域内声明的类型（如接口、别名）
// declares: 当前作用域内声明的 declare 类型（如 declare interface）
// 扩展字段：
// isGenericScope: 是否为泛型作用域
// resolvedImportSources: 已解析导入路径
// exportedTypes: 通过 export 暴露的类型
// exportedDeclares: 通过 export declare 暴露的类型声明
export class TypeScope {
  constructor(
    public filename: string,
    public source: string,
    public offset: number = 0,
    public imports: Record<string, Import> = Object.create(null),
    public types: Record<string, ScopeTypeNode> = Object.create(null),
    public declares: Record<string, ScopeTypeNode> = Object.create(null),
  ) {}
  isGenericScope = false
  resolvedImportSources: Record<string, string> = Object.create(null)
  exportedTypes: Record<string, ScopeTypeNode> = Object.create(null)
  exportedDeclares: Record<string, ScopeTypeNode> = Object.create(null)
}

// _ownerScope 是可选的，用于还未绑定作用域的情况
export interface MaybeWithScope {
  _ownerScope?: TypeScope
}

// 这是一个中间结果结构，用于表示 defineProps 分析后的结构化结果：
// props: 一个对象，键是属性名，值是 TS 中的属性签名或方法签名，并附带 _ownerScope 表示该类型来自哪个作用域。
// calls: 可选的 call signatures，例如函数式组件中的 props 类型为函数时。
interface ResolvedElements {
  props: Record<
    string,
    (TSPropertySignature | TSMethodSignature) & {
      // resolved props always has ownerScope attached
      _ownerScope: TypeScope
    }
  >
  calls?: (TSCallSignatureDeclaration | TSFunctionType)[]
}

/**
 * Resolve arbitrary type node to a list of type elements that can be then
 * mapped to runtime props or emits.
 */
// 将任意类型节点（如 TypeLiteral、Interface、TypeAlias、Reference 等）解析成结构化的字段列表，以便后续转换为运行时的 props 或 emits。
export function resolveTypeElements(
  // ctx: 类型解析上下文（可以是 SFC 编译器上下文或简化版）。
  // node: 当前要解析的类型节点，它可能来自 defineProps<T>() 或 defineEmits<T>()。
  // 要求 node 携带 _ownerScope（表示属于哪个作用域）；
  // 还可能携带 _resolvedElements 缓存字段（避免重复解析）。
  // scope: 当前类型查找的作用域，默认为 ctxToScope(ctx)。
  // typeParameters: 泛型参数映射表（可选），用于处理泛型类型。
  ctx: TypeResolveContext,
  node: Node & MaybeWithScope & { _resolvedElements?: ResolvedElements },
  scope?: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  // 是否可以使用缓存（typeParameters 为空时才允许缓存结果）：
  const canCache = !typeParameters
  // 如果 node._resolvedElements 已存在，直接返回缓存结果，避免重复解析：
  if (canCache && node._resolvedElements) {
    return node._resolvedElements
  }
  // 否则，调用内部函数 innerResolveTypeElements(...) 进行真实的类型解析，传入：
  // 编译上下文
  // 当前节点
  // 所在作用域（优先用节点自带的 _ownerScope，否则用传入的或 ctxToScope(ctx) 推导出的作用域）
  // 泛型参数表
  const resolved = innerResolveTypeElements(
    ctx,
    node,
    node._ownerScope || scope || ctxToScope(ctx),
    typeParameters,
  )
  // 如果允许缓存，则将解析结果赋值到 node._resolvedElements，否则直接返回结果。
  return canCache ? (node._resolvedElements = resolved) : resolved
}

// 根据类型节点的不同类型，调用对应的处理函数，将其转换为一个标准的结构（ResolvedElements），其中包含组件 props 或 emits 的类型定义。
function innerResolveTypeElements(
  // ctx: 类型解析上下文
  // node: 当前要解析的 TypeScript AST 类型节点
  // scope: 当前所在的类型作用域
  // typeParameters: 泛型参数映射（如果存在）
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  if (
    node.leadingComments &&
    node.leadingComments.some(c => c.value.includes('@vue-ignore'))
  ) {
    // @vue-ignore 注释跳过处理：
    // 如果该类型节点前有 @vue-ignore 注释，表示用户显式让编译器忽略这个类型，直接返回空 prop。
    return { props: {} }
  }
  switch (node.type) {
    case 'TSTypeLiteral':
      // TSTypeLiteral'：内联的对象类型，如 type Props = { foo: string }
      // → 调用 typeElementsToMap 处理成员数组
      return typeElementsToMap(ctx, node.members, scope, typeParameters)
    case 'TSInterfaceDeclaration':
      // 'TSInterfaceDeclaration'：接口类型，如 interface Props { foo: string }
      // → 调用 resolveInterfaceMembers 提取接口所有成员，包括继承的
      return resolveInterfaceMembers(ctx, node, scope, typeParameters)
    case 'TSTypeAliasDeclaration':
    case 'TSTypeAnnotation':
    case 'TSParenthesizedType':
      // 'TSTypeAliasDeclaration' | 'TSTypeAnnotation' | 'TSParenthesizedType'：
      // 包括类型别名（type）、注解（: Foo）或括号包裹的类型
      // → 递归调用 resolveTypeElements 处理其内部 typeAnnotation
      return resolveTypeElements(
        ctx,
        node.typeAnnotation,
        scope,
        typeParameters,
      )
    case 'TSFunctionType': {
      // TSFunctionType'：函数类型，如 defineEmits<(e: string) => void>()
      // → 表示是 emits 结构，不含 props，返回 calls 数组
      return { props: {}, calls: [node] }
    }
    case 'TSUnionType':
    case 'TSIntersectionType':
      // 'TSUnionType' | 'TSIntersectionType'：联合或交叉类型
      // → 遍历所有组成类型，递归调用解析后再用 mergeElements 合并
      return mergeElements(
        node.types.map(t => resolveTypeElements(ctx, t, scope, typeParameters)),
        node.type,
      )
    case 'TSMappedType':
      // 'TSMappedType'：映射类型，如 { [K in Keys]: string }
      // → 调用 resolveMappedType，解析 key/value 动态映射类型
      return resolveMappedType(ctx, node, scope, typeParameters)
    case 'TSIndexedAccessType': {
      // 'TSIndexedAccessType'：索引访问类型，如 Props['foo']
      // → 调用 resolveIndexType 提取目标字段，再递归解析它们
      const types = resolveIndexType(ctx, node, scope)
      return mergeElements(
        types.map(t => resolveTypeElements(ctx, t, t._ownerScope)),
        'TSUnionType',
      )
    }
    case 'TSExpressionWithTypeArguments': // referenced by interface extends
    case 'TSTypeReference': {
      // 获取引用的类型名称：
      const typeName = getReferenceName(node)
      if (
        (typeName === 'ExtractPropTypes' ||
          typeName === 'ExtractPublicPropTypes') &&
        node.typeParameters &&
        scope.imports[typeName]?.source === 'vue'
      ) {
        // 判断是否是 ExtractPropTypes 或 ExtractPublicPropTypes
        // 如果是这两个 Vue 内置的 utility 类型，并且是从 vue 模块导入的，说明用户写的是：
        // defineProps<ExtractPropTypes<typeof myComponentProps>>()
        // → 递归解析其类型参数的类型元素
        return resolveExtractPropTypes(
          resolveTypeElements(
            ctx,
            node.typeParameters.params[0],
            scope,
            typeParameters,
          ),
          scope,
        )
      }
      // 否则尝试解析这个类型引用指向的实际声明（interface、alias 等）：
      const resolved = resolveTypeReference(ctx, node, scope)
      if (resolved) {
        let typeParams: Record<string, Node> | undefined
        if (
          // 检查是否是泛型类型：
          (resolved.type === 'TSTypeAliasDeclaration' ||
            resolved.type === 'TSInterfaceDeclaration') &&
          resolved.typeParameters &&
          node.typeParameters
        ) {
          // 建立泛型参数的映射表：
          typeParams = Object.create(null)
          resolved.typeParameters.params.forEach((p, i) => {
            let param = typeParameters && typeParameters[p.name]
            if (!param) param = node.typeParameters!.params[i]
            typeParams![p.name] = param
          })
        }
        // 然后递归解析引用类型的真实内容：
        return resolveTypeElements(
          ctx,
          resolved,
          resolved._ownerScope,
          typeParams,
        )
      } else {
        // 如果没能解析到任何已声明类型（resolved 为 undefined）：
        // 如果 typeName 是字符串，继续尝试以下几种情况：
        if (typeof typeName === 'string') {
          // 泛型参数表中存在此类型：
          if (typeParameters && typeParameters[typeName]) {
            return resolveTypeElements(
              ctx,
              typeParameters[typeName],
              scope,
              typeParameters,
            )
          }
          if (
            // @ts-expect-error
            //  支持的内建类型工具：
            SupportedBuiltinsSet.has(typeName)
          ) {
            return resolveBuiltin(
              ctx,
              node,
              typeName as any,
              scope,
              typeParameters,
            )
          } else if (typeName === 'ReturnType' && node.typeParameters) {
            // limited support, only reference types
            //  是 ReturnType<T> 类型工具：

            // 限制支持，仅当 T 是引用类型时生效。
            // 调用 resolveReturnType(...) 得到函数返回值类型后，再递归处理它。
            const ret = resolveReturnType(
              ctx,
              node.typeParameters.params[0],
              scope,
            )
            if (ret) {
              return resolveTypeElements(ctx, ret, scope)
            }
          }
        }
        return ctx.error(
          // 所有解析失败的情况统一报错：
          `Unresolvable type reference or unsupported built-in utility type`,
          node,
          scope,
        )
      }
    }
    // 这种类型来自 TS 的 import('vue').ExtractPropTypes<T> 或 import('my-lib').MyType 写法。
    case 'TSImportType': {
      // 首先检查是否是 import('vue').ExtractPropTypes<T> 形式：
      if (
        getId(node.argument) === 'vue' &&
        node.qualifier?.type === 'Identifier' &&
        node.qualifier.name === 'ExtractPropTypes' &&
        node.typeParameters
      ) {
        // 如果匹配到了 Vue 的内置类型工具，则提取其泛型参数并递归解析：
        return resolveExtractPropTypes(
          resolveTypeElements(ctx, node.typeParameters.params[0], scope),
          scope,
        )
      }
      // 如果不是 ExtractPropTypes，则尝试将导入路径转为一个作用域：
      const sourceScope = importSourceToScope(
        ctx,
        node.argument,
        scope,
        node.argument.value,
      )
      // 再使用该作用域解析其类型引用：
      const resolved = resolveTypeReference(ctx, node, sourceScope)
      // 如果成功解析，就继续递归处理它：
      if (resolved) {
        return resolveTypeElements(ctx, resolved, resolved._ownerScope)
      }
      break
    }
    case 'TSTypeQuery':
      // 处理 TSTypeQuery 类型：
      // 这种类型表示 typeof someValue，例如：
      // type Props = ExtractPropTypes<typeof someSetupVariable>
      {
        // 同样是先尝试解析引用的变量/类型，并继续递归解析其结构。
        const resolved = resolveTypeReference(ctx, node, scope)
        if (resolved) {
          return resolveTypeElements(ctx, resolved, resolved._ownerScope)
        }
      }
      break
  }
  return ctx.error(`Unresolvable type: ${node.type}`, node, scope)
}

// 将 TS 类型的成员数组（如来自 interface 或 type {}）转换为标准化的 ResolvedElements 结构。
function typeElementsToMap(
  ctx: TypeResolveContext,
  elements: TSTypeElement[],
  scope = ctxToScope(ctx),
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  // 遍历所有 TSTypeElement 成员：
  // 如果是属性或方法（TSPropertySignature 或 TSMethodSignature）：
  // 如果传入了泛型参数，则创建子作用域，并标记为泛型作用域。
  // 设置 _ownerScope 标记所属作用域。
  // 如果是普通 key（非计算），直接加到 res.props。
  // 如果 key 是 TemplateLiteral，调用 resolveTemplateKeys() 取出每个 key。
  // 否则报错：不支持的计算属性键。
  // 如果是 TSCallSignatureDeclaration（函数签名），则加到 res.calls。
  const res: ResolvedElements = { props: {} }
  for (const e of elements) {
    if (e.type === 'TSPropertySignature' || e.type === 'TSMethodSignature') {
      // capture generic parameters on node's scope
      if (typeParameters) {
        scope = createChildScope(scope)
        scope.isGenericScope = true
        Object.assign(scope.types, typeParameters)
      }
      ;(e as MaybeWithScope)._ownerScope = scope
      const name = getId(e.key)
      if (name && !e.computed) {
        res.props[name] = e as ResolvedElements['props'][string]
      } else if (e.key.type === 'TemplateLiteral') {
        for (const key of resolveTemplateKeys(ctx, e.key, scope)) {
          res.props[key] = e as ResolvedElements['props'][string]
        }
      } else {
        ctx.error(
          `Unsupported computed key in type referenced by a macro`,
          e.key,
          scope,
        )
      }
    } else if (e.type === 'TSCallSignatureDeclaration') {
      ;(res.calls || (res.calls = [])).push(e)
    }
  }
  return res
}

// 用于合并多个 ResolvedElements，一般出现在联合类型（|）或交叉类型（&）的处理过程中。
function mergeElements(
  maps: ResolvedElements[],
  type: 'TSUnionType' | 'TSIntersectionType',
): ResolvedElements {
  // 遍历多个 ResolvedElements 的 props：
  // 如果 key 不冲突，直接合并；
  // 如果冲突了（同名属性），用 createProperty() 创建一个新的合并节点，类型为 TSUnionType 或 TSIntersectionType，类型数组为两个冲突属性。
  // calls（函数签名）也会合并到结果中。
  if (maps.length === 1) return maps[0]
  const res: ResolvedElements = { props: {} }
  const { props: baseProps } = res
  for (const { props, calls } of maps) {
    for (const key in props) {
      if (!hasOwn(baseProps, key)) {
        baseProps[key] = props[key]
      } else {
        baseProps[key] = createProperty(
          baseProps[key].key,
          {
            type,
            // @ts-expect-error
            types: [baseProps[key], props[key]],
          },
          baseProps[key]._ownerScope,
          baseProps[key].optional || props[key].optional,
        )
      }
    }
    if (calls) {
      ;(res.calls || (res.calls = [])).push(...calls)
    }
  }
  return res
}

// 构造一个标准的 TSPropertySignature 节点（即 TS 的属性定义 AST），用于 Vue 编译器后续使用。
function createProperty(
  // key: 属性名表达式
  // typeAnnotation: TS 类型节点
  // scope: 当前作用域
  // optional: 是否是可选字段
  key: Expression,
  typeAnnotation: TSType,
  scope: TypeScope,
  optional: boolean,
): TSPropertySignature & WithScope {
  return {
    type: 'TSPropertySignature',
    key,
    kind: 'get',
    optional,
    typeAnnotation: {
      type: 'TSTypeAnnotation',
      typeAnnotation,
    },
    _ownerScope: scope,
  }
}

// 专门用于解析 TSInterfaceDeclaration 接口类型中的所有成员，包括 extends 的父接口。
function resolveInterfaceMembers(
  ctx: TypeResolveContext,
  node: TSInterfaceDeclaration & MaybeWithScope,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  // 首先使用 typeElementsToMap() 解析自身成员。
  // 然后处理 extends：
  // 对每个 ext 类型，调用 resolveTypeElements() 获取继承的属性和函数签名；
  // 如果不冲突就合并到当前接口的 props 和 calls；
  // 如果解析失败，会提示用户可以使用 /* @vue-ignore */ 注释来忽略这个 extends，并提示它的运行时行为是作为“透传属性”。
  const base = typeElementsToMap(
    ctx,
    node.body.body,
    node._ownerScope,
    typeParameters,
  )
  if (node.extends) {
    for (const ext of node.extends) {
      try {
        const { props, calls } = resolveTypeElements(ctx, ext, scope)
        for (const key in props) {
          if (!hasOwn(base.props, key)) {
            base.props[key] = props[key]
          }
        }
        if (calls) {
          ;(base.calls || (base.calls = [])).push(...calls)
        }
      } catch (e) {
        ctx.error(
          `Failed to resolve extends base type.\nIf this previously worked in 3.2, ` +
            `you can instruct the compiler to ignore this extend by adding ` +
            `/* @vue-ignore */ before it, for example:\n\n` +
            `interface Props extends /* @vue-ignore */ Base {}\n\n` +
            `Note: both in 3.2 or with the ignore, the properties in the base ` +
            `type are treated as fallthrough attrs at runtime.`,
          ext,
          scope,
        )
      }
    }
  }
  return base
}

// 将形如 { [K in Keys]: Type } 的映射类型转为可识别的 prop 字段。
function resolveMappedType(
  ctx: TypeResolveContext,
  node: TSMappedType,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  // 判断是否存在 nameType（即 [K in X as Y]），有则从 nameType 中解析 key 名，否则从 constraint 中提取键集合。
  // 为每个 key 构建一个 TSPropertySignature，并记录到 ResolvedElements.props 中。
  // 设置 prop 类型为 node.typeAnnotation，是否可选由 node.optional 决定。
  // 支持泛型参数的作用域继承处理。
  const res: ResolvedElements = { props: {} }
  let keys: string[]
  if (node.nameType) {
    const { name, constraint } = node.typeParameter
    scope = createChildScope(scope)
    Object.assign(scope.types, { ...typeParameters, [name]: constraint })
    keys = resolveStringType(ctx, node.nameType, scope)
  } else {
    keys = resolveStringType(ctx, node.typeParameter.constraint!, scope)
  }
  for (const key of keys) {
    res.props[key] = createProperty(
      {
        type: 'Identifier',
        name: key,
      },
      node.typeAnnotation!,
      scope,
      !!node.optional,
    )
  }
  return res
}

// 处理索引访问类型（T[K]），提取 K 表示的字段对应的类型节点。
function resolveIndexType(
  ctx: TypeResolveContext,
  node: TSIndexedAccessType,
  scope: TypeScope,
): (TSType & MaybeWithScope)[] {
  // 如果索引是 number，说明是在访问数组元素，调用 resolveArrayElementType()。
  // 否则：
  // 首先解析 K 为 key 数组（字符串形式）；
  // 然后对 T 做 resolveTypeElements()，获取它的所有字段；
  // 遍历字段名数组，从中提取出每个字段的类型节点组成数组返回。
  if (node.indexType.type === 'TSNumberKeyword') {
    return resolveArrayElementType(ctx, node.objectType, scope)
  }

  const { indexType, objectType } = node
  const types: TSType[] = []
  let keys: string[]
  let resolved: ResolvedElements
  if (indexType.type === 'TSStringKeyword') {
    resolved = resolveTypeElements(ctx, objectType, scope)
    keys = Object.keys(resolved.props)
  } else {
    keys = resolveStringType(ctx, indexType, scope)
    resolved = resolveTypeElements(ctx, objectType, scope)
  }
  for (const key of keys) {
    const targetType = resolved.props[key]?.typeAnnotation?.typeAnnotation
    if (targetType) {
      ;(targetType as TSType & MaybeWithScope)._ownerScope =
        resolved.props[key]._ownerScope
      types.push(targetType)
    }
  }
  return types
}

// 从数组或元组类型中提取其元素类型。
function resolveArrayElementType(
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
): TSType[] {
  // 支持结构：
  // TSArrayType → 返回 [elementType]
  // TSTupleType → 返回多个元素类型
  // TSTypeReference → 支持 Array<T> 的形式，或通过引用类型进一步递归提取
  // type[]
  if (node.type === 'TSArrayType') {
    return [node.elementType]
  }
  // tuple
  if (node.type === 'TSTupleType') {
    return node.elementTypes.map(t =>
      t.type === 'TSNamedTupleMember' ? t.elementType : t,
    )
  }
  if (node.type === 'TSTypeReference') {
    // Array<type>
    if (getReferenceName(node) === 'Array' && node.typeParameters) {
      return node.typeParameters.params
    } else {
      const resolved = resolveTypeReference(ctx, node, scope)
      if (resolved) {
        return resolveArrayElementType(ctx, resolved, scope)
      }
    }
  }
  return ctx.error(
    'Failed to resolve element type from target type',
    node,
    scope,
  )
}

// 将 TypeScript 类型节点解析为一组字符串 key，用于推导映射类型或索引类型中使用的 key。
function resolveStringType(
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
): string[] {
  // 支持结构：
  // StringLiteral → 返回 [value]
  // TSLiteralType → 递归解析其内部字面量
  // TSUnionType → 批量递归解析每个成员
  // TemplateLiteral → 调用 resolveTemplateKeys() 解析字符串模板
  // TSTypeReference → 特殊支持内置工具类型：
  switch (node.type) {
    case 'StringLiteral':
      return [node.value]
    case 'TSLiteralType':
      return resolveStringType(ctx, node.literal, scope)
    case 'TSUnionType':
      return node.types.map(t => resolveStringType(ctx, t, scope)).flat()
    case 'TemplateLiteral': {
      return resolveTemplateKeys(ctx, node, scope)
    }
    case 'TSTypeReference': {
      const resolved = resolveTypeReference(ctx, node, scope)
      if (resolved) {
        return resolveStringType(ctx, resolved, scope)
      }
      if (node.typeName.type === 'Identifier') {
        const getParam = (index = 0) =>
          resolveStringType(ctx, node.typeParameters!.params[index], scope)
        switch (node.typeName.name) {
          case 'Extract':
            return getParam(1)
          case 'Exclude': {
            const excluded = getParam(1)
            return getParam().filter(s => !excluded.includes(s))
          }
          case 'Uppercase':
            return getParam().map(s => s.toUpperCase())
          case 'Lowercase':
            return getParam().map(s => s.toLowerCase())
          case 'Capitalize':
            return getParam().map(capitalize)
          case 'Uncapitalize':
            return getParam().map(s => s[0].toLowerCase() + s.slice(1))
          default:
            ctx.error(
              'Unsupported type when resolving index type',
              node.typeName,
              scope,
            )
        }
      }
    }
  }
  return ctx.error('Failed to resolve index type into finite keys', node, scope)
}

// 递归解析模板字符串类型中的变量，返回所有可能的组合键名数组。
// 例子：
// type Keys = `is-${'open' | 'closed'}`
// 会解析为：['is-open', 'is-closed']
function resolveTemplateKeys(
  ctx: TypeResolveContext,
  node: TemplateLiteral,
  scope: TypeScope,
): string[] {
  // 先处理首段静态字符串。
  // 然后对第一个表达式调用 resolveStringType，获取可能值。
  // 对剩余表达式递归。
  // 拼接所有组合形成完整 key 字符串。
  if (!node.expressions.length) {
    return [node.quasis[0].value.raw]
  }

  const res: string[] = []
  const e = node.expressions[0]
  const q = node.quasis[0]
  const leading = q ? q.value.raw : ``
  const resolved = resolveStringType(ctx, e, scope)
  const restResolved = resolveTemplateKeys(
    ctx,
    {
      ...node,
      expressions: node.expressions.slice(1),
      quasis: q ? node.quasis.slice(1) : node.quasis,
    },
    scope,
  )

  for (const r of resolved) {
    for (const rr of restResolved) {
      res.push(leading + r + rr)
    }
  }

  return res
}

// 一个集合，列出 Vue 编译器支持的 TS 工具类型，包括：
// Partial
// Required
// Readonly
// Pick
// Omit
const SupportedBuiltinsSet = new Set([
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
] as const)

type GetSetType<T> = T extends Set<infer V> ? V : never

// 专门处理上面五种 TS 工具类型，把它们转为 ResolvedElements，用于生成 props 结构。
function resolveBuiltin(
  ctx: TypeResolveContext,
  node: TSTypeReference | TSExpressionWithTypeArguments,
  name: GetSetType<typeof SupportedBuiltinsSet>,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  // Partial<T> → 所有字段变为可选（optional: true）
  // Required<T> → 所有字段变为必填（optional: false）
  // Readonly<T> → 不影响结构，仅透传
  // Pick<T, Keys> → 只保留部分字段
  // Omit<T, Keys> → 排除部分字段
  const t = resolveTypeElements(
    ctx,
    node.typeParameters!.params[0],
    scope,
    typeParameters,
  )
  switch (name) {
    case 'Partial': {
      const res: ResolvedElements = { props: {}, calls: t.calls }
      Object.keys(t.props).forEach(key => {
        res.props[key] = { ...t.props[key], optional: true }
      })
      return res
    }
    case 'Required': {
      const res: ResolvedElements = { props: {}, calls: t.calls }
      Object.keys(t.props).forEach(key => {
        res.props[key] = { ...t.props[key], optional: false }
      })
      return res
    }
    case 'Readonly':
      return t
    case 'Pick': {
      const picked = resolveStringType(
        ctx,
        node.typeParameters!.params[1],
        scope,
      )
      const res: ResolvedElements = { props: {}, calls: t.calls }
      for (const key of picked) {
        res.props[key] = t.props[key]
      }
      return res
    }
    case 'Omit':
      const omitted = resolveStringType(
        ctx,
        node.typeParameters!.params[1],
        scope,
      )
      const res: ResolvedElements = { props: {}, calls: t.calls }
      for (const key in t.props) {
        if (!omitted.includes(key)) {
          res.props[key] = t.props[key]
        }
      }
      return res
  }
}

type ReferenceTypes =
  | TSTypeReference
  | TSExpressionWithTypeArguments
  | TSImportType
  | TSTypeQuery

// 将类型引用（如 Foo, Bar.A, typeof someValue, import("pkg").Type）解析为实际的类型声明节点。
function resolveTypeReference(
  ctx: TypeResolveContext,
  node: ReferenceTypes & {
    _resolvedReference?: ScopeTypeNode
  },
  scope?: TypeScope,
  name?: string,
  onlyExported = false,
): ScopeTypeNode | undefined {
  // 支持缓存 _resolvedReference
  // 调用内部函数 innerResolveTypeReference() 进行精细查找
  // 匹配：
  // 当前作用域的 types, declares, exportedTypes, exportedDeclares
  // 导入来源（如 import { Foo } from "pkg"）
  // 全局作用域（通过 resolveGlobalScope()）
  const canCache = !scope?.isGenericScope
  if (canCache && node._resolvedReference) {
    return node._resolvedReference
  }
  const resolved = innerResolveTypeReference(
    ctx,
    scope || ctxToScope(ctx),
    name || getReferenceName(node),
    node,
    onlyExported,
  )
  return canCache ? (node._resolvedReference = resolved) : resolved
}

// 真正的解析逻辑，递归查找类型名在作用域中的定义来源。
function innerResolveTypeReference(
  ctx: TypeResolveContext,
  scope: TypeScope,
  name: string | string[],
  node: ReferenceTypes,
  onlyExported: boolean,
): ScopeTypeNode | undefined {
  // 如果类型在导入表中（scope.imports），调用 resolveTypeFromImport
  // 否则在当前作用域的类型字典中查找（根据 node 类型判断是查 declares 还是 types）
  // 如果当前作用域没有，就递归向全局作用域查找
  // 支持命名空间路径（例如 Foo.Bar.Baz）
  if (typeof name === 'string') {
    if (scope.imports[name]) {
      return resolveTypeFromImport(ctx, node, name, scope)
    } else {
      const lookupSource =
        node.type === 'TSTypeQuery'
          ? onlyExported
            ? scope.exportedDeclares
            : scope.declares
          : onlyExported
            ? scope.exportedTypes
            : scope.types
      if (lookupSource[name]) {
        return lookupSource[name]
      } else {
        // fallback to global
        const globalScopes = resolveGlobalScope(ctx)
        if (globalScopes) {
          for (const s of globalScopes) {
            const src = node.type === 'TSTypeQuery' ? s.declares : s.types
            if (src[name]) {
              ;(ctx.deps || (ctx.deps = new Set())).add(s.filename)
              return src[name]
            }
          }
        }
      }
    }
  } else {
    let ns = innerResolveTypeReference(ctx, scope, name[0], node, onlyExported)
    if (ns) {
      if (ns.type !== 'TSModuleDeclaration') {
        // namespace merged with other types, attached as _ns
        ns = ns._ns
      }
      if (ns) {
        const childScope = moduleDeclToScope(ctx, ns, ns._ownerScope || scope)
        return innerResolveTypeReference(
          ctx,
          childScope,
          name.length > 2 ? name.slice(1) : name[name.length - 1],
          node,
          !ns.declare,
        )
      }
    }
  }
}

// 提取一个类型引用（如 Foo, import("vue").PropType<T>, typeof x）的“名称”标识。
function getReferenceName(node: ReferenceTypes): string | string[] {
  // 处理分支：
  // TSTypeReference → typeName
  // TSExpressionWithTypeArguments → expression
  // TSImportType → qualifier
  // TSTypeQuery → exprName
  // 返回值：
  // 若是 Identifier → 返回名称字符串
  // 若是 TSQualifiedName（如 A.B.C）→ 通过 qualifiedNameToPath() 返回字符串数组
  // 否则返回 'default'（默认导出引用）
  const ref =
    node.type === 'TSTypeReference'
      ? node.typeName
      : node.type === 'TSExpressionWithTypeArguments'
        ? node.expression
        : node.type === 'TSImportType'
          ? node.qualifier
          : node.exprName
  if (ref?.type === 'Identifier') {
    return ref.name
  } else if (ref?.type === 'TSQualifiedName') {
    return qualifiedNameToPath(ref)
  } else {
    return 'default'
  }
}

// 递归解析 TSQualifiedName，将 A.B.C 类型引用拆解为 ['A', 'B', 'C']
function qualifiedNameToPath(node: Identifier | TSQualifiedName): string[] {
  if (node.type === 'Identifier') {
    return [node.name]
  } else {
    return [...qualifiedNameToPath(node.left), node.right.name]
  }
}

// 从 ctx.options.globalTypeFiles 读取配置的全局类型文件，生成全局的 TypeScope[]。
// 依赖 resolveFS() 获取文件系统访问能力（必要）
// 使用 fileToScope() 将文件内容解析为作用域结构
function resolveGlobalScope(ctx: TypeResolveContext): TypeScope[] | undefined {
  if (ctx.options.globalTypeFiles) {
    const fs = resolveFS(ctx)
    if (!fs) {
      throw new Error('[vue/compiler-sfc] globalTypeFiles requires fs access.')
    }
    return ctx.options.globalTypeFiles.map(file =>
      fileToScope(ctx, normalizePath(file), true),
    )
  }
}

let ts: typeof TS | undefined
let loadTS: (() => typeof TS) | undefined

/**
 * @private
 */
// 注册一个懒加载的 TypeScript 实例，供非 Node 环境动态加载 typescript 包以实现类型解析。
export function registerTS(_loadTS: () => typeof TS): void {
  loadTS = () => {
    try {
      return _loadTS()
    } catch (err: any) {
      if (
        typeof err.message === 'string' &&
        err.message.includes('Cannot find module')
      ) {
        throw new Error(
          'Failed to load TypeScript, which is required for resolving imported types. ' +
            'Please make sure "typescript" is installed as a project dependency.',
        )
      } else {
        throw new Error(
          'Failed to load TypeScript for resolving imported types.',
        )
      }
    }
  }
}

type FS = NonNullable<SFCScriptCompileOptions['fs']>

// 返回用于读取文件的文件系统（fs），支持 Node 和浏览器兼容。
// 首选 ctx.fs
// 其次用 ts.sys（Node 环境）
// 添加 .vue.ts 兼容路径修复逻辑（替换 .ts）
// 返回值实现了 fileExists, readFile, realpath
function resolveFS(ctx: TypeResolveContext): FS | undefined {
  if (ctx.fs) {
    return ctx.fs
  }
  if (!ts && loadTS) {
    ts = loadTS()
  }
  const fs = ctx.options.fs || ts?.sys
  if (!fs) {
    return
  }
  return (ctx.fs = {
    fileExists(file) {
      if (file.endsWith('.vue.ts')) {
        file = file.replace(/\.ts$/, '')
      }
      return fs.fileExists(file)
    },
    readFile(file) {
      if (file.endsWith('.vue.ts')) {
        file = file.replace(/\.ts$/, '')
      }
      return fs.readFile(file)
    },
    realpath: fs.realpath,
  })
}

// 当某个类型引用是导入类型时（import { Foo } from 'lib'），根据 scope.imports 找到对应源模块，
// 然后调用 importSourceToScope() 加载并解析导入文件为新作用域，再递归调用 resolveTypeReference 获取真正的类型声明节点。
function resolveTypeFromImport(
  ctx: TypeResolveContext,
  node: ReferenceTypes,
  name: string,
  scope: TypeScope,
): ScopeTypeNode | undefined {
  const { source, imported } = scope.imports[name]
  const sourceScope = importSourceToScope(ctx, node, scope, source)
  return resolveTypeReference(ctx, node, sourceScope, imported, true)
}

// 将一个导入源（如 './types' 或 'vue'）转换为一个 TypeScope，用于查找其导出的类型。
function importSourceToScope(
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
  source: string,
): TypeScope {
  // 获取 fs（文件系统）用于访问模块文件
  // 判断 import 路径：
  // .. → 父级路径
  // . → 相对路径
  // 否则视为模块路径，需 Node 环境 + TypeScript 支持
  // 根据路径调用 resolveExt() 解析扩展名（如 .ts、.d.ts、.vue.ts）
  // 最后调用 fileToScope() 将目标文件解析为 TypeScope
  // 如果解析失败，会通过 ctx.error 返回错误。
  let fs: FS | undefined
  try {
    fs = resolveFS(ctx)
  } catch (err: any) {
    return ctx.error(err.message, node, scope)
  }
  if (!fs) {
    return ctx.error(
      `No fs option provided to \`compileScript\` in non-Node environment. ` +
        `File system access is required for resolving imported types.`,
      node,
      scope,
    )
  }

  let resolved: string | undefined = scope.resolvedImportSources[source]
  if (!resolved) {
    if (source.startsWith('..')) {
      const osSpecificJoinFn = process.platform === 'win32' ? join : joinPaths

      const filename = osSpecificJoinFn(dirname(scope.filename), source)
      resolved = resolveExt(filename, fs)
    } else if (source[0] === '.') {
      // relative import - fast path
      const filename = joinPaths(dirname(scope.filename), source)
      resolved = resolveExt(filename, fs)
    } else {
      // module or aliased import - use full TS resolution, only supported in Node
      if (!__CJS__) {
        return ctx.error(
          `Type import from non-relative sources is not supported in the browser build.`,
          node,
          scope,
        )
      }
      if (!ts) {
        if (loadTS) ts = loadTS()
        if (!ts) {
          return ctx.error(
            `Failed to resolve import source ${JSON.stringify(source)}. ` +
              `typescript is required as a peer dep for vue in order ` +
              `to support resolving types from module imports.`,
            node,
            scope,
          )
        }
      }
      resolved = resolveWithTS(scope.filename, source, ts, fs)
    }
    if (resolved) {
      resolved = scope.resolvedImportSources[source] = normalizePath(resolved)
    }
  }
  if (resolved) {
    // (hmr) register dependency file on ctx
    ;(ctx.deps || (ctx.deps = new Set())).add(resolved)
    return fileToScope(ctx, resolved)
  } else {
    return ctx.error(
      `Failed to resolve import source ${JSON.stringify(source)}.`,
      node,
      scope,
    )
  }
}

// 将 .js 等导入路径解析为 .ts、.tsx、.d.ts 或 index.ts 等真实存在的文件。
function resolveExt(filename: string, fs: FS) {
  // #8339 ts may import .js but we should resolve to corresponding ts or d.ts
  filename = filename.replace(/\.js$/, '')
  const tryResolve = (filename: string) => {
    if (fs.fileExists(filename)) return filename
  }
  return (
    tryResolve(filename) ||
    tryResolve(filename + `.ts`) ||
    tryResolve(filename + `.tsx`) ||
    tryResolve(filename + `.d.ts`) ||
    tryResolve(joinPaths(filename, `index.ts`)) ||
    tryResolve(joinPaths(filename, `index.tsx`)) ||
    tryResolve(joinPaths(filename, `index.d.ts`))
  )
}

interface CachedConfig {
  config: TS.ParsedCommandLine
  cache?: TS.ModuleResolutionCache
}

const tsConfigCache = createCache<CachedConfig[]>()
const tsConfigRefMap = new Map<string, string>()

// 通过 TypeScript API 使用 tsconfig 路径、别名等规则解析一个模块导入为文件路径。
function resolveWithTS(
  containingFile: string,
  source: string,
  ts: typeof TS,
  fs: FS,
): string | undefined {
  // 查找 tsconfig 文件（ts.findConfigFile）
  // 调用 loadTSConfig 加载并缓存配置
  // 创建 ts.ModuleResolutionCache
  // 使用 ts.resolveModuleName() 解析 source 对应的文件路径
  // 修复 .vue.ts 的路径
  if (!__CJS__) return

  // 1. resolve tsconfig.json
  const configPath = ts.findConfigFile(containingFile, fs.fileExists)
  // 2. load tsconfig.json
  let tsCompilerOptions: TS.CompilerOptions
  let tsResolveCache: TS.ModuleResolutionCache | undefined
  if (configPath) {
    let configs: CachedConfig[]
    const normalizedConfigPath = normalizePath(configPath)
    const cached = tsConfigCache.get(normalizedConfigPath)
    if (!cached) {
      configs = loadTSConfig(configPath, ts, fs).map(config => ({ config }))
      tsConfigCache.set(normalizedConfigPath, configs)
    } else {
      configs = cached
    }
    let matchedConfig: CachedConfig | undefined
    if (configs.length === 1) {
      matchedConfig = configs[0]
    } else {
      // resolve which config matches the current file
      for (const c of configs) {
        const base = normalizePath(
          (c.config.options.pathsBasePath as string) ||
            dirname(c.config.options.configFilePath as string),
        )
        const included: string[] | undefined = c.config.raw?.include
        const excluded: string[] | undefined = c.config.raw?.exclude
        if (
          (!included && (!base || containingFile.startsWith(base))) ||
          included?.some(p => isMatch(containingFile, joinPaths(base, p)))
        ) {
          if (
            excluded &&
            excluded.some(p => isMatch(containingFile, joinPaths(base, p)))
          ) {
            continue
          }
          matchedConfig = c
          break
        }
      }
      if (!matchedConfig) {
        matchedConfig = configs[configs.length - 1]
      }
    }
    tsCompilerOptions = matchedConfig.config.options
    tsResolveCache =
      matchedConfig.cache ||
      (matchedConfig.cache = ts.createModuleResolutionCache(
        process.cwd(),
        createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames),
        tsCompilerOptions,
      ))
  } else {
    tsCompilerOptions = {}
  }

  // 3. resolve
  const res = ts.resolveModuleName(
    source,
    containingFile,
    tsCompilerOptions,
    fs,
    tsResolveCache,
  )

  if (res.resolvedModule) {
    let filename = res.resolvedModule.resolvedFileName
    if (filename.endsWith('.vue.ts')) {
      filename = filename.replace(/\.ts$/, '')
    }
    return fs.realpath ? fs.realpath(filename) : filename
  }
}

// 解析 tsconfig.json（支持 projectReferences），并形成缓存结构。
// 支持多个 tsconfig 层级嵌套
// 使用 ts.parseJsonConfigFileContent
function loadTSConfig(
  configPath: string,
  ts: typeof TS,
  fs: FS,
  visited = new Set<string>(),
): TS.ParsedCommandLine[] {
  // The only case where `fs` is NOT `ts.sys` is during tests.
  // parse config host requires an extra `readDirectory` method
  // during tests, which is stubbed.
  const parseConfigHost = __TEST__
    ? {
        ...fs,
        useCaseSensitiveFileNames: true,
        readDirectory: () => [],
      }
    : ts.sys
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, fs.readFile).config,
    parseConfigHost,
    dirname(configPath),
    undefined,
    configPath,
  )
  const res = [config]
  visited.add(configPath)
  if (config.projectReferences) {
    for (const ref of config.projectReferences) {
      const refPath = ts.resolveProjectReferencePath(ref)
      if (visited.has(refPath) || !fs.fileExists(refPath)) {
        continue
      }
      tsConfigRefMap.set(refPath, configPath)
      res.unshift(...loadTSConfig(refPath, ts, fs, visited))
    }
  }
  return res
}

const fileToScopeCache = createCache<TypeScope>()

/**
 * @private
 */
// 清除某个文件的类型缓存（常用于热更新、调试或重编译）。
export function invalidateTypeCache(filename: string): void {
  filename = normalizePath(filename)
  fileToScopeCache.delete(filename)
  tsConfigCache.delete(filename)
  const affectedConfig = tsConfigRefMap.get(filename)
  if (affectedConfig) tsConfigCache.delete(affectedConfig)
}

// 将一个文件内容（.ts, .tsx, .vue）解析成 Vue 编译器的 TypeScope（自定义类型作用域结构）。
export function fileToScope(
  ctx: TypeResolveContext,
  filename: string,
  asGlobal = false,
): TypeScope {
  const cached = fileToScopeCache.get(filename)
  if (cached) {
    return cached
  }
  // fs should be guaranteed to exist here
  const fs = resolveFS(ctx)!
  const source = fs.readFile(filename) || ''
  const body = parseFile(filename, source, ctx.options.babelParserPlugins)
  const scope = new TypeScope(filename, source, 0, recordImports(body))
  recordTypes(ctx, body, scope, asGlobal)
  fileToScopeCache.set(filename, scope)
  return scope
}

// 对不同文件类型执行解析逻辑：
// .ts / .tsx → Babel parser
// .vue → 提取 <script> 和 <script setup> 块，拼接为一段 JS/TS，统一解析
function parseFile(
  filename: string,
  content: string,
  parserPlugins?: SFCScriptCompileOptions['babelParserPlugins'],
): Statement[] {
  const ext = extname(filename)
  if (ext === '.ts' || ext === '.mts' || ext === '.tsx' || ext === '.mtsx') {
    return babelParse(content, {
      plugins: resolveParserPlugins(
        ext.slice(1),
        parserPlugins,
        /\.d\.m?ts$/.test(filename),
      ),
      sourceType: 'module',
    }).program.body
  } else if (ext === '.vue') {
    const {
      descriptor: { script, scriptSetup },
    } = parse(content)
    if (!script && !scriptSetup) {
      return []
    }

    // ensure the correct offset with original source
    const scriptOffset = script ? script.loc.start.offset : Infinity
    const scriptSetupOffset = scriptSetup
      ? scriptSetup.loc.start.offset
      : Infinity
    const firstBlock = scriptOffset < scriptSetupOffset ? script : scriptSetup
    const secondBlock = scriptOffset < scriptSetupOffset ? scriptSetup : script

    let scriptContent =
      ' '.repeat(Math.min(scriptOffset, scriptSetupOffset)) +
      firstBlock!.content
    if (secondBlock) {
      scriptContent +=
        ' '.repeat(secondBlock.loc.start.offset - script!.loc.end.offset) +
        secondBlock.content
    }
    const lang = script?.lang || scriptSetup?.lang
    return babelParse(scriptContent, {
      plugins: resolveParserPlugins(lang!, parserPlugins),
      sourceType: 'module',
    }).program.body
  }
  return []
}

// 将当前上下文（SFC 的 ctx）转为 TypeScope。
// 用于在解析类型引用时提供上下文类型信息。
function ctxToScope(ctx: TypeResolveContext): TypeScope {
  if (ctx.scope) {
    return ctx.scope
  }

  const body =
    'ast' in ctx
      ? ctx.ast
      : ctx.scriptAst
        ? [...ctx.scriptAst.body, ...ctx.scriptSetupAst!.body]
        : ctx.scriptSetupAst!.body

  const scope = new TypeScope(
    ctx.filename,
    ctx.source,
    'startOffset' in ctx ? ctx.startOffset! : 0,
    'userImports' in ctx ? Object.create(ctx.userImports) : recordImports(body),
  )

  recordTypes(ctx, body, scope)

  return (ctx.scope = scope)
}

// 将 TS 命名空间（namespace A {}）转为 TypeScope，用于嵌套作用域支持。
function moduleDeclToScope(
  ctx: TypeResolveContext,
  node: TSModuleDeclaration & { _resolvedChildScope?: TypeScope },
  parentScope: TypeScope,
): TypeScope {
  if (node._resolvedChildScope) {
    return node._resolvedChildScope
  }

  const scope = createChildScope(parentScope)

  if (node.body.type === 'TSModuleDeclaration') {
    const decl = node.body as TSModuleDeclaration & WithScope
    decl._ownerScope = scope
    const id = getId(decl.id)
    scope.types[id] = scope.exportedTypes[id] = decl
  } else {
    recordTypes(ctx, node.body.body, scope)
  }

  return (node._resolvedChildScope = scope)
}

function createChildScope(parentScope: TypeScope) {
  return new TypeScope(
    parentScope.filename,
    parentScope.source,
    parentScope.offset,
    Object.create(parentScope.imports),
    Object.create(parentScope.types),
    Object.create(parentScope.declares),
  )
}

const importExportRE = /^Import|^Export/

// 遍历 AST 中的语句（statement），记录接口、枚举、类型别名、模块声明、类、变量类型声明等信息到作用域中。
// 功能亮点：
// 支持命名空间合并（mergeNamespaces）
// 支持 export, export default, export * from, export { A as B } 等 TS 导出语法
// 自动处理 _ownerScope 标记，建立作用域关系
function recordTypes(
  ctx: TypeResolveContext,
  body: Statement[],
  scope: TypeScope,
  asGlobal = false,
) {
  const { types, declares, exportedTypes, exportedDeclares, imports } = scope
  const isAmbient = asGlobal
    ? !body.some(s => importExportRE.test(s.type))
    : false
  for (const stmt of body) {
    if (asGlobal) {
      if (isAmbient) {
        if ((stmt as any).declare) {
          recordType(stmt, types, declares)
        }
      } else if (stmt.type === 'TSModuleDeclaration' && stmt.global) {
        for (const s of (stmt.body as TSModuleBlock).body) {
          recordType(s, types, declares)
        }
      }
    } else {
      recordType(stmt, types, declares)
    }
  }
  if (!asGlobal) {
    for (const stmt of body) {
      if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.declaration) {
          recordType(stmt.declaration, types, declares)
          recordType(stmt.declaration, exportedTypes, exportedDeclares)
        } else {
          for (const spec of stmt.specifiers) {
            if (spec.type === 'ExportSpecifier') {
              const local = spec.local.name
              const exported = getId(spec.exported)
              if (stmt.source) {
                // re-export, register an import + export as a type reference
                imports[exported] = {
                  source: stmt.source.value,
                  imported: local,
                }
                exportedTypes[exported] = {
                  type: 'TSTypeReference',
                  typeName: {
                    type: 'Identifier',
                    name: local,
                  },
                  _ownerScope: scope,
                }
              } else if (types[local]) {
                // exporting local defined type
                exportedTypes[exported] = types[local]
              }
            }
          }
        }
      } else if (stmt.type === 'ExportAllDeclaration') {
        const sourceScope = importSourceToScope(
          ctx,
          stmt.source,
          scope,
          stmt.source.value,
        )
        Object.assign(scope.exportedTypes, sourceScope.exportedTypes)
      } else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration) {
        if (stmt.declaration.type !== 'Identifier') {
          recordType(stmt.declaration, types, declares, 'default')
          recordType(
            stmt.declaration,
            exportedTypes,
            exportedDeclares,
            'default',
          )
        } else if (types[stmt.declaration.name]) {
          exportedTypes['default'] = types[stmt.declaration.name]
        }
      }
    }
  }
  for (const key of Object.keys(types)) {
    const node = types[key]
    node._ownerScope = scope
    if (node._ns) node._ns._ownerScope = scope
  }
  for (const key of Object.keys(declares)) {
    declares[key]._ownerScope = scope
  }
}

function recordType(
  node: Node,
  types: Record<string, Node>,
  declares: Record<string, Node>,
  overwriteId?: string,
) {
  switch (node.type) {
    case 'TSInterfaceDeclaration':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration': {
      const id = overwriteId || getId(node.id)
      let existing = types[id]
      if (existing) {
        if (node.type === 'TSModuleDeclaration') {
          if (existing.type === 'TSModuleDeclaration') {
            mergeNamespaces(existing as typeof node, node)
          } else {
            attachNamespace(existing, node)
          }
          break
        }
        if (existing.type === 'TSModuleDeclaration') {
          // replace and attach namespace
          types[id] = node
          attachNamespace(node, existing)
          break
        }

        if (existing.type !== node.type) {
          // type-level error
          break
        }
        if (node.type === 'TSInterfaceDeclaration') {
          ;(existing as typeof node).body.body.push(...node.body.body)
        } else {
          ;(existing as typeof node).members.push(...node.members)
        }
      } else {
        types[id] = node
      }
      break
    }
    case 'ClassDeclaration':
      if (overwriteId || node.id) types[overwriteId || getId(node.id!)] = node
      break
    case 'TSTypeAliasDeclaration':
      types[node.id.name] = node.typeParameters ? node : node.typeAnnotation
      break
    case 'TSDeclareFunction':
      if (node.id) declares[node.id.name] = node
      break
    case 'VariableDeclaration': {
      if (node.declare) {
        for (const decl of node.declarations) {
          if (decl.id.type === 'Identifier' && decl.id.typeAnnotation) {
            declares[decl.id.name] = (
              decl.id.typeAnnotation as TSTypeAnnotation
            ).typeAnnotation
          }
        }
      }
      break
    }
  }
}

function mergeNamespaces(to: TSModuleDeclaration, from: TSModuleDeclaration) {
  const toBody = to.body
  const fromBody = from.body
  if (toBody.type === 'TSModuleDeclaration') {
    if (fromBody.type === 'TSModuleDeclaration') {
      // both decl
      mergeNamespaces(toBody, fromBody)
    } else {
      // to: decl -> from: block
      fromBody.body.push({
        type: 'ExportNamedDeclaration',
        declaration: toBody,
        exportKind: 'type',
        specifiers: [],
      })
    }
  } else if (fromBody.type === 'TSModuleDeclaration') {
    // to: block <- from: decl
    toBody.body.push({
      type: 'ExportNamedDeclaration',
      declaration: fromBody,
      exportKind: 'type',
      specifiers: [],
    })
  } else {
    // both block
    toBody.body.push(...fromBody.body)
  }
}

function attachNamespace(
  to: Node & { _ns?: TSModuleDeclaration },
  ns: TSModuleDeclaration,
) {
  if (!to._ns) {
    to._ns = ns
  } else {
    mergeNamespaces(to._ns, ns)
  }
}

// 收集 import { Foo } from 'pkg' 等语句，将其注册进作用域中的 imports 映射表。
export function recordImports(body: Statement[]): Record<string, Import> {
  const imports: TypeScope['imports'] = Object.create(null)
  for (const s of body) {
    recordImport(s, imports)
  }
  return imports
}

function recordImport(node: Node, imports: TypeScope['imports']) {
  if (node.type !== 'ImportDeclaration') {
    return
  }
  for (const s of node.specifiers) {
    imports[s.local.name] = {
      imported: getImportedName(s),
      source: node.source.value,
    }
  }
}

// Vue SFC 编译器中关键的类型推导工具函数之一。它接收一个 TypeScript 类型节点（TSType），并将其转换为一个运行时代码中可用的类型标记字符串数组，例如：
// 'String'
// 'Number'
// 'Boolean'
// 'Array'
// 'Object'
// 'Function'
// 'null'
// 'Symbol'
// 这个结果将用于生成 Vue 的 props 选项中的 type 字段：
// props: {
//   foo: { type: String },
//   bar: { type: [Number, String] }
// }
export function inferRuntimeType(
  // ctx: 类型解析上下文
  // node: TS 类型节点（例如 TSStringKeyword、TSUnionType 等）
  // scope: 类型作用域（通常来自 _ownerScope，否则由 ctxToScope(ctx) 生成）
  // isKeyOf: 当前是否在 keyof 的上下文中（默认 false）
  ctx: TypeResolveContext,
  node: Node & MaybeWithScope,
  scope: TypeScope = node._ownerScope || ctxToScope(ctx),
  isKeyOf = false,
): string[] {
  try {
    // 逐类判断 TS 类型节点
    switch (node.type) {
      // 基础类型节点
      case 'TSStringKeyword':
        return ['String']
      case 'TSNumberKeyword':
        return ['Number']
      case 'TSBooleanKeyword':
        return ['Boolean']
      case 'TSObjectKeyword':
        return ['Object']
      case 'TSNullKeyword':
        return ['null']
      case 'TSTypeLiteral':
      case 'TSInterfaceDeclaration': {
        // 对象结构和接口：
        // 处理对象属性类型，支持普通字段和函数签名、索引签名等，根据是否是 keyof 语境推导出 String / Number / Object / Function 等。
        // TODO (nice to have) generate runtime property validation
        const types = new Set<string>()
        const members =
          node.type === 'TSTypeLiteral' ? node.members : node.body.body

        for (const m of members) {
          if (isKeyOf) {
            if (
              m.type === 'TSPropertySignature' &&
              m.key.type === 'NumericLiteral'
            ) {
              types.add('Number')
            } else if (m.type === 'TSIndexSignature') {
              const annotation = m.parameters[0].typeAnnotation
              if (annotation && annotation.type !== 'Noop') {
                const type = inferRuntimeType(
                  ctx,
                  annotation.typeAnnotation,
                  scope,
                )[0]
                if (type === UNKNOWN_TYPE) return [UNKNOWN_TYPE]
                types.add(type)
              }
            } else {
              types.add('String')
            }
          } else if (
            m.type === 'TSCallSignatureDeclaration' ||
            m.type === 'TSConstructSignatureDeclaration'
          ) {
            types.add('Function')
          } else {
            types.add('Object')
          }
        }

        return types.size
          ? Array.from(types)
          : [isKeyOf ? UNKNOWN_TYPE : 'Object']
      }
      case 'TSPropertySignature':
        if (node.typeAnnotation) {
          return inferRuntimeType(
            ctx,
            node.typeAnnotation.typeAnnotation,
            scope,
          )
        }
        break
      case 'TSMethodSignature':
      case 'TSFunctionType':
        // 函数类型：
        return ['Function']
      case 'TSArrayType':
      case 'TSTupleType':
        // 数组和元组：
        // TODO (nice to have) generate runtime element type/length checks
        return ['Array']

      case 'TSLiteralType':
        // 字面量类型（LiteralType）：
        switch (node.literal.type) {
          case 'StringLiteral':
            return ['String']
          case 'BooleanLiteral':
            return ['Boolean']
          case 'NumericLiteral':
          case 'BigIntLiteral':
            return ['Number']
          default:
            return [UNKNOWN_TYPE]
        }

      case 'TSTypeReference': {
        // 引用类型（TSTypeReference）：
        // 先通过 resolveTypeReference 尝试获取类型定义；
        // 再递归调用 inferRuntimeType 推导；
        // 特殊内建工具类型也支持，如：
        // Partial<T>, Readonly<T> → ['Object']
        // Parameters<F> → ['Array']
        // Uppercase<T> → ['String']
        const resolved = resolveTypeReference(ctx, node, scope)
        if (resolved) {
          return inferRuntimeType(ctx, resolved, resolved._ownerScope, isKeyOf)
        }

        if (node.typeName.type === 'Identifier') {
          if (isKeyOf) {
            switch (node.typeName.name) {
              case 'String':
              case 'Array':
              case 'ArrayLike':
              case 'Parameters':
              case 'ConstructorParameters':
              case 'ReadonlyArray':
                return ['String', 'Number']

              // TS built-in utility types
              case 'Record':
              case 'Partial':
              case 'Required':
              case 'Readonly':
                if (node.typeParameters && node.typeParameters.params[0]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[0],
                    scope,
                    true,
                  )
                }
                break
              case 'Pick':
              case 'Extract':
                if (node.typeParameters && node.typeParameters.params[1]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[1],
                    scope,
                  )
                }
                break

              case 'Function':
              case 'Object':
              case 'Set':
              case 'Map':
              case 'WeakSet':
              case 'WeakMap':
              case 'Date':
              case 'Promise':
              case 'Error':
              case 'Uppercase':
              case 'Lowercase':
              case 'Capitalize':
              case 'Uncapitalize':
              case 'ReadonlyMap':
              case 'ReadonlySet':
                return ['String']
            }
          } else {
            switch (node.typeName.name) {
              case 'Array':
              case 'Function':
              case 'Object':
              case 'Set':
              case 'Map':
              case 'WeakSet':
              case 'WeakMap':
              case 'Date':
              case 'Promise':
              case 'Error':
                return [node.typeName.name]

              // TS built-in utility types
              // https://www.typescriptlang.org/docs/handbook/utility-types.html
              case 'Partial':
              case 'Required':
              case 'Readonly':
              case 'Record':
              case 'Pick':
              case 'Omit':
              case 'InstanceType':
                return ['Object']

              case 'Uppercase':
              case 'Lowercase':
              case 'Capitalize':
              case 'Uncapitalize':
                return ['String']

              case 'Parameters':
              case 'ConstructorParameters':
              case 'ReadonlyArray':
                return ['Array']

              case 'ReadonlyMap':
                return ['Map']
              case 'ReadonlySet':
                return ['Set']

              case 'NonNullable':
                if (node.typeParameters && node.typeParameters.params[0]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[0],
                    scope,
                  ).filter(t => t !== 'null')
                }
                break
              case 'Extract':
                if (node.typeParameters && node.typeParameters.params[1]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[1],
                    scope,
                  )
                }
                break
              case 'Exclude':
              case 'OmitThisParameter':
                if (node.typeParameters && node.typeParameters.params[0]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[0],
                    scope,
                  )
                }
                break
            }
          }
        }
        // cannot infer, fallback to UNKNOWN: ThisParameterType
        break
      }

      case 'TSParenthesizedType':
        return inferRuntimeType(ctx, node.typeAnnotation, scope)

      case 'TSUnionType':
        // 联合类型（TSUnionType）：
        // 递归调用 flattenTypes 展开所有成员类型，并去重。
        return flattenTypes(ctx, node.types, scope, isKeyOf)
      case 'TSIntersectionType': {
        // 交叉类型（TSIntersectionType）：
        // 也使用 flattenTypes，但过滤掉 UNKNOWN_TYPE。
        return flattenTypes(ctx, node.types, scope, isKeyOf).filter(
          t => t !== UNKNOWN_TYPE,
        )
      }

      case 'TSEnumDeclaration':
        // 枚举类型：
        return inferEnumType(node)

      case 'TSSymbolKeyword':
        return ['Symbol']

      case 'TSIndexedAccessType': {
        // 索引访问类型（TSIndexedAccessType）：
        // 如 Props['foo']，会解析目标字段并递归推导。
        const types = resolveIndexType(ctx, node, scope)
        return flattenTypes(ctx, types, scope, isKeyOf)
      }

      case 'ClassDeclaration':
        return ['Object']

      // 导入类型 / 类型查询：
      // TSImportType → 从 import('xxx') 中导入类型再解析
      // TSTypeQuery  → typeof xxx，从 scope 中查找并递归推导
      case 'TSImportType': {
        const sourceScope = importSourceToScope(
          ctx,
          node.argument,
          scope,
          node.argument.value,
        )
        const resolved = resolveTypeReference(ctx, node, sourceScope)
        if (resolved) {
          return inferRuntimeType(ctx, resolved, resolved._ownerScope)
        }
        break
      }

      case 'TSTypeQuery': {
        const id = node.exprName
        if (id.type === 'Identifier') {
          // typeof only support identifier in local scope
          const matched = scope.declares[id.name]
          if (matched) {
            return inferRuntimeType(ctx, matched, matched._ownerScope, isKeyOf)
          }
        }
        break
      }

      // e.g. readonly
      case 'TSTypeOperator': {
        // 类型操作符：
        // TSTypeOperator → 如 `readonly T` 或 `keyof T`，递归解析 `T`
        return inferRuntimeType(
          ctx,
          node.typeAnnotation,
          scope,
          node.operator === 'keyof',
        )
      }

      case 'TSAnyKeyword': {
        // 任意类型（TSAnyKeyword）：
        // keyof any → 返回 ['String', 'Number', 'Symbol']
        if (isKeyOf) {
          return ['String', 'Number', 'Symbol']
        }
        break
      }
    }
  } catch (e) {
    // always soft fail on failed runtime type inference
  }
  // 其他 / 未识别 / 错误：
  // 默认返回 [UNKNOWN_TYPE]，表示该类型无法静态推导成 Vue 支持的 runtime 类型。
  return [UNKNOWN_TYPE] // no runtime check
}

// 将多个 TypeScript 类型节点（TSType[]）统一转换为一个字符串数组形式的运行时类型表示（如 "String"、"Number" 等），并去重。
// 常用于 defineProps<T>() 或枚举推断等场景中，把类型节点解析为 Vue runtime 需要的类型标记。
function flattenTypes(
  // ctx: 类型解析上下文，用于类型处理和报错信息。
  // types: 一个类型节点数组，可能是联合类型、交叉类型的组成部分。
  // scope: 当前的类型作用域。
  // isKeyOf: 是否是 keyof 上下文，用于 inferRuntimeType 的特殊处理（默认 false）。
  ctx: TypeResolveContext,
  types: TSType[],
  scope: TypeScope,
  isKeyOf: boolean = false,
): string[] {
  // 如果只有一个类型，直接调用 inferRuntimeType 获取其运行时类型
  if (types.length === 1) {
    return inferRuntimeType(ctx, types[0], scope, isKeyOf)
  }
  // 如果是多个类型（如联合类型），对每个类型调用 inferRuntimeType，将返回的数组展开、合并，并通过 Set 去重：
  return [
    ...new Set(
      ([] as string[]).concat(
        ...types.map(t => inferRuntimeType(ctx, t, scope, isKeyOf)),
      ),
    ),
  ]
}

// 从一个 TypeScript 的枚举定义（TSEnumDeclaration）中推断出枚举成员的值类型，用于后续生成 prop 类型时判断是 String 还是 Number。
function inferEnumType(node: TSEnumDeclaration): string[] {
  // node: 一个 TS 枚举声明节点（TSEnumDeclaration），例如：
  // enum Color {
  //   Red = 1,
  //   Blue = 2
  // }
  // enum Status {
  //   Success = 'success',
  //   Fail = 'fail'
  // }

  // 创建一个 Set 集合 types 用于收集成员的类型（去重）：
  const types = new Set<string>()
  // 遍历枚举的所有成员：
  for (const m of node.members) {
    if (m.initializer) {
      // 检查每个成员是否有初始值（initializer）：
      // 如果初始值是字符串字面量（StringLiteral），添加 'String'
      // 如果初始值是数字字面量（NumericLiteral），添加 'Number'
      switch (m.initializer.type) {
        case 'StringLiteral':
          types.add('String')
          break
        case 'NumericLiteral':
          types.add('Number')
          break
      }
    }
  }
  // 遍历完成后，返回收集到的类型数组：
  // 如果所有成员都没有初始值（也就是默认情况下），按照 TypeScript 的默认行为认为是数字枚举，因此返回 ['Number']。
  return types.size ? [...types] : ['Number']
}

/**
 * support for the `ExtractPropTypes` helper - it's non-exhaustive, mostly
 * tailored towards popular component libs like element-plus and antd-vue.
 */
// 处理 Vue 中对 ExtractPropTypes 工具类型的支持，将 ExtractPropTypes<typeof somePropOptions> 的结构还原为一组静态的 TS 类型成员。
// 它主要用于兼容一些 UI 组件库（如 Element Plus、Ant Design Vue）中常用的 prop 定义形式。
function resolveExtractPropTypes(
  // props: 来自 ResolvedElements，表示类型定义中提取出来的所有 props 字段（每个字段是一个 TS AST 节点）。
  // scope: 当前类型的作用域，用于辅助解析泛型、引用类型等。
  { props }: ResolvedElements,
  scope: TypeScope,
): ResolvedElements {
  // 创建一个空的 ResolvedElements 结构，初始化 res.props = {}。
  const res: ResolvedElements = { props: {} }
  // 遍历传入的 props 每个字段（即来自 defineProps 的类型结构）：
  for (const key in props) {
    // 对每个 prop 字段，提取其 TS 类型信息：
    const raw = props[key]
    // 这里的 raw.typeAnnotation.typeAnnotation 是提取 prop 类型的精确部分，例如：
    // foo: {
    //   type: StringConstructor
    // }
    // 对应的类型节点结构是：
    // typeAnnotation (外层)
    // typeAnnotation (内层) → TSTypeReference → StringConstructor
    // 通过调用 reverseInferType(...)，把类似 { type: XXX } 的结构转为标准的 TSPropertySignature 类型字段。
    // 返回新的 ResolvedElements，它的 props 中的每一项都变成了具备静态类型定义的 prop 节点，可以用于生成 prop 校验或类型补全。
    res.props[key] = reverseInferType(
      raw.key,
      raw.typeAnnotation!.typeAnnotation,
      scope,
    )
  }
  return res
}

// 该函数用于“反向推断”某个 prop 的类型。
// 常用于 Vue 编译器将 runtime props 写法（如 props: { foo: String } 或 props: { bar: { type: Number, required: true } }）
// 转换为静态类型节点（TS AST）用于生成类型声明或用于类型推断。
// 这个函数是 runtime → type 转换的桥梁，能自动识别 Vue props 写法中的各种结构（包括简写构造函数、对象形式、PropType 封装等），
// 并将其转为静态类型节点，便于类型推断、代码补全、类型校验等用途。
function reverseInferType(
  // key: 属性名（可以是字符串、标识符等）
  // node: 当前被推断的 TS 类型节点
  // scope: 当前类型所在作用域
  // optional: 是否是可选的 prop（默认为 true）
  // checkObjectSyntax: 是否启用“对象语法结构”的识别（默认启用）
  key: Expression,
  node: TSType,
  scope: TypeScope,
  optional = true,
  checkObjectSyntax = true,
): TSPropertySignature & WithScope {
  if (checkObjectSyntax && node.type === 'TSTypeLiteral') {
    // check { type: xxx }
    // 如果启用了 checkObjectSyntax，并且类型是 TSTypeLiteral，则尝试从中提取 type 和 required 字段：
    const typeType = findStaticPropertyType(node, 'type')
    if (typeType) {
      // 如果存在 type 字段，递归调用 reverseInferType 来处理其 type 指向的类型。
      // 如果还存在 required: false，将 optional 设置为 true（反向逻辑）。
      const requiredType = findStaticPropertyType(node, 'required')
      const optional =
        requiredType &&
        requiredType.type === 'TSLiteralType' &&
        requiredType.literal.type === 'BooleanLiteral'
          ? !requiredType.literal.value
          : true
      return reverseInferType(key, typeType, scope, optional, false)
    }
  } else if (
    node.type === 'TSTypeReference' &&
    node.typeName.type === 'Identifier'
  ) {
    // 识别构造函数写法，如 StringConstructor、NumberConstructor：
    // 如果类型是 TSTypeReference，且类型名是 Identifier
    if (node.typeName.name.endsWith('Constructor')) {
      return createProperty(
        key,
        ctorToType(node.typeName.name),
        scope,
        optional,
      )
    } else if (node.typeName.name === 'PropType' && node.typeParameters) {
      // 如果类型是 PropType<T>，并且带有类型参数：
      // 直接提取 T，再构造属性类型。
      // PropType<{}>
      return createProperty(key, node.typeParameters.params[0], scope, optional)
    }
  }
  if (
    (node.type === 'TSTypeReference' || node.type === 'TSImportType') &&
    node.typeParameters
  ) {
    // 对于形如 Foo.Bar<StringConstructor> 之类的嵌套泛型：
    // try if we can catch Foo.Bar<XXXConstructor>
    // 遍历参数中的每一个类型节点，递归推断，如果有一个能成功推断就返回。
    for (const t of node.typeParameters.params) {
      const inferred = reverseInferType(key, t, scope, optional)
      if (inferred) return inferred
    }
  }
  // 如果都不符合，返回类型为 null 的 prop，作为保底：
  return createProperty(key, { type: `TSNullKeyword` }, scope, optional)
}

// 将一个构造函数名称（例如 "StringConstructor"）转换为对应的 TypeScript 类型节点（TSType）。
// ctorType: 构造函数类型的字符串名称，如 "StringConstructor"、"ArrayConstructor" 等。
function ctorToType(ctorType: string): TSType {
  // 去掉尾部的 "Constructor" 字符串，提取出类型名部分：
  const ctor = ctorType.slice(0, -11)
  switch (ctor) {
    case 'String':
    case 'Number':
    case 'Boolean':
      // 如果是 "String"、"Number" 或 "Boolean"，直接返回对应的 TSStringKeyword、TSNumberKeyword、TSBooleanKeyword 类型节点：
      return { type: `TS${ctor}Keyword` }
    case 'Array':
    case 'Function':
    case 'Object':
    case 'Set':
    case 'Map':
    case 'WeakSet':
    case 'WeakMap':
    case 'Date':
    case 'Promise':
      // 如果是数组、函数、对象、集合类等复杂结构，返回 TSTypeReference 类型节点
      return {
        type: 'TSTypeReference',
        typeName: { type: 'Identifier', name: ctor },
      }
  }
  // fallback to null
  // 无法识别的类型：
  // 默认返回 TSNullKeyword 作为兜底，表示类型无法解析时的空类型。
  return { type: `TSNullKeyword` }
}

// 在一个 TypeScript 的类型字面量（TSTypeLiteral）节点中查找某个静态属性的类型定义，并返回该属性的类型节点。
// node: 一个 TSTypeLiteral 类型节点，对应 TypeScript 中的对象类型，如：
// type Props = {
//   foo: string
//   bar?: number
// }
// key: 要查找的属性名，例如 "foo"、"bar"。
function findStaticPropertyType(node: TSTypeLiteral, key: string) {
  // 遍历 node.members 数组，查找满足以下条件的成员（属性）：
  // 成员是 TSPropertySignature 类型；
  // 成员不是计算属性（[key]: value 这种会跳过）；
  // 成员的 key 与传入的 key 匹配（使用 getId() 获取标识符或字符串）；
  // 成员有类型注解（typeAnnotation）；
  const prop = node.members.find(
    m =>
      m.type === 'TSPropertySignature' &&
      !m.computed &&
      getId(m.key) === key &&
      m.typeAnnotation,
  )
  // 如果找到了符合条件的属性，返回它的类型节点（即 typeAnnotation.typeAnnotation）：
  return prop && prop.typeAnnotation!.typeAnnotation
}

// 尝试解析一个类型表达式或引用，获取它的“返回值类型”，通常用于处理像 ReturnType<typeof someFn> 这样的结构。
function resolveReturnType(
  // ctx: 当前类型解析上下文（提供错误处理、作用域信息等）
  // arg: 类型表达式节点，可能是函数引用、函数类型、typeof 表达式等
  // scope: 当前类型所在作用域，用于查找类型定义或导入
  ctx: TypeResolveContext,
  arg: Node,
  scope: TypeScope,
) {
  // 初始赋值：默认将 arg 本身当作已解析的类型节点：
  let resolved: Node | undefined = arg
  if (
    arg.type === 'TSTypeReference' ||
    arg.type === 'TSTypeQuery' ||
    arg.type === 'TSImportType'
  ) {
    // 判断是否是引用类的类型节点（需解析）：
    // TSTypeReference：类型引用，如 Foo
    // TSTypeQuery：类型查询，如 typeof bar
    // TSImportType：动态导入类型，如 import('vue').Something
    // 如果是以上类型，尝试使用 resolveTypeReference() 解析它，获取实际类型定义：
    resolved = resolveTypeReference(ctx, arg, scope)
  }
  // 解析失败则返回 undefined：
  if (!resolved) return
  if (resolved.type === 'TSFunctionType') {
    // 如果解析结果是一个函数类型（TSFunctionType），例如：
    // type Fn = () => number
    // 就返回它的返回值类型：
    return resolved.typeAnnotation?.typeAnnotation
  }
  if (resolved.type === 'TSDeclareFunction') {
    // 如果类型是 TSDeclareFunction（即 declare function foo(): number），则直接取其 returnType：
    // return resolved.returnType
    return resolved.returnType
  }
}

// 用于解析 TypeScript 中的联合类型（TSUnionType），并返回其组成的基本类型节点数组。
export function resolveUnionType(
  ctx: TypeResolveContext,
  node: Node & MaybeWithScope & { _resolvedElements?: ResolvedElements },
  scope?: TypeScope,
): Node[] {
  if (node.type === 'TSTypeReference') {
    // 如果传入的节点是 TSTypeReference 类型，表示这是一个类型的引用，例如 type A = B。
    // 使用 resolveTypeReference 函数尝试解析该类型引用，获取其实际定义。
    // 如果成功解析，则将 node 更新为解析后的结果。
    const resolved = resolveTypeReference(ctx, node, scope)
    if (resolved) node = resolved
  }

  let types: Node[]
  if (node.type === 'TSUnionType') {
    // 如果更新后的 node 是 TSUnionType 类型，表示这是一个联合类型，例如 type A = B | C。
    // 对其每个组成类型（node.types）递归调用 resolveUnionType，将结果扁平化为一个数组。
    types = node.types.flatMap(node => resolveUnionType(ctx, node, scope))
  } else {
    // 如果 node 不是联合类型，表示这是一个基本类型，直接将其放入数组中。
    types = [node]
  }

  // 示例：
  // 假设有以下类型定义：
  // type A = B | C;
  // type B = D | E;
  // type C = F;
  // 调用 resolveUnionType 解析类型 A，将会得到 [D, E, F] 这三个基本类型节点的数组。
  return types
}
