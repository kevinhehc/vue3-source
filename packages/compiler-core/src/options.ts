import type {
  ElementNode,
  Namespace,
  Namespaces,
  ParentNode,
  TemplateChildNode,
} from './ast'
import type { CompilerError } from './errors'
import type {
  DirectiveTransform,
  NodeTransform,
  TransformContext,
} from './transform'
import type { CompilerCompatOptions } from './compat/compatConfig'
import type { ParserPlugin } from '@babel/parser'

// 异常处理接口
export interface ErrorHandlingOptions {
  // 告警处理方法
  onWarn?: (warning: CompilerError) => void
  // 错误处理方法
  onError?: (error: CompilerError) => void
}

// 用于自定义解析模板时的行为
export interface ParserOptions
  extends ErrorHandlingOptions,
    CompilerCompatOptions {
  /**
   * Base mode is platform agnostic and only parses HTML-like template syntax,
   * treating all tags the same way. Specific tag parsing behavior can be
   * configured by higher-level compilers.
   *
   * HTML mode adds additional logic for handling special parsing behavior in
   * `<script>`, `<style>`,`<title>` and `<textarea>`.
   * The logic is handled inside compiler-core for efficiency.
   *
   * SFC mode treats content of all root-level tags except `<template>` as plain
   * text.
   *
   *
   * 决定模板的解析模式：
   *
   * 'base': 平台无关的解析方式，所有标签一视同仁。
   *
   * 'html': 处理 <script>、<style>、<textarea> 等特殊标签。
   *
   * 'sfc': 单文件组件模式，仅 <template> 被解析为 AST，其他标签作为纯文本。
   */
  parseMode?: 'base' | 'html' | 'sfc'

  /**
   * Specify the root namespace to use when parsing a template.
   * Defaults to `Namespaces.HTML` (0).
   *
   * 命名空间（namespace），默认为 HTML。常见值：
   *
   * 0 → HTML
   *
   * 1 → SVG
   *
   * 2 → MathML
   *
   * 用于处理嵌套 SVG/MathML 的情况。
   */
  ns?: Namespaces

  /**
   * e.g. platform native elements, e.g. `<div>` for browsers
   *
   * 是否是平台原生标签，例如浏览器中的 <div>、<span>。
   */
  isNativeTag?: (tag: string) => boolean

  /**
   * e.g. native elements that can self-close, e.g. `<img>`, `<br>`, `<hr>`
   * 是否是自闭合标签，如 <br>、<img>，它们没有结束标签。
   */
  isVoidTag?: (tag: string) => boolean

  /**
   * e.g. elements that should preserve whitespace inside, e.g. `<pre>`
   * 是否是 <pre>，影响模板中的空白处理。
   */
  isPreTag?: (tag: string) => boolean

  /**
   * Elements that should ignore the first newline token per parinsg spec
   * e.g. `<textarea>` and `<pre>`
   * 某些标签如 <textarea> 和 <pre>，会忽略开头的换行。
   */
  isIgnoreNewlineTag?: (tag: string) => boolean

  /**
   * Platform-specific built-in components e.g. `<Transition>`
   * 是否是内建组件（如 <Transition>），返回组件的 symbol。
   */
  isBuiltInComponent?: (tag: string) => symbol | void

  /**
   * Separate option for end users to extend the native elements list
   * 用于定义哪些标签是自定义元素（不会警告），如 Web Components：<my-button>
   */
  isCustomElement?: (tag: string) => boolean | void

  /**
   * Get tag namespace
   * 获取标签的命名空间，支持嵌套处理。
   */
  getNamespace?: (
    tag: string,
    parent: ElementNode | undefined,
    rootNamespace: Namespace,
  ) => Namespace

  /**
   * @default ['{{', '}}']
   * 插值语法分隔符，默认是 {{ }}，但可以自定义，比如 [[ ]]。
   */
  delimiters?: [string, string]

  /**
   * Whitespace handling strategy
   * @default 'condense'
   * 空格处理策略：
   *
   * 'preserve'：保留所有空格。
   *
   * 'condense'（默认）：压缩空格。
   */
  whitespace?: 'preserve' | 'condense'

  /**
   * Only used for DOM compilers that runs in the browser.
   * In non-browser builds, this option is ignored.
   * 将 HTML 实体解码，例如把 &lt; 转为 <。主要用于浏览器端编译器。
   */
  decodeEntities?: (rawText: string, asAttr: boolean) => string

  /**
   * Whether to keep comments in the templates AST.
   * This defaults to `true` in development and `false` in production builds.
   * 是否保留注释节点。开发模式为 true，生产模式默认为 false。
   */
  comments?: boolean

  /**
   * Parse JavaScript expressions with Babel.
   * @default false
   * 是否为表达式添加作用域前缀，用于实现作用域提升与 v-on 编译优化。
   */
  prefixIdentifiers?: boolean

  /**
   * A list of parser plugins to enable for `@babel/parser`, which is used to
   * parse expressions in bindings and interpolations.
   * https://babeljs.io/docs/en/next/babel-parser#plugins
   * Babel 插件列表，用于扩展表达式解析能力（如支持 TypeScript、JSX、optional chaining 等）。
   */
  expressionPlugins?: ParserPlugin[]
}

