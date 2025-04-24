import {
  type AttributeNode,
  ConstantTypes,
  type DirectiveNode,
  type ElementNode,
  ElementTypes,
  type ForParseResult,
  Namespaces,
  NodeTypes,
  type RootNode,
  type SimpleExpressionNode,
  type SourceLocation,
  type TemplateChildNode,
  createRoot,
  createSimpleExpression,
} from './ast'
import type { ParserOptions } from './options'
import Tokenizer, {
  CharCodes,
  ParseMode,
  QuoteType,
  Sequences,
  State,
  isWhitespace,
  toCharCodes,
} from './tokenizer'
import {
  type CompilerCompatOptions,
  CompilerDeprecationTypes,
  checkCompatEnabled,
  isCompatEnabled,
  warnDeprecation,
} from './compat/compatConfig'
import { NO, extend } from '@vue/shared'
import {
  ErrorCodes,
  createCompilerError,
  defaultOnError,
  defaultOnWarn,
} from './errors'
import {
  forAliasRE,
  isCoreComponent,
  isSimpleIdentifier,
  isStaticArgOf,
} from './utils'
import { decodeHTML } from 'entities/lib/decode.js'
import {
  type ParserOptions as BabelOptions,
  parse,
  parseExpression,
} from '@babel/parser'

type OptionalOptions =
  | 'decodeEntities' // 是否解码 HTML 实体（&nbsp; 等）
  | 'whitespace' // 如何处理空白字符（preserve / condense）
  | 'isNativeTag' // 判断是否是平台原生标签（如 'div'）
  | 'isBuiltInComponent' // 判断是否是内置组件（如 Transition）
  | 'expressionPlugins' // 解析表达式时的 Babel 插件列表
  | keyof CompilerCompatOptions // 向后兼容 Vue 2 的配置项

// 第一步：Required<ParserOptions>
// 把 ParserOptions 中的所有字段都变成 必填。
// 这意味着你不能再跳过任何字段，除非我们后面再做处理。
//
// 第二步：Omit<..., OptionalOptions>
// 再从上一步中 移除掉 OptionalOptions 列出的字段，这些字段我们不想强制设为 required。
//
// 第三步：Pick<ParserOptions, OptionalOptions>
// 从原始 ParserOptions 中 重新取出 OptionalOptions 列出的字段，并保持它们原来的状态（可能是可选的）。
//
// 最后：用 & 组合
// 我们把这两部分合并，得到一个最终的类型：
//
// 对大部分字段是 Required 的
//
// 但对 OptionalOptions 指定的字段是 保持原始可选状态的
export type MergedParserOptions = Omit<
  Required<ParserOptions>,
  OptionalOptions
> &
  Pick<ParserOptions, OptionalOptions>

export const defaultParserOptions: MergedParserOptions = {
  // 当前解析模式（可选值还有 raw 或 module）
  // 默认是基础解析，不加特殊行为
  parseMode: 'base',

  // 默认命名空间是 HTML（用于 SVG、MathML 判断）
  ns: Namespaces.HTML,

  // 插值表达式的定界符，Vue 默认是 {{ }}
  // 你可以改成 <% %>、[[ ]] 等
  delimiters: [`{{`, `}}`],

  // 函数，用于动态判断某标签应使用什么命名空间（如 <svg> 开启 SVG 模式）
  getNamespace: () => Namespaces.HTML,

  // 是否是自闭合标签，例如 <br>, <img> 等
  // NO 是一个默认函数，始终返回 false（你可以重写）
  isVoidTag: NO,

  // 是否是 <pre> 标签（控制空白处理）
  isPreTag: NO,

  // 是否忽略换行符（常用于 <pre>、textarea、svg）
  isIgnoreNewlineTag: NO,

  // 是否是自定义元素（跳过编译，如 Web Component 标签 <my-foo>）
  isCustomElement: NO,

  // 错误与警告处理函数
  // 编译器内部调用这两个钩子输出错误消息或警告信息
  onError: defaultOnError,
  onWarn: defaultOnWarn,

  // 是否保留 HTML 注释节点
  // 默认只在开发模式下保留（由 __DEV__ 控制）
  comments: __DEV__,

  // 是否给模板表达式中使用的变量加 _ctx. 前缀
  // 为了兼容旧语法（Vue 2 中默认不开启），Vue 3 编译器开启后用于更严格作用域控制
  prefixIdentifiers: false,
}

// 核心解析上下文
// 当前的解析器配置
// 来自调用 baseParse(template, options) 时传入的参数
let currentOptions: MergedParserOptions = defaultParserOptions

// 当前构建中的 AST 根节点，类型为 RootNode
// 最终整个模板会被包装在 type: ROOT 的节点下
// 在 baseParse() 入口中初始化它
let currentRoot: RootNode | null = null

// parser state
// 当前正在解析的字符串内容（完整的模板）
let currentInput = ''

// 当前正在处理的开始标签节点（<div>、<template> 等）
// 在处理 parseElement() 时用于记录上下文状态
let currentOpenTag: ElementNode | null = null

// 当前正在处理的 prop（如 id="foo" 或 v-model="x"）
// 用于捕捉正在构建的 prop 结构
let currentProp: AttributeNode | DirectiveNode | null = null

// 当前属性值字符串，以及它在输入字符串中的起止位置
// 例如解析：class="my-class" 时，这里会记录 "my-class" 及其索引
let currentAttrValue = ''
let currentAttrStartIndex = -1
let currentAttrEndIndex = -1

// 是否在 <pre> 标签内部
// <pre> 标签内保留所有空白字符（换行、缩进）
let inPre = 0

// 是否在 v-pre 指令范围内
// v-pre 会关闭编译器的表达式解析功能，保留原样输出
let inVPre = false

// 当前的 v-pre 的 DOM 边界标签（用于嵌套判断）
// 例如：<div v-pre>...</div> 会标记这个标签作为 v-pre 作用范围终点
let currentVPreBoundary: ElementNode | null = null

// 节点栈（解析器核心机制）

// 用来维护标签节点的嵌套关系（类似 HTML 栈）
// 每次解析到一个新的 <div> 开始标签时，会 stack.push(div)
// 解析到对应的 </div> 结束标签时，stack.pop() 出来
// 用于构建正确的嵌套关系和 parent-child 结构
const stack: ElementNode[] = []

