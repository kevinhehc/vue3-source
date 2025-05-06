import type { CallExpression, Node, ObjectPattern, Program } from '@babel/types'
import type { SFCDescriptor } from '../parse'
import { generateCodeFrame, isArray } from '@vue/shared'
import { type ParserPlugin, parse as babelParse } from '@babel/parser'
import type { ImportBinding, SFCScriptCompileOptions } from '../compileScript'
import type { PropsDestructureBindings } from './defineProps'
import type { ModelDecl } from './defineModel'
import type { BindingMetadata } from '../../../compiler-core/src'
import MagicString from 'magic-string'
import type { TypeScope } from './resolveType'
import { warn } from '../warn'

// ScriptCompileContext 是一个中间状态容器，在编译单文件组件时用于收集、追踪、操作 <script> 和 <script setup> 中的所有关键信息。
export class ScriptCompileContext {
  // isJS: 是否为 JavaScript 文件
  // isTS: 是否为 TypeScript（含 ts, tsx, mts, mtsx 等）
  // isCE: 是否为自定义元素模式（Custom Elements）
  isJS: boolean
  isTS: boolean
  isCE = false

  // 存放普通 <script> 与 <script setup> 的 Babel AST
  // 用于后续分析如变量声明、宏调用等结构
  scriptAst: Program | null
  scriptSetupAst: Program | null

  // source: 源代码全文
  // filename: 当前 SFC 文件名
  // s: 用于修改源代码并生成 sourcemap 的 MagicString 实例
  // startOffset / endOffset: <script setup> 标签在整个文件中的位置偏移（用于生成 code frame、报错定位等）
  source: string = this.descriptor.source
  filename: string = this.descriptor.filename
  s: MagicString = new MagicString(this.source)
  startOffset: number | undefined =
    this.descriptor.scriptSetup?.loc.start.offset
  endOffset: number | undefined = this.descriptor.scriptSetup?.loc.end.offset

  // import / type analysis
  // scope: 当前语法块的作用域，用于记录变量、类型等的可见性
  // userImports: 用户在 <script> 中的导入内容（用于分析哪些变量是来自外部）
  scope?: TypeScope
  globalScopes?: TypeScope[]
  userImports: Record<string, ImportBinding> = Object.create(null)

  // macros presence check
  // 用于记录是否在代码中使用了宏函数，如 defineProps()、defineEmits() 等
  // 编译器据此判断是否注入相关运行时代码、生成辅助逻辑
  hasDefinePropsCall = false
  hasDefineEmitCall = false
  hasDefineExposeCall = false
  hasDefaultExportName = false
  hasDefaultExportRender = false
  hasDefineOptionsCall = false
  hasDefineSlotsCall = false
  hasDefineModelCall = false

  // defineProps
  // 用于支持如下各种 defineProps() 变体的处理：
  // const props = defineProps<{ title: string }>()
  // const { title } = defineProps()
  // 提取类型、解构变量、默认值等信息，供后续代码生成使用
  propsCall: CallExpression | undefined
  propsDecl: Node | undefined
  propsRuntimeDecl: Node | undefined
  propsTypeDecl: Node | undefined
  propsDestructureDecl: ObjectPattern | undefined
  propsDestructuredBindings: PropsDestructureBindings = Object.create(null)
  propsDestructureRestId: string | undefined
  propsRuntimeDefaults: Node | undefined

  // defineEmits、defineModel、defineOptions 相关字段
  // 类似 defineProps，这些字段存储了宏的声明节点、类型定义、辅助信息，用于生成最终的组件导出代码。

  // defineEmits
  emitsRuntimeDecl: Node | undefined
  emitsTypeDecl: Node | undefined
  emitDecl: Node | undefined

  // defineModel
  modelDecls: Record<string, ModelDecl> = Object.create(null)

  // defineOptions
  optionsRuntimeDecl: Node | undefined

  // codegen
  // bindingMetadata: 当前 SFC 中的变量绑定信息（如哪些是 prop、data、setup 变量等）
  // helperImports: 所有使用到的 Vue 辅助函数（如 ref, defineExpose 等）
  // helper(): 注册一个辅助函数并返回对应的代码标识（用于生成代码时替换为 _defineExpose() 等）
  bindingMetadata: BindingMetadata = {}
  helperImports: Set<string> = new Set()
  helper(key: string): string {
    this.helperImports.add(key)
    return `_${key}`
  }