// 提升静态节点的转换函数类型定义，用于 AST 转换阶段。
export type HoistTransform = (
  // children: 模板的子节点
  // context: 当前转换上下文（TransformContext）
  // parent: 父节点
  children: TemplateChildNode[],
  context: TransformContext,
  parent: ParentNode,
) => void

// 在 Vue 模板编译阶段使用的绑定类型，用于帮助 Vue 识别模板中用到的变量属于什么来源，
// 是否是 ref、prop、literal 等，从而在编译时决定是否需要 .value 或 unref() 等处理。

// <script setup>
// const count = ref(0)                      // setup-ref
// const msg = "hello"                       // setup-const
// const obj = reactive({ n: 1 })            // setup-reactive-const
// let local = 10                            // setup-let
// const { title: myTitle } = defineProps()  // props-aliased
// </script>
//
// <template>
//   {{ count }}    ← 自动解包 ref，变成 count.value
//   {{ msg }}      ← 直接使用
//   {{ obj.n }}    ← reactive 中的变动，允许变化
//   {{ local }}    ← 保守处理
//   {{ myTitle }}  ← 被当作 props 处理
// </template>
export enum BindingTypes {
  /**
   * returned from data()
   * 来源：data() 返回的对象。
   * 编译模板时会自动加 .value（如果是 ref）。
   * 旧的选项式 API 中用得比较多。
   */
  DATA = 'data',

  /**
   * declared as a prop
   * 来源：组件的 props 传入。
   * 是响应式的，但不是 ref，不需要 .value。
   * 编译模板时不需要 unref()。
   */
  PROPS = 'props',

  /**
   * a local alias of a `<script setup>` destructured prop.
   * the original is stored in __propsAliases of the bindingMetadata object.
   *
   * 来源：<script setup> 中结构 props 并起别名。
   * const { title: myTitle } = defineProps()
   * 编译器会记录这些别名，原始的名字保存在 __propsAliases 中。
   * 有些场景下仍然需要关联 props 的 reactivity。
   */
  PROPS_ALIASED = 'props-aliased',

  /**
   * a let binding (may or may not be a ref)
   *
   * 源：<script setup> 中使用 let 声明的变量。
   * let count = 0
   * 可能是 ref，也可能不是，无法确定。
   */
  SETUP_LET = 'setup-let',

  /**
   * a const binding that can never be a ref.
   * these bindings don't need `unref()` calls when processed in inlined
   * template expressions.
   *
   * 来源：<script setup> 中使用 const 且静态不可变。
   * const foo = 123
   * 编译器知道它绝不会是 ref，不需要 unref()。
   * 编译器会直接使用这个变量。
   */
  SETUP_CONST = 'setup-const',

  /**
   * a const binding that does not need `unref()`, but may be mutated.
   *
   * 也是 const，但可以被内部 mutation。
   * const obj = reactive({ count: 1 })
   * 编译器不会调用 unref()，但变量可能变化。
   * 不像 setup-const 那样被视为彻底静态。
   */
  SETUP_REACTIVE_CONST = 'setup-reactive-const',