// 是字符解析器，它配合状态机，将原始模板逐字符转换为结构化事件。
const tokenizer = new Tokenizer(stack, {
  // 1.用于构建 AST 的节点栈 2. 事件回调对象

  // 当解析器遇到语法错误或非法字符时触发，调用 emitError 进行报错提示（可能会打印错误、标记位置等）。
  onerr: emitError,

  // 触发条件：普通文本节点（非标签、非指令、非插值）
  ontext(start, end) {
    // <div>Hello</div>
    // Hello 就会触发 ontext

    // 用 getSlice 取出对应字符串；
    // 调用 onText(...) 函数（上层传入的回调）；
    // 将文本加入 AST 中。
    onText(getSlice(start, end), start, end)
  },

  // 触发条件：文本中的 HTML 实体被解析为字符（如 &amp; → &）
  ontextentity(char, start, end) {
    // <div>Tom &amp; Jerry</div>
    // &amp; 被解析后，会触发该回调：
    // 处理方式与普通文本相同，作为一个字符插入 AST。
    onText(char, start, end)
  },

  // 触发条件：插值表达式（形如 {{ message }}）
  oninterpolation(start, end) {
    if (inVPre) {
      // 如果当前处于 v-pre 指令作用范围内（即 Vue 不处理插值表达式的区域），就将整个插值 {{ ... }} 当作纯文本处理。
      return onText(getSlice(start, end), start, end)
    }

    // {{ message }} 取内容时跳过前缀 {{ 和后缀 }}
    let innerStart = start + tokenizer.delimiterOpen.length
    let innerEnd = end - tokenizer.delimiterClose.length

    // 清理表达式前后多余空格，使得 {{ msg }} 仍只解析 msg。
    while (isWhitespace(currentInput.charCodeAt(innerStart))) {
      innerStart++
    }
    while (isWhitespace(currentInput.charCodeAt(innerEnd - 1))) {
      innerEnd--
    }
    // 提取表达式字符串
    let exp = getSlice(innerStart, innerEnd)
    // decode entities for backwards compat
    if (exp.includes('&')) {
      // 出于兼容性考虑（老版本可能写 &lt;），对表达式做实体解码；
      // 在浏览器或 Node 环境下采用不同的解码方式。
      if (__BROWSER__) {
        exp = currentOptions.decodeEntities!(exp, false)
      } else {
        exp = decodeHTML(exp)
      }
    }
    // 创建 AST 节点：
    // 类型为 INTERPOLATION
    // 表达式是 createExp(...) 生成的
    // 位置信息是 getLoc(...)

    // 最终生成的插值 AST 节点结构大致如下：

    // {
    //   type: INTERPOLATION,
    //   content: {
    //     type: SIMPLE_EXPRESSION,
    //     content: 'message',
    //     isStatic: false,
    //     ...
    //   },
    //   loc: { start, end }
    // }
    addNode({
      type: NodeTypes.INTERPOLATION,
      content: createExp(exp, false, getLoc(innerStart, innerEnd)),
      loc: getLoc(start, end),
    })
  },

  // 在解析到标签名时触发，比如：
  // <div>
  onopentagname(start, end) {
    // 取出标签名，比如 "div"、"MyComponent"，位置在源码中的 [start, end)。
    const name = getSlice(start, end)
    // 创建一个新的 AST 节点（尚未闭合）；
    // 类型设为 ELEMENT，并记录标签名。
    currentOpenTag = {
      type: NodeTypes.ELEMENT,
      tag: name,
      // 调用命名空间判断逻辑，支持 SVG、MathML 等；
      // 依据当前父级节点（stack[0]）和默认命名空间（currentOptions.ns）进行判断；
      // 对于 Vue 模板大部分情况会是 HTML 命名空间。
      ns: currentOptions.getNamespace(name, stack[0], currentOptions.ns),
      // 初始设定为普通元素类型；
      // 等标签闭合（</div>）或属性被分析完后，可能会变为组件、slot 等。
      tagType: ElementTypes.ELEMENT, // will be refined on tag close
      // 准备接收后续解析过程中遇到的属性、指令和子节点。
      props: [],
      children: [],
      // 位置信息用于 AST 工具链标记源码区域；
      // 注意 start - 1 是因为 < 符号不包含在 start 中，要往前补 1。
      loc: getLoc(start - 1, end),
      // 用于后续代码生成（transform 阶段）填充生成逻辑；
      // 在本阶段还未赋值。
      codegenNode: undefined,
    }

    // 示例 AST 节点结果：
    // {
    //   type: ELEMENT,
    //   tag: 'div',
    //   ns: 0, // HTML
    //   tagType: ELEMENT,
    //   props: [],
    //   children: [],
    //   loc: { ... },
    //   codegenNode: undefined
    // }
  },

  // 当解析器读到标签的 > 或 /> 时调用；
  onopentagend(end) {
    // 设置 currentOpenTag 的闭合位置；
    // 判断是否是自闭合标签；
    // 将其添加到 AST 树中并压入 stack；
    // 或在自闭合情况下立即关闭。
    endOpenTag(end)
  },

  // 当解析器读到结束标签 </xxx> 时触发；
  // 它的任务是 从 stack 中找到匹配的开始标签并关闭它；
  // 同时处理错误容错、结构修复等。
  onclosetag(start, end) {
    // 提取结束标签的标签名，如 "div"、"span"。
    const name = getSlice(start, end)
    // Void 标签（自闭合标签）本身不能写结束标签；
    // 如果写了 </br>，这里会跳过关闭逻辑。
    if (!currentOptions.isVoidTag(name)) {
      // 遍历 AST 构建栈，从栈底（旧的父节点）往上找；
      // 查找 stack 中第一个与当前关闭标签名匹配的开始标签；
      // 使用 toLowerCase() 保证大小写兼容（HTML 标签不区分大小写）。
      let found = false
      for (let i = 0; i < stack.length; i++) {
        const e = stack[i]
        if (e.tag.toLowerCase() === name.toLowerCase()) {
          // 如果中间有未闭合的嵌套标签（i > 0），说明中间标签缺少 </xxx>；
          // 报错：缺少结束标签。
          found = true
          if (i > 0) {
            emitError(ErrorCodes.X_MISSING_END_TAG, stack[0].loc.start.offset)
          }
          // 从 stack 中连续弹出所有标签，直到当前标签被正确关闭；
          // 每次弹出都调用 onCloseTag(...)：
          for (let j = 0; j <= i; j++) {
            const el = stack.shift()!
            onCloseTag(el, end, j < i)
          }
          break
        }
      }
      if (!found) {
        // 如果没有找到任何匹配标签；
        // 报错：无效的结束标签，如 </p> 没有对应的 <p>。
        emitError(ErrorCodes.X_INVALID_END_TAG, backTrack(start, CharCodes.Lt))
      }
    }
  },

  // 处理 自闭合标签（如 <br />, <img />, <input />）的核心逻辑。
  // 它结合了标签闭合（endOpenTag）与标签立即关闭（onCloseTag）的处理，确保自闭合标签能完整创建 → 正确添加 → 马上关闭。
  onselfclosingtag(end) {
    // 获取当前正在构建的标签名（比如 "img"）；
    // currentOpenTag 是由 onopentagname 创建的 AST 节点。
    const name = currentOpenTag!.tag
    // 标记该标签是自闭合的；
    // 这个字段会记录到 AST 中，便于后续判断和代码生成阶段处理（无需写结束标签）。
    currentOpenTag!.isSelfClosing = true
    // 正常结束 open tag 流程：
    // 设置位置信息（loc.end）；
    // 将 currentOpenTag 加入 AST；
    // 并根据是否自闭合判断是否压入 stack。
    // 注意：这里调用 endOpenTag 是必须的，不然 addNode(...) 不会触发。
    endOpenTag(end)

    // 这部分是一个防御性逻辑，确保如果解析器意外将自闭合标签压入了 stack（某些状态组合可能发生），就立刻把它弹出并调用 onCloseTag(...)：
    if (stack[0] && stack[0].tag === name) {
      onCloseTag(stack.shift()!, end)
    }

    // 处理 <br />

    // <div><br /></div>

    // 读取 <br → onopentagname("br")
    // 遇到 /> → onselfclosingtag(end):
    // 标记 isSelfClosing
    // endOpenTag() 添加到 div.children
    // 弹出 stack 并调用 onCloseTag(br)
    // 最终 AST：
    // {
    //   type: ELEMENT,
    //   tag: 'div',
    //   children: [
    //     {
    //       type: ELEMENT,
    //       tag: 'br',
    //       isSelfClosing: true,
    //       ...
    //     }
    //   ]
    // }
  },

  // 处理 HTML 属性名 时调用的回调函数，它会创建一个 AST 属性节点的初始结构。
  // 这个回调是配合 HTML 状态机中 stateInAttrName 等状态触发的，也就是当解析器读取到属性名时（如 class、id、type），就会调用这个函数。
  onattribname(start, end) {
    // plain attribute
    // 初始化一个新的属性节点对象，并赋值给全局变量 currentProp；
    // 这个 currentProp 表示当前正在解析的属性；
    // 后续如果解析到了 = 和属性值，则会更新这个对象的 .value 字段。
    currentProp = {
      // 表示这是一个普通属性节点（不是指令）；
      // 节点类型为 ATTRIBUTE，最终在 AST 中表现为：
      // {
      //   type: ATTRIBUTE,
      //   name: "class",
      //   value: { ... }
      // }
      type: NodeTypes.ATTRIBUTE,
      // 从源码中提取出属性名，比如 "class"、"id"；
      // getSlice(...) 是字符串切片方法，返回对应区间的文本。
      name: getSlice(start, end),
      // 设置属性名的精确位置信息；
      // 用于错误提示、调试或源码映射（如高亮属性名）。
      nameLoc: getLoc(start, end),
      // 初始值设为 undefined，后面遇到 = 或值时会更新；
      // 对于布尔属性（如 <input disabled>），可能最终值仍为 undefined。
      value: undefined,
      // 记录属性整体位置的开始点；
      // 结束点会在 onattribend() 或 setLocEnd() 中设置。
      loc: getLoc(start),
    }
    // 示例：处理 <input class="btn">
    // 当解析器遇到 class 时：
    // 进入 stateInAttrName；
    // 检测到属性名结束 → 触发 onattribname(start, end)；
    // 构建 currentProp：
    // {
    //   type: ATTRIBUTE,
    //   name: "class",
    //   nameLoc: { start, end },
    //   value: undefined,
    //   loc: { start, end: undefined, source: undefined }
    // }
    // 后续：
    // 解析到 = 和 "btn"；
    // 填充 currentProp.value = { content: "btn", ... }；
    // 最后调用 onattribend()，将 currentProp 加入 currentOpenTag.props。
  },

  // 处理 指令名（directive name）的回调函数，是解析器识别 v- 开头的结构或简写形式（如 @click、.prop、:title）的核心。
  ondirname(start, end) {
    // raw 是原始属性前缀字符串，比如：
    // '@'
    // ':'
    // '#'
    // '.prop'
    // 'v-model'
    const raw = getSlice(start, end)

    // raw 值	    对应 name	解释
    // : 或 .	    'bind'	    :title 是 v-bind:title
    // @	        'on'	    @click 是 v-on:click
    // #	        'slot'	    #header 是 v-slot:header
    // 其他如 v-if	'if'	    去掉前缀 'v-'
    const name =
      raw === '.' || raw === ':'
        ? 'bind'
        : raw === '@'
          ? 'on'
          : raw === '#'
            ? 'slot'
            : raw.slice(2)

    // 如果不是在 v-pre 且没有解析出合法指令名 → 报错；
    // 比如错误写法 <div v->。
    if (!inVPre && name === '') {
      emitError(ErrorCodes.X_MISSING_DIRECTIVE_NAME, start)
    }

    if (inVPre || name === '') {
      // 变成普通属性节点（不编译）
      // 在 v-pre 中的所有东西都视作普通 HTML 属性；
      // 或者你写了 v- 但后面没名字也视作普通属性（保底容错）。
      currentProp = {
        type: NodeTypes.ATTRIBUTE,
        name: raw,
        nameLoc: getLoc(start, end),
        value: undefined,
        loc: getLoc(start),
      }
    } else {
      // 创建指令节点 DirectiveNode；
      // 设置指令名、原始前缀名、表达式、参数、修饰符等初始值；
      // 如果是 .prop 形式，自动添加 modifiers: ['prop']。
      currentProp = {
        type: NodeTypes.DIRECTIVE,
        name,
        rawName: raw,
        exp: undefined,
        arg: undefined,
        modifiers: raw === '.' ? [createSimpleExpression('prop')] : [],
        loc: getLoc(start),
      }

      // 遇到 v-pre 时开启“跳过编译模式”，所有后续属性会当作 HTML 处理；
      // 记录当前 open tag 为 v-pre 的范围开始。
      if (name === 'pre') {
        inVPre = tokenizer.inVPre = true
        currentVPreBoundary = currentOpenTag
        // convert dirs before this one to attributes

        // 如果 v-pre 在后面才出现，为了符合“所有属性都当作 HTML 处理”，
        // 把之前已经认定为 directive 的属性，转成 attribute；
        // 例如 <div v-bind:id v-pre> → v-bind:id 被转为 id。
        const props = currentOpenTag!.props
        for (let i = 0; i < props.length; i++) {
          if (props[i].type === NodeTypes.DIRECTIVE) {
            props[i] = dirToAttr(props[i] as DirectiveNode)
          }
        }
      }
    }
  },

  // 用于处理 指令参数 的回调函数 ondirarg(start, end)，它在解析如下形式的属性时被调用：
  // <div :title="msg" />
  // <div @[event]="handler" />
  // <div v-on:click="doSomething" />

  // 什么是“指令参数”？
  // 在 Vue 指令语法中，冒号后面的部分叫做 参数（argument），比如：
  //
  //
  // 指令写法	        指令名	参数
  // v-bind:title="..."	bind	title
  // v-on:click="..."	on	    click
  // v-slot:header	    slot	header
  // @submit	        on  	submit
  // :[dynamicKey]	    bind	动态参数
  ondirarg(start, end) {
    // 起始和结束相同，说明参数为空，直接跳过；
    // 例如写成 v-bind=... 没有参数，什么都不做。
    if (start === end) return

    // 提取参数文本，比如 "title"、"[dynamicKey]"；
    // 是源码中的原始字符串，不含 v-、: 等前缀。
    const arg = getSlice(start, end)
    if (inVPre) {
      // 如果当前处于 v-pre 模式（跳过编译）：
      // 把参数拼接回属性名（如 :title 会成为 title）；
      // 更新属性名的结束位置 nameLoc.end；
      // 整个属性会作为纯 HTML 属性处理。
      ;(currentProp as AttributeNode).name += arg
      setLocEnd((currentProp as AttributeNode).nameLoc, end)
    } else {
      // 判断是否是静态参数（非 :[...]）：
      // 静态参数例子：:title
      // 动态参数例子：:[dynamicKey]
      const isStatic = arg[0] !== `[`

      // 创建 arg 表达式节点，填入 DirectiveNode.arg 字段：
      // 静态参数使用原始字符串；
      // 动态参数去掉两侧中括号 [key] → key；
      // 设置 isStatic 和常量类型：
      // 静态参数：CAN_STRINGIFY（用于预优化）；
      // 动态参数：NOT_CONSTANT。
      ;(currentProp as DirectiveNode).arg = createExp(
        isStatic ? arg : arg.slice(1, -1),
        isStatic,
        getLoc(start, end),
        isStatic ? ConstantTypes.CAN_STRINGIFY : ConstantTypes.NOT_CONSTANT,
      )
    }
    // 生成结果结构（静态参数示例）：
    // {
    //   type: DIRECTIVE,
    //   name: 'bind',
    //   arg: {
    //     type: SIMPLE_EXPRESSION,
    //     content: 'title',
    //     isStatic: true,
    //     constType: CAN_STRINGIFY,
    //     loc: { start, end }
    //   },
    //   ...
    // }
  },

  // 中处理 指令修饰符（modifier） 的回调函数。
  //
  // 这段逻辑专门负责解析形如：
  // <input v-model.lazy>
  // <button @click.stop>
  // <slot name="foo.bar">
  // 中的 .lazy, .stop, .bar 等修饰符，并将它们正确地附加到当前的 currentProp 上（属性或指令节点）。
  // 什么是指令修饰符？
  // 在 Vue 中，修饰符是对指令行为的扩展说明：
  // 示例	                说明
  // v-model.lazy	        lazy 是修饰符
  // @click.stop	        stop 是事件修饰符
  // v-slot:header.right	right 是插槽参数的修饰符
  ondirmodifier(start, end) {
    // 提取修饰符文本，比如 'stop', 'lazy', 'prop', 'native' 等；
    // 字符位置通过 start 到 end 提供。
    const mod = getSlice(start, end)
    if (inVPre) {
      // 在 v-pre 模式下，所有内容都是“原样处理”；
      // 把 .modifier 当作属性名后缀直接拼接；
      // 位置更新：修改 nameLoc.end。
      ;(currentProp as AttributeNode).name += '.' + mod
      setLocEnd((currentProp as AttributeNode).nameLoc, end)
    } else if ((currentProp as DirectiveNode).name === 'slot') {
      // 对于 v-slot:foo.bar 这种写法，.bar 并不是指令的 modifiers，而是 参数名的一部分；
      // 所以将修饰符拼接到 arg.content 上；
      // 这是一种向后兼容的特殊处理（Vue 3 官方也称这是“edge case”）。
      // slot has no modifiers, special case for edge cases like
      // https://github.com/vuejs/language-tools/issues/2710
      const arg = (currentProp as DirectiveNode).arg
      if (arg) {
        ;(arg as SimpleExpressionNode).content += '.' + mod
        setLocEnd(arg.loc, end)
      }
    } else {
      // 正常指令（如 v-model, @click）的修饰符
      // 然后推入当前指令节点的 .modifiers 数组中。
      const exp = createSimpleExpression(mod, true, getLoc(start, end))
      ;(currentProp as DirectiveNode).modifiers.push(exp)
    }
  },

  // 解析 HTML 属性值（attribute value）过程中被反复调用的回调函数，用于收集属性值的实际内容，例如：
  // <input type="text" value="hello">
  // 当解析器读到 value="hello" 这部分时，它会逐段调用 onattribdata 来累计 "hello"。
  onattribdata(start, end) {
    // 用 getSlice(start, end) 提取当前这段属性值内容；
    // 累加到全局变量 currentAttrValue 上；
    // 这个变量是在 onattribname 或 onattribstart 时初始化的，用于构建完整的属性节点。
    currentAttrValue += getSlice(start, end)

    // 如果是第一次进入这个函数，记录属性值的起始位置。
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start

    // 每次都更新属性值的结束位置；
    // 这样能确保收集过程中最后知道整个值的范围。
    currentAttrEndIndex = end
  },

  // 处理 属性值中的实体字符（如 &amp;, &lt;, &quot;）的专用回调。
  // 它和 onattribdata(...) 是配套使用的，用于构造 HTML attribute 的最终值 —— 不管你写的是普通文本还是实体字符，都会拼接进 currentAttrValue。
  // 什么是 “属性值中的实体”？
  // HTML 支持实体字符表示法，例如：
  // <input value="Tom &amp; Jerry" />
  // 浏览器解析后值是：Tom & Jerry
  // 编译器需要还原这些实体字符为对应字符（如 &）
  onattribentity(char, start, end) {
    // 把解码后的字符追加到 currentAttrValue；
    // currentAttrValue 最终会被用于构建 AttributeNode.value。
    currentAttrValue += char
    // 如果还没记录开始位置，就把当前作为起始；
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start
    // 每次更新结束位置为当前实体的结束。
    currentAttrEndIndex = end
  },

  // 在解析 HTML 标签的属性名结束时执行一些逻辑
  onattribnameend(end) {
    // 获取当前属性名的起始位置
    const start = currentProp!.loc.start.offset

    // 从模板源码中截取属性名字符串
    const name = getSlice(start, end)

    // 如果当前属性是指令（如 v-if、:class 等），记录它的原始名字
    if (currentProp!.type === NodeTypes.DIRECTIVE) {
      currentProp!.rawName = name
    }

    // 检查是否有重复的属性（包括普通属性和指令）
    if (
      currentOpenTag!.props.some(
        p => (p.type === NodeTypes.DIRECTIVE ? p.rawName : p.name) === name,
      )
    ) {
      // 如果发现重复属性，抛出一个错误
      emitError(ErrorCodes.DUPLICATE_ATTRIBUTE, start)
    }
  },

  // 处理属性的值、设置属性的位置信息、判断属性类型（普通属性或指令），并把属性挂到标签节点上。
  onattribend(quote, end) {
    // 确保当前正在解析一个标签，并且有一个正在构建的属性。
    if (currentOpenTag && currentProp) {
      // finalize end pos
      // 设置当前属性位置的结束位置，用于定位属性在源码中的范围。
      setLocEnd(currentProp.loc, end)

      // 如果属性是有值的（QuoteType.NoValue 表示无值，如 <input disabled>）。
      if (quote !== QuoteType.NoValue) {
        if (__BROWSER__ && currentAttrValue.includes('&')) {
          // 浏览器中需要对实体字符（如 &amp;）进行解码。
          currentAttrValue = currentOptions.decodeEntities!(
            currentAttrValue,
            true,
          )
        }

        // 这是普通属性，不是 v- 这种指令。
        if (currentProp.type === NodeTypes.ATTRIBUTE) {
          // assign value

          // condense whitespaces in class
          // 如果是 class 属性，会把多余的空格压缩掉。
          if (currentProp!.name === 'class') {
            currentAttrValue = condense(currentAttrValue).trim()
          }

          // 对于未加引号的属性，如果值为空，报错（HTML 语法错误）。
          if (quote === QuoteType.Unquoted && !currentAttrValue) {
            emitError(ErrorCodes.MISSING_ATTRIBUTE_VALUE, end)
          }

          // 置属性值节点。注意：
          // 加引号的属性值位置包含引号；
          // 未加引号的不包含。
          currentProp!.value = {
            type: NodeTypes.TEXT,
            content: currentAttrValue,
            loc:
              quote === QuoteType.Unquoted
                ? getLoc(currentAttrStartIndex, currentAttrEndIndex)
                : getLoc(currentAttrStartIndex - 1, currentAttrEndIndex + 1),
          }
          // 如果是 <template lang="pug"> 这种情况（非 html），切换 tokenizer 模式为 RCDATA，避免错误解析模板语法。
          if (
            tokenizer.inSFCRoot &&
            currentOpenTag.tag === 'template' &&
            currentProp.name === 'lang' &&
            currentAttrValue &&
            currentAttrValue !== 'html'
          ) {
            // SFC root template with preprocessor lang, force tokenizer to
            // RCDATA mode
            tokenizer.enterRCDATA(toCharCodes(`</template`), 0)
          }
        } else {
          // directive
          // 如果是指令类型属性（v-if, :foo, @click 等）：
          let expParseMode = ExpParseMode.Normal
          if (!__BROWSER__) {
            // 非浏览器环境下对不同指令设置不同的表达式解析模式（便于静态分析）。
            // 不同指令使用不同解析模式：
            // v-for 跳过表达式解析；
            // v-slot 解析参数；
            // v-on 如果含分号，认为是语句块。
            if (currentProp.name === 'for') {
              expParseMode = ExpParseMode.Skip
            } else if (currentProp.name === 'slot') {
              expParseMode = ExpParseMode.Params
            } else if (
              currentProp.name === 'on' &&
              currentAttrValue.includes(';')
            ) {
              expParseMode = ExpParseMode.Statements
            }
          }

          // 构建表达式节点，后续用于 AST 转换与代码生成。
          currentProp.exp = createExp(
            currentAttrValue,
            false,
            getLoc(currentAttrStartIndex, currentAttrEndIndex),
            ConstantTypes.NOT_CONSTANT,
            expParseMode,
          )
          // 如果是 v-for，就额外解析成 for 的结构（item in list 等结构）。
          if (currentProp.name === 'for') {
            currentProp.forParseResult = parseForExpression(currentProp.exp)
          }
          // 2.x compat v-bind:foo.sync -> v-model:foo
          // Vue 2 的兼容性处理：把 v-bind:foo.sync 识别为 v-model:foo。
          let syncIndex = -1
          if (
            __COMPAT__ &&
            currentProp.name === 'bind' &&
            (syncIndex = currentProp.modifiers.findIndex(
              mod => mod.content === 'sync',
            )) > -1 &&
            checkCompatEnabled(
              CompilerDeprecationTypes.COMPILER_V_BIND_SYNC,
              currentOptions,
              currentProp.loc,
              currentProp.arg!.loc.source,
            )
          ) {
            currentProp.name = 'model'
            currentProp.modifiers.splice(syncIndex, 1)
          }
        }
      }
      if (
        currentProp.type !== NodeTypes.DIRECTIVE ||
        currentProp.name !== 'pre'
      ) {
        // 不是 v-pre 的属性，都会加到标签上。v-pre 会影响后续编译过程，所以不马上 push。
        currentOpenTag.props.push(currentProp)
      }
    }
    // 清空状态，准备下一个属性：
    currentAttrValue = ''
    currentAttrStartIndex = currentAttrEndIndex = -1
  },

  // 处理注释
  oncomment(start, end) {
    if (currentOptions.comments) {
      addNode({
        type: NodeTypes.COMMENT,
        content: getSlice(start, end),
        loc: getLoc(start - 4, end + 3),
      })
    }
  },

  // 在解析结束时调用的收尾逻辑。它的作用是：
  // 检查是否有未完成的状态（比如标签没闭合、属性没收尾等）。
  // 抛出适当的错误。
  // 清理未闭合的标签。
  onend() {
    // end 表示整个模板字符串的末尾位置，供错误提示使用。
    const end = currentInput.length
    // EOF ERRORS
    //  在开发模式或非浏览器模式下，检查是否处于非法结束状态（不是纯文本）。
    if ((__DEV__ || !__BROWSER__) && tokenizer.state !== State.Text) {
      switch (tokenizer.state) {
        case State.BeforeTagName:
        case State.BeforeClosingTagName:
          // 文件结束时还在等待标签名（如 < 后面没跟标签名），报错：EOF_BEFORE_TAG_NAME。
          emitError(ErrorCodes.EOF_BEFORE_TAG_NAME, end)
          break
        case State.Interpolation:
        case State.InterpolationClose:
          // 处于插值解析状态（{{ 没闭合），报错：X_MISSING_INTERPOLATION_END。
          emitError(
            ErrorCodes.X_MISSING_INTERPOLATION_END,
            tokenizer.sectionStart,
          )
          break
        case State.InCommentLike:
          // 如果处于注释或 CDATA 状态但文件已经结束，报错：注释没闭合。
          if (tokenizer.currentSequence === Sequences.CdataEnd) {
            emitError(ErrorCodes.EOF_IN_CDATA, end)
          } else {
            emitError(ErrorCodes.EOF_IN_COMMENT, end)
          }
          break
        case State.InTagName:
        case State.InSelfClosingTag:
        case State.InClosingTagName:
        case State.BeforeAttrName:
        case State.InAttrName:
        case State.InDirName:
        case State.InDirArg:
        case State.InDirDynamicArg:
        case State.InDirModifier:
        case State.AfterAttrName:
        case State.BeforeAttrValue:
        case State.InAttrValueDq: // "
        case State.InAttrValueSq: // '
        case State.InAttrValueNq:
          // 文件在解析标签或属性时就结束了，报错：EOF_IN_TAG
          emitError(ErrorCodes.EOF_IN_TAG, end)
          break
        default:
          // console.log(tokenizer.state)
          break
      }
    }
    // 遍历所有未闭合的标签。
    for (let index = 0; index < stack.length; index++) {
      // 调用 onCloseTag 处理标签“强制闭合”。
      onCloseTag(stack[index], end - 1)
      // 每个未闭合的标签都报一个错误：X_MISSING_END_TAG。
      emitError(ErrorCodes.X_MISSING_END_TAG, stack[index].loc.start.offset)
    }
  },

  // 处理 <![CDATA[ ... ]]> 标签块。HTML 中不支持 CDATA，但 SVG / MathML 这些 XML 命名空间中允许。
  oncdata(start, end) {
    // 检查当前标签栈顶部的命名空间，不是 HTML 才允许 CDATA。
    if (stack[0].ns !== Namespaces.HTML) {
      // 对于非 HTML 命名空间，将 CDATA 内容当成普通文本处理。
      onText(getSlice(start, end), start, end)
    } else {
      // 如果是在 HTML 中用 CDATA（不合法），抛出错误：
      // 这里的 start - 9 是因为 <![CDATA[ 长度为 9，用于精确错误定位。
      emitError(ErrorCodes.CDATA_IN_HTML_CONTENT, start - 9)
    }
  },

  // 处理 <?xml ... ?> 或类似的处理指令（processing instruction），这些是 XML 专有语法。
  onprocessinginstruction(start) {
    // ignore as we do not have runtime handling for this, only check error
    // Vue 不支持运行时处理这些指令，只是做语法校验。
    if ((stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML) {
      //  当前标签栈顶部如果是 HTML 命名空间（即普通 HTML 文件），这些 <?...?> 是不合法的。
      emitError(
        ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
        start - 1,
      )
    }
  },
})

// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

// 解析 v-for 表达式 的函数 parseForExpression，它将 v-for="(item, key, index) in list" 这类字符串，解析为结构化的 AST 对象。
function parseForExpression(
  input: SimpleExpressionNode,
): ForParseResult | undefined {
  // loc：源代码中的位置信息。
  // exp：v-for 的表达式内容，比如 "item in items"。
  const loc = input.loc
  const exp = input.content
  // forAliasRE：正则，匹配 item in list 或 (item, i) of list。
  // 如果匹配失败，返回 undefined。
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  // LHS：左边变量部分（如 item 或 (item, index)）
  // RHS：右边源数据部分（如 list）
  const [, LHS, RHS] = inMatch

  // 构造表达式节点
  // 用于将字符串切片 content 转换为表达式节点 AST。
  // offset 用于定位在源码中的准确位置。
  // asParam = true 表示这部分是函数参数风格（如 item, index），用于影响后续解析模式。
  const createAliasExpression = (
    content: string,
    offset: number,
    asParam = false,
  ) => {
    const start = loc.start.offset + offset
    const end = start + content.length
    return createExp(
      content,
      false,
      getLoc(start, end),
      ConstantTypes.NOT_CONSTANT,
      asParam ? ExpParseMode.Params : ExpParseMode.Normal,
    )
  }

  // source：数据来源，比如 items。
  // 其他字段将会在后续解析 (item, key, index) 时填入。
  const result: ForParseResult = {
    source: createAliasExpression(RHS.trim(), exp.indexOf(RHS, LHS.length)),
    value: undefined,
    key: undefined,
    index: undefined,
    finalized: false,
  }

  // 去掉括号与多余空格，提取出变量部分。
  // 记录其在表达式中的偏移量，用于计算准确位置。
  let valueContent = LHS.trim().replace(stripParensRE, '').trim()
  const trimmedOffset = LHS.indexOf(valueContent)

  // forIteratorRE：正则，提取 key 与 index。
  const iteratorMatch = valueContent.match(forIteratorRE)

  // 提取 key，并从 valueContent 中移除它。
  if (iteratorMatch) {
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined

    // 创建 key 表达式
    if (keyContent) {
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      result.key = createAliasExpression(keyContent, keyOffset, true)
    }

    //  创建 index 表达式（如果存在）
    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        result.index = createAliasExpression(
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length,
          ),
          true,
        )
      }
    }
  }

  // 最后处理 value
  if (valueContent) {
    result.value = createAliasExpression(valueContent, trimmedOffset, true)
  }

  // 示例解析
  // 输入模板：
  // <div v-for="(item, key, index) in items"></div>
  // 输出结构体大概如下：
  // {
  //   source: "items",
  //   value: "item",
  //   key: "key",
  //   index: "index",
  //   finalized: false
  // }
  return result
}