  /**
   * to be exposed on compiled script block for HMR cache busting
   */
  // deps: 当前模块依赖的文件路径集合（用于热更新判断）
  deps?: Set<string>

  /**
   * cache for resolved fs
   */
  // fs: 可注入的文件系统接口，用于读取额外文件内容等（如 type-only imports）
  fs?: NonNullable<SFCScriptCompileOptions['fs']>

  // 完成了初始化工作，包括语言类型判断、解析 AST、记录配置项等，目的是为后续的宏分析、变量提取、代码生成等提供完整上下文信息。
  constructor(
    // descriptor: parse() 得到的组件解析描述对象，包含 <script>、<script setup> 的内容、位置等
    // options: 用户传入的 <script> 编译选项（如是否启用 TS、是否是 Custom Element 等）
    public descriptor: SFCDescriptor,
    public options: Partial<SFCScriptCompileOptions>,
  ) {
    const { script, scriptSetup } = descriptor
    const scriptLang = script && script.lang
    const scriptSetupLang = scriptSetup && scriptSetup.lang

    // 根据 <script lang="..."> 或 <script setup lang="..."> 推断语言类型。
    this.isJS =
      scriptLang === 'js' ||
      scriptLang === 'jsx' ||
      scriptSetupLang === 'js' ||
      scriptSetupLang === 'jsx'
    this.isTS =
      scriptLang === 'ts' ||
      scriptLang === 'tsx' ||
      scriptSetupLang === 'ts' ||
      scriptSetupLang === 'tsx'

    // 如果配置启用了 customElement，标记当前组件为自定义元素
    // 支持传布尔值或函数（按文件名判断）
    const customElement = options.customElement
    const filename = this.descriptor.filename
    if (customElement) {
      this.isCE =
        typeof customElement === 'boolean'
          ? customElement
          : customElement(filename)
    }
    // resolve parser plugins
    // 调用 resolveParserPlugins 函数，根据语言和用户配置生成适合的 Babel parser 插件（如 typescript, jsx, decorators 等）
    const plugins: ParserPlugin[] = resolveParserPlugins(
      (scriptLang || scriptSetupLang)!,
      options.babelParserPlugins,
    )

    // 调用 @babel/parser 进行源码解析，生成 Program AST
    // 发生错误时，构造带代码框的错误提示（使用 generateCodeFrame）
    // offset 用于确保报错位置与整个 SFC 的源代码行列一致
    function parse(input: string, offset: number): Program {
      try {
        return babelParse(input, {
          plugins,
          sourceType: 'module',
        }).program
      } catch (e: any) {
        e.message = `[vue/compiler-sfc] ${e.message}\n\n${
          descriptor.filename
        }\n${generateCodeFrame(
          descriptor.source,
          e.pos + offset,
          e.pos + offset + 1,
        )}`
        throw e
      }
    }

    // 分别对 <script> 和 <script setup> 的内容进行解析，保存为 Babel AST 的 Program 对象，供后续分析使用。
    this.scriptAst =
      descriptor.script &&
      parse(descriptor.script.content, descriptor.script.loc.start.offset)

    this.scriptSetupAst =
      descriptor.scriptSetup &&
      parse(descriptor.scriptSetup!.content, this.startOffset!)
  }

  // 给定一个 AST 节点，提取其在源文件中的代码字符串
  // 用于宏处理、代码提取、类型分析等
  getString(node: Node, scriptSetup = true): string {
    const block = scriptSetup
      ? this.descriptor.scriptSetup!
      : this.descriptor.script!
    return block.content.slice(node.start!, node.end!)
  }

  //  warn()：生成带代码框的警告信息，调用全局 warn() 函数输出
  warn(msg: string, node: Node, scope?: TypeScope): void {
    warn(generateError(msg, node, this, scope))
  }

  // error()：抛出包含代码位置提示的错误，终止编译过程
  error(msg: string, node: Node, scope?: TypeScope): never {
    throw new Error(
      `[@vue/compiler-sfc] ${generateError(msg, node, this, scope)}`,
    )
  }
}

