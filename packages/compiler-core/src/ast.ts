import { type PatchFlags, isString } from '@vue/shared'
import {
  CREATE_BLOCK,
  CREATE_ELEMENT_BLOCK,
  CREATE_ELEMENT_VNODE,
  type CREATE_SLOTS,
  CREATE_VNODE,
  type FRAGMENT,
  OPEN_BLOCK,
  type RENDER_LIST,
  type RENDER_SLOT,
  WITH_DIRECTIVES,
  type WITH_MEMO,
} from './runtimeHelpers'
import type { PropsExpression } from './transforms/transformElement'
import type { ImportItem, TransformContext } from './transform'
import type { Node as BabelNode } from '@babel/types'

// Vue template is a platform-agnostic superset of HTML (syntax only).
// More namespaces can be declared by platform specific compilers.

// Vue 模板是一种平台无关的 HTML 超集（仅语法方面）。
// 意思是它在 HTML 的基础上扩展了一些语法特性，
// 但并不绑定于某一个平台（例如浏览器、Weex、小程序等）。
// 各个平台可以在自己的编译器中声明更多的命名空间（namespace），
// 用于处理平台特定的标签或特性。
export type Namespace = number

// 定义一个枚举类型 Namespaces，用于标识模板中元素所属的命名空间。
// 这在解析模板时非常重要，因为不同命名空间的元素（如 SVG 或 MathML）
// 可能有不同的解析规则或渲染行为。
export enum Namespaces {
  // HTML 命名空间：大多数常见的标签（如 div、span、p 等）都属于 HTML 命名空间。
  HTML,
  // SVG 命名空间：用于解析 <svg> 标签及其内部的所有 SVG 元素。
  // SVG 有自己的一套元素和属性，不能按照普通 HTML 来处理。
  SVG,
  // MathML 命名空间：用于解析数学标记语言 <math> 及其内部标签。
  // Vue 不常用 MathML，但这里预留了空间支持。
  MATH_ML,
}

// AST 节点类型定义，用于标识每个节点的具体类型
export enum NodeTypes {
  ROOT, // 整个模板的根节点
  ELEMENT, // 普通的 HTML 或自定义组件元素节点，例如 <div>、<MyComponent>
  TEXT, // 文本节点，例如纯文本 "hello"
  COMMENT, // 注释节点，例如 <!-- some comment -->
  SIMPLE_EXPRESSION, // 简单表达式，例如 foo 或 'bar'，不含复合逻辑
  INTERPOLATION, // 插值表达式，例如 {{ message }}
  ATTRIBUTE, // 属性节点，例如 class="main"
  DIRECTIVE, // 指令节点，例如 v-if="ok"，v-bind:href="url"
  // containers
  COMPOUND_EXPRESSION, // 复合表达式，例如 message + ' world'，由多个子表达式拼接而成
  IF, // v-if 指令的主节点
  IF_BRANCH, // v-if / v-else-if / v-else 的分支结构
  FOR, // v-for 的主节点
  TEXT_CALL, // 包装文本节点的 codegen 节点，用于处理动态文本插值
  // codegen
  VNODE_CALL, // 虚拟节点调用，例如 createVNode(...)，最终用于生成渲染函数

  // 以下为 JS AST 节点，用于 codegen 阶段生成 JS 代码
  JS_CALL_EXPRESSION, // 函数调用表达式，例如 fn(...)
  JS_OBJECT_EXPRESSION, // 对象字面量表达式，例如 { id: foo }
  JS_PROPERTY, // 对象中的属性，例如 id: foo
  JS_ARRAY_EXPRESSION, // 数组表达式，例如 [foo, bar]
  JS_FUNCTION_EXPRESSION, // 函数表达式，例如 () => {}
  JS_CONDITIONAL_EXPRESSION, // 条件表达式，例如 ok ? foo : bar
  JS_CACHE_EXPRESSION, // 缓存表达式，用于优化静态内容

  // ssr codegen
  // 以下为 SSR（服务端渲染）相关的 JS 节点类型
  JS_BLOCK_STATEMENT, // 代码块，例如 { ... }
  JS_TEMPLATE_LITERAL, // 模板字符串，例如 \`${foo}\`
  JS_IF_STATEMENT, // if 语句，例如 if (ok) { ... }
  JS_ASSIGNMENT_EXPRESSION, // 赋值表达式，例如 a = b
  JS_SEQUENCE_EXPRESSION, // 表达式序列，例如 (a, b, c)
  JS_RETURN_STATEMENT, // return 语句，例如 return a
}

// 用于细分 ELEMENT 类型节点的具体种类
export enum ElementTypes {
  // 普通 HTML 元素，例如 <div>、<p>、<span>
  ELEMENT,
  // 组件标签，例如 <MyComponent>（包括动态组件 <component :is="...">）
  COMPONENT,
  // 插槽标签，例如 <slot>
  SLOT,
  // template 标签，例如 <template v-if="ok">、<template v-for="..."> 等
  TEMPLATE,
}

// 所有 AST 节点的基础结构定义
export interface Node {
  // 节点的类型，对应 NodeTypes 枚举中的值，例如 ELEMENT、TEXT、INTERPOLATION 等
  type: NodeTypes
  // 节点在源码中的位置信息，用于报错提示、高亮等开发者工具功能
  loc: SourceLocation
}

// The node's range. The `start` is inclusive and `end` is exclusive.
// [start, end)
// 节点在源码中的范围。
// `start` 是起始位置（包含该位置），`end` 是结束位置（不包含该位置）。
// 即范围是左闭右开区间：[start, end)
export interface SourceLocation {
  // 节点开始的位置
  start: Position
  // 节点结束的位置
  end: Position
  // 节点在源码中对应的原始字符串片段，例如 "<div>" 或 "{{ msg }}"
  source: string
}

export interface Position {
  // 从整个文件开始算起的字符偏移量（第一个字符是 offset = 0）
  offset: number // from start of file
  // 所在的行号，从 1 开始计数（第 1 行是 line = 1）
  line: number
  // 当前行内的字符列数，从 0 开始计数（行首是 column = 0）
  column: number
}

export type ParentNode = RootNode | ElementNode | IfBranchNode | ForNode

export type ExpressionNode = SimpleExpressionNode | CompoundExpressionNode

export type TemplateChildNode =
  | ElementNode
  | InterpolationNode
  | CompoundExpressionNode
  | TextNode
  | CommentNode
  | IfNode
  | IfBranchNode
  | ForNode
  | TextCallNode