// 截取字符
function getSlice(start: number, end: number) {
  return currentInput.slice(start, end)
}

// 在解析 HTML 开始标签的末尾 > 时，完成当前标签节点的状态设置，并决定接下来该如何处理该标签。
function endOpenTag(end: number) {
  // 如果当前是 SFC（Single File Component）模式，在根模板中，
  if (tokenizer.inSFCRoot) {
    // in SFC mode, generate locations for root-level tags' inner content.
    // 为标签的 inner content（即子节点）记录起始位置（用于 source map 和错误定位等）。
    currentOpenTag!.innerLoc = getLoc(end + 1, end + 1)
  }
  // 将当前标签节点（currentOpenTag）添加到 AST 中（即作为当前父节点的子节点）。
  addNode(currentOpenTag!)
  const { tag, ns } = currentOpenTag!
  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    // 如果是 <pre> 标签，开启 inPre 模式（保留标签内的空格和换行），用于处理类似：
    // <pre>
    //   content
    // </pre>
    inPre++
  }
  if (currentOptions.isVoidTag(tag)) {
    // 果是 HTML 中的 自闭合标签（如 <br>、<img> 等 void tag），立即调用 onCloseTag 关闭该标签。
    onCloseTag(currentOpenTag!, end)
  } else {
    // 如果不是自闭合标签，将标签压入 stack 中，表示它还没闭合，接下来可能会嵌套子标签。
    stack.unshift(currentOpenTag!)
    if (ns === Namespaces.SVG || ns === Namespaces.MATH_ML) {
      // 如果是 SVG 或 MathML 命名空间的标签，进入 XML 模式（比如 <svg><circle ...></svg> 这种）。
      tokenizer.inXML = true
    }
  }
  // 最后清空当前正在构建的 open tag，为下一个标签做好准备。
  currentOpenTag = null
}

