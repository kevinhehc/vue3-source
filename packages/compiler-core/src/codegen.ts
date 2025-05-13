import type { CodegenOptions } from './options'
import {
  type ArrayExpression,
  type AssignmentExpression,
  type CacheExpression,
  type CallExpression,
  type CommentNode,
  type CompoundExpressionNode,
  type ConditionalExpression,
  type ExpressionNode,
  type FunctionExpression,
  type IfStatement,
  type InterpolationNode,
  type JSChildNode,
  NodeTypes,
  type ObjectExpression,
  type Position,
  type ReturnStatement,
  type RootNode,
  type SSRCodegenNode,
  type SequenceExpression,
  type SimpleExpressionNode,
  type TemplateChildNode,
  type TemplateLiteral,
  type TextNode,
  type VNodeCall,
  getVNodeBlockHelper,
  getVNodeHelper,
  locStub,
} from './ast'
import { SourceMapGenerator } from 'source-map-js'
import {
  advancePositionWithMutation,
  assert,
  isSimpleIdentifier,
  toValidAssetId,
} from './utils'
import {
  PatchFlagNames,
  type PatchFlags,
  isArray,
  isString,
  isSymbol,
} from '@vue/shared'
import {
  CREATE_COMMENT,
  CREATE_ELEMENT_VNODE,
  CREATE_STATIC,
  CREATE_TEXT,
  CREATE_VNODE,
  OPEN_BLOCK,
  RESOLVE_COMPONENT,
  RESOLVE_DIRECTIVE,
  RESOLVE_FILTER,
  SET_BLOCK_TRACKING,
  TO_DISPLAY_STRING,
  WITH_CTX,
  WITH_DIRECTIVES,
  helperNameMap,
} from './runtimeHelpers'
import type { ImportItem } from './transform'

/**
 * The `SourceMapGenerator` type from `source-map-js` is a bit incomplete as it
 * misses `toJSON()`. We also need to add types for internal properties which we
 * need to access for better performance.
 *
 * Since TS 5.3, dts generation starts to strangely include broken triple slash
 * references for source-map-js, so we are inlining all source map related types
 * here to to workaround that.
 *
 * source-map-js 的类型声明不完整：
 * 没有包含 toJSON() 方法。
 * 有些内部属性（如 _sources、_mappings）虽然存在，但类型定义中没有暴露。
 *
 * TypeScript 5.3 起出现的问题：
 * TypeScript 在 .d.ts 文件生成时对 source-map-js 的引用出错。
 * 所以 直接内联这些类型，绕过错误。
 */

// 这是对 source-map-js 的 SourceMapGenerator 的替代接口。
export interface CodegenSourceMapGenerator {
  // 置源文件内容，用于调试映射。
  // 相当于告诉 sourcemap：这段 JS 是从哪个源代码转译来的。
  setSourceContent(sourceFile: string, sourceContent: string): void
  // SourceMapGenerator has this method but the types do not include it
  // 官方未定义但实际存在的方法。
  // 把 source map 转换为最终的 JSON 格式对象。
  // RawSourceMap 是标准 source map 格式。
  toJSON(): RawSourceMap
  // source-map-js 内部用于存储所有源文件、变量名。
  // 编译器用这些字段来做优化（比如判断是否添加重复项）。
  _sources: Set<string>
  _names: Set<string>
  // _mappings.add(...) 是内部 API，用于添加一条 mapping。
  // 比起使用高层 API，直接操作内部结构会更快、更可控，但也不建议公开。
  _mappings: {
    add(mapping: MappingItem): void
  }
}

// 用来描述 JS 源码编译之后与原始源码的映射关系。
export interface RawSourceMap {
  file?: string // 可选，表示生成的目标文件名（如 app.js）
  sourceRoot?: string // 可选，源文件路径的根目录，用于简化路径（如 "../src"）
  version: string // 版本号，必须是 "3"（Source Map v3）
  sources: string[] // 所有源文件路径（相对于 sourceRoot）
  names: string[] // 所有出现在映射中的变量或属性名（如 foo, bar）
  sourcesContent?: string[] // 源文件的原始内容（按 sources 顺序），用于嵌入源码
  mappings: string // 使用 VLQ 编码的映射数据字符串（压缩后的映射路径）
}

// 这个是单条映射的结构，是 source-map-js 内部维护 _mappings 时每一条映射项的数据。
interface MappingItem {
  source: string // 对应的源文件路径
  generatedLine: number // 编译后代码所在的行号（从 1 开始）
  generatedColumn: number // 编译后代码所在的列号（从 0 开始）
  originalLine: number // 原始源码中的行号
  originalColumn: number // 原始源码中的列号
  name: string | null // 映射的变量或方法名（可能用于 names 字段）
}

// Babel 和 Rollup 会识别这个注释标记，表示这个函数是 无副作用的纯函数。
// 这样可以安全地进行 Tree-Shaking。
const PURE_ANNOTATION = `/*@__PURE__*/`

// 作用是为 import 创建别名形式，如：
// import {
//   createVNode as _createVNode
// } from "vue"
// 比如：
// aliasHelper(CREATE_VNODE)
// // => "createVNode: _createVNode"
const aliasHelper = (s: symbol) => `${helperNameMap[s]}: _${helperNameMap[s]}`

// 表示所有可以参与代码生成的节点类型（Vue 模板中节点或 JS 表达式等）：
// TemplateChildNode：模板里的 DOM 节点、插值表达式等。
// JSChildNode：JavaScript 表达式片段节点。
// SSRCodegenNode：SSR 模式下的 AST 节点。
type CodegenNode = TemplateChildNode | JSChildNode | SSRCodegenNode

export interface CodegenResult {
  code: string // 最终生成的 JS 渲染函数字符串
  preamble: string // import 声明、变量定义等头部代码
  ast: RootNode // 输入的模板 AST
  map?: RawSourceMap // 可选的 source map
}

// 时决定是否在开头或结尾添加换行。
// 这个状态通常用于格式化输出。
enum NewlineType {
  Start = 0,
  End = -1,
  None = -2,
  Unknown = -3,
}

export interface CodegenContext
  extends Omit<Required<CodegenOptions>, 'bindingMetadata' | 'inline'> {
  source: string // 原始模板字符串
  code: string // 当前累积生成的代码字符串
  line: number // 当前行号
  column: number // 当前列号
  offset: number // 源码位置偏移
  indentLevel: number // 当前缩进级别
  pure: boolean // 是否要加 PURE 注释
  map?: CodegenSourceMapGenerator // 如果生成 source map，则是它的构建器
  helper(key: symbol): string // 获取 helper 的别名（如 _createVNode）用于生成代码。
  push(code: string, newlineIndex?: number, node?: CodegenNode): void // 添加一段代码到 code 字符串中，同时更新位置信息和映射。

  // 控制缩进与换行，用于格式化输出结构。
  indent(): void
  deindent(withoutNewLine?: boolean): void
  newline(): void
}