// RootNode 表示整个模板的 AST 根节点，是最顶层的节点。
// 它扩展自基础的 Node 接口（含 type 和 loc 字段）
export interface RootNode extends Node {
  // 必须是 ROOT 类型
  type: NodeTypes.ROOT
  // 原始模板字符串（通常是整个 <template> 的内容）
  source: string
  // 根节点的直接子节点们，包含元素、插值、文本等（统一叫 TemplateChildNode）
  children: TemplateChildNode[]
  // 编译过程中用到的辅助函数（helpers），例如 toDisplayString、createVNode 等
  // 用 symbol 标识，每个 helper 都是 runtime 中的一个函数
  helpers: Set<symbol>
  // 模板中使用到的组件名称（字符串数组），例如 ['MyComponent']
  components: string[]
  // 模板中使用到的指令名称，例如 ['v-model', 'v-show']
  directives: string[]
  // 用于静态提升的表达式（hoist），提升到渲染函数外部
  // 每一项可能是 JS 表达式，也可能是 null（没用上）
  hoists: (JSChildNode | null)[]
  // 编译过程中生成的 import 语句
  imports: ImportItem[]
  // 缓存的表达式（v-once 或优化的复杂表达式）
  cached: (CacheExpression | null)[]
  // 临时变量计数，用于生成唯一的 temp 变量名
  temps: number
  // SSR 模式下使用的辅助函数
  ssrHelpers?: symbol[]
  // 最终生成的 codegen 根节点，可能是模板节点、JS 表达式、或者 BlockStatement
  codegenNode?: TemplateChildNode | JSChildNode | BlockStatement
  // 是否已经经过 transform 阶段处理
  transformed?: boolean

  // v2 compat only
  // （仅用于 Vue 2 兼容）记录过滤器名称
  filters?: string[]
}

export type ElementNode =
  | PlainElementNode
  | ComponentNode
  | SlotOutletNode
  | TemplateNode

export interface BaseElementNode extends Node {
  // AST 中的元素节点结构（type === NodeTypes.ELEMENT）
  type: NodeTypes.ELEMENT
  // 命名空间，用于判断是 HTML、SVG、MathML 等，参考 Namespaces 枚举
  ns: Namespace
  // 标签名称，例如 'div'、'span'、'MyComponent'
  tag: string
  // 标签类型，来自 ElementTypes 枚举，用于区分 HTML 元素、组件、<slot>、<template>
  tagType: ElementTypes
  // 标签上的属性列表，包含普通属性（AttributeNode）和指令（DirectiveNode）
  // 例如 class="foo"、v-if="ok"、:title="msg"
  props: Array<AttributeNode | DirectiveNode>
  // 子节点数组，例如子元素、文本、插值等
  children: TemplateChildNode[]
  // 是否自闭合标签，例如 <img />, <br />，会影响 codegen 阶段
  isSelfClosing?: boolean
  // 仅用于单文件组件 (SFC) 的顶层元素
  // innerLoc 表示标签的内部位置（即 <div>xxx</div> 中 xxx 的范围）
  innerLoc?: SourceLocation // only for SFC root level elements
}

// PlainElementNode 表示模板中最常见的“普通 HTML 元素”节点。
// 它继承了 BaseElementNode 的通用结构，并额外指定 tagType 和 codegenNode。
export interface PlainElementNode extends BaseElementNode {
  // 明确标识该节点是 HTML 元素，不是组件、slot、template
  tagType: ElementTypes.ELEMENT

  // 用于渲染函数生成阶段的节点（codegen 阶段）
  // 有几种不同的情况：

  // 1. 正常情况下生成 VNodeCall（createVNode 调用）
  // 2. 被静态提升时是一个简单表达式（SimpleExpressionNode）
  // 3. 被 v-once 缓存时是一个 CacheExpression
  // 4. 被 v-memo 缓存时是一个 MemoExpression
  // 5. 还未生成时是 undefined
  codegenNode:
    | VNodeCall
    | SimpleExpressionNode // when hoisted
    | CacheExpression // when cached by v-once
    | MemoExpression // when cached by v-memo
    | undefined

  // 如果是 SSR 渲染，使用 SSR 的生成节点（字符串模板）
  ssrCodegenNode?: TemplateLiteral
}

// ComponentNode 表示模板中的组件节点，例如 <MyComponent />
// 继承自 BaseElementNode，适用于 tagType 为 COMPONENT 的节点
export interface ComponentNode extends BaseElementNode {
  // 明确这个节点的类型是组件（非 HTML 元素、<slot>、<template>）
  tagType: ElementTypes.COMPONENT

  // 这个字段是编译器 codegen 阶段生成渲染函数用的中间节点
  // 有以下几种情况：

  // - 普通情况下是 VNodeCall，表示 createVNode() 的调用
  // - 被 v-once 缓存时，会变成 CacheExpression
  // - 被 v-memo 缓存时，会变成 MemoExpression
  // - 初始状态（还未 codegen）时可能是 undefined
  codegenNode:
    | VNodeCall
    | CacheExpression // when cached by v-once
    | MemoExpression // when cached by v-memo
    | undefined

  // 如果是 SSR 渲染模式，生成的将是函数调用表达式（例如 ssrRenderComponent(...)）
  ssrCodegenNode?: CallExpression
}

// SlotOutletNode 表示模板中的 <slot> 标签节点
// 继承自 BaseElementNode，限定 tagType 为 SLOT
export interface SlotOutletNode extends BaseElementNode {
  // 表明这是一个 <slot> 插槽标签节点（而不是普通元素或组件）
  tagType: ElementTypes.SLOT

  // 渲染函数生成阶段的节点
  // - 通常是 RenderSlotCall，表示调用 renderSlot() 函数
  // - 被 v-once 缓存时，会是 CacheExpression
  // - 尚未生成 codegen 节点时是 undefined
  codegenNode:
    | RenderSlotCall
    | CacheExpression // when cached by v-once
    | undefined

  // SSR 模式下，插槽对应的函数调用节点
  ssrCodegenNode?: CallExpression
}

// TemplateNode 用来表示 <template> 标签节点
// 继承自 BaseElementNode，指定 tagType 为 TEMPLATE
export interface TemplateNode extends BaseElementNode {
  // 表明这是一个 <template> 容器标签
  tagType: ElementTypes.TEMPLATE