// 用于处理 文本节点 的回调函数。它在解析器识别到文本内容时触发，并将文本内容转为 AST 中的 TextNode。
// 解码实体字符（如 &amp; → &）；
// 合并相邻文本节点；
// 添加新的文本节点到当前作用域的父节点中。
function onText(content: string, start: number, end: number) {
  if (__BROWSER__) {
    // 如果在浏览器环境中：
    // 且当前节点不是 <script> 或 <style>（这些标签内容不应解码）；
    // 且文本包含 &，可能是 HTML 实体字符；
    // 使用 decodeEntities() 对文本进行实体解码，如：
    // foo &amp; bar → foo & bar
    const tag = stack[0] && stack[0].tag
    if (tag !== 'script' && tag !== 'style' && content.includes('&')) {
      content = currentOptions.decodeEntities!(content, false)
    }
  }
  // 取出当前的父节点（栈顶元素），如果栈为空，则使用 currentRoot。
  const parent = stack[0] || currentRoot
  // 获取父节点下的最后一个子节点；
  // 用于判断是否可以合并文本（比如连续两个文本节点）。
  const lastNode = parent.children[parent.children.length - 1]
  if (lastNode && lastNode.type === NodeTypes.TEXT) {
    // 如果前一个节点是文本类型，直接合并内容；
    // 更新它的位置信息，延伸到当前 end。
    // 合并文本是为了避免出现多个连续文本节点，减少渲染开销。
    // merge
    lastNode.content += content
    setLocEnd(lastNode.loc, end)
  } else {
    // 创建一个新的 TextNode 并加入到 children 数组；
    // 使用 getLoc(...) 记录其在原始模板中的位置。
    parent.children.push({
      type: NodeTypes.TEXT,
      content,
      loc: getLoc(start, end),
    })
  }
}