// 创建一个用于收集和生成代码的上下文对象 CodegenContext。
// ast: 模板编译后的抽象语法树。
// options: 编码配置选项，比如是否开启 sourceMap、是否是 SSR、是否使用 TypeScript 等。
function createCodegenContext(
  ast: RootNode,
  {
    mode = 'function',
    prefixIdentifiers = mode === 'module',
    sourceMap = false,
    filename = `template.vue.html`,
    scopeId = null,
    optimizeImports = false,
    runtimeGlobalName = `Vue`,
    runtimeModuleName = `vue`,
    ssrRuntimeModuleName = 'vue/server-renderer',
    ssr = false,
    isTS = false,
    inSSR = false,
  }: CodegenOptions,
): CodegenContext {
  const context: CodegenContext = {
    mode,
    prefixIdentifiers,
    sourceMap,
    filename,
    scopeId,
    optimizeImports,
    runtimeGlobalName,
    runtimeModuleName,
    ssrRuntimeModuleName,
    ssr,
    isTS,
    inSSR,
    source: ast.source,
    code: ``,
    column: 1,
    line: 1,
    offset: 0,
    indentLevel: 0,
    pure: false,
    map: undefined,
    // 用于从 helperNameMap 中取出辅助函数的名称（如 _toDisplayString）。
    // 给方法加上下划线
    helper(key) {
      return `_${helperNameMap[key]}`
    },
    // 用于向生成结果中添加代码字符串，同时根据内容更新行号、列号，以及添加 source map 映射（如果启用）。
    // 参数	说明
    // code	要追加的代码字符串
    // newlineIndex	表示换行符在字符串中的位置或类型（用于优化性能）
    // node	与这段代码对应的 AST 节点（用于生成 source map 映射）
    push(code, newlineIndex = NewlineType.None, node) {
      // 将传入的 code 追加到当前上下文维护的 code 变量中，构成最终的渲染函数代码。
      context.code += code

      // !__BROWSER__: 只在非浏览器环境中进行 source map 生成（构建阶段）。
      // context.map: 是否启用了 sourceMap 功能。
      if (!__BROWSER__ && context.map) {
        // 添加起始位置映射（根据 AST 节点）
        if (node) {
          // 如果传入了 AST 节点 node，并且是一个动态表达式（非静态），尝试提取出一个有意义的变量名（如 _ctx.foo → foo），用于 source map 的 name 字段。
          // addMapping(node.loc.start, name)：将这段代码的起始位置（模板中的位置）映射到生成代码的当前位置。
          let name
          if (node.type === NodeTypes.SIMPLE_EXPRESSION && !node.isStatic) {
            const content = node.content.replace(/^_ctx\./, '')
            if (content !== node.content && isSimpleIdentifier(content)) {
              name = content
            }
          }
          addMapping(node.loc.start, name)
        }
        // 如果换行位置未知，调用通用方法 advancePositionWithMutation 来逐字符扫描代码，更新行号、列号、偏移量。
        if (newlineIndex === NewlineType.Unknown) {
          // multiple newlines, full iteration
          advancePositionWithMutation(context, code)
        } else {
          // fast paths
          // 快速路径：优化处理不含换行符的字符串
          // // 直接增加 offset 和 column（不需处理换行）。
          context.offset += code.length
          if (newlineIndex === NewlineType.None) {
            // no newlines; fast path to avoid newline detection
            if (__TEST__ && code.includes('\n')) {
              // 若在测试模式下发现实际包含 \n，抛出错误提醒开发者。
              throw new Error(
                `CodegenContext.push() called newlineIndex: none, but contains` +
                  `newlines: ${code.replace(/\n/g, '\\n')}`,
              )
            }
            context.column += code.length
          } else {
            // single newline at known index
            // 单一换行符优化路径（位于字符串末尾）
            if (newlineIndex === NewlineType.End) {
              // NewlineType.End: 说明换行符在字符串末尾。直接推算位置。
              newlineIndex = code.length - 1
            }
            if (
              __TEST__ &&
              (code.charAt(newlineIndex) !== '\n' ||
                code.slice(0, newlineIndex).includes('\n') ||
                code.slice(newlineIndex + 1).includes('\n'))
            ) {
              // 然后做合法性校验（测试模式）：
              throw new Error(
                `CodegenContext.push() called with newlineIndex: ${newlineIndex} ` +
                  `but does not conform: ${code.replace(/\n/g, '\\n')}`,
              )
            }
            // 接着更新行列号：
            context.line++
            context.column = code.length - newlineIndex
          }
        }
        if (node && node.loc !== locStub) {
          addMapping(node.loc.end)
        }
      }
    },
    // 增加缩进层级 + 换行
    indent() {
      newline(++context.indentLevel)
    },
    // 减少缩进层级（可以选择是否换行）
    deindent(withoutNewLine = false) {
      if (withoutNewLine) {
        --context.indentLevel
      } else {
        newline(--context.indentLevel)
      }
    },
    // 根据当前缩进层级插入换行和空格
    newline() {
      newline(context.indentLevel)
    },
  }

  function newline(n: number) {
    context.push('\n' + `  `.repeat(n), NewlineType.Start)
  }

  // 这是用于添加 source map 的映射记录（只有开启了 sourceMap 才生效）。
  function addMapping(loc: Position, name: string | null = null) {
    // we use the private property to directly add the mapping
    // because the addMapping() implementation in source-map-js has a bunch of
    // unnecessary arg and validation checks that are pure overhead in our case.
    const { _names, _mappings } = context.map!
    if (name !== null && !_names.has(name)) _names.add(name)
    _mappings.add({
      // originalLine / originalColumn: 源模板的位置
      // generatedLine / generatedColumn: 输出代码中的位置
      originalLine: loc.line,
      originalColumn: loc.column - 1, // source-map column is 0 based
      generatedLine: context.line,
      generatedColumn: context.column - 1,
      source: filename,
      name,
    })
  }

  if (!__BROWSER__ && sourceMap) {
    // 只在非浏览器环境（比如构建时）并且开启了 sourceMap 的时候，才会真正加载 source-map-js 来初始化生成器。
    // lazy require source-map implementation, only in non-browser builds
    context.map =
      new SourceMapGenerator() as unknown as CodegenSourceMapGenerator
    context.map.setSourceContent(filename, context.source)
    context.map._sources.add(filename)
  }

  return context
}