  // TemplateNode is a container type that always gets compiled away
  // <template> 是一个“结构标签”，本身不会生成任何渲染代码，
  // 所以它在 codegen 阶段不会有对应的 vnode，也就没有 codegenNode
  codegenNode: undefined
}

// TextNode 表示模板中的“纯文本”节点。
// 例如 <div>Hello World</div> 中的 "Hello World" 就是一个 TextNode。
export interface TextNode extends Node {
  // 节点类型固定为 TEXT
  type: NodeTypes.TEXT

  // 文本的具体内容，例如 "Hello World"
  content: string
}

// CommentNode 表示模板中的 HTML 注释节点，例如 <!-- some comment -->
export interface CommentNode extends Node {
  // 节点类型固定为 COMMENT
  type: NodeTypes.COMMENT
  // 注释的内容，不包含 <!-- 和 -->
  content: string
}

// AttributeNode 表示静态属性节点，例如 class="foo"、id="main"
export interface AttributeNode extends Node {
  // 节点类型，固定为 ATTRIBUTE
  type: NodeTypes.ATTRIBUTE
  // 属性名称，例如 "class"、"id"
  name: string
  // 属性名称在源码中的位置（用于报错提示、source map）
  nameLoc: SourceLocation
  // 属性值，是一个 TextNode，或者 undefined（表示无值，如 <input disabled>）
  value: TextNode | undefined
}

// DirectiveNode 表示 Vue 模板中的指令节点（v- 系列，或其简写）
// 例如：v-if="ok"、:title="msg"、@click="doSomething"
export interface DirectiveNode extends Node {
  // 节点类型固定为 DIRECTIVE
  type: NodeTypes.DIRECTIVE

  /**
   * the normalized name without prefix or shorthands, e.g. "bind", "on"
   */
  /**
   * 指令的标准化名称，不带 v-、:、@ 这些前缀。
   * 例如：v-bind:title → "bind"，@click → "on"，v-if → "if"
   */
  name: string

  /**
   * the raw attribute name, preserving shorthand, and including arg & modifiers
   * this is only used during parse.
   */
  /**
   * 原始属性名，保留前缀和修饰符（只在 parse 阶段使用）
   * 例如：@click.stop、v-bind:title.sync
   */
  rawName?: string

  /**
   * 指令的表达式部分（等号右侧）
   * 例如：v-if="ok" 中的 "ok"
   * 可能是一个复杂表达式节点，也可能是 undefined（比如 v-on:click）
   */
  exp: ExpressionNode | undefined

  /**
   * 指令的参数（冒号后）
   * 例如：v-bind:title → "title"，v-on:click → "click"
   * 可能是动态参数（例如 v-bind:[dynamicKey]）
   */
  arg: ExpressionNode | undefined

  /**
   * 指令的修饰符（如 .stop、.sync 等），会被解析为字符串表达式节点
   */
  modifiers: SimpleExpressionNode[]
  /**
   * optional property to cache the expression parse result for v-for
   */
  /**
   * v-for 特有：缓存 v-for 表达式解析的结果（解析后的源、alias、index 等）
   */
  forParseResult?: ForParseResult
}

/**
 * Static types have several levels.
 * Higher levels implies lower levels. e.g. a node that can be stringified
 * can always be hoisted and skipped for patch.
 */
/**
 * 静态节点的常量等级（ConstantTypes）定义
 * 等级越高，意味着节点越“静态”，优化空间越大。
 *
 * 高等级隐含低等级能力：
 * 例如：能被字符串化（CAN_STRINGIFY）的节点，必然也能被缓存（CAN_CACHE）和跳过 patch。
 */
export enum ConstantTypes {
  // 不是静态的，不能做任何优化
  NOT_CONSTANT = 0,
  // 是静态的，但只能跳过 patch，不可缓存也不可字符串化
  // 例如：某些 class="xxx" 或 style 不含动态绑定的属性
  CAN_SKIP_PATCH,
  // 可以被缓存，例如 hoist 到模板外，只计算一次
  // 对于性能有明显提升，通常用于静态 vnode 或 props
  CAN_CACHE,

  // 可以直接字符串化（序列化为静态字符串），
  // 通常用于 SSR、静态文本/HTML 等，不依赖任何运行时计算
  CAN_STRINGIFY,
}

// SimpleExpressionNode 表示一个“简单表达式”，
// 是 AST 中表达式节点的一种，比如 "msg"、"user.name"、"count + 1"
export interface SimpleExpressionNode extends Node {
  // 类型为 SIMPLE_EXPRESSION
  type: NodeTypes.SIMPLE_EXPRESSION

  // 表达式的文本内容（原始字符串）
  content: string

  // 是否是静态表达式（例如 "true"、"hello" 是静态的，而 "user.name" 是动态的）
  isStatic: boolean

  // 表达式的静态等级（用于优化，比如是否可以缓存或字符串化）
  constType: ConstantTypes

  /**
   * - `null` means the expression is a simple identifier that doesn't need
   *    parsing
   * - `false` means there was a parsing error
   */
  /**
   * Babel AST 节点，用于支持表达式的更深层语义分析（通过 babel 解析）
   * - null 表示是一个简单标识符（如 msg）不需要 Babel AST
   * - false 表示表达式解析失败（语法错误）
   */
  ast?: BabelNode | null | false

  /**
   * Indicates this is an identifier for a hoist vnode call and points to the
   * hoisted node.
   */
  /**
   * 如果这个表达式是 vnode hoisting 的标识符，
   * 则 hoisted 指向实际被 hoist 的节点（JS 表达式）
   */
  hoisted?: JSChildNode

  /**
   * an expression parsed as the params of a function will track
   * the identifiers declared inside the function body.
   */
  /**
   * 用于函数参数中的表达式分析时，记录该函数体内声明的变量标识符
   * 例如：`(item, index) => item + index` 会记录 ["item", "index"]
   */
  identifiers?: string[]

  /**
   * 用于 `v-on` 的简写判断，比如 @click="clickHandler"，会标记为 true
   */
  isHandlerKey?: boolean
}

// InterpolationNode 表示插值表达式节点，
// 也就是模板中出现的 {{ 表达式 }} 这种语法。
export interface InterpolationNode extends Node {
  // 类型固定为 INTERPOLATION
  type: NodeTypes.INTERPOLATION