// 元素闭合处理的核心函数，每当解析器遇到一个结束标签（如 </div>、</template>）时，它会调用这个函数来完成这个元素节点的收尾工作，并处理一系列重要的后处理逻辑：
// 函数职责总结
// onCloseTag(el, end, isImplied = false) 主要做以下几件事：
// 设置元素的位置范围（loc）
// 设置 inner 内容范围（innerLoc）
// 确定元素类型（tagType）
// 空白压缩与 <pre> / <textarea> 处理
// 管理 v-pre、inPre、命名空间等解析状态
// 兼容模式处理（Vue 2 的行为）
function onCloseTag(el: ElementNode, end: number, isImplied = false) {
  // attach end position
  // isImplied = true 表示这个标签并没有真实结束标签（如自动闭合的 </p>）；
  // 使用 backTrack 向前找 < 来确定位置；
  // 正常标签使用 lookAhead 找 >
  if (isImplied) {
    // implied close, end should be backtracked to close
    setLocEnd(el.loc, backTrack(end, CharCodes.Lt))
  } else {
    setLocEnd(el.loc, lookAhead(end, CharCodes.Gt) + 1)
  }

  // 用于 SFC (<template>) 模式下保留内部源码片段；
  // 如果没有 children，就让 innerStart = innerEnd。
  if (tokenizer.inSFCRoot) {
    // SFC root tag, resolve inner end
    if (el.children.length) {
      el.innerLoc!.end = extend({}, el.children[el.children.length - 1].loc.end)
    } else {
      el.innerLoc!.end = extend({}, el.innerLoc!.start)
    }
    el.innerLoc!.source = getSlice(
      el.innerLoc!.start.offset,
      el.innerLoc!.end.offset,
    )
  }

  // refine element type
  // 判断标签类型，决定后续如何处理：
  // 普通元素：ELEMENT
  // 插槽：SLOT
  // 动态组件、fragment template：TEMPLATE
  // Vue component：COMPONENT
  const { tag, ns, children } = el
  if (!inVPre) {
    if (tag === 'slot') {
      el.tagType = ElementTypes.SLOT
    } else if (isFragmentTemplate(el)) {
      el.tagType = ElementTypes.TEMPLATE
    } else if (isComponent(el)) {
      el.tagType = ElementTypes.COMPONENT
    }
  }

  // whitespace management
  // 如果不在 RCDATA（如 <textarea>, <title>）模式中，就对 children 执行空白优化。
  if (!tokenizer.inRCDATA) {
    el.children = condenseWhitespace(children, tag)
  }

  // 移除 <textarea>、<pre> 中开头的换行
  if (ns === Namespaces.HTML && currentOptions.isIgnoreNewlineTag(tag)) {
    // remove leading newline for <textarea> and <pre> per html spec
    // https://html.spec.whatwg.org/multipage/parsing.html#parsing-main-inbody
    // 按 HTML spec，对 <textarea>, <pre> 中第一个换行符要忽略。
    const first = children[0]
    if (first && first.type === NodeTypes.TEXT) {
      first.content = first.content.replace(/^\r?\n/, '')
    }
  }

  // 恢复解析状态标记
  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    inPre--
  }
  if (currentVPreBoundary === el) {
    // 关闭 <pre>、v-pre 状态；
    inVPre = tokenizer.inVPre = false
    currentVPreBoundary = null
  }
  if (
    tokenizer.inXML &&
    (stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML
  ) {
    // 退出兼容模式或 XML 模式下的状态。
    tokenizer.inXML = false
  }

  // 2.x compat / deprecation checks
  // 兼容模式处理（Vue 2 向后兼容）
  if (__COMPAT__) {
    const props = el.props
    if (
      __DEV__ &&
      isCompatEnabled(
        CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
        currentOptions,
      )
    ) {
      let hasIf = false
      let hasFor = false
      for (let i = 0; i < props.length; i++) {
        const p = props[i]
        if (p.type === NodeTypes.DIRECTIVE) {
          if (p.name === 'if') {
            hasIf = true
          } else if (p.name === 'for') {
            hasFor = true
          }
        }
        if (hasIf && hasFor) {
          // 检测指令列表中是否同时存在 v-if 和 v-for；
          // 在 2.x 中不推荐这样使用，发出 deprecation warning。
          warnDeprecation(
            CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
            currentOptions,
            el.loc,
          )
          break
        }
      }
    }

    if (
      !tokenizer.inSFCRoot &&
      isCompatEnabled(
        CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
        currentOptions,
      ) &&
      el.tag === 'template' &&
      !isFragmentTemplate(el)
    ) {
      // 如果 template 没有控制指令（v-if, v-for, v-slot），认为它是原生标签；
      // 警告并移除这个 template 节点，将其 children 拿出来直接挂在父节点上
      __DEV__ &&
        warnDeprecation(
          CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
          currentOptions,
          el.loc,
        )
      // unwrap
      const parent = stack[0] || currentRoot
      const index = parent.children.indexOf(el)
      parent.children.splice(index, 1, ...el.children)
    }

    const inlineTemplateProp = props.find(
      p => p.type === NodeTypes.ATTRIBUTE && p.name === 'inline-template',
    ) as AttributeNode
    if (
      inlineTemplateProp &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE,
        currentOptions,
        inlineTemplateProp.loc,
      ) &&
      el.children.length
    ) {
      // 旧写法 <component inline-template> 的支持；
      // 将子节点拼成一个文本属性值。
      inlineTemplateProp.value = {
        type: NodeTypes.TEXT,
        content: getSlice(
          el.children[0].loc.start.offset,
          el.children[el.children.length - 1].loc.end.offset,
        ),
        loc: inlineTemplateProp.loc,
      }
    }
  }
}