// 核心方法
// 在线代码生成测试 https://template-explorer.vuejs.org/#eyJzcmMiOiI8ZGl2PkhlbGxvIFdvcmxkPC9kaXY+Iiwib3B0aW9ucyI6e319
// 模板编译阶段的最后一步：将 AST 转换为 JavaScript 渲染函数的源码字符串。
// ast: 模板解析后的抽象语法树（AST）
// options: 代码生成选项
// CodegenResult: 包含最终生成的 code 字符串、sourceMap、preamble、ast 本身
export function generate(
  ast: RootNode,
  options: CodegenOptions & {
    onContextCreated?: (context: CodegenContext) => void
  } = {},
): CodegenResult {
  // 创建 CodegenContext（包含了 push、indent、code 等工具方法）。
  const context = createCodegenContext(ast, options)
  if (options.onContextCreated) options.onContextCreated(context)

  // 拆出 context 中需要用的内容
  const {
    mode,
    push,
    prefixIdentifiers,
    indent,
    deindent,
    newline,
    scopeId,
    ssr,
  } = context

  // 变量	含义
  // helpers	渲染中用到的 helper 函数，如 _toDisplayString
  // useWithBlock	是否用 with(_ctx) {} 作用域包装（非模块/非 prefixIdentifiers 模式）
  // genScopeId	是否为 scoped CSS 生成作用域 ID
  // isSetupInlined	setup 语法糖是否内联渲染函数
  const helpers = Array.from(ast.helpers)
  const hasHelpers = helpers.length > 0
  const useWithBlock = !prefixIdentifiers && mode !== 'module'
  const genScopeId = !__BROWSER__ && scopeId != null && mode === 'module'
  const isSetupInlined = !__BROWSER__ && !!options.inline

  // preambles
  // in setup() inline mode, the preamble is generated in a sub context
  // and returned separately.
  // 渲染函数头部代码生成（Preamble）
  const preambleContext = isSetupInlined
    ? createCodegenContext(ast, options)
    : context
  // 模块模式：生成 import { ... } from 'vue'
  // 非模块模式：添加 _Vue = Vue、注册 helpers 等
  if (!__BROWSER__ && mode === 'module') {
    genModulePreamble(ast, preambleContext, genScopeId, isSetupInlined)
  } else {
    genFunctionPreamble(ast, preambleContext)
  }

  // enter render function
  // 渲染函数签名生成
  // 非 SSR 模式下是：
  // function render(_ctx, _cache)
  const functionName = ssr ? `ssrRender` : `render`
  const args = ssr ? ['_ctx', '_push', '_parent', '_attrs'] : ['_ctx', '_cache']
  if (!__BROWSER__ && options.bindingMetadata && !options.inline) {
    // binding optimization args
    args.push('$props', '$setup', '$data', '$options')
  }

  // 然后，如果开启 TS 或 binding metadata，会生成带类型的签名：
  // const signature = options.isTS ? args.map(arg => `${arg}: any`).join(',') : ...
  const signature =
    !__BROWSER__ && options.isTS
      ? args.map(arg => `${arg}: any`).join(',')
      : args.join(', ')

  // 函数体起始代码
  // 例如：
  // function render(_ctx, _cache) {
  if (isSetupInlined) {
    push(`(${signature}) => {`)
  } else {
    push(`function ${functionName}(${signature}) {`)
  }
  indent()

  // with block 开启作用域包裹（Vue 2 兼容模式）
  // 再将需要的 helpers 解构出来：
  if (useWithBlock) {
    push(`with (_ctx) {`)
    indent()
    // function mode const declarations should be inside with block
    // also they should be renamed to avoid collision with user properties
    if (hasHelpers) {
      push(
        `const { ${helpers.map(aliasHelper).join(', ')} } = _Vue\n`,
        NewlineType.End,
      )
      newline()
    }
  }

  // generate asset resolution statements
  // 生成组件/指令/过滤器注册语句（内部 asset）
  // 这些调用会生成如下代码：
  // resolveComponent("MyComponent")
  // resolveDirective("v-model")
  if (ast.components.length) {
    genAssets(ast.components, 'component', context)
    if (ast.directives.length || ast.temps > 0) {
      newline()
    }
  }
  if (ast.directives.length) {
    genAssets(ast.directives, 'directive', context)
    if (ast.temps > 0) {
      newline()
    }
  }
  if (__COMPAT__ && ast.filters && ast.filters.length) {
    newline()
    genAssets(ast.filters, 'filter', context)
    newline()
  }

  // 这些是为运行时表达式所准备的临时变量（优化或转换中间产物）。
  if (ast.temps > 0) {
    push(`let `)
    for (let i = 0; i < ast.temps; i++) {
      push(`${i > 0 ? `, ` : ``}_temp${i}`)
    }
  }
  if (ast.components.length || ast.directives.length || ast.temps) {
    push(`\n`, NewlineType.Start)
    newline()
  }

  // generate the VNode tree expression
  // 渲染树代码生成
  // 核心的虚拟 DOM 树就是在这里生成的 —— 会调用 genNode() 遍历整个 codegenNode
  if (!ssr) {
    push(`return `)
  }
  if (ast.codegenNode) {
    genNode(ast.codegenNode, context)
  } else {
    push(`null`)
  }

  // 尾部闭合代码块
  // 结束 with block 和整个渲染函数。
  if (useWithBlock) {
    deindent()
    push(`}`)
  }

  deindent()
  push(`}`)

  // 最终输出结果：
  // 一个典型的渲染函数最终看起来会像这样：
  // function render(_ctx, _cache) {
  //   with (_ctx) {
  //     const { toDisplayString, openBlock, createElementBlock } = _Vue
  //     return (openBlock(), createElementBlock("div", null, toDisplayString(msg)))
  //   }
  // }
  return {
    ast,
    code: context.code,
    preamble: isSetupInlined ? preambleContext.code : ``,
    map: context.map ? context.map.toJSON() : undefined,
  }
}

// 专门用来生成渲染函数开头的 变量声明和导入语句。
// 这个函数生成的代码是插在渲染函数体开头、正式生成 vnode 代码之前的，比如：
// const { createVNode, toDisplayString } = Vue
function genFunctionPreamble(ast: RootNode, context: CodegenContext) {
  // 变量	含义
  // ssr	是否为服务器端渲染模式
  // prefixIdentifiers	是否启用了前缀标识符模式（作用：_ctx.xxx）
  // push()	输出代码字符串
  // runtimeModuleName	默认是 'vue'，用于 require('vue')
  // runtimeGlobalName	默认是 'Vue'，浏览器环境下的全局变量
  // ssrRuntimeModuleName	默认是 'vue/server-renderer'，SSR 渲染器模块名
  const {
    ssr,
    prefixIdentifiers,
    push,
    newline,
    runtimeModuleName,
    runtimeGlobalName,
    ssrRuntimeModuleName,
  } = context

  // 这行逻辑的作用是：
  //
  // 在 SSR 模式（Node.js 中），生成：
  // require("vue")
  // 在浏览器环境中，使用：
  // 这个变量在后面用于生成 const { helper1, helper2 } = VueBinding 语句。
  const VueBinding =
    !__BROWSER__ && ssr
      ? `require(${JSON.stringify(runtimeModuleName)})`
      : runtimeGlobalName

  // Generate const declaration for helpers
  // In prefix mode, we place the const declaration at top so it's done
  // only once; But if we not prefixing, we place the declaration inside the
  // with block so it doesn't incur the `in` check cost for every helper access.
  // 将编译器记录的所有渲染时用到的 helper 函数列出来。
  const helpers = Array.from(ast.helpers)
  if (helpers.length > 0) {
    // 如果 prefixIdentifiers: true（模块模式）
    // 所有 helper 被解构一次放在顶层，全局复用。
    if (!__BROWSER__ && prefixIdentifiers) {
      push(
        `const { ${helpers.map(aliasHelper).join(', ')} } = ${VueBinding}\n`,
        NewlineType.End,
      )
    } else {
      // "with" mode.
      // save Vue in a separate variable to avoid collision
      // 否则（with 模式 / 浏览器全局模式）
      // 把全局 Vue 缓存在 _Vue 变量中，避免冲突。
      // 实际 helper 解构在 with (_ctx) {} 内部进行。
      // 但对于静态提升（hoist）的节点，其 helper 不能写在 with 中，所以这里提前声明。
      push(`const _Vue = ${VueBinding}\n`, NewlineType.End)
      // in "with" mode, helpers are declared inside the with block to avoid
      // has check cost, but hoists are lifted out of the function - we need
      // to provide the helper here.
      // 生成用于静态提升的 helpers（如 createVNode, createStaticVNode）
      // 这段是为了 hoisted vnode 使用的 helpers，它们生成在 with 块之外。
      if (ast.hoists.length) {
        const staticHelpers = [
          CREATE_VNODE,
          CREATE_ELEMENT_VNODE,
          CREATE_COMMENT,
          CREATE_TEXT,
          CREATE_STATIC,
        ]
          .filter(helper => helpers.includes(helper))
          .map(aliasHelper)
          .join(', ')
        push(`const { ${staticHelpers} } = _Vue\n`, NewlineType.End)
      }
    }
  }
  // generate variables for ssr helpers
  // 处理 SSR 模式下的 helpers
  // SSR 渲染用到的 helpers 是来自 vue/server-renderer
  // 它们也需要提前声明
  if (!__BROWSER__ && ast.ssrHelpers && ast.ssrHelpers.length) {
    // ssr guarantees prefixIdentifier: true
    push(
      `const { ${ast.ssrHelpers
        .map(aliasHelper)
        .join(', ')} } = require("${ssrRuntimeModuleName}")\n`,
      NewlineType.End,
    )
  }
  // 生成 hoisted 节点（静态 vnode）
  // 这个调用负责生成形如：
  // const _hoisted_1 = createStaticVNode("<div>Hello</div>", 1)
  // 这些 hoists 会在模板编译时被静态分析出来。
  genHoists(ast.hoists, context)
  newline()
  push(`return `)

  // 最终生成的示例代码可能长这样：
  // const { createVNode, toDisplayString } = Vue
  // const _hoisted_1 = createVNode("div", null, "hello")
  // return
}