  /**
   * a const binding that may be a ref.
   * 可能是 ref，也可能不是，编译器无法确定。
   * const maybe = getSomething()
   * 模板中使用时要添加 unref() 处理。
   * 编译器需要小心处理。
   */
  SETUP_MAYBE_REF = 'setup-maybe-ref',

  /**
   * bindings that are guaranteed to be refs
   * 明确是一个 ref：
   * const count = ref(0)
   * 模板中使用时要自动加 .value 或使用 unref()。
   * 编译器需要解包 ref。
   */
  SETUP_REF = 'setup-ref',

  /**
   * declared by other options, e.g. computed, inject
   * 来源：选项式 API 中的 computed、inject、methods 等。
   * inject('theme')
   * computed(() => ...)
   * 编译器认为它们是响应式值，需处理。
   */
  OPTIONS = 'options',

  /**
   * a literal constant, e.g. 'foo', 1, true
   *
   * 字面量常量，例如：
   * const foo = 'bar'
   * 或者在模板中直接使用 'hello'、true、123
   * 纯静态，编译时直接嵌入，不需要处理 .value 或 unref()。
   */
  LITERAL_CONST = 'literal-const',
}

// 这个结构定义了每个变量的绑定类型，是 <script setup> 语法编译的核心中间数据结构之一。我们来一条一条详细讲清楚它的用途和构成。
// BindingMetadata 是 Vue 编译器在分析 <script setup> 语法时生成的一个 变量类型映射表。
// 它的作用是：
// 告诉编译器：“我在模板中看到的变量 foo 是从哪里来的？它是什么类型？我该怎么处理它？”
// <script setup> → compileScript() → BindingMetadata
//                                  ↓
//                     transformExpression() / transformElement()
//                                  ↓
//                        生成 render 函数代码
export type BindingMetadata = {
  // 这是一个普通对象，键是变量名（如 "count"、"title"），值是变量的绑定类型（来自你之前贴的 BindingTypes 枚举）。
  [key: string]: BindingTypes | undefined
} & {
  // 表示该 BindingMetadata 是基于 <script setup> 分析生成的，而不是普通的选项式 API（export default {}）分析出来的。
  __isScriptSetup?: boolean
  // 记录 <script setup> 中 解构 props 起别名 的映射表。
  __propsAliases?: Record<string, string>
}

// 这组配置主要在模板编译器生成 render() 函数时使用，属于模板编译到 JS 代码的后期阶段（codegen）。
// template → parse → AST
//                ↓
//            transform (接收 SharedTransformCodegenOptions)
//                ↓
//            generate (依然接收这些 options)
//                ↓
//           返回 render 函数的字符串 + code map
interface SharedTransformCodegenOptions {
  /**
   * Transform expressions like {{ foo }} to `_ctx.foo`.
   * If this option is false, the generated code will be wrapped in a
   * `with (this) { ... }` block.
   * - This is force-enabled in module mode, since modules are by default strict
   * and cannot use `with`
   * @default mode === 'module'
   *
   *
   * 决定是否为模板表达式加前缀，比如 _ctx.foo。
   *
   * ✅ true（推荐在 <script setup> 中）：
   * {{ foo }} → _ctx.foo
   * ❌ false（传统选项式 API）：
   * {{ foo }} → with (this) { return foo }
   * 注意：在模块模式（module mode）中是强制开启的，因为 with 在严格模式下无效。
   */
  prefixIdentifiers?: boolean

  /**
   * Control whether generate SSR-optimized render functions instead.
   * The resulting function must be attached to the component via the
   * `ssrRender` option instead of `render`.
   *
   * When compiler generates code for SSR's fallback branch, we need to set it to false:
   *  - context.ssr = false
   *
   * see `subTransform` in `ssrTransformComponent.ts`
   *
   * 是否要生成服务端渲染（SSR）优化的代码。
   * 如果是 SSR 编译，会走 ssrRender 函数而不是普通 render()。
   * 用于生成形如：
   * ssrRender(ctx, push, parent, attrs)
   */
  ssr?: boolean