// 正向扫描函数，从指定的起点 index 向后查找指定字符 c 的位置。
// 它的主要用途也是在 模板字符串解析阶段，用于快速跳过无用字符或寻找特定标记的位置，比如：
// 快速跳过直到 > 来完成标签扫描；
// 判断接下来是否包含某个分隔符；
// 错误定位或预读辅助。
function lookAhead(index: number, c: number) {
  let i = index
  while (currentInput.charCodeAt(i) !== c && i < currentInput.length - 1) i++
  return i
}

// 从指定的索引 index 开始，向前回溯查找第一个匹配字符 c，并返回它的索引。
function backTrack(index: number, c: number) {
  let i = index
  while (currentInput.charCodeAt(i) !== c && i >= 0) i--
  return i
}

const specialTemplateDir = new Set(['if', 'else', 'else-if', 'for', 'slot'])
// 用来判断一个 <template> 标签是否是一个 “片段模板”，即：它是否是用来支持控制结构的，例如 v-if、v-for、v-slot 等。
function isFragmentTemplate({ tag, props }: ElementNode): boolean {
  // 必须是 <template> 标签才考虑；
  // 其他标签（如 <div>, <span>, <slot>）直接返回 false。
  if (tag === 'template') {
    // 遍历 <template> 标签的所有属性节点。
    for (let i = 0; i < props.length; i++) {
      if (
        // 只处理指令节点（如 v-if, v-for，而不是普通属性）；
        // specialTemplateDir 是一个 Set，包含特殊控制指令名，如：
        // 如果 props[i] 是这些特殊指令中的一个，则说明这个 <template> 是用于控制结构或插槽的片段模板 → 返回 true。
        props[i].type === NodeTypes.DIRECTIVE &&
        specialTemplateDir.has((props[i] as DirectiveNode).name)
      ) {
        return true
      }
    }
  }
  return false
}

// 用来识别一个 AST 元素节点（ElementNode）是否应被视为 Vue 组件。
// 组件和原生标签的处理方式截然不同；
// 它直接影响代码生成、运行时渲染逻辑、性能优化等环节；
// 特别在 <component :is="...">、大小写组件、内置组件、自定义组件等混合使用时尤为重要。
function isComponent({ tag, props }: ElementNode): boolean {
  // 用户可以通过配置 isCustomElement 显式声明某些标签不是组件；
  // 一般用于 Web Components、SVG 自定义标签等。
  if (currentOptions.isCustomElement(tag)) {
    return false
  }

  // 条件                           	    含义
  // tag === 'component'         	    是 <component> 动态组件
  // isUpperCase(tag.charCodeAt(0))	    首字母大写（如 MyComponent）
  // isCoreComponent(tag)	            是内置核心组件（如 <Suspense>、<Teleport>）
  // isBuiltInComponent(tag)	        是用户配置的内置组件
  // isNativeTag && !isNativeTag(tag)	如果不是原生 HTML 标签，也当作组件
  if (
    tag === 'component' ||
    isUpperCase(tag.charCodeAt(0)) ||
    isCoreComponent(tag) ||
    (currentOptions.isBuiltInComponent &&
      currentOptions.isBuiltInComponent(tag)) ||
    (currentOptions.isNativeTag && !currentOptions.isNativeTag(tag))
  ) {
    return true
  }
  // at this point the tag should be a native tag, but check for potential "is"
  // casting
  // 再检查 <div is="some-component">
  // 这是处理动态组件的一种写法（尤其是兼容老版本）：
  // <div is="vue:foo" />
  // <div :is="componentName" />
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.name === 'is' && p.value) {
        // 静态 is 属性；
        // 且值以 vue: 开头 → 明确表示是 Vue 组件。
        if (p.value.content.startsWith('vue:')) {
          return true
        } else if (
          // 如果处于兼容模式，则允许静态 is="Foo" 被视为组件；
          // 需要触发兼容性开关 COMPILER_IS_ON_ELEMENT。
          __COMPAT__ &&
          checkCompatEnabled(
            CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
            currentOptions,
            p.loc,
          )
        ) {
          return true
        }
      }
    } else if (
      // 动态绑定（v-bind） 动态绑定 :is 被视为组件，只在兼容模式下生效。
      __COMPAT__ &&
      // :is on plain element - only treat as component in compat mode
      p.name === 'bind' &&
      isStaticArgOf(p.arg, 'is') &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
        currentOptions,
        p.loc,
      )
    ) {
      return true
    }
  }
  // 如果所有规则都不匹配，则视为普通原生元素。
  return false
}

// 判断是否是大写
function isUpperCase(c: number) {
  return c > 64 && c < 91
}

const windowsNewlineRE = /\r\n/g