// 用于 模块模式 (mode: 'module') 的 genModulePreamble 函数，
// 它和 genFunctionPreamble 一样，也用于生成渲染函数之前的声明代码（Preamble），
// 但是针对模块环境（即使用 ES module 的代码生成，比如 .vue SFC 编译后）。

// 它的任务是为最终生成的 render() 函数提供：
// 代码	内容
// import	从 vue 模块导入需要的 runtime helper
// SSR helper 导入	如果需要 SSR 支持，也从 vue/server-renderer 导入
// 用户 <script setup> 中用到的 import	来自模板 AST 的 imports 属性
// 静态提升节点	通过 genHoists() 提前定义
// export	如果不是内联函数，则导出渲染函数
function genModulePreamble(
  ast: RootNode,
  context: CodegenContext,
  genScopeId: boolean,
  inline?: boolean,
) {
  // 这些都是用于输出代码或构建模块导入时需要的信息。
  const {
    push,
    newline,
    optimizeImports,
    runtimeModuleName,
    ssrRuntimeModuleName,
  } = context

  // generate import statements for helpers
  // ast.helpers 是编译过程中记录的 helper 集合，比如：
  // CREATE_VNODE → createVNode
  // TO_DISPLAY_STRING → toDisplayString
  if (ast.helpers.size) {
    const helpers = Array.from(ast.helpers)
    if (optimizeImports) {
      // optimizeImports === true
      // push(
      //   `import { createVNode, toDisplayString } from "vue"`,
      // )
      // push(
      //   `const _createVNode = createVNode, _toDisplayString = toDisplayString`
      // )
      // 为了解决 Webpack 的 tree-shaking 和作用域穿透问题，编译器会将 helper 先导入，再赋值给本地变量（带 _ 前缀）。
      // 好处：避免运行时使用 (0, createVNode) 包裹形式，减少性能损耗。

      // when bundled with webpack with code-split, calling an import binding
      // as a function leads to it being wrapped with `Object(a.b)` or `(0,a.b)`,
      // incurring both payload size increase and potential perf overhead.
      // therefore we assign the imports to variables (which is a constant ~50b
      // cost per-component instead of scaling with template size)
      push(
        `import { ${helpers
          .map(s => helperNameMap[s])
          .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`,
        NewlineType.End,
      )
      push(
        `\n// Binding optimization for webpack code-split\nconst ${helpers
          .map(s => `_${helperNameMap[s]} = ${helperNameMap[s]}`)
          .join(', ')}\n`,
        NewlineType.End,
      )
    } else {
      // import { createVNode as _createVNode, toDisplayString as _toDisplayString } from "vue"
      // 没有做绑定优化，直接用 as _xxx 来重命名导入。
      push(
        `import { ${helpers
          .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
          .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`,
        NewlineType.End,
      )
    }
  }

  // SSR 渲染函数可能会用到如 _ssrRenderComponent、_ssrInterpolate 等特殊方法。
  if (ast.ssrHelpers && ast.ssrHelpers.length) {
    push(
      `import { ${ast.ssrHelpers
        .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
        .join(', ')} } from "${ssrRuntimeModuleName}"\n`,
      NewlineType.End,
    )
  }

  // 这些 import 是从用户在 <script setup> 中写的：
  // <script setup>
  // import MyButton from './MyButton.vue'
  // </script>
  // 这些 import 会被收集到 ast.imports 中，然后重新生成 import 语句。
  if (ast.imports.length) {
    genImports(ast.imports, context)
    newline()
  }

  // 生成类似：
  // const _hoisted_1 = createStaticVNode(...)
  // 这些节点是模板中不变的 vnode，用 createStaticVNode 来静态创建以提升性能。
  genHoists(ast.hoists, context)
  newline()

  if (!inline) {
    // 最后加上 export（非 inline 模式）
    // 举个例子：
    // export function render(_ctx, _cache) { ... }
    // 只有非 inline 模式（不是 setup() => () => ...）才加上 export。
    push(`export `)
  }

  // 最终你可能会看到类似下面的模块头：
  // import { createVNode as _createVNode, toDisplayString as _toDisplayString } from "vue"
  // const _hoisted_1 = _createVNode("div", null, "hello")
  // export function render(_ctx, _cache) {
  //   return _createVNode("div", null, _toDisplayString(_ctx.msg))
  // }
}

// 为模板中用到的组件、指令或过滤器生成 resolve 声明代码。
// 在模板中，如果使用了：
// <MyComponent />
// <div v-my-directive />
// {{ msg | capitalize }}
// 那么 Vue 编译器就需要生成对应的运行时代码：
// const _MyComponent = resolveComponent("MyComponent")
// const _myDirective = resolveDirective("my-directive")
// const _capitalize = resolveFilter("capitalize") // 仅在兼容模式
// 这些 resolveXXX() 是运行时辅助函数，用来根据名称查找注册的组件或指令。
function genAssets(
  // assets：字符串数组，如 ['MyComponent', 'v-model']
  // type：表明是组件、指令还是过滤器
  // context：上下文工具包，提供 push()、helper() 等工具
  assets: string[], // 被模板中引用的组件/指令/过滤器名称
  type: 'component' | 'directive' | 'filter', // 资源类型
  { helper, push, newline, isTS }: CodegenContext,
) {
  // 选择对应的 resolver helper 名称
  // 类型	Helper
  // component	resolveComponent
  // directive	resolveDirective
  // filter（仅兼容模式）	resolveFilter
  // 最终返回带 _ 前缀的 helper，例如：_resolveComponent。
  const resolver = helper(
    __COMPAT__ && type === 'filter'
      ? RESOLVE_FILTER
      : type === 'component'
        ? RESOLVE_COMPONENT
        : RESOLVE_DIRECTIVE,
  )

  // 逐个处理传入的组件、指令、过滤器名。
  for (let i = 0; i < assets.length; i++) {
    let id = assets[i]
    // potential component implicit self-reference inferred from SFC filename
    // 处理可能的 __self 后缀（用于组件自引用）
    // Vue SFC 编译时，如果组件在模板中引用了自己，id 会变成 MyComponent__self，这里是将它还原回原始名字。
    // 然后在生成的代码中通过传入 true 参数告诉 resolveComponent：\
    // resolveComponent("MyComponent", true)
    const maybeSelfReference = id.endsWith('__self')
    if (maybeSelfReference) {
      id = id.slice(0, -6)
    }
    // 调用 push() 生成最终的声明代码
    push(
      // toValidAssetId(id, type)：将资源名转成合法的变量名（带 _ 前缀），例如：
      // MyComponent → _MyComponent
      // vFocus → _vFocus
      // capitalize → _capitalize
      // isTS：如果当前是 TypeScript 模式，添加后缀 ! 来断言非 null：
      // const _MyComponent = _resolveComponent("MyComponent")!
      `const ${toValidAssetId(id, type)} = ${resolver}(${JSON.stringify(id)}${
        maybeSelfReference ? `, true` : ``
      })${isTS ? `!` : ``}`,
    )
    // 输出换行（非最后一个时）
    // 用于格式化代码输出。
    if (i < assets.length - 1) {
      newline()
    }
  }
}