  // 插值中的表达式内容，会是一个表达式节点（如 SimpleExpressionNode 或 CompoundExpressionNode）
  content: ExpressionNode
}

// CompoundExpressionNode 表示复合表达式，
// 即由多个表达式、文本、插值拼接构成的复杂结构
export interface CompoundExpressionNode extends Node {
  // 节点类型固定为 COMPOUND_EXPRESSION
  type: NodeTypes.COMPOUND_EXPRESSION

  /**
   * - `null` means the expression is a simple identifier that doesn't need
   *    parsing
   * - `false` means there was a parsing error
   */
  /**
   * Babel AST 节点
   * - null：表示这是简单的拼接标识符，不需要额外解析
   * - false：表示表达式解析失败（语法错误）
   * - BabelNode：表示已经由 Babel 解析成 AST，用于更深层分析（如作用域、依赖）
   */
  ast?: BabelNode | null | false

  /**
   * 表达式的组成部分，按顺序排列的子节点数组
   * 可以是：
   * - SimpleExpressionNode：单个表达式
   * - CompoundExpressionNode：嵌套的复合表达式
   * - InterpolationNode：插值表达式
   * - TextNode：纯文本
   * - string：代码片段（例如 "+", "(", ")"）
   * - symbol：内部用的特殊标记符号（比如用于 codegen）
   */
  children: (
    | SimpleExpressionNode
    | CompoundExpressionNode
    | InterpolationNode
    | TextNode
    | string
    | symbol
  )[]

  /**
   * an expression parsed as the params of a function will track
   * the identifiers declared inside the function body.
   */
  /**
   * 用于函数表达式中的作用域追踪，
   * 例如在 v-on 的内联函数表达式中声明的变量
   */
  identifiers?: string[]

  /**
   * 如果是 v-on 的事件名表达式（如 `@click="fn"`），
   * 这个字段为 true（供事件优化使用）
   */
  isHandlerKey?: boolean
}

// IfNode 表示模板中的 v-if / v-else-if / v-else 结构的“控制节点”
// 每一个 IfNode 对应一整组 if + else if + else 分支
export interface IfNode extends Node {
  // 类型标识为 IF 节点
  type: NodeTypes.IF

  // 分支数组，包含所有 v-if / v-else-if / v-else 的组合体
  branches: IfBranchNode[]

  // codegen 阶段生成的节点
  // - 如果没有 v-once：生成 IfConditionalExpression（三元表达式）
  // - 如果有 v-once：生成 CacheExpression，用于缓存整段逻辑
  codegenNode?: IfConditionalExpression | CacheExpression // <div v-if v-once>
}

// IfBranchNode 表示 v-if / v-else-if / v-else 的一个分支
// 每个分支对应一个条件和一组子节点（DOM 内容）
export interface IfBranchNode extends Node {
  // 类型固定为 IF_BRANCH
  type: NodeTypes.IF_BRANCH

  // 分支的条件表达式
  // - 对于 v-if 和 v-else-if，这是表达式节点（如 a > b）
  // - 对于 v-else，condition 是 undefined
  condition: ExpressionNode | undefined // else

  // 分支中包含的子节点（即该条件下渲染的模板内容）
  children: TemplateChildNode[]

  // 开发者指定的 key（使用 key="..."），用于更稳定的 diff 和优化
  // 可以是属性节点（AttributeNode）或指令节点（DirectiveNode）
  userKey?: AttributeNode | DirectiveNode

  // 如果这个分支来自 <template v-if> 或 <template v-else>，则为 true
  // 编译器会特殊处理 template 标签（不会生成 DOM 元素）
  isTemplateIf?: boolean
}

// ForNode 表示模板中的 v-for 指令（循环结构）节点
export interface ForNode extends Node {
  // 节点类型标识为 FOR
  type: NodeTypes.FOR

  // 被迭代的数据源表达式（v-for 的 in / of 后面的部分）
  // 例如：v-for="item in list" → source 是 "list"
  source: ExpressionNode

  // 被绑定的项的变量名（item），可能是 undefined（极少情况）
  valueAlias: ExpressionNode | undefined

  // 可选：v-for 的第二个参数（key）
  // 例如：v-for="(item, key) in obj" → keyAlias 是 "key"
  keyAlias: ExpressionNode | undefined

  // 可选：v-for 的第三个参数（index）
  // 例如：v-for="(value, key, index) in object" → objectIndexAlias 是 "index"
  objectIndexAlias: ExpressionNode | undefined

  // 用于缓存解析结果，例如 AST + 错误提示（来自 parseVForExpression）
  parseResult: ForParseResult

  // v-for 内部要渲染的子节点们
  children: TemplateChildNode[]

  // 编译阶段生成的 codegen 节点，用于渲染函数中的循环调用逻辑
  // 例如：renderList(list, (item, index) => ...)
  codegenNode?: ForCodegenNode
}

// ForParseResult 表示 v-for 表达式解析后的结果
// 例如 v-for="(item, key, index) in list"
export interface ForParseResult {
  // v-for 迭代的数据源表达式（in 或 of 后的部分）
  // 上例中是 "list"
  source: ExpressionNode
  // v-for 中第一个变量，通常是每一项的值（item）
  value: ExpressionNode | undefined

  // v-for 中第二个变量，通常是 key（用于对象遍历）
  // 上例中是 "key"
  key: ExpressionNode | undefined

  // v-for 中第三个变量，通常是 index（用于索引遍历）
  // 上例中是 "index"
  index: ExpressionNode | undefined

  // 是否已经完成预处理（由 transform 阶段设置）
  finalized: boolean
}

// TextCallNode 表示用于渲染函数中 createTextVNode(...) 调用的节点
export interface TextCallNode extends Node {
  // 类型标记为 TEXT_CALL（即将文本用于 codegen 的调用）
  type: NodeTypes.TEXT_CALL

  // 原始的内容节点，可以是：
  // - TextNode：纯文本
  // - InterpolationNode：插值表达式
  // - CompoundExpressionNode：文本与插值混合
  content: TextNode | InterpolationNode | CompoundExpressionNode

  // 渲染函数生成时的最终表达式
  // - 通常是 CallExpression（createTextVNode(...)）
  // - 被静态提升（hoisted）时是 SimpleExpressionNode（一个变量引用）
  codegenNode: CallExpression | SimpleExpressionNode // when hoisted
}