  /**
   * Indicates whether the compiler generates code for SSR,
   * it is always true when generating code for SSR,
   * regardless of whether we are generating code for SSR's fallback branch,
   * this means that when the compiler generates code for SSR's fallback branch:
   *  - context.ssr = false
   *  - context.inSSR = true
   *
   *
   *  表示“当前是否在 SSR 编译环境中”。
   * 跟 ssr 的区别：
   * 字段	含义
   * ssr	当前是不是在生成 SSR 代码
   * inSSR	当前是不是在SSR 的编译上下文环境中
   * ⚠️ 重要场景：生成 SSR fallback 分支时：
   * context.ssr = false
   * context.inSSR = true
   */
  inSSR?: boolean

  /**
   * Optional binding metadata analyzed from script - used to optimize
   * binding access when `prefixIdentifiers` is enabled.
   *
   * 用于告诉编译器变量来源和类型（props/ref/const/etc），从而：
   * 决定要不要 unref()
   * 决定要不要加 _ctx. 前缀
   * 是否可以直接原样输出
   */
  bindingMetadata?: BindingMetadata

  /**
   * Compile the function for inlining inside setup().
   * This allows the function to directly access setup() local bindings.
   *
   * 如果设置为 true，表示编译的是一个要内联在 setup() 中的函数。
   * 典型用法：
   * const render = () => { ... }
   * 内联的情况下，模板表达式可以直接访问 setup() 作用域下的变量。
   */
  inline?: boolean

  /**
   * Indicates that transforms and codegen should try to output valid TS code
   * 是否生成 TypeScript 兼容的代码。
   * 主要会：
   * 保留类型注释
   * 输出合法的 .ts 语法，比如：
   * const foo: number = 123
   */
  isTS?: boolean

  /**
   * Filename for source map generation.
   * Also used for self-recursive reference in templates
   * @default 'template.vue.html'
   *
   * 生成 source map 的源文件名
   * 组件内部引用自己的 name 时用到（如递归组件）
   * 默认是 'template.vue.html'，在调试或报错中也会体现。
   */
  filename?: string
}