// 用于生成 静态提升 (hoisting) 的节点定义代码。
// 把静态不变的 vnode 表达式提升为顶层常量，这样每次渲染时就不会重新创建它们。
//
// 比如模板：
// <div><span>static</span></div>
// 会被优化为：

// const _hoisted_1 = createElementVNode("span", null, "static")
//
// function render(...) {
//   return createElementVNode("div", null, [_hoisted_1])
// }
function genHoists(
  //hoists	静态提升表达式数组（即生成静态 vnode 的表达式）
  // context	代码生成上下文，提供 push()、newline()、code 等输出工具
  hoists: (JSChildNode | null)[],
  context: CodegenContext,
) {
  if (!hoists.length) {
    return
  }
  // 开启 pure 模式
  // 这是用于 标记当前代码是纯表达式（可静态分析或压缩的）。比如用于添加 /*#__PURE__*/ 注释：
  // 这个注释会帮助像 Terser、esbuild 这样的工具进行 摇树优化（tree-shaking）。
  context.pure = true
  const { push, newline } = context
  newline()

  // 遍历所有 hoist 节点并输出常量声明
  for (let i = 0; i < hoists.length; i++) {
    const exp = hoists[i]
    if (exp) {
      // 每个静态节点会被命名为 _hoisted_1、_hoisted_2...
      // genNode(exp, context)：递归生成表达式代码，比如：
      // createElementVNode("div", null, "hello")
      push(`const _hoisted_${i + 1} = `)
      genNode(exp, context)
      newline()
    }
  }

  // 重置 pure 状态（确保后续代码不会再标注 PURE）
  context.pure = false
}

// 用于生成用户在 <script setup> 中显式声明的 import 语句。
// importsOptions	ImportItem[]	每个 ImportItem 表示用户声明的一个 import
// context	CodegenContext	编译代码的上下文对象，提供 push()、newline() 等工具方法
function genImports(importsOptions: ImportItem[], context: CodegenContext) {
  if (!importsOptions.length) {
    return
  }
  // imports.exp: 是 AST 中的 JSChildNode，表示 import 的表达式部分（如 { ref, computed } 或 defaultExport 等）
  // 使用 genNode() 来将表达式转换为代码字符串
  // imports.path: 是模块路径字符串，如 'vue', './MyComponent.vue'
  // context.push() 用于追加字符串到输出代码中
  // context.newline() 插入换行，便于可读性
  importsOptions.forEach(imports => {
    context.push(`import `)
    genNode(imports.exp, context)
    context.push(` from '${imports.path}'`)
    context.newline()
  })

  // 示例输入 & 输出
  // 假设模板中原始语法：

  // <script setup>
  // import { ref } from 'vue'
  // import MyComponent from './MyComponent.vue'
  // </script>

  // 转换后的 importsOptions 结构可能为：

  // [
  //   {
  //     exp: { type: 'ObjectExpression', codegen representation of `{ ref }` },
  //     path: 'vue'
  //   },
  //   {
  //     exp: { type: 'Identifier', name: 'MyComponent' },
  //     path: './MyComponent.vue'
  //   }
  // ]

  // 最终输出代码：

  // import { ref } from 'vue'
  // import MyComponent from './MyComponent.vue'
}

// 判断生成节点是不是字符
function isText(n: string | CodegenNode) {
  return (
    isString(n) ||
    n.type === NodeTypes.SIMPLE_EXPRESSION ||
    n.type === NodeTypes.TEXT ||
    n.type === NodeTypes.INTERPOLATION ||
    n.type === NodeTypes.COMPOUND_EXPRESSION
  )
}