// 用于描述模板里 纯文本类子节点 的联合类型
export type TemplateTextChildNode =
  | TextNode // 纯文本，比如 "hello"
  | InterpolationNode // 插值表达式，例如 {{ msg }}
  | CompoundExpressionNode // 混合文本与插值，例如 "hello {{ name }}!"

// VNodeCall 表示渲染函数中 createVNode(...) 的调用结构
export interface VNodeCall extends Node {
  // 节点类型固定为 VNODE_CALL
  type: NodeTypes.VNODE_CALL
  // 标签名，可以是字符串（如 "div"）、symbol（内置组件）、或函数调用（resolveComponent）
  tag: string | symbol | CallExpression
  // props 对象（第二个参数），可以是对象表达式、null，或 hoist 后的变量
  props: PropsExpression | undefined

  /**
   * 子节点，有多种情况：
   * - 多个子节点组成的数组（如多个 <div>、多个 slot）
   * - 单个文本类子节点（如 "hello", {{ msg }}, 复合表达式）
   * - 插槽对象（组件传入的 slots）
   * - v-for 生成的 renderList 表达式
   * - 被 hoist 或 cache 过的表达式
   */
  children:
    | TemplateChildNode[] // multiple children   // 多个子节点（VNode 数组）
    | TemplateTextChildNode // single text child  // 单个文本类节点
    | SlotsExpression // component slots   // 插槽对象
    | ForRenderListExpression // v-for fragment call  // renderList(...)
    | SimpleExpressionNode // hoisted  // 被静态提升后
    | CacheExpression // cached  // v-once 缓存
    | undefined // 没有子节点

  // patchFlag 是 vue diff 算法的优化标志（数字或常量），告诉 renderer 哪些内容可能动态变
  patchFlag: PatchFlags | undefined

  // 标记哪些 props 是动态的（用于 runtime diff 优化）
  dynamicProps: string | SimpleExpressionNode | undefined

  // 是否包含指令，如 v-show、v-model
  directives: DirectiveArguments | undefined

  // 是否是一个 block 节点（即 openBlock + createBlock）
  isBlock: boolean

  // 是否禁用子节点 tracking（用于一些静态节点）
  disableTracking: boolean

  // 是否是组件调用（用于特殊处理 props/slots）
  isComponent: boolean
}

// JS Node Types ---------------------------------------------------------------

// We also include a number of JavaScript AST nodes for code generation.
// The AST is an intentionally minimal subset just to meet the exact needs of
// Vue render function generation.

export type JSChildNode =
  | VNodeCall // createVNode(...) 调用节点
  | CallExpression // 任意函数调用，如 renderSlot(...)
  | ObjectExpression // 对象字面量，如 { class: 'btn' }
  | ArrayExpression // 数组字面量，如 [foo, bar]
  | ExpressionNode // 表达式节点，如变量、计算式
  | FunctionExpression // 函数表达式，如 () => {}
  | ConditionalExpression // 三元表达式，如 a ? b : c
  | CacheExpression // v-once 缓存节点
  | AssignmentExpression // 赋值表达式，如 a = b
  | SequenceExpression // 表达式序列，如 (a, b, c)

// CallExpression 表示一个 JS 函数调用表达式
// 用于生成 createVNode(...)、renderSlot(...) 等代码片段
export interface CallExpression extends Node {
  // 节点类型：JS 调用表达式
  type: NodeTypes.JS_CALL_EXPRESSION

  // 要调用的函数名，可以是字符串或 symbol（runtime 中的辅助函数）
  callee: string | symbol

  // 函数参数数组，参数类型支持多种情况：
  arguments: (
    | string // 例如字符串常量参数："div"
    | symbol // 运行时内置标识符，例如 `CREATE_VNODE`
    | JSChildNode // 表达式参数，如 VNodeCall、对象、函数等
    | SSRCodegenNode // SSR 模式下专用的表达式
    | TemplateChildNode // AST 节点：用于某些 compile-time 插槽渲染
    | TemplateChildNode[] // 多个子节点（用于 children 参数）
  )[]
}

// 在 codegen 阶段用来生成 JavaScript 对象字面量 的 AST 节点
// ObjectExpression 表示一个 JavaScript 对象字面量
// 例如：{ class: 'btn', id: dynamicId }
export interface ObjectExpression extends Node {
  // 节点类型：JS 对象表达式
  type: NodeTypes.JS_OBJECT_EXPRESSION
  // 对象的属性列表（每个都是 Property 类型，key-value 对）
  properties: Array<Property>
}

// Property 表示 JS 对象中的一个属性（键值对）
// 例如 { class: 'foo' } 中的 class: 'foo'
export interface Property extends Node {
  // 节点类型：JS_PROPERTY（用于识别这是对象属性）
  type: NodeTypes.JS_PROPERTY
  // 属性名（key），是一个表达式节点：
  // 可以是普通字符串（如 "id"），也可以是计算属性表达式（如 [keyName]）
  key: ExpressionNode
  // 属性值（value），可以是任意 JS 表达式（字符串、变量、VNodeCall 等）
  value: JSChildNode
}

// ArrayExpression 表示一个 JavaScript 数组字面量表达式
export interface ArrayExpression extends Node {
  // 类型标识：JS 数组表达式
  type: NodeTypes.JS_ARRAY_EXPRESSION
  // 数组中的元素，可以是字符串或任意 AST 节点（例如表达式、VNodeCall 等）
  elements: Array<string | Node>
}

// FunctionExpression 表示一个 JS 函数表达式
// 常用于 renderList()、插槽函数、事件处理函数等场景
export interface FunctionExpression extends Node {
  // 类型标识为 JS_FUNCTION_EXPRESSION
  type: NodeTypes.JS_FUNCTION_EXPRESSION

  // 函数的参数，可以是：
  // - 单个字符串：例如 "item"
  // - 单个表达式节点：表达式参数
  // - 多个参数：如 ["item", "index"]
  // - undefined：无参数函数
  params: ExpressionNode | string | (ExpressionNode | string)[] | undefined

  // 函数的返回值，可以是：
  // - 模板子节点（如插槽内容）
  // - 渲染调用表达式（VNodeCall、TextCallNode 等）
  returns?: TemplateChildNode | TemplateChildNode[] | JSChildNode

  // 函数体（若非箭头函数），可以是代码块或条件语句
  body?: BlockStatement | IfStatement