// 压缩、清理、规范化模板中的空白字符。
// 这是编译器在构建 AST 后对 children 节点列表做的 优化处理，
// 主要目的是根据 whitespace 设置（preserve or condense）对 <div>, <span>, <template> 等标签中的空白进行裁剪、合并或转换。
function condenseWhitespace(
  nodes: TemplateChildNode[], // 一个元素的子节点数组（children）；
  tag?: string, // 可选，当前标签名（如 pre, div），用于判断是否需要特殊处理；
): TemplateChildNode[] {
  // 如果当前编译选项不是 'preserve'，则启用压缩空白（shouldCondense = true）；
  // 'preserve'：保持原样；否则进行空白优化。
  const shouldCondense = currentOptions.whitespace !== 'preserve'
  // 记录是否有空白节点被删除，用于后续决定是否执行 filter(Boolean)。
  let removedWhitespace = false
  // 遍历所有子节点
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    // 只处理文本节点；
    // 忽略元素、注释、插值等其他节点。
    if (node.type === NodeTypes.TEXT) {
      // 非 <pre> 标签场景：
      if (!inPre) {
        // 如果不是 <pre> 且是全空白文本：
        if (isAllWhitespace(node.content)) {
          // 获取前后节点类型（用于判断该空白是否是“结构性”空白）；
          const prev = nodes[i - 1] && nodes[i - 1].type
          const next = nodes[i + 1] && nodes[i + 1].type
          // Remove if:
          // - the whitespace is the first or last node, or:
          // - (condense mode) the whitespace is between two comments, or:
          // - (condense mode) the whitespace is between comment and element, or:
          // - (condense mode) the whitespace is between two elements AND contains newline
          if (
            !prev ||
            !next || // 是首尾空白节点
            (shouldCondense &&
              ((prev === NodeTypes.COMMENT &&
                (next === NodeTypes.COMMENT || next === NodeTypes.ELEMENT)) ||
                (prev === NodeTypes.ELEMENT &&
                  (next === NodeTypes.COMMENT ||
                    (next === NodeTypes.ELEMENT &&
                      hasNewlineChar(node.content))))))
          ) {
            // 情况	                                说明
            // 是第一个或最后一个节点	                没有实质性前/后节点
            // 是注释之间的空白（condense 模式）    	多余注释换行间空白
            // 是元素之间带换行的空白（condense 模式）	HTML 的结构性空白，可删除

            // 标记删除；
            removedWhitespace = true
            // 将节点置为 null（后面会统一清理）。
            nodes[i] = null as any
          } else {
            // Otherwise, the whitespace is condensed into a single space
            // 否则：压缩为空格 ' '
            node.content = ' '
          }
        } else if (shouldCondense) {
          // 如果是非全空白文本，但启用压缩模式 → 用 condense() 合并空格（例如多个空格变一个）。
          // in condense mode, consecutive whitespaces in text are condensed
          // down to a single space.
          node.content = condense(node.content)
        }
      } else {
        // #6410 normalize windows newlines in <pre>:
        // in SSR, browsers normalize server-rendered \r\n into a single \n
        // in the DOM

        // 在 <pre> 中不要压缩内容，但要把 \r\n 转换为 \n；
        // 模拟浏览器在 DOM 中如何渲染服务端输出（兼容 SSR）。
        node.content = node.content.replace(windowsNewlineRE, '\n')
      }
    }
  }

  // 如果前面有空白节点被置为 null，就过滤掉它们；
  // 否则直接返回原数组（无修改）。
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

// 用来判断字符串是否全部由空白字符组成
function isAllWhitespace(str: string) {
  for (let i = 0; i < str.length; i++) {
    if (!isWhitespace(str.charCodeAt(i))) {
      return false
    }
  }
  return true
}

// 用于检测字符串中是否包含换行符（\n 或 \r）。它常见于编译器、模板处理器、格式化器中，
// 用来判断一段文本是否跨行或是否需要特殊处理（比如：保留换行、插入分号、自动格式化等）。
function hasNewlineChar(str: string) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c === CharCodes.NewLine || c === CharCodes.CarriageReturn) {
      return true
    }
  }
  return false
}

// 小巧实用的工具函数，常用于 压缩字符串中的多余空白字符，其核心功能就是将字符串中连续的空白字符（如多个空格、换行、制表符）合并为一个空格。
function condense(str: string) {
  let ret = ''
  let prevCharIsWhitespace = false
  for (let i = 0; i < str.length; i++) {
    if (isWhitespace(str.charCodeAt(i))) {
      if (!prevCharIsWhitespace) {
        ret += ' '
        prevCharIsWhitespace = true
      }
    } else {
      ret += str[i]
      prevCharIsWhitespace = false
    }
  }
  return ret
}

// 用于将解析出来的 AST 节点插入到当前语法结构中的核心方法之一。
function addNode(node: TemplateChildNode) {
  // 它将节点添加到“当前父节点的 children 列表”中；
  // stack[0]: 是 AST 构建过程中当前正在处理的打开标签（如 <div>）；
  // 如果 stack 是空的（比如你正在处理顶层节点），就使用 currentRoot（根节点）；
  // 然后将这个 node 插入到该父节点的 children 数组中。
  // ⚠️ 前面的 ; 是为了防止在某些上下文中出错（例如前一行是函数调用，JS 自动插入分号行为可能干扰）。
  ;(stack[0] || currentRoot).children.push(node)

  // 示例
  // 比如你在处理如下模板：
  // <div>Hello <span>world</span></div>
  // 解析过程：
  // 遇到 <div> → 推入 stack；
  // 遇到文本 Hello → addNode(text) 插入到 div.children；
  // 遇到 <span> → 推入 stack；
  // 遇到文本 world → addNode(text) 插入到 span.children；
  // 遇到 </span> → 弹出 span；
  // 遇到 </div> → 弹出 div；
  // 整个 AST 构建完成，根节点是 currentRoot。
}

// 将起止字符索引位置（offset）转换成 SourceLocation 对象，用于记录 AST 节点在源代码中的 精确位置、源码内容 等元信息。
function getLoc(start: number, end?: number): SourceLocation {
  return {
    // 源码中的起始位置（包含行号、列号、偏移）；
    start: tokenizer.getPos(start),
    // 源码中的结束位置；
    // @ts-expect-error allow late attachment
    end: end == null ? end : tokenizer.getPos(end),
    // 源码片段字符串（从 start 到 end）。
    // @ts-expect-error allow late attachment
    source: end == null ? end : getSlice(start, end),
  }
}

// 当你需要在 AST 中复制一个节点的位置信息时，就会用它来快速构造一个新的 SourceLocation 实例。
export function cloneLoc(loc: SourceLocation): SourceLocation {
  return getLoc(loc.start.offset, loc.end.offset)
}

// 用于在解析完成某个语法结构（如元素、属性、表达式）后设置该结构的结束位置，并记录对应的源码片段。
// 它在构建 AST 节点时非常关键，因为每个节点都需要精确的位置信息，供后续的 代码提示、错误标注、source map、IDE 联动 使用。
function setLocEnd(loc: SourceLocation, end: number) {
  // 通过 tokenizer.getPos(end) 获取该索引对应的 位置信息（如 line, column, offset）；
  // 并赋值给 loc.end。
  loc.end = tokenizer.getPos(end)
  // 把起始偏移到结束偏移之间的源码片段取出来，赋值给 loc.source；
  // 这样你就可以看到该节点在源码中的实际文本内容，例如：
  // <div class="foo">
  // 对应的 source 可能就是：div class="foo"（包含属性、空格等）
  loc.source = getSlice(loc.start.offset, end)
}

// 将一个指令节点 DirectiveNode（如 v-bind="foo"）转成一个普通的属性节点 AttributeNode，
// 主要用于兼容模式（Vue 2 的 AST）或特定场景下转换回 HTML 属性格式。
//
// 这个函数常见于：
// Vue 编译器内部做 AST 转换时（例如向 Vue 2 AST 兼容）
// 某些指令需要退化为普通属性时（如 v-bind:id="id" → id="xxx"）
// SFC 编译阶段恢复原始 HTML 属性信息（如原始位置、文本内容）
function dirToAttr(dir: DirectiveNode): AttributeNode {
  const attr: AttributeNode = {
    type: NodeTypes.ATTRIBUTE,
    name: dir.rawName!, // 原始属性名，如 `:class` 或 `v-bind:id`。  name 使用 rawName，保留绑定修饰符（带冒号、点等）
    // 构造属性名的位置信息（用于后续错误提示、source map）
    nameLoc: getLoc(
      dir.loc.start.offset,
      dir.loc.start.offset + dir.rawName!.length,
    ),
    // 初始设置 value = undefined（可能后面补上）
    // loc 是整个指令节点的位置
    value: undefined,
    loc: dir.loc,
  }
  // 若指令有表达式，则将其转为属性值（TextNode）
  if (dir.exp) {
    // account for quotes
    // 如果是绑定表达式（如 :id="someVar"），就提取表达式部分的位置
    const loc = dir.exp.loc

    // 加引号的偏移修正
    if (loc.end.offset < dir.loc.end.offset) {
      // 为什么要改位置？
      // 原始表达式 foo 被包在 "foo" 里
      // AST 中 dir.exp.loc 只标记了 foo，而不是整个 "foo"
      // 所以我们把 start.offset - 1、end.offset + 1，人为包住引号
      loc.start.offset--
      loc.start.column--
      loc.end.offset++
      loc.end.column++
    }
    // 构造 TextNode 作为属性值
    // 构建一个文本节点：{ type: TEXT, content: 'foo', loc: ... }
    // 相当于 id="foo" 中 "foo" 这一部分
    attr.value = {
      type: NodeTypes.TEXT,
      content: (dir.exp as SimpleExpressionNode).content,
      loc,
    }
  }
  return attr
}

enum ExpParseMode {
  Normal, // 普通表达式，例如 {{ msg }}、:class="isActive"
  Params, // 参数模式，用于 v-for、v-slot 等，如 (item, index)
  Statements, // 多语句模式，用于事件绑定如 @click="a++; b++"
  Skip, // 跳过解析（如 v-pre 中的表达式）
}