// 将一组 AST 表达式节点（如多个子节点）输出成 JavaScript 数组字面量的字符串形式。
function genNodeListAsArray(
  nodes: (string | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext,
) {
  // 判断是否要换行缩进格式化
  // 如果节点数 > 3
  // 或者有不是纯文本的节点（如嵌套数组、VNode 等）
  // 并且当前不是浏览器打包（即是开发/构建阶段）
  // 👉 那么就开启“多行格式”，数组每个元素单独占一行。
  const multilines =
    nodes.length > 3 ||
    ((!__BROWSER__ || __DEV__) && nodes.some(n => isArray(n) || !isText(n)))

  // 打开数组 [，并在需要时缩进
  context.push(`[`)
  multilines && context.indent()

  // 这个函数用于输出数组中的每一个元素（包括逗号分隔）
  // 如果开启 multilines，会插入换行和缩进格式化
  genNodeList(nodes, context, multilines)

  // 结束缩进，关闭数组 ]
  multilines && context.deindent()
  context.push(`]`)

  // 使用场景举例：
  // 假设模板是：
  // <div>
  //   <p>1</p>
  //   <p>2</p>
  //   <p>3</p>
  // </div>
  // 会被转换成：
  // [
  //   createElementVNode("p", null, "1"),
  //   createElementVNode("p", null, "2"),
  //   createElementVNode("p", null, "3")
  // ]
  // 这些 vnode 是通过 genNodeListAsArray() 拼成数组的。
}

function genNodeList(
  // 参数	说明
  // nodes	要生成的数组项（字符串、AST 节点、嵌套数组等）
  // context	代码生成上下文
  // multilines	是否多行格式化输出（换行 + 缩进）
  // comma	是否添加逗号分隔符
  nodes: (string | symbol | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext,
  multilines: boolean = false,
  comma: boolean = true,
) {
  const { push, newline } = context
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (isString(node)) {
      // 字符串（直接输出代码片段）
      // 比如字符串字面量 "div"，或已经被编译器预处理好的代码片段 _ctx.foo。
      push(node, NewlineType.Unknown)
    } else if (isArray(node)) {
      genNodeListAsArray(node, context)
    } else {
      genNode(node, context)
    }
    if (i < nodes.length - 1) {
      if (multilines) {
        comma && push(',')
        newline()
      } else {
        comma && push(', ')
      }
    }
  }
}

// 代码生成的分发中心，根据 AST 节点的类型，将节点分派给对应的生成函数（如 genExpression、genVNodeCall 等）。
function genNode(node: CodegenNode | symbol | string, context: CodegenContext) {
  // 用于已经是“代码字符串”的情况，比如字面量或拼接好的代码段。
  if (isString(node)) {
    context.push(node, NewlineType.Unknown)
    return
  }
  // 编译器用 Symbol 表示 helper 函数（如 CREATE_VNODE → _createVNode），这里转换为实际的函数名。
  if (isSymbol(node)) {
    context.push(context.helper(node))
    return
  }

  // switch (node.type) 按类型分发

  // ① 模板 AST 节点（高层结构）：
  // 类型	函数
  // ELEMENT	.codegenNode → vnode
  // IF / FOR	结构控制语句 → .codegenNode
  // genNode(node.codegenNode!, context)
  // 这些节点本身不直接生成代码，而是依赖 transform 阶段生成的 .codegenNode。

  // ② 具体代码表达式节点（直接输出）：
  // 类型	描述	函数
  // TEXT	文本节点	genText()
  // SIMPLE_EXPRESSION	普通表达式	genExpression()
  // INTERPOLATION	插值（{{ msg }})	genInterpolation()
  // TEXT_CALL	复合表达式 textVNode 包裹	genNode() 调用 .codegenNode
  // COMPOUND_EXPRESSION	表达式组合	genCompoundExpression()
  // COMMENT	注释节点	genComment()
  // VNODE_CALL	创建 VNode 的函数调用	genVNodeCall()

  // ③ JS 表达式节点（由 transform 阶段生成）
  // 类型	表达式	生成器函数
  // JS_CALL_EXPRESSION	函数调用	genCallExpression()
  // JS_OBJECT_EXPRESSION	对象字面量	genObjectExpression()
  // JS_ARRAY_EXPRESSION	数组表达式	genArrayExpression()
  // JS_FUNCTION_EXPRESSION	匿名函数	genFunctionExpression()
  // JS_CONDITIONAL_EXPRESSION	三元表达式	genConditionalExpression()
  // JS_CACHE_EXPRESSION	缓存表达式（性能优化）	genCacheExpression()
  // JS_BLOCK_STATEMENT	多语句块（e.g. v-for）	genNodeList() 处理 body

  // ④ SSR only 节点类型（仅服务器端渲染）
  // 在浏览器打包时不会生成这些代码：
  // 类型	描述
  // JS_TEMPLATE_LITERAL
  // JS_IF_STATEMENT
  // JS_ASSIGNMENT_EXPRESSION
  // JS_SEQUENCE_EXPRESSION
  // JS_RETURN_STATEMENT

  // 🧪 示例应用场景
  // 模板：
  // <div>{{ msg }}</div>
  // 转换为：
  // createElementVNode("div", null, toDisplayString(_ctx.msg))
  // 调用路径：
  // genNode → VNODE_CALL → genVNodeCall → genNode(children) → INTERPOLATION → genInterpolation → SIMPLE_EXPRESSION → genExpression

  switch (node.type) {
    case NodeTypes.ELEMENT:
    case NodeTypes.IF:
    case NodeTypes.FOR:
      __DEV__ &&
        assert(
          node.codegenNode != null,
          `Codegen node is missing for element/if/for node. ` +
            `Apply appropriate transforms first.`,
        )
      genNode(node.codegenNode!, context)
      break
    case NodeTypes.TEXT:
      genText(node, context)
      break
    case NodeTypes.SIMPLE_EXPRESSION:
      genExpression(node, context)
      break
    case NodeTypes.INTERPOLATION:
      genInterpolation(node, context)
      break
    case NodeTypes.TEXT_CALL:
      genNode(node.codegenNode, context)
      break
    case NodeTypes.COMPOUND_EXPRESSION:
      genCompoundExpression(node, context)
      break
    case NodeTypes.COMMENT:
      genComment(node, context)
      break
    case NodeTypes.VNODE_CALL:
      genVNodeCall(node, context)
      break

    case NodeTypes.JS_CALL_EXPRESSION:
      genCallExpression(node, context)
      break
    case NodeTypes.JS_OBJECT_EXPRESSION:
      genObjectExpression(node, context)
      break
    case NodeTypes.JS_ARRAY_EXPRESSION:
      genArrayExpression(node, context)
      break
    case NodeTypes.JS_FUNCTION_EXPRESSION:
      genFunctionExpression(node, context)
      break
    case NodeTypes.JS_CONDITIONAL_EXPRESSION:
      genConditionalExpression(node, context)
      break
    case NodeTypes.JS_CACHE_EXPRESSION:
      genCacheExpression(node, context)
      break
    case NodeTypes.JS_BLOCK_STATEMENT:
      genNodeList(node.body, context, true, false)
      break

    // SSR only types
    case NodeTypes.JS_TEMPLATE_LITERAL:
      !__BROWSER__ && genTemplateLiteral(node, context)
      break
    case NodeTypes.JS_IF_STATEMENT:
      !__BROWSER__ && genIfStatement(node, context)
      break
    case NodeTypes.JS_ASSIGNMENT_EXPRESSION:
      !__BROWSER__ && genAssignmentExpression(node, context)
      break
    case NodeTypes.JS_SEQUENCE_EXPRESSION:
      !__BROWSER__ && genSequenceExpression(node, context)
      break
    case NodeTypes.JS_RETURN_STATEMENT:
      !__BROWSER__ && genReturnStatement(node, context)
      break

    /* v8 ignore start IF_BRANCH 是中间结构，不输出代码：*/
    case NodeTypes.IF_BRANCH:
      // noop
      break
    default:
      // 这是 TypeScript 的穷尽检查技巧，用来确保所有 NodeTypes 都已处理。
      if (__DEV__) {
        assert(false, `unhandled codegen node type: ${(node as any).type}`)
        // make sure we exhaust all possible types
        const exhaustiveCheck: never = node
        return exhaustiveCheck
      }
    /* v8 ignore stop */
  }
}

// 直接输出文字
function genText(
  node: TextNode | SimpleExpressionNode,
  context: CodegenContext,
) {
  context.push(JSON.stringify(node.content), NewlineType.Unknown, node)
}

// 为什么要判断 isStatic？
// 是为了在 codegen 阶段区分 字面量值 和 变量/表达式，避免生成的代码语义出错。
// isStatic	示例	输出
// true	'foo'	"foo"
// false	_ctx.foo	_ctx.foo
function genExpression(node: SimpleExpressionNode, context: CodegenContext) {
  const { content, isStatic } = node
  context.push(
    isStatic ? JSON.stringify(content) : content,
    NewlineType.Unknown,
    node,
  )
}

// 用来把模板中的 {{ msg }} 插值，编译成运行时代码：toDisplayString(_ctx.msg)
function genInterpolation(node: InterpolationNode, context: CodegenContext) {
  const { push, helper, pure } = context
  if (pure) push(PURE_ANNOTATION)
  push(`${helper(TO_DISPLAY_STRING)}(`)
  genNode(node.content, context)
  push(`)`)
}

function genCompoundExpression(
  node: CompoundExpressionNode,
  context: CodegenContext,
) {
  // 遍历 children 数组
  // 如果是字符串（例如操作符 +），直接输出
  // 如果是表达式节点，递归调用 genNode() 输出它的值
  for (let i = 0; i < node.children!.length; i++) {
    const child = node.children![i]
    if (isString(child)) {
      context.push(child, NewlineType.Unknown)
    } else {
      genNode(child, context)
    }
  }
}

//
function genExpressionAsPropertyKey(
  node: ExpressionNode,
  context: CodegenContext,
) {
  const { push } = context
  if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
    // 动态 key：如 [someVar]
    push(`[`)
    genCompoundExpression(node, context)
    push(`]`)
  } else if (node.isStatic) {
    // only quote keys if necessary
    const text = isSimpleIdentifier(node.content)
      ? node.content
      : JSON.stringify(node.content)
    // 静态合法 key：如 id → id
    push(text, NewlineType.None, node)
  } else {
    // 静态但非法 key：如 'data-id' → "data-id"
    push(`[${node.content}]`, NewlineType.Unknown, node)
  }
}

// 生成注释节点
function genComment(node: CommentNode, context: CodegenContext) {
  const { push, helper, pure } = context
  if (pure) {
    push(PURE_ANNOTATION)
  }
  push(
    `${helper(CREATE_COMMENT)}(${JSON.stringify(node.content)})`,
    NewlineType.Unknown,
    node,
  )
}