  // 是否换行显示（影响 codegen 输出格式）
  newline: boolean
  /**
   * This flag is for codegen to determine whether it needs to generate the
   * withScopeId() wrapper
   */
  // 是否是插槽函数（用于 withScopeId 包裹逻辑）
  isSlot: boolean
  /**
   * __COMPAT__ only, indicates a slot function that should be excluded from
   * the legacy $scopedSlots instance property.
   */
  // 仅用于兼容模式：是否从 $scopedSlots 中排除该插槽
  isNonScopedSlot?: boolean
}

// ConditionalExpression 表示 JS 中的三元表达式：test ? consequent : alternate
export interface ConditionalExpression extends Node {
  // 类型固定为 JS_CONDITIONAL_EXPRESSION
  type: NodeTypes.JS_CONDITIONAL_EXPRESSION
  // 条件表达式（test），例如：ok
  test: JSChildNode
  // 条件为 true 时的表达式（consequent），例如：createVNode(...)
  consequent: JSChildNode
  // 条件为 false 时的表达式（alternate），可以是另一个 VNode、null，或嵌套的条件表达式
  alternate: JSChildNode
  // 是否换行显示（影响生成代码格式）
  newline: boolean
}

// CacheExpression 表示一个运行时缓存表达式
// 通常由 v-once 或 transformCache() 插入，用于缓存 vnode 或表达式结果
export interface CacheExpression extends Node {
  // 节点类型：JS 缓存表达式
  type: NodeTypes.JS_CACHE_EXPRESSION
  // 缓存的索引：对应 _cache[index]
  index: number
  // 要缓存的目标值（如一个 VNodeCall、TextCallNode、ArrayExpression 等）
  value: JSChildNode
  // 是否需要暂停依赖追踪（例如函数或非响应式内容）
  needPauseTracking: boolean
  // 是否是 v-once 的缓存（vs 通用优化缓存）
  inVOnce: boolean
  // 是否需要用 [...cached] 的方式展开缓存结果（适用于 slot fragment）
  needArraySpread: boolean
}

// MemoExpression 是一个特殊的 CallExpression，用于 v-memo 的实现
export interface MemoExpression extends CallExpression {
  // 调用的函数固定为 WITH_MEMO（表示调用 withMemo(...)）
  callee: typeof WITH_MEMO

  // 参数顺序固定：
  // [0] 条件表达式（依赖值，用于判断是否重用缓存）
  // [1] MemoFactory：函数，返回 VNode 或片段（缓存目标）
  // [2] 缓存 key（字符串，用于唯一标识）
  // [3] 缓存优化提示标记（如 PatchFlag）
  arguments: [ExpressionNode, MemoFactory, string, string]
}

// MemoFactory 是用于 v-memo 的工厂函数表达式
// 它扩展自 FunctionExpression，返回值必须是一个 Block 结构（VNode 或 fragment）
interface MemoFactory extends FunctionExpression {
  // 返回的必须是一个可渲染的 block 节点（用于 createBlock、createVNode 等）
  returns: BlockCodegenNode
}

// SSR-specific Node Types -----------------------------------------------------

// SSRCodegenNode 表示 SSR codegen 阶段可能使用的所有 JS 节点类型
export type SSRCodegenNode =
  | BlockStatement // 代码块，如 { ... }
  | TemplateLiteral // 模板字符串，如 `Hello ${name}`
  | IfStatement // if 条件结构，如 if (...) { ... } else { ... }
  | AssignmentExpression // 赋值表达式，如 foo = bar
  | ReturnStatement // return 语句，如 return vnode
  | SequenceExpression // 表达式序列，如 (a, b, c)

// BlockStatement 表示一个 JavaScript 代码块 { ... }
// 通常用于函数体、if 分支、try/catch 等语境中
export interface BlockStatement extends Node {
  // 节点类型，固定为 JS_BLOCK_STATEMENT
  type: NodeTypes.JS_BLOCK_STATEMENT
  // 块内包含的语句列表，可以是任意表达式或 if 语句
  body: (JSChildNode | IfStatement)[]
}

// TemplateLiteral 表示 JS 中的模板字符串（`...${...}`）结构
export interface TemplateLiteral extends Node {
  // 类型：模板字符串节点
  type: NodeTypes.JS_TEMPLATE_LITERAL

  // 模板字符串中的各个部分：
  // - 字符串常量（静态部分）
  // - 表达式节点（插值部分，如变量、调用等）
  elements: (string | JSChildNode)[]
}

// IfStatement 表示 JS 中的 if 语句：if (...) { ... } else { ... }
export interface IfStatement extends Node {
  // 类型标识为 JS_IF_STATEMENT
  type: NodeTypes.JS_IF_STATEMENT

  // 条件表达式（判断是否执行 consequent）
  test: ExpressionNode

  // 主分支：条件为 true 时执行的语句块
  consequent: BlockStatement

  // else 或 else if 分支（可以是嵌套的 IfStatement、Block 或 Return）
  alternate: IfStatement | BlockStatement | ReturnStatement | undefined
}

// AssignmentExpression 表示 JS 的赋值表达式，如：a = b
export interface AssignmentExpression extends Node {
  // 节点类型，固定为 JS_ASSIGNMENT_EXPRESSION
  type: NodeTypes.JS_ASSIGNMENT_EXPRESSION
  // 左侧是一个变量（一般是简单标识符），不能是复杂表达式
  left: SimpleExpressionNode
  // 右侧是任意 JS 子表达式（如 VNode、TextCall、ObjectExpression 等）
  right: JSChildNode
}

// SequenceExpression 表示 JS 中的表达式序列，如：(a, b, c)
// 表示顺序执行 a、b、c，并返回最后一个表达式 c 的值
export interface SequenceExpression extends Node {
  // 节点类型：JS_SEQUENCE_EXPRESSION
  type: NodeTypes.JS_SEQUENCE_EXPRESSION

  // 要依次执行的表达式数组（最终值是最后一项的值）
  expressions: JSChildNode[]
}

export interface ReturnStatement extends Node {
  type: NodeTypes.JS_RETURN_STATEMENT
  returns: TemplateChildNode | TemplateChildNode[] | JSChildNode
}

// Codegen Node Types ----------------------------------------------------------

// DirectiveArguments 是指令参数的数组表达式
// 它继承自 ArrayExpression，但内部元素类型限定为 DirectiveArgumentNode
export interface DirectiveArguments extends ArrayExpression {
  elements: DirectiveArgumentNode[]
}

