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

const tokenizer = new Tokenizer(stack, {
  onerr: emitError,

  ontext(start, end) {
    onText(getSlice(start, end), start, end)
  },

  ontextentity(char, start, end) {
    onText(char, start, end)
  },

  oninterpolation(start, end) {
    if (inVPre) {
      return onText(getSlice(start, end), start, end)
    }
    let innerStart = start + tokenizer.delimiterOpen.length
    let innerEnd = end - tokenizer.delimiterClose.length
    while (isWhitespace(currentInput.charCodeAt(innerStart))) {
      innerStart++
    }
    while (isWhitespace(currentInput.charCodeAt(innerEnd - 1))) {
      innerEnd--
    }
    let exp = getSlice(innerStart, innerEnd)
    // decode entities for backwards compat
    if (exp.includes('&')) {
      if (__BROWSER__) {
        exp = currentOptions.decodeEntities!(exp, false)
      } else {
        exp = decodeHTML(exp)
      }
    }
    addNode({
      type: NodeTypes.INTERPOLATION,
      content: createExp(exp, false, getLoc(innerStart, innerEnd)),
      loc: getLoc(start, end),
    })
  },

  onopentagname(start, end) {
    const name = getSlice(start, end)
    currentOpenTag = {
      type: NodeTypes.ELEMENT,
      tag: name,
      ns: currentOptions.getNamespace(name, stack[0], currentOptions.ns),
      tagType: ElementTypes.ELEMENT, // will be refined on tag close
      props: [],
      children: [],
      loc: getLoc(start - 1, end),
      codegenNode: undefined,
    }
  },

  onopentagend(end) {
    endOpenTag(end)
  },

  onclosetag(start, end) {
    const name = getSlice(start, end)
    if (!currentOptions.isVoidTag(name)) {
      let found = false
      for (let i = 0; i < stack.length; i++) {
        const e = stack[i]
        if (e.tag.toLowerCase() === name.toLowerCase()) {
          found = true
          if (i > 0) {
            emitError(ErrorCodes.X_MISSING_END_TAG, stack[0].loc.start.offset)
          }
          for (let j = 0; j <= i; j++) {
            const el = stack.shift()!
            onCloseTag(el, end, j < i)
          }
          break
        }
      }
      if (!found) {
        emitError(ErrorCodes.X_INVALID_END_TAG, backTrack(start, CharCodes.Lt))
      }
    }
  },

  onselfclosingtag(end) {
    const name = currentOpenTag!.tag
    currentOpenTag!.isSelfClosing = true
    endOpenTag(end)
    if (stack[0] && stack[0].tag === name) {
      onCloseTag(stack.shift()!, end)
    }
  },

  onattribname(start, end) {
    // plain attribute
    currentProp = {
      type: NodeTypes.ATTRIBUTE,
      name: getSlice(start, end),
      nameLoc: getLoc(start, end),
      value: undefined,
      loc: getLoc(start),
    }
  },

  ondirname(start, end) {
    const raw = getSlice(start, end)
    const name =
      raw === '.' || raw === ':'
        ? 'bind'
        : raw === '@'
          ? 'on'
          : raw === '#'
            ? 'slot'
            : raw.slice(2)

    if (!inVPre && name === '') {
      emitError(ErrorCodes.X_MISSING_DIRECTIVE_NAME, start)
    }

    if (inVPre || name === '') {
      currentProp = {
        type: NodeTypes.ATTRIBUTE,
        name: raw,
        nameLoc: getLoc(start, end),
        value: undefined,
        loc: getLoc(start),
      }
    } else {
      currentProp = {
        type: NodeTypes.DIRECTIVE,
        name,
        rawName: raw,
        exp: undefined,
        arg: undefined,
        modifiers: raw === '.' ? [createSimpleExpression('prop')] : [],
        loc: getLoc(start),
      }
      if (name === 'pre') {
        inVPre = tokenizer.inVPre = true
        currentVPreBoundary = currentOpenTag
        // convert dirs before this one to attributes
        const props = currentOpenTag!.props
        for (let i = 0; i < props.length; i++) {
          if (props[i].type === NodeTypes.DIRECTIVE) {
            props[i] = dirToAttr(props[i] as DirectiveNode)
          }
        }
      }
    }
  },

  ondirarg(start, end) {
    if (start === end) return
    const arg = getSlice(start, end)
    if (inVPre) {
      ;(currentProp as AttributeNode).name += arg
      setLocEnd((currentProp as AttributeNode).nameLoc, end)
    } else {
      const isStatic = arg[0] !== `[`
      ;(currentProp as DirectiveNode).arg = createExp(
        isStatic ? arg : arg.slice(1, -1),
        isStatic,
        getLoc(start, end),
        isStatic ? ConstantTypes.CAN_STRINGIFY : ConstantTypes.NOT_CONSTANT,
      )
    }
  },

  ondirmodifier(start, end) {
    const mod = getSlice(start, end)
    if (inVPre) {
      ;(currentProp as AttributeNode).name += '.' + mod
      setLocEnd((currentProp as AttributeNode).nameLoc, end)
    } else if ((currentProp as DirectiveNode).name === 'slot') {
      // slot has no modifiers, special case for edge cases like
      // https://github.com/vuejs/language-tools/issues/2710
      const arg = (currentProp as DirectiveNode).arg
      if (arg) {
        ;(arg as SimpleExpressionNode).content += '.' + mod
        setLocEnd(arg.loc, end)
      }
    } else {
      const exp = createSimpleExpression(mod, true, getLoc(start, end))
      ;(currentProp as DirectiveNode).modifiers.push(exp)
    }
  },

  onattribdata(start, end) {
    currentAttrValue += getSlice(start, end)
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start
    currentAttrEndIndex = end
  },

  onattribentity(char, start, end) {
    currentAttrValue += char
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start
    currentAttrEndIndex = end
  },

  onattribnameend(end) {
    const start = currentProp!.loc.start.offset
    const name = getSlice(start, end)
    if (currentProp!.type === NodeTypes.DIRECTIVE) {
      currentProp!.rawName = name
    }
    // check duplicate attrs
    if (
      currentOpenTag!.props.some(
        p => (p.type === NodeTypes.DIRECTIVE ? p.rawName : p.name) === name,
      )
    ) {
      emitError(ErrorCodes.DUPLICATE_ATTRIBUTE, start)
    }
  },

  onattribend(quote, end) {
    if (currentOpenTag && currentProp) {
      // finalize end pos
      setLocEnd(currentProp.loc, end)

      if (quote !== QuoteType.NoValue) {
        if (__BROWSER__ && currentAttrValue.includes('&')) {
          currentAttrValue = currentOptions.decodeEntities!(
            currentAttrValue,
            true,
          )
        }

        if (currentProp.type === NodeTypes.ATTRIBUTE) {
          // assign value

          // condense whitespaces in class
          if (currentProp!.name === 'class') {
            currentAttrValue = condense(currentAttrValue).trim()
          }

          if (quote === QuoteType.Unquoted && !currentAttrValue) {
            emitError(ErrorCodes.MISSING_ATTRIBUTE_VALUE, end)
          }

          currentProp!.value = {
            type: NodeTypes.TEXT,
            content: currentAttrValue,
            loc:
              quote === QuoteType.Unquoted
                ? getLoc(currentAttrStartIndex, currentAttrEndIndex)
                : getLoc(currentAttrStartIndex - 1, currentAttrEndIndex + 1),
          }
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
          let expParseMode = ExpParseMode.Normal
          if (!__BROWSER__) {
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
          currentProp.exp = createExp(
            currentAttrValue,
            false,
            getLoc(currentAttrStartIndex, currentAttrEndIndex),
            ConstantTypes.NOT_CONSTANT,
            expParseMode,
          )
          if (currentProp.name === 'for') {
            currentProp.forParseResult = parseForExpression(currentProp.exp)
          }
          // 2.x compat v-bind:foo.sync -> v-model:foo
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
        currentOpenTag.props.push(currentProp)
      }
    }
    currentAttrValue = ''
    currentAttrStartIndex = currentAttrEndIndex = -1
  },

  oncomment(start, end) {
    if (currentOptions.comments) {
      addNode({
        type: NodeTypes.COMMENT,
        content: getSlice(start, end),
        loc: getLoc(start - 4, end + 3),
      })
    }
  },

  onend() {
    const end = currentInput.length
    // EOF ERRORS
    if ((__DEV__ || !__BROWSER__) && tokenizer.state !== State.Text) {
      switch (tokenizer.state) {
        case State.BeforeTagName:
        case State.BeforeClosingTagName:
          emitError(ErrorCodes.EOF_BEFORE_TAG_NAME, end)
          break
        case State.Interpolation:
        case State.InterpolationClose:
          emitError(
            ErrorCodes.X_MISSING_INTERPOLATION_END,
            tokenizer.sectionStart,
          )
          break
        case State.InCommentLike:
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
          emitError(ErrorCodes.EOF_IN_TAG, end)
          break
        default:
          // console.log(tokenizer.state)
          break
      }
    }
    for (let index = 0; index < stack.length; index++) {
      onCloseTag(stack[index], end - 1)
      emitError(ErrorCodes.X_MISSING_END_TAG, stack[index].loc.start.offset)
    }
  },

  oncdata(start, end) {
    if (stack[0].ns !== Namespaces.HTML) {
      onText(getSlice(start, end), start, end)
    } else {
      emitError(ErrorCodes.CDATA_IN_HTML_CONTENT, start - 9)
    }
  },

  onprocessinginstruction(start) {
    // ignore as we do not have runtime handling for this, only check error
    if ((stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML) {
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

function parseForExpression(
  input: SimpleExpressionNode,
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  const [, LHS, RHS] = inMatch

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

  const result: ForParseResult = {
    source: createAliasExpression(RHS.trim(), exp.indexOf(RHS, LHS.length)),
    value: undefined,
    key: undefined,
    index: undefined,
    finalized: false,
  }

  let valueContent = LHS.trim().replace(stripParensRE, '').trim()
  const trimmedOffset = LHS.indexOf(valueContent)

  const iteratorMatch = valueContent.match(forIteratorRE)
  if (iteratorMatch) {
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined
    if (keyContent) {
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      result.key = createAliasExpression(keyContent, keyOffset, true)
    }

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

  if (valueContent) {
    result.value = createAliasExpression(valueContent, trimmedOffset, true)
  }

  return result
}

function getSlice(start: number, end: number) {
  return currentInput.slice(start, end)
}

function endOpenTag(end: number) {
  if (tokenizer.inSFCRoot) {
    // in SFC mode, generate locations for root-level tags' inner content.
    currentOpenTag!.innerLoc = getLoc(end + 1, end + 1)
  }
  addNode(currentOpenTag!)
  const { tag, ns } = currentOpenTag!
  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    inPre++
  }
  if (currentOptions.isVoidTag(tag)) {
    onCloseTag(currentOpenTag!, end)
  } else {
    stack.unshift(currentOpenTag!)
    if (ns === Namespaces.SVG || ns === Namespaces.MATH_ML) {
      tokenizer.inXML = true
    }
  }
  currentOpenTag = null
}

function onText(content: string, start: number, end: number) {
  if (__BROWSER__) {
    const tag = stack[0] && stack[0].tag
    if (tag !== 'script' && tag !== 'style' && content.includes('&')) {
      content = currentOptions.decodeEntities!(content, false)
    }
  }
  const parent = stack[0] || currentRoot
  const lastNode = parent.children[parent.children.length - 1]
  if (lastNode && lastNode.type === NodeTypes.TEXT) {
    // merge
    lastNode.content += content
    setLocEnd(lastNode.loc, end)
  } else {
    parent.children.push({
      type: NodeTypes.TEXT,
      content,
      loc: getLoc(start, end),
    })
  }
}

function onCloseTag(el: ElementNode, end: number, isImplied = false) {
  // attach end position
  if (isImplied) {
    // implied close, end should be backtracked to close
    setLocEnd(el.loc, backTrack(end, CharCodes.Lt))
  } else {
    setLocEnd(el.loc, lookAhead(end, CharCodes.Gt) + 1)
  }

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
  if (!tokenizer.inRCDATA) {
    el.children = condenseWhitespace(children, tag)
  }

  if (ns === Namespaces.HTML && currentOptions.isIgnoreNewlineTag(tag)) {
    // remove leading newline for <textarea> and <pre> per html spec
    // https://html.spec.whatwg.org/multipage/parsing.html#parsing-main-inbody
    const first = children[0]
    if (first && first.type === NodeTypes.TEXT) {
      first.content = first.content.replace(/^\r?\n/, '')
    }
  }

  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    inPre--
  }
  if (currentVPreBoundary === el) {
    inVPre = tokenizer.inVPre = false
    currentVPreBoundary = null
  }
  if (
    tokenizer.inXML &&
    (stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML
  ) {
    tokenizer.inXML = false
  }

  // 2.x compat / deprecation checks
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

function lookAhead(index: number, c: number) {
  let i = index
  while (currentInput.charCodeAt(i) !== c && i < currentInput.length - 1) i++
  return i
}

function backTrack(index: number, c: number) {
  let i = index
  while (currentInput.charCodeAt(i) !== c && i >= 0) i--
  return i
}

const specialTemplateDir = new Set(['if', 'else', 'else-if', 'for', 'slot'])
function isFragmentTemplate({ tag, props }: ElementNode): boolean {
  if (tag === 'template') {
    for (let i = 0; i < props.length; i++) {
      if (
        props[i].type === NodeTypes.DIRECTIVE &&
        specialTemplateDir.has((props[i] as DirectiveNode).name)
      ) {
        return true
      }
    }
  }
  return false
}

function isComponent({ tag, props }: ElementNode): boolean {
  if (currentOptions.isCustomElement(tag)) {
    return false
  }
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
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.name === 'is' && p.value) {
        if (p.value.content.startsWith('vue:')) {
          return true
        } else if (
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
  return false
}

function isUpperCase(c: number) {
  return c > 64 && c < 91
}

const windowsNewlineRE = /\r\n/g
function condenseWhitespace(
  nodes: TemplateChildNode[],
  tag?: string,
): TemplateChildNode[] {
  const shouldCondense = currentOptions.whitespace !== 'preserve'
  let removedWhitespace = false
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type === NodeTypes.TEXT) {
      if (!inPre) {
        if (isAllWhitespace(node.content)) {
          const prev = nodes[i - 1] && nodes[i - 1].type
          const next = nodes[i + 1] && nodes[i + 1].type
          // Remove if:
          // - the whitespace is the first or last node, or:
          // - (condense mode) the whitespace is between two comments, or:
          // - (condense mode) the whitespace is between comment and element, or:
          // - (condense mode) the whitespace is between two elements AND contains newline
          if (
            !prev ||
            !next ||
            (shouldCondense &&
              ((prev === NodeTypes.COMMENT &&
                (next === NodeTypes.COMMENT || next === NodeTypes.ELEMENT)) ||
                (prev === NodeTypes.ELEMENT &&
                  (next === NodeTypes.COMMENT ||
                    (next === NodeTypes.ELEMENT &&
                      hasNewlineChar(node.content))))))
          ) {
            removedWhitespace = true
            nodes[i] = null as any
          } else {
            // Otherwise, the whitespace is condensed into a single space
            node.content = ' '
          }
        } else if (shouldCondense) {
          // in condense mode, consecutive whitespaces in text are condensed
          // down to a single space.
          node.content = condense(node.content)
        }
      } else {
        // #6410 normalize windows newlines in <pre>:
        // in SSR, browsers normalize server-rendered \r\n into a single \n
        // in the DOM
        node.content = node.content.replace(windowsNewlineRE, '\n')
      }
    }
  }
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

function isAllWhitespace(str: string) {
  for (let i = 0; i < str.length; i++) {
    if (!isWhitespace(str.charCodeAt(i))) {
      return false
    }
  }
  return true
}

function hasNewlineChar(str: string) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c === CharCodes.NewLine || c === CharCodes.CarriageReturn) {
      return true
    }
  }
  return false
}

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

function addNode(node: TemplateChildNode) {
  ;(stack[0] || currentRoot).children.push(node)
}

function getLoc(start: number, end?: number): SourceLocation {
  return {
    start: tokenizer.getPos(start),
    // @ts-expect-error allow late attachment
    end: end == null ? end : tokenizer.getPos(end),
    // @ts-expect-error allow late attachment
    source: end == null ? end : getSlice(start, end),
  }
}

export function cloneLoc(loc: SourceLocation): SourceLocation {
  return getLoc(loc.start.offset, loc.end.offset)
}

function setLocEnd(loc: SourceLocation, end: number) {
  loc.end = tokenizer.getPos(end)
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