// 它负责生成 createVNode() / createBlock() 等虚拟 DOM 节点调用的最终 JS 代码。
// 这个函数将如下的模板代码：
// <div id="foo">hello</div>
// 编译生成类似的运行时代码：
// createVNode("div", { id: "foo" }, "hello", /* patchFlag */ 0)
// 如果开启 block 模式，它会使用：
// openBlock(), createBlock(...)
function genVNodeCall(node: VNodeCall, context: CodegenContext) {
  const { push, helper, pure } = context
  const {
    tag, // 标签名，如 'div'，或组件名
    props, // 属性对象
    children, // 子节点
    patchFlag, // vnode patch 优化标志
    dynamicProps, // 动态属性字符串
    directives, // 是否使用 v-directives
    isBlock, // 是否为 block 模式 vnode
    disableTracking, // 是否禁用依赖追踪（如 v-once）
    isComponent, // 是否为组件
  } = node

  // add dev annotations to patch flags
  // patchFlag 生成字符串注释（只在开发模式）
  let patchFlagString
  if (patchFlag) {
    if (__DEV__) {
      if (patchFlag < 0) {
        // special flags (negative and mutually exclusive)
        // 生成注释形式的 patchFlag，如 1 /* TEXT */
        patchFlagString = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`
      } else {
        // bitwise flags
        const flagNames = Object.keys(PatchFlagNames)
          .map(Number)
          .filter(n => n > 0 && patchFlag & n)
          .map(n => PatchFlagNames[n as PatchFlags])
          .join(`, `)
        patchFlagString = patchFlag + ` /* ${flagNames} */`
      }
    } else {
      patchFlagString = String(patchFlag)
    }
  }

  // 开始处理 withDirectives() 包裹（如果用了 v-my-directive）
  if (directives) {
    push(helper(WITH_DIRECTIVES) + `(`)
  }

  // 如果是 block 模式，生成 openBlock() 开头
  if (isBlock) {
    push(`(${helper(OPEN_BLOCK)}(${disableTracking ? `true` : ``}), `)
  }

  // 输出 /*#__PURE__*/ 注释（用于 tree-shaking）
  if (pure) {
    push(PURE_ANNOTATION)
  }
  // 决定使用哪个 vnode 函数
  // 类型	使用函数
  // block + element	createBlock
  // block + component	createBlock
  // 普通 + element	createVNode
  // 普通 + component	createVNode
  // SSR 相关	ssrRenderXXX
  const callHelper: symbol = isBlock
    ? getVNodeBlockHelper(context.inSSR, isComponent)
    : getVNodeHelper(context.inSSR, isComponent)
  push(helper(callHelper) + `(`, NewlineType.None, node)
  genNodeList(
    genNullableArgs([tag, props, children, patchFlagString, dynamicProps]),
    context,
  )
  // 如果是 block 模式或带指令，闭合函数调用括号
  push(`)`)
  if (isBlock) {
    push(`)`)
  }
  if (directives) {
    push(`, `)
    genNode(directives, context)
    push(`)`)
  }
}

// 使用场景举例
// 1、场景 ：生成 createVNode(...)
// <div id="foo">hello</div>
// 2、编译阶段：
// createVNode("div", { id: "foo" }, "hello")
// 3、现在假如有些属性缺失，比如没有 props：
// <div>{{ msg }}</div>
// 4、生成调用：
// createVNode("div", null, _ctx.msg)
// 5、就要靠 genNullableArgs() 保证即使没有 props，也能输出 null：
// genNullableArgs([
//   createSimpleExpression('"div"'),
//   null,
//   createSimpleExpression('_ctx.msg')
// ], context)
// 6、输出：
// "div", null, _ctx.msg
function genNullableArgs(args: any[]): CallExpression['arguments'] {
  let i = args.length
  while (i--) {
    if (args[i] != null) break
  }
  return args.slice(0, i + 1).map(arg => arg || `null`)
}

// JavaScript
// 生成的 函数调用节点（CallExpression），转化为最终输出的 JavaScript 代码字符串。
// 案例：
// {{ msg }} 编译为：
// _toDisplayString(_ctx.msg)
function genCallExpression(node: CallExpression, context: CodegenContext) {
  const { push, helper, pure } = context
  const callee = isString(node.callee) ? node.callee : helper(node.callee)
  if (pure) {
    push(PURE_ANNOTATION)
  }
  push(callee + `(`, NewlineType.None, node)
  genNodeList(node.arguments, context)
  push(`)`)
}

function genObjectExpression(node: ObjectExpression, context: CodegenContext) {
  // 实际例子对比
  // 📌 模板：
  // <div :id="dynamicId" class="static-class" :[keyName]="val" />
  // 转换成 AST：
  // {
  //   type: JS_OBJECT_EXPRESSION,
  //   properties: [
  //     {
  //       key: { type: SIMPLE_EXPRESSION, content: 'id' },
  //       value: { type: SIMPLE_EXPRESSION, content: 'dynamicId' }
  //     },
  //     {
  //       key: { type: SIMPLE_EXPRESSION, content: 'class' },
  //       value: { type: SIMPLE_EXPRESSION, content: `'static-class'` }
  //     },
  //     {
  //       key: { type: COMPOUND_EXPRESSION, children: ['keyName'] },
  //       value: { type: SIMPLE_EXPRESSION, content: 'val' }
  //     }
  //   ]
  // }
  // 使用 genObjectExpression() 生成代码：
  // {
  //   id: dynamicId,
  //   class: 'static-class',
  //   [keyName]: val
  // }
  const { push, indent, deindent, newline } = context
  const { properties } = node
  if (!properties.length) {
    push(`{}`, NewlineType.None, node)
    return
  }
  const multilines =
    properties.length > 1 ||
    ((!__BROWSER__ || __DEV__) &&
      properties.some(p => p.value.type !== NodeTypes.SIMPLE_EXPRESSION))
  push(multilines ? `{` : `{ `)
  multilines && indent()
  for (let i = 0; i < properties.length; i++) {
    const { key, value } = properties[i]
    // key
    genExpressionAsPropertyKey(key, context)
    push(`: `)
    // value
    genNode(value, context)
    if (i < properties.length - 1) {
      // will only reach this if it's multilines
      push(`,`)
      newline()
    }
  }
  multilines && deindent()
  push(multilines ? `}` : ` }`)
}

// 数组
function genArrayExpression(node: ArrayExpression, context: CodegenContext) {
  genNodeListAsArray(node.elements as CodegenNode[], context)
}

// 生成 JavaScript 的箭头函数代码，支持 slot 包裹、参数、返回值、函数体、格式控制等功能。
function genFunctionExpression(
  node: FunctionExpression,
  context: CodegenContext,
) {
  // 字段	含义
  // params	函数参数（可以是单个节点或数组）
  // returns	返回表达式（如 return createVNode(...)）
  // body	完整函数体代码块（替代 returns）
  // newline	是否将函数内容换行、缩进显示
  // isSlot	是否为 slot 函数（会包在 _withCtx(...) 中）
  // isNonScopedSlot	（兼容模式下）是否为非作用域插槽（影响额外参数）
  const { push, indent, deindent } = context
  const { params, returns, body, newline, isSlot } = node
  if (isSlot) {
    // wrap slot functions with owner context
    // 如果是 slot 函数，用 _withCtx() 包裹
    // 这是为 slot 注入上下文，让 slot 函数能访问组件内部变量。
    push(`_${helperNameMap[WITH_CTX]}(`) // 等价于 _withCtx(
  }

  // 开始生成箭头函数开头 (params) =>
  // () =>
  // (a) =>
  // (a, b) =>
  push(`(`, NewlineType.None, node)
  if (isArray(params)) {
    genNodeList(params, context)
  } else if (params) {
    genNode(params, context)
  }
  push(`) => `)

  // 如果有 newline 或函数体，生成 {} 包裹
  if (newline || body) {
    push(`{`)
    indent()
  }

  // 输出函数返回或函数体内容
  if (returns) {
    if (newline) {
      push(`return `)
    }
    if (isArray(returns)) {
      genNodeListAsArray(returns, context)
    } else {
      genNode(returns, context)
    }
  } else if (body) {
    genNode(body, context)
  }

  // 如果使用了块 {}，结束缩进并闭合
  if (newline || body) {
    deindent()
    push(`}`)
  }

  // 如果是插槽函数，补上 _withCtx(..., undefined, true) 参数闭合
  if (isSlot) {
    if (__COMPAT__ && node.isNonScopedSlot) {
      push(`, undefined, true`)
    }
    push(`)`)
  }
}

// 三元表达式（condition ? trueExp : falseExp） 的代码生成函数。
function genConditionalExpression(
  node: ConditionalExpression,
  context: CodegenContext,
) {
  const { test, consequent, alternate, newline: needNewline } = node
  const { push, indent, deindent, newline } = context

  // 如果是简单标识符（如 isDark），就不加括号，否则加括号。
  // 示例：

  // // test = _ctx.isDark
  // _ctx.isDark ? ...

  // // test = _ctx.mode === 'dark'
  // (_ctx.mode === 'dark') ? ...
  if (test.type === NodeTypes.SIMPLE_EXPRESSION) {
    const needsParens = !isSimpleIdentifier(test.content)
    needsParens && push(`(`)
    genExpression(test, context)
    needsParens && push(`)`)
  } else {
    push(`(`)
    genNode(test, context)
    push(`)`)
  }

  // 输出 ? 并进入缩进（多行时）
  // 示例输出（单行）：
  // _ctx.isDark ? 'Dark' : 'Light'
  // 示例输出（多行）：
  // (_ctx.mode === 'dark')
  //   ? 'Dark'
  //   : 'Light'
  needNewline && indent()
  context.indentLevel++
  needNewline || push(` `)
  push(`? `)
  genNode(consequent, context)
  context.indentLevel--

  // 输出 : 和 alternate 分支
  needNewline && newline()
  needNewline || push(` `)
  push(`: `)

  // 检查 alternate 是否是嵌套的三元表达式
  const isNested = alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
  if (!isNested) {
    context.indentLevel++
  }
  genNode(alternate, context)
  if (!isNested) {
    context.indentLevel--
  }

  // 最后收尾缩进
  needNewline && deindent(true /* without newline */)
}

function genCacheExpression(node: CacheExpression, context: CodegenContext) {
  // 案例 1：普通插值表达式（带重复）
  // <p>{{ expensiveComputation() }}</p>
  // <p>{{ expensiveComputation() }}</p>
  // 编译后逻辑：
  // _cache[1] || (_cache[1] = toDisplayString(expensiveComputation()))
  // 解释：表达式执行一次，结果被缓存，在多处使用时不再重复调用函数。

  // 案例 2：v-once 缓存 VNode
  // <p v-once>{{ message }}</p>
  // 编译生成：
  // _cache[1] || (
  //   _setBlockTracking(-1),
  //   (_cache[1] = createVNode("p", null, toDisplayString(_ctx.message))).cacheIndex = 1,
  //   _setBlockTracking(1),
  //   _cache[1]
  // )
  // 解释：
  // _setBlockTracking(-1): 停止依赖追踪，避免响应式追踪浪费
  // .cacheIndex = 1: 标记 vnode 所在的缓存槽位（用于 hydration）
  // _setBlockTracking(1): 恢复追踪

  // 案例 3：静态子节点数组（比如 v-for 中无响应式绑定）
  // <ul v-once>
  //   <li>A</li>
  //   <li>B</li>
  // </ul>
  // 编译后代码：
  // [...(_cache[2] || (
  //   _setBlockTracking(-1),
  //   (_cache[2] = [
  //     createVNode("li", null, "A"),
  //     createVNode("li", null, "B")
  //   ]).cacheIndex = 2,
  //   _setBlockTracking(1),
  //   _cache[2]
  // ))]
  // 解释：
  // 使用了 needArraySpread = true，因此包裹在 [...( ... )] 中
  // vnode 数组整体缓存，避免重复创建数组和 vnode

  // 例 4：组件带 v-once（缓存组件 vnode）
  // <MyCard v-once />
  // 编译结果：
  // _cache[3] || (
  //   _setBlockTracking(-1),
  //   (_cache[3] = createVNode(_MyCard)).cacheIndex = 3,
  //   _setBlockTracking(1),
  //   _cache[3]
  // )
  // 解释：
  // 即使是组件也可以缓存其 vnode，防止每次重新渲染时都调用 createVNode

  // 案例 5：v-if 条件分支缓存
  // <div>
  //   <p v-if="condition">{{ compute() }}</p>
  // </div>
  // 可能编译出：
  // condition
  //   ? (_cache[4] || (_cache[4] = createVNode("p", null, toDisplayString(compute()))))
  //   : null
  // 解释：如果 condition 是真，只执行一次 compute()，其结果保存在 _cache[4]
  const { push, helper, indent, deindent, newline } = context
  const { needPauseTracking, needArraySpread } = node
  if (needArraySpread) {
    push(`[...(`)
  }
  push(`_cache[${node.index}] || (`)
  if (needPauseTracking) {
    indent()
    push(`${helper(SET_BLOCK_TRACKING)}(-1`)
    if (node.inVOnce) push(`, true`)
    push(`),`)
    newline()
    push(`(`)
  }
  push(`_cache[${node.index}] = `)
  genNode(node.value, context)
  if (needPauseTracking) {
    push(`).cacheIndex = ${node.index},`)
    newline()
    push(`${helper(SET_BLOCK_TRACKING)}(1),`)
    newline()
    push(`_cache[${node.index}]`)
    deindent()
  }
  push(`)`)
  if (needArraySpread) {
    push(`)]`)
  }
}

//  模板字符串
function genTemplateLiteral(node: TemplateLiteral, context: CodegenContext) {
  const { push, indent, deindent } = context
  push('`')
  const l = node.elements.length
  const multilines = l > 3
  for (let i = 0; i < l; i++) {
    const e = node.elements[i]
    if (isString(e)) {
      push(e.replace(/(`|\$|\\)/g, '\\$1'), NewlineType.Unknown)
    } else {
      push('${')
      if (multilines) indent()
      genNode(e, context)
      if (multilines) deindent()
      push('}')
    }
  }
  push('`')
}

// if表达式
function genIfStatement(node: IfStatement, context: CodegenContext) {
  const { push, indent, deindent } = context
  const { test, consequent, alternate } = node
  push(`if (`)
  genNode(test, context)
  push(`) {`)
  indent()
  genNode(consequent, context)
  deindent()
  push(`}`)
  if (alternate) {
    push(` else `)
    if (alternate.type === NodeTypes.JS_IF_STATEMENT) {
      genIfStatement(alternate, context)
    } else {
      push(`{`)
      indent()
      genNode(alternate, context)
      deindent()
      push(`}`)
    }
  }
}

// 赋值表达式
function genAssignmentExpression(
  node: AssignmentExpression,
  context: CodegenContext,
) {
  genNode(node.left, context)
  context.push(` = `)
  genNode(node.right, context)
}

// 序列，例如：(a, b, c)
function genSequenceExpression(
  node: SequenceExpression,
  context: CodegenContext,
) {
  context.push(`(`)
  genNodeList(node.expressions, context)
  context.push(`)`)
}

// return 语句表达式
function genReturnStatement(
  { returns }: ReturnStatement,
  context: CodegenContext,
) {
  context.push(`return `)
  if (isArray(returns)) {
    genNodeListAsArray(returns, context)
  } else {
    genNode(returns, context)
  }
}