// DirectiveArgumentNode 表示 withDirectives() 中的单个指令项
export interface DirectiveArgumentNode extends ArrayExpression {
  elements: // dir, exp, arg, modifiers
  | [string] // 最简单形式：只有指令名，如 v-foo
    | [string, ExpressionNode] // 指令名 + 表达式，如 v-foo="msg"
    | [string, ExpressionNode, ExpressionNode] // 指令名 + 表达式 + 参数，如 v-foo:arg="msg"
    | [string, ExpressionNode, ExpressionNode, ObjectExpression] // 指令名 + 表达式 + 参数 + 修饰符，如 v-foo:arg.mod1.mod2="msg"
}

// renderSlot(...)
// RenderSlotCall 表示一次 renderSlot(...) 调用（即插槽渲染）
export interface RenderSlotCall extends CallExpression {
  // 固定 callee 为 RENDER_SLOT（Vue 运行时导入的 renderSlot 函数）
  callee: typeof RENDER_SLOT

  // 参数类型分三种（按顺序可选）：
  // 1. $slots, name
  // 2. $slots, name, props
  // 3. $slots, name, props, fallback children
  arguments: // $slots, name, props, fallback
  | [string, string | ExpressionNode]
    | [string, string | ExpressionNode, PropsExpression]
    | [
        string,
        string | ExpressionNode,
        PropsExpression | '{}',
        TemplateChildNode[],
      ]

  // 每个参数的含义：
  // [0]	$slots	string	插槽源对象（通常是 _ctx.$slots）
  // [1]	name	string or ExpressionNode	插槽名称，例如 "default" 或变量表达式
  // [2]	props	PropsExpression（可选）	传入插槽的 props（作用域插槽）
  // [3]	fallback	TemplateChildNode[]	插槽未定义时的备用内容（默认插槽内容）
}

export type SlotsExpression = SlotsObjectExpression | DynamicSlotsExpression

// { foo: () => [...] }
export interface SlotsObjectExpression extends ObjectExpression {
  properties: SlotsObjectProperty[]
}

export interface SlotsObjectProperty extends Property {
  value: SlotFunctionExpression
}

export interface SlotFunctionExpression extends FunctionExpression {
  returns: TemplateChildNode[] | CacheExpression
}

// createSlots({ ... }, [
//    foo ? () => [] : undefined,
//    renderList(list, i => () => [i])
// ])
export interface DynamicSlotsExpression extends CallExpression {
  callee: typeof CREATE_SLOTS
  arguments: [SlotsObjectExpression, DynamicSlotEntries]
}

export interface DynamicSlotEntries extends ArrayExpression {
  elements: (ConditionalDynamicSlotNode | ListDynamicSlotNode)[]
}

export interface ConditionalDynamicSlotNode extends ConditionalExpression {
  consequent: DynamicSlotNode
  alternate: DynamicSlotNode | SimpleExpressionNode
}

export interface ListDynamicSlotNode extends CallExpression {
  callee: typeof RENDER_LIST
  arguments: [ExpressionNode, ListDynamicSlotIterator]
}

export interface ListDynamicSlotIterator extends FunctionExpression {
  returns: DynamicSlotNode
}

export interface DynamicSlotNode extends ObjectExpression {
  properties: [Property, DynamicSlotFnProperty]
}

export interface DynamicSlotFnProperty extends Property {
  value: SlotFunctionExpression
}

export type BlockCodegenNode = VNodeCall | RenderSlotCall

// IfConditionalExpression 是 v-if 的 codegen 表达结构
// 它扩展了普通三元表达式，但保证了分支结果是 Block 或缓存
export interface IfConditionalExpression extends ConditionalExpression {
  // 条件为 true 的情况（必须是可以渲染的块或缓存）
  consequent: BlockCodegenNode | MemoExpression
  // 条件为 false 的情况（可以是块，也可以继续嵌套条件或缓存）
  alternate: BlockCodegenNode | IfConditionalExpression | MemoExpression
}

// ForCodegenNode 是 v-for 渲染时生成的特殊 VNodeCall 结构
// 它基于 VNodeCall，用于表示一个 Fragment 节点，内部通过 renderList 渲染
export interface ForCodegenNode extends VNodeCall {
  // 必须是 block（openBlock + createBlock）
  isBlock: true
  // 标签是 Fragment（表示虚拟容器，无真实 DOM 元素）
  tag: typeof FRAGMENT
  // 无 props（因为是 Fragment）
  props: undefined
  // 子节点是一个 renderList(...) 表达式
  children: ForRenderListExpression
  // diff patch 标记，通常是 STABLE_FRAGMENT
  patchFlag: PatchFlags
  // 是否禁用依赖追踪（提升性能）
  disableTracking: boolean
}

export interface ForRenderListExpression extends CallExpression {
  callee: typeof RENDER_LIST
  arguments: [ExpressionNode, ForIteratorExpression]
}

export interface ForIteratorExpression extends FunctionExpression {
  returns?: BlockCodegenNode
}

// AST Utilities ---------------------------------------------------------------

// Some expressions, e.g. sequence and conditional expressions, are never
// associated with template nodes, so their source locations are just a stub.
// Container types like CompoundExpression also don't need a real location.
export const locStub: SourceLocation = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 1, offset: 0 },
  source: '',
}

export function createRoot(
  children: TemplateChildNode[],
  source = '',
): RootNode {
  return {
    type: NodeTypes.ROOT,
    source,
    children,
    helpers: new Set(),
    components: [],
    directives: [],
    hoists: [],
    imports: [],
    cached: [],
    temps: 0,
    codegenNode: undefined,
    loc: locStub,
  }
}

export function createVNodeCall(
  context: TransformContext | null,
  tag: VNodeCall['tag'],
  props?: VNodeCall['props'],
  children?: VNodeCall['children'],
  patchFlag?: VNodeCall['patchFlag'],
  dynamicProps?: VNodeCall['dynamicProps'],
  directives?: VNodeCall['directives'],
  isBlock: VNodeCall['isBlock'] = false,
  disableTracking: VNodeCall['disableTracking'] = false,
  isComponent: VNodeCall['isComponent'] = false,
  loc: SourceLocation = locStub,
): VNodeCall {
  if (context) {
    if (isBlock) {
      context.helper(OPEN_BLOCK)
      context.helper(getVNodeBlockHelper(context.inSSR, isComponent))
    } else {
      context.helper(getVNodeHelper(context.inSSR, isComponent))
    }
    if (directives) {
      context.helper(WITH_DIRECTIVES)
    }
  }

  return {
    type: NodeTypes.VNODE_CALL,
    tag,
    props,
    children,
    patchFlag,
    dynamicProps,
    directives,
    isBlock,
    disableTracking,
    isComponent,
    loc,
  }
}