// 创建一个 SimpleExpressionNode，并在需要时将其表达式字符串解析为 AST（抽象语法树），从而支持后续作用域分析、变量前缀处理、静态提升判断等优化。
// 这个函数是解析模板中如 {{ msg }}、:class="isActive ? 'a' : 'b'"、v-on:click="handleClick" 等绑定表达式的关键处理逻辑。
// 流程图：
// 字符串内容 → SimpleExpressionNode
//           ↘（可选）AST → Babel解析 → 标注 identifiers/错误
function createExp(
  // content: 表达式内容（字符串），如 "msg"、"count + 1"、"x ? y : z"
  // isStatic: 是否是静态表达式（常量字符串）
  // loc: 表达式在模板中的位置（用于错误定位）
  // constType: 用于判断常量等级，优化用（可提升/缓存/字符串化）
  // parseMode: 表达式解析模式（常规表达式/参数/语句）
  content: SimpleExpressionNode['content'],
  isStatic: SimpleExpressionNode['isStatic'] = false,
  loc: SourceLocation,
  constType: ConstantTypes = ConstantTypes.NOT_CONSTANT,
  parseMode = ExpParseMode.Normal,
) {
  // 创建一个基本的 SimpleExpressionNode
  // 包含字段：content, loc, isStatic, constType
  const exp = createSimpleExpression(content, isStatic, loc, constType)
  if (
    // 不是浏览器环境（服务端或编译器环境）
    // 表达式是动态的（非静态字面量）
    // 编译选项要求加 _ctx. 前缀（即 scope 追踪）
    // 表达式需要解析（不跳过）
    // 表达式不是空白
    !__BROWSER__ &&
    !isStatic &&
    currentOptions.prefixIdentifiers &&
    parseMode !== ExpParseMode.Skip &&
    content.trim()
  ) {
    // 用 Babel 把表达式内容转换为 AST 结构

    // 如果是纯变量名，如 count、userName
    // 就不走 Babel 解析（性能优化）
    // 设置 ast = null 表示这是一个有效、但无需 AST 追踪的表达式
    if (isSimpleIdentifier(content)) {
      exp.ast = null // fast path
      return exp
    }
    try {
      // 加载编译选项里的 Babel 插件（支持可选链、TS、扩展语法等）
      // 默认始终包含 'typescript' 插件支持 TS 表达式
      const plugins = currentOptions.expressionPlugins
      const options: BabelOptions = {
        plugins: plugins ? [...plugins, 'typescript'] : ['typescript'],
      }
      // 不同模式下包裹方式
      // Statements 模式（v-on多语句）：msg++; count-- ➜ 加空格包裹为 msg++; count--
      // Params 模式（函数参数）：item, index ➜ 包裹为 (item, index) => {}
      // Normal 模式（默认）：count + 1 ➜ 包裹为 (count + 1)
      if (parseMode === ExpParseMode.Statements) {
        // v-on with multi-inline-statements, pad 1 char
        exp.ast = parse(` ${content} `, options).program
      } else if (parseMode === ExpParseMode.Params) {
        exp.ast = parseExpression(`(${content})=>{}`, options)
      } else {
        // normal exp, wrap with parens
        exp.ast = parseExpression(`(${content})`, options)
      }
    } catch (e: any) {
      // 如果解析失败（如语法错误）
      // 设置 exp.ast = false
      // 调用 emitError() 报告错误，带定位信息
      exp.ast = false // indicate an error
      emitError(ErrorCodes.X_INVALID_EXPRESSION, loc.start.offset, e.message)
    }
  }
  // 返回构造好的 SimpleExpressionNode
  // 它可能含有：
  // ast = null：无需解析（纯变量）
  // ast = false：解析失败
  // ast = Babel AST：成功解析，供后续作用域分析使用
  return exp
}

// 用于在模板解析过程中 报告语法错误或不合法结构，并通过用户或默认的 onError 回调进行处理。
// code: 错误代码（枚举类型 ErrorCodes，表示是哪类错误）
// index: 错误在模板字符串中的位置（从 0 开始的字符索引）
// message: 可选的自定义错误提示（可覆盖默认错误信息）
function emitError(code: ErrorCodes, index: number, message?: string) {
  // 调用当前解析器配置里的 onError() 函数
  // 这个函数通常来自用户传入的 ParserOptions.onError，或默认的 defaultOnError
  currentOptions.onError(
    createCompilerError(code, getLoc(index, index), undefined, message),
  )
}

function reset() {
  // 调用词法分析器 tokenizer 的内部重置函数
  // 会重置指针、模式、插值定界符等内容（如 mode, inXML, pos, input）
  tokenizer.reset()

  // 当前正在处理的开始标签置空
  // 例如 <div> 还未闭合时，这里会记录它，reset 后清除
  currentOpenTag = null

  // 当前正在构建的属性（普通属性或指令）清空
  // 用于处理解析 <div class="x"> 或 v-model="msg" 等 prop 的状态
  currentProp = null

  // 当前属性的值清空，以及它在 input 中的位置也重置
  // 用于构建 AttributeNode 或 DirectiveNode 时的 source range 信息
  currentAttrValue = ''
  currentAttrStartIndex = -1
  currentAttrEndIndex = -1

  // 清空 stack（标签栈）
  // stack 是解析器用于构建嵌套结构的关键结构：
  // 每次 <div> 入栈
  // 每次 </div> 出栈
  // 清空它确保重新开始新的 AST 构建
  stack.length = 0
}

// 整个编译器“前端”的第一步——把模板字符串（<template>...</template>）转换成 AST（抽象语法树）。
// input: 模板字符串，比如 <div>{{ msg }}</div>
// options: 编译选项，如 delimiters, isCustomElement, onError 等
// 返回：RootNode，也就是 AST 的根节点
export function baseParse(input: string, options?: ParserOptions): RootNode {
  // 清空所有解析状态变量（比如 currentOpenTag、stack、currentAttrValue 等）
  // 通常用于解析多个模板时确保状态干净
  reset()

  // 设置当前正在处理的模板字符串
  currentInput = input

  // 创建新的配置对象（浅拷贝默认配置），避免直接修改默认值
  currentOptions = extend({}, defaultParserOptions)

  // 合并用户传入的选项
  // 手动遍历 options 合并到 currentOptions
  // 用 != null 防止覆盖默认值（只合并不为 null/undefined 的配置）
  // 使用 @ts-expect-error 跳过类型检查（因为不是所有字段都属于 MergedParserOptions）
  if (options) {
    let key: keyof ParserOptions
    for (key in options) {
      if (options[key] != null) {
        // @ts-expect-error
        currentOptions[key] = options[key]
      }
    }
  }

  // 开发环境下的验证逻辑（可选）
  if (__DEV__) {
    // 用于确保 decodeEntities 在正确平台中传入
    // 服务端中不支持该选项
    // 浏览器中必须启用（否则实体如 &amp; 无法正确解析）
    if (!__BROWSER__ && currentOptions.decodeEntities) {
      console.warn(
        `[@vue/compiler-core] decodeEntities option is passed but will be ` +
          `ignored in non-browser builds.`,
      )
    } else if (__BROWSER__ && !currentOptions.decodeEntities) {
      throw new Error(
        `[@vue/compiler-core] decodeEntities option is required in browser builds.`,
      )
    }
  }

  // 设置解析器状态 tokenizer（词法分析器）

  // 设置当前解析模式（普通 HTML、SFC、或基础模式）
  // 会影响如何处理标签、属性、注释、CDATAs 等
  tokenizer.mode =
    currentOptions.parseMode === 'html'
      ? ParseMode.HTML
      : currentOptions.parseMode === 'sfc'
        ? ParseMode.SFC
        : ParseMode.BASE

  // 设置是否为 XML 模式（用于 SVG、MathML 标签）
  tokenizer.inXML =
    currentOptions.ns === Namespaces.SVG ||
    currentOptions.ns === Namespaces.MATH_ML

  // 自定义插值定界符，如改成 [[ msg ]] → delimiters: ['[[', ']]']
  const delimiters = options && options.delimiters
  if (delimiters) {
    tokenizer.delimiterOpen = toCharCodes(delimiters[0])
    tokenizer.delimiterClose = toCharCodes(delimiters[1])
  }

  // 创建根节点 RootNode，初始化为空 children 数组
  // 并赋值给 currentRoot，用于全局状态引用
  const root = (currentRoot = createRoot([], input))

  // 启动词法分析器（实际是 HTML tokenizer + parser）
  // 会不断填充 root.children 以及构建完整的 AST 树结构
  tokenizer.parse(currentInput)
  // 设置整个 root 的源码位置（用于错误提示和 source map）
  root.loc = getLoc(0, input.length)
  // 清除冗余空白字符（如果设置了 whitespace: 'condense'）
  root.children = condenseWhitespace(root.children)

  // 清空状态，返回最终构建好的 AST 根节点
  currentRoot = null
  return root
}