// 错误提示工具函数 generateError，用于生成包含源码高亮的错误信息，帮助开发者快速定位 <script> 区块中的语法或类型问题。
function generateError(
  // 参数	含义
  // msg	错误信息文本（如：变量未定义）
  // node	错误对应的 AST 节点，包含 start 和 end 位置
  // ctx	编译上下文，包含源代码、文件名、起始偏移等信息
  // scope	可选的类型分析作用域（某些子块作用域），用于定位偏移和源代码
  msg: string,
  node: Node,
  ctx: ScriptCompileContext,
  scope?: TypeScope,
) {
  // 获取偏移量（offset），用于正确定位错误在源码中的位置
  // 如果指定了 scope（如 setup() 返回内部作用域），使用其 offset；
  // 否则使用整个 <script> 的起始偏移量 ctx.startOffset
  const offset = scope ? scope.offset : ctx.startOffset!

  // 返回格式：

  // <错误信息>
  //
  // <文件路径>
  // <高亮代码片段>

  // 例如：
  // Variable "count" is not defined.
  //
  // src/components/Foo.vue
  //   12 |   return {
  //   13 |     count: unknownVar
  //      |             ^^^^^^^^^

  // 关键工具函数：
  // generateCodeFrame(source, start, end)
  // 提供高亮代码片段（类 CLI 编译器报错）
  // 类似 Babel 的错误框架，可精确标出问题所在
  return `${msg}\n\n${(scope || ctx.descriptor).filename}\n${generateCodeFrame(
    (scope || ctx.descriptor).source,
    node.start! + offset,
    node.end! + offset,
  )}`
}

// 根据脚本语言类型（如 ts, tsx, jsx）和用户自定义插件选项，生成最终用于 Babel 解析器（@babel/parser）的插件列表。
// 这是为了配置 Babel 在解析 <script> 内容时所需要的语言特性支持插件，例如是否启用 TypeScript、JSX、decorators 等语法扩展。
export function resolveParserPlugins(
  // 参数	含义
  // lang	<script lang="xxx"> 中的语言类型（如 'ts', 'tsx', 'js', 'jsx'）
  // userPlugins	用户传入的自定义 Babel parser 插件列表
  // dts	是否正在解析 .d.ts 类型声明文件，用于配置 typescript 插件选项
  lang: string,
  userPlugins?: ParserPlugin[],
  dts = false,
): ParserPlugin[] {
  // 初始化插件数组
  const plugins: ParserPlugin[] = []
  // 如果用户没有显式添加 importAttributes 或 importAssertions，则默认添加 importAttributes；
  // 支持这种语法的解析：
  // import img from './a.png' with { type: 'image' }
  if (
    !userPlugins ||
    !userPlugins.some(
      p =>
        p === 'importAssertions' ||
        p === 'importAttributes' ||
        (isArray(p) && p[0] === 'importAttributes'),
    )
  ) {
    plugins.push('importAttributes')
  }
  // 处理 JSX 支持
  // 如果语言是支持 JSX 的，添加 jsx 插件；
  // 否则：如果用户插件中包含 jsx，就过滤掉（防止报错或多余配置）
  if (lang === 'jsx' || lang === 'tsx' || lang === 'mtsx') {
    plugins.push('jsx')
  } else if (userPlugins) {
    // If don't match the case of adding jsx
    // should remove the jsx from user options
    userPlugins = userPlugins.filter(p => p !== 'jsx')
  }
  // 对于 TypeScript、TSX、MTSX 文件：
  // 加入 typescript 插件（并传递是否是 .d.ts 文件）
  // 加入 explicitResourceManagement（支持 using 语法）
  // 如果用户没有指定 decorators 插件，则默认使用 decorators-legacy
  if (lang === 'ts' || lang === 'mts' || lang === 'tsx' || lang === 'mtsx') {
    plugins.push(['typescript', { dts }], 'explicitResourceManagement')
    if (!userPlugins || !userPlugins.includes('decorators')) {
      plugins.push('decorators-legacy')
    }
  }
  // 合并用户插件（最后添加）
  if (userPlugins) {
    plugins.push(...userPlugins)
  }
  return plugins

  // 用途场景：
  //
  // Vue SFC 编译器需要根据 <script lang="xxx"> 动态配置 Babel 解析器插件；
  // 保证正确解析 TS、JSX、decorators、import attributes 等语法；
  // 同时允许用户通过 compilerOptions.parserPlugins 传入自定义插件。
}