export function createArrayExpression(
  elements: ArrayExpression['elements'],
  loc: SourceLocation = locStub,
): ArrayExpression {
  return {
    type: NodeTypes.JS_ARRAY_EXPRESSION,
    loc,
    elements,
  }
}

export function createObjectExpression(
  properties: ObjectExpression['properties'],
  loc: SourceLocation = locStub,
): ObjectExpression {
  return {
    type: NodeTypes.JS_OBJECT_EXPRESSION,
    loc,
    properties,
  }
}

export function createObjectProperty(
  key: Property['key'] | string,
  value: Property['value'],
): Property {
  return {
    type: NodeTypes.JS_PROPERTY,
    loc: locStub,
    key: isString(key) ? createSimpleExpression(key, true) : key,
    value,
  }
}

export function createSimpleExpression(
  content: SimpleExpressionNode['content'],
  isStatic: SimpleExpressionNode['isStatic'] = false,
  loc: SourceLocation = locStub,
  constType: ConstantTypes = ConstantTypes.NOT_CONSTANT,
): SimpleExpressionNode {
  return {
    type: NodeTypes.SIMPLE_EXPRESSION,
    loc,
    content,
    isStatic,
    constType: isStatic ? ConstantTypes.CAN_STRINGIFY : constType,
  }
}

export function createInterpolation(
  content: InterpolationNode['content'] | string,
  loc: SourceLocation,
): InterpolationNode {
  return {
    type: NodeTypes.INTERPOLATION,
    loc,
    content: isString(content)
      ? createSimpleExpression(content, false, loc)
      : content,
  }
}

export function createCompoundExpression(
  children: CompoundExpressionNode['children'],
  loc: SourceLocation = locStub,
): CompoundExpressionNode {
  return {
    type: NodeTypes.COMPOUND_EXPRESSION,
    loc,
    children,
  }
}

type InferCodegenNodeType<T> = T extends typeof RENDER_SLOT
  ? RenderSlotCall
  : CallExpression

export function createCallExpression<T extends CallExpression['callee']>(
  callee: T,
  args: CallExpression['arguments'] = [],
  loc: SourceLocation = locStub,
): InferCodegenNodeType<T> {
  return {
    type: NodeTypes.JS_CALL_EXPRESSION,
    loc,
    callee,
    arguments: args,
  } as InferCodegenNodeType<T>
}

export function createFunctionExpression(
  params: FunctionExpression['params'],
  returns: FunctionExpression['returns'] = undefined,
  newline: boolean = false,
  isSlot: boolean = false,
  loc: SourceLocation = locStub,
): FunctionExpression {
  return {
    type: NodeTypes.JS_FUNCTION_EXPRESSION,
    params,
    returns,
    newline,
    isSlot,
    loc,
  }
}

export function createConditionalExpression(
  test: ConditionalExpression['test'],
  consequent: ConditionalExpression['consequent'],
  alternate: ConditionalExpression['alternate'],
  newline = true,
): ConditionalExpression {
  return {
    type: NodeTypes.JS_CONDITIONAL_EXPRESSION,
    test,
    consequent,
    alternate,
    newline,
    loc: locStub,
  }
}

export function createCacheExpression(
  index: number,
  value: JSChildNode,
  needPauseTracking: boolean = false,
  inVOnce: boolean = false,
): CacheExpression {
  return {
    type: NodeTypes.JS_CACHE_EXPRESSION,
    index,
    value,
    needPauseTracking: needPauseTracking,
    inVOnce,
    needArraySpread: false,
    loc: locStub,
  }
}

export function createBlockStatement(
  body: BlockStatement['body'],
): BlockStatement {
  return {
    type: NodeTypes.JS_BLOCK_STATEMENT,
    body,
    loc: locStub,
  }
}

export function createTemplateLiteral(
  elements: TemplateLiteral['elements'],
): TemplateLiteral {
  return {
    type: NodeTypes.JS_TEMPLATE_LITERAL,
    elements,
    loc: locStub,
  }
}

export function createIfStatement(
  test: IfStatement['test'],
  consequent: IfStatement['consequent'],
  alternate?: IfStatement['alternate'],
): IfStatement {
  return {
    type: NodeTypes.JS_IF_STATEMENT,
    test,
    consequent,
    alternate,
    loc: locStub,
  }
}

export function createAssignmentExpression(
  left: AssignmentExpression['left'],
  right: AssignmentExpression['right'],
): AssignmentExpression {
  return {
    type: NodeTypes.JS_ASSIGNMENT_EXPRESSION,
    left,
    right,
    loc: locStub,
  }
}

export function createSequenceExpression(
  expressions: SequenceExpression['expressions'],
): SequenceExpression {
  return {
    type: NodeTypes.JS_SEQUENCE_EXPRESSION,
    expressions,
    loc: locStub,
  }
}

export function createReturnStatement(
  returns: ReturnStatement['returns'],
): ReturnStatement {
  return {
    type: NodeTypes.JS_RETURN_STATEMENT,
    returns,
    loc: locStub,
  }
}

export function getVNodeHelper(
  ssr: boolean,
  isComponent: boolean,
): typeof CREATE_VNODE | typeof CREATE_ELEMENT_VNODE {
  return ssr || isComponent ? CREATE_VNODE : CREATE_ELEMENT_VNODE
}

export function getVNodeBlockHelper(
  ssr: boolean,
  isComponent: boolean,
): typeof CREATE_BLOCK | typeof CREATE_ELEMENT_BLOCK {
  return ssr || isComponent ? CREATE_BLOCK : CREATE_ELEMENT_BLOCK
}

export function convertToBlock(
  node: VNodeCall,
  { helper, removeHelper, inSSR }: TransformContext,
): void {
  if (!node.isBlock) {
    node.isBlock = true
    removeHelper(getVNodeHelper(inSSR, node.isComponent))
    helper(OPEN_BLOCK)
    helper(getVNodeBlockHelper(inSSR, node.isComponent))
  }
}