// 是整个 模板编译 transform 阶段 的配置选项。这个阶段负责将解析得到的模板 AST 转换为带有优化信息的 AST（如 hoisted 静态节点、表达式处理、事件缓存等），是编译管线中最关键的一步。
// parse(template) → AST
//     ↓
// transform(AST, TransformOptions)  ← 就在用这个接口
//     ↓
// optimizeAST (hoist static, cache handlers, etc.)
//     ↓
// generate(AST, CodegenOptions)
//     ↓
// output JS code
export interface TransformOptions
  extends SharedTransformCodegenOptions,
    ErrorHandlingOptions,
    CompilerCompatOptions {
  /**
   * An array of node transforms to be applied to every AST node.
   *
   * 注册一组用于处理所有 AST 节点类型的转换函数（每个都执行）
   * 比如：
   * [transformElement, transformText, transformExpression]
   * 你可以添加自定义 transform，比如处理自定义标签、分析内容、插入注释等。
   */
  nodeTransforms?: NodeTransform[]

  /**
   * An object of { name: transform } to be applied to every directive attribute
   * node found on element nodes.
   *
   * 注册指令的处理函数，如处理 v-model, v-show, v-html 等
   *
   * 结构是：
   * {
   *   model: transformModel,
   *   show: transformShow
   * }
   * Vue 内置了这些 transform，比如在 compiler-dom 的 transforms/vModel.ts
   */
  directiveTransforms?: Record<string, DirectiveTransform | undefined>

  /**
   * An optional hook to transform a node being hoisted.
   * used by compiler-dom to turn hoisted nodes into stringified HTML vnodes.
   * @default null
   *
   * 用于处理被提升（hoist）到外部的节点，比如静态节点或属性对象。
   *
   * Vue 的 compiler-dom 会把 hoist 的节点直接生成字符串 vnode：
   * transformHoist = stringifyStatic
   */
  transformHoist?: HoistTransform | null

  /**
   * If the pairing runtime provides additional built-in elements, use this to
   * mark them as built-in so the compiler will generate component vnodes
   * for them.
   *
   * 判断一个标签是否是内建组件（如 <Transition>、<KeepAlive>）
   * 如果是，则生成组件 vnode（createVNode(Transition, ...)）
   */
  isBuiltInComponent?: (tag: string) => symbol | void

  /**
   * Used by some transforms that expects only native elements
   *
   * 判断一个标签是否是用户自定义元素（例如 Web Components）
   * 用于跳过这类标签的编译检查（避免警告）
   */
  isCustomElement?: (tag: string) => boolean | void

  /**
   * Transform expressions like {{ foo }} to `_ctx.foo`.
   * If this option is false, the generated code will be wrapped in a
   * `with (this) { ... }` block.
   * - This is force-enabled in module mode, since modules are by default strict
   * and cannot use `with`
   * @default mode === 'module'
   *
   * 否为表达式加 _ctx. 前缀（或使用 unref()）
   */
  prefixIdentifiers?: boolean

  /**
   * Cache static VNodes and props objects to `_hoisted_x` constants
   * @default false
   * 否将模板中的静态节点、静态 props 提升为 _hoisted_x
   * 性能优化关键点！
   * 设置为 true，像这样：
   * const _hoisted_1 = createElementVNode("div", null, "hello", -1)
   * 可避免每次重新创建静态节点。
   */
  hoistStatic?: boolean

  /**
   * Cache v-on handlers to avoid creating new inline functions on each render,
   * also avoids the need for dynamically patching the handlers by wrapping it.
   * e.g `@click="foo"` by default is compiled to `{ onClick: foo }`. With this
   * option it's compiled to:
   * ```js
   * { onClick: _cache[0] || (_cache[0] = e => _ctx.foo(e)) }
   * ```
   * - Requires "prefixIdentifiers" to be enabled because it relies on scope
   * analysis to determine if a handler is safe to cache.
   * @default false
   *
   * 缓存事件处理函数（如 @click="foo"）
   * 开启后变成：
   * onClick: _cache[0] || (_cache[0] = e => _ctx.foo(e))
   * 避免每次重新创建函数（提升性能），需要开启 prefixIdentifiers 才能正确判断作用域。
   */
  cacheHandlers?: boolean

  /**
   * A list of parser plugins to enable for `@babel/parser`, which is used to
   * parse expressions in bindings and interpolations.
   * https://babeljs.io/docs/en/next/babel-parser#plugins
   *
   * 传给 Babel parser 的插件，用于支持 TS、JSX 等扩展语法
   *
   * 例如支持：
   * expressionPlugins: ['typescript', 'optionalChaining', 'decorators']
   */
  expressionPlugins?: ParserPlugin[]

  /**
   * SFC scoped styles ID
   * 用于 SFC <style scoped>，编译时生成的唯一 ID，如：data-v-abc123
   * 影响生成 vnode：
   * <div data-v-abc123>
   */
  scopeId?: string | null

  /**
   * Indicates this SFC template has used :slotted in its styles
   * Defaults to `true` for backwards compatibility - SFC tooling should set it
   * to `false` if no `:slotted` usage is detected in `<style>`
   *
   * 是否检测到了 :slotted 样式，影响编译产物的 slotted 标记（用于 scope CSS）
   * Vue 默认设置为 true 以兼容旧代码，但如果 <style> 中没用 :slotted，推荐设置为 false 以优化体积。
   */
  slotted?: boolean

  /**
   * SFC `<style vars>` injection string
   * Should already be an object expression, e.g. `{ 'xxxx-color': color }`
   * needed to render inline CSS variables on component root
   *
   * 编译服务端渲染时，组件需要注入的 CSS 变量（来自 <style vars>）
   * 例如：
   * ssrCssVars: `{ '--main-color': mainColor }`
   * 编译后会插入内联变量支持。
   */
  ssrCssVars?: string

  /**
   * Whether to compile the template assuming it needs to handle HMR.
   * Some edge cases may need to generate different code for HMR to work
   * correctly, e.g. #6938, #7138
   *
   * 是否生成 HMR（热更新）友好的代码
   * 某些边缘场景下（如组件包含自引用等），需要不同的代码以确保热更新正确工作。
   */
  hmr?: boolean
}

// compile()
//   └─ parse() → AST
//       └─ transform()     ← uses SharedTransformCodegenOptions
//           └─ generate()  ← uses CodegenOptions
export interface CodegenOptions extends SharedTransformCodegenOptions {
  /**
   * - `module` mode will generate ES module import statements for helpers
   * and export the render function as the default export.
   * - `function` mode will generate a single `const { helpers... } = Vue`
   * statement and return the render function. It expects `Vue` to be globally
   * available (or passed by wrapping the code with an IIFE). It is meant to be
   * used with `new Function(code)()` to generate a render function at runtime.
   * @default 'function'
   *
   * 控制生成的代码格式（ESM 模块 vs 函数体运行）
   *
   * 'module'（默认用于生产构建）
   * 会生成：
   * import { toDisplayString, openBlock } from "vue"
   * export default function render(...) { ... }
   *
   * 'function'（用于 new Function() 动态生成）
   * 会生成：
   * const { toDisplayString, openBlock } = Vue
   * return function render(...) { ... }
   *
   * 用途：
   * 模块模式用于 打包构建
   * 函数模式用于 运行时动态构建（如沙箱或浏览器中 new Function()）
   */
  mode?: 'module' | 'function'

  /**
   * Generate source map?
   * @default false
   *
   * 是否生成 source map（用于调试）
   * generate(ast, {
   *   sourceMap: true
   * })
   * 会附带 codeMap 数据供调试器定位模板中的行列。
   */
  sourceMap?: boolean

  /**
   * SFC scoped styles ID
   * 用于生成带作用域的 CSS 编译 ID，如 <style scoped>
   *
   * 举例：
   * 当 scopeId = "data-v-123abc"，渲染代码会插入：
   * <div data-v-123abc>
   * 也会影响：
   * _push(`<div data-v-123abc>`)
   * 用于保证 SFC 样式只作用于当前组件。
   */
  scopeId?: string | null

  /**
   * Option to optimize helper import bindings via variable assignment
   * (only used for webpack code-split)
   * @default false
   *
   * 是否优化 helpers 的导入形式
   * 当设置为 true 时，适用于 Webpack 代码分割优化场景（很少用户用到这个高级功能）：
   * import _toDisplayString from 'vue/runtime-core/toDisplayString'
   * 默认是 false，正常使用即可。
   */
  optimizeImports?: boolean

  /**
   * Customize where to import runtime helpers from.
   * @default 'vue'
   *
   * 默认从哪里导入 Vue 的 runtime helper 工具函数
   * 默认值：'vue'
   * 如果你在自定义构建中想要从别的包导入 runtime，可以自定义它
   *
   * 示例：
   * runtimeModuleName: 'vue-runtime-core'
   * 则生成代码：
   * import { toDisplayString } from 'vue-runtime-core'
   */
  runtimeModuleName?: string

  /**
   * Customize where to import ssr runtime helpers from/**
   * @default 'vue/server-renderer'
   *
   * 类似上面的 runtime 配置，但用于 SSR 编译
   * 默认：vue/server-renderer
   * 用于从服务器渲染的 helper 中导入函数
   */
  ssrRuntimeModuleName?: string

  /**
   * Customize the global variable name of `Vue` to get helpers from
   * in function mode
   * @default 'Vue'
   *
   * 仅在 'function' 模式下生效，用来指定全局变量名
   *
   * 默认是 'Vue'，意味着在非模块模式中生成：
   * const { openBlock, createBlock } = Vue
   * 如果你用的是自定义的全局变量，可以改名：
   * runtimeGlobalName: '__MyVue__'
   * 会生成：
   * const { openBlock } = __MyVue__
   */
  runtimeGlobalName?: string
}

export type CompilerOptions = ParserOptions & TransformOptions & CodegenOptions
