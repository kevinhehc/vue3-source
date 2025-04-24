/**
 * This Tokenizer is adapted from htmlparser2 under the MIT License listed at
 * https://github.com/fb55/htmlparser2/blob/master/LICENSE

Copyright 2010, 2011, Chris Winberry <chris@winberry.net>. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
 */

import { ErrorCodes } from './errors'
import type { ElementNode, Position } from './ast'

/**
 * Note: entities is a non-browser-build-only dependency.
 * In the browser, we use an HTML element to do the decoding.
 * Make sure all imports from entities are only used in non-browser branches
 * so that it can be properly treeshaken.
 */
import {
  DecodingMode,
  EntityDecoder,
  fromCodePoint,
  htmlDecodeTree,
} from 'entities/lib/decode.js'

export enum ParseMode {
  BASE,
  HTML,
  SFC,
}

export enum CharCodes {
  Tab = 0x9, // "\t"
  NewLine = 0xa, // "\n"
  FormFeed = 0xc, // "\f"
  CarriageReturn = 0xd, // "\r"
  Space = 0x20, // " "
  ExclamationMark = 0x21, // "!"
  Number = 0x23, // "#"
  Amp = 0x26, // "&"
  SingleQuote = 0x27, // "'"
  DoubleQuote = 0x22, // '"'
  GraveAccent = 96, // "`"
  Dash = 0x2d, // "-"
  Slash = 0x2f, // "/"
  Zero = 0x30, // "0"
  Nine = 0x39, // "9"
  Semi = 0x3b, // ";"
  Lt = 0x3c, // "<"
  Eq = 0x3d, // "="
  Gt = 0x3e, // ">"
  Questionmark = 0x3f, // "?"
  UpperA = 0x41, // "A"
  LowerA = 0x61, // "a"
  UpperF = 0x46, // "F"
  LowerF = 0x66, // "f"
  UpperZ = 0x5a, // "Z"
  LowerZ = 0x7a, // "z"
  LowerX = 0x78, // "x"
  LowerV = 0x76, // "v"
  Dot = 0x2e, // "."
  Colon = 0x3a, // ":"
  At = 0x40, // "@"
  LeftSquare = 91, // "["
  RightSquare = 93, // "]"
}

const defaultDelimitersOpen = new Uint8Array([123, 123]) // "{{"
const defaultDelimitersClose = new Uint8Array([125, 125]) // "}}"

/** All the states the tokenizer can be in. */
// Vue 编译器中 模板词法分析器（tokenizer） 的状态枚举定义：State。
// 这是一个非常核心的枚举，用于驱动 HTML 模板的逐字符扫描过程，控制当前字符所在的上下文状态，从而判断该怎么解析下一个字符。
//
// State 枚举定义了词法解析器（tokenizer）在解析 <template> 时可能处于的所有解析状态，用于细致区分标签、指令、属性、插值、注释等场景。
//
// HTML 模板不是行级语言，而是结构嵌套语言，且 Vue 又有自定义扩展语法（如 v-if, {{ msg }}，:foo），所以 Vue 的 tokenizer 必须是一个基于状态的有限状态机（FSM）。
export enum State {
  //  基本文本内容
  Text = 1, // 默认状态，表示在文本节点中（如 <div>Hello</div> 中的 Hello）。当遇到 < 或 {{ 会切换状态。

  // interpolation 插值表达式处理 {{ msg }}
  InterpolationOpen, // 发现 {{ 后进入此状态，准备解析插值表达式
  Interpolation, // 处于 {{ 与 }} 之间，解析表达式内容，如 msg + 1
  InterpolationClose, // 发现 }} 后进入此状态，表示插值表达式结束

  // Tags 标签解析相关 <div>, </div>
  BeforeTagName, // After < .  读到 < 后进入，准备读取标签名
  InTagName, // 正在解析标签名（如 div、my-component）
  InSelfClosingTag, // 读到 /> 时进入，表示标签自闭合
  BeforeClosingTagName, // 遇到 </ 后准备读取关闭标签名
  InClosingTagName, // 正在解析关闭标签名（如 </div>）
  AfterClosingTagName, // 关闭标签名解析完毕，准备跳到文本或下一个节点

  // Attrs 属性与指令名解析（如 class="x", v-bind:foo）
  BeforeAttrName, // 准备解析下一个属性名或指令名
  InAttrName, // 正在解析常规属性名，如 class、id
  InDirName, // 正在解析指令名，如 v-bind、v-if（v-后）
  InDirArg, // 指令参数，如 v-bind:foo 中的 foo
  InDirDynamicArg, // 动态参数，如 v-bind:[foo] 中的 foo
  InDirModifier, // 指令修饰符，如 v-on:click.stop.prevent 中的 .stop
  AfterAttrName, // 属性名结束，等待 = 或下一个属性名

  //  属性值解析（支持 "...", '...', 不加引号）
  BeforeAttrValue, // 遇到 = 后，准备读取属性值
  InAttrValueDq, // "     使用双引号包裹的值，如 "foo"
  InAttrValueSq, // '   使用单引号包裹的值，如 'foo'
  InAttrValueNq, //  未加引号的值，如 checked、true、foo.bar

  // Declarations HTML 特殊声明解析（如 DOCTYPE）
  BeforeDeclaration, // !      读到 <! 后进入，判断是否是声明/注释
  InDeclaration, // 正在解析 <!DOCTYPE html> 等

  // Processing instructions 处理指令（HTML 中的 <?xml ... ?>）
  InProcessingInstruction, // ?     少见，仅处理 <?...?> 结构，如 XML 声明

  // Comments & CDATA 注释 & CDATA 支持
  BeforeComment, // 遇到 <!-- 时进入，准备读取注释内容
  CDATASequence, // 特殊注释结构，如 <!--[if IE]>（兼容 IE）
  InSpecialComment, // 普通 HTML 注释内容，直到遇到 -->
  InCommentLike, // <![CDATA[ 开始后的内容（用于 SVG / XML 中嵌套）

  // Special tags 特殊标签结构（script / style / title / textarea）
  BeforeSpecialS, // Decide if we deal with `<script` or `<style`    // 遇到 <s 时，需要判断是否是 <script> 或 <style>
  BeforeSpecialT, // Decide if we deal with `<title` or `<textarea` // 遇到 <t 时，判断是否是 <title> 或 <textarea>
  SpecialStartSequence, // 开始读取 <script>/<style> 内容的状态
  InRCDATA, // 特殊标签中的内容，不识别 HTML 标签，如 <textarea>hello</textarea>

  //  HTML 实体解析（如 &amp;）
  InEntity, // 正在读取实体结构，例如 &nbsp;、&#x3C;，用于解析为字符

  // Vue SFC 模式（特例）
  InSFCRootTagName, // 用于解析 .vue 文件中 <template> 标签的根节点名（只在 SFC 模式下使用）
}

/**
 * HTML only allows ASCII alpha characters (a-z and A-Z) at the beginning of a
 * tag name.
 *
 * HTML 标签名的第一个字符只能是 ASCII 字母（大小写皆可），也就是 a-z 或 A-Z
 */
function isTagStartChar(c: number): boolean {
  return (
    (c >= CharCodes.LowerA && c <= CharCodes.LowerZ) ||
    (c >= CharCodes.UpperA && c <= CharCodes.UpperZ)
  )
}

// 判断某个字符是否是“空白字符”，比如空格、换行、制表符等。这个函数在词法分析（tokenizer）中经常被用来跳过或压缩不必要的空白。
export function isWhitespace(c: number): boolean {
  return (
    c === CharCodes.Space ||
    c === CharCodes.NewLine ||
    c === CharCodes.Tab ||
    c === CharCodes.FormFeed ||
    c === CharCodes.CarriageReturn
  )
}

// 判断当前字符是否标志着“标签结构部分（如标签名、属性名）已经结束”，也就是：当前字符是 /、> 或空白字符时，标签的当前部分应当收尾了。
function isEndOfTagSection(c: number): boolean {
  // 字符	含义
  // /	    自闭合标签（如 <br/>）
  // >	    标签闭合（如 <div>）
  // 空格	后面有属性名（如 <div class="a">）
  return c === CharCodes.Slash || c === CharCodes.Gt || isWhitespace(c)
}

// 将字符串转换成一个 Uint8Array，其每一项是该字符串中字符的 ASCII 编码（Unicode 编码的低 8 位）。
// 这个函数主要用于模板解析器中的插值符号（如 {{, }}）处理，用以高效比对字符序列。
export function toCharCodes(str: string): Uint8Array {
  const ret = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    ret[i] = str.charCodeAt(i)
  }
  return ret
}

// 处理 HTML 属性值引号类型 的枚举类型
export enum QuoteType {
  NoValue = 0, // 没有属性值，例如 <input disabled>
  Unquoted = 1, // 没有引号的值，例如 <input value=123>
  Single = 2, // 单引号包裹，例如 <input value='abc'>
  Double = 3, // 双引号包裹，例如 <input value="abc">
}

//  tokenizer（词法分析器）层的回调接口定义
export interface Callbacks {
  // 普通文本内容（非插值）	<div>Hello</div> → "Hello"
  ontext(start: number, endIndex: number): void
  // 遇到 HTML 实体（如 &amp;）	&lt; → <
  ontextentity(char: string, start: number, endIndex: number): void

  // 插值表达式	{{ msg }}
  oninterpolation(start: number, endIndex: number): void

  // 标签名起始	<div> 中的 div
  onopentagname(start: number, endIndex: number): void
  // 标签名后（属性前或闭合）	<div>、<div class="x">
  onopentagend(endIndex: number): void
  // 自闭合标签结束	<img />
  onselfclosingtag(endIndex: number): void
  // 闭合标签	</div>
  onclosetag(start: number, endIndex: number): void

  // 属性值内容	"a"、'a'、a
  onattribdata(start: number, endIndex: number): void
  // 属性值中遇到 HTML 实体	&gt;
  onattribentity(char: string, start: number, end: number): void
  // 属性结束	"、' 或空格后
  onattribend(quote: QuoteType, endIndex: number): void
  // 属性名开始	class="a" → class
  onattribname(start: number, endIndex: number): void
  // 属性名结束	class后
  onattribnameend(endIndex: number): void

  // 指令名起始，如 v-bind, v-if
  ondirname(start: number, endIndex: number): void
  // 指令参数，如 v-bind:foo 中的 foo
  ondirarg(start: number, endIndex: number): void
  // 指令修饰符，如 .stop、.prevent
  ondirmodifier(start: number, endIndex: number): void

  // 注释	<!-- comment -->
  oncomment(start: number, endIndex: number): void
  // CDATA 块	<![CDATA[ ... ]]>
  oncdata(start: number, endIndex: number): void

  // XML 指令	<?xml ... ?>
  onprocessinginstruction(start: number, endIndex: number): void
  // ondeclaration(start: number, endIndex: number): void
  // 模板解析完成	调用结束
  onend(): void
  // 发生解析错误	调用 emitError(...)
  onerr(code: ErrorCodes, index: number): void
}

/**
 * Sequences used to match longer strings.
 *
 * We don't have `Script`, `Style`, or `Title` here. Instead, we re-use the *End
 * sequences with an increased offset.
 */
// 存储一组关键结构的字符序列（作为 Uint8Array），用于 tokenizer 进行高效的多字符匹配，比如判断是否遇到 </script>、-->、<![CDATA[ 等特殊结束标记。
export const Sequences: {
  Cdata: Uint8Array
  CdataEnd: Uint8Array
  CommentEnd: Uint8Array
  ScriptEnd: Uint8Array
  StyleEnd: Uint8Array
  TitleEnd: Uint8Array
  TextareaEnd: Uint8Array
} = {
  Cdata: new Uint8Array([0x43, 0x44, 0x41, 0x54, 0x41, 0x5b]), // CDATA[
  CdataEnd: new Uint8Array([0x5d, 0x5d, 0x3e]), // ]]>
  CommentEnd: new Uint8Array([0x2d, 0x2d, 0x3e]), // `-->`
  ScriptEnd: new Uint8Array([0x3c, 0x2f, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74]), // `</script`
  StyleEnd: new Uint8Array([0x3c, 0x2f, 0x73, 0x74, 0x79, 0x6c, 0x65]), // `</style`
  TitleEnd: new Uint8Array([0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65]), // `</title`
  TextareaEnd: new Uint8Array([
    0x3c, 0x2f, 116, 101, 120, 116, 97, 114, 101, 97,
  ]), // `</textarea
}

export default class Tokenizer {
  /** The current state the tokenizer is in. */
  /** 当前词法分析器所处的状态（文本、标签、指令等） */
  public state: State = State.Text

  /** The read buffer. */
  // 模板字符串内容，如 <div>{{ msg }}</div>
  private buffer = ''

  /** The beginning of the section that is currently being read. */
  // 用于标记 ontext、onopentagname、onattribdata 等的起点位置
  public sectionStart = 0

  /** The index within the buffer that we are currently looking at. */
  /** 当前读取位置（字符索引） */
  // 每次读取字符时会 index++，是主循环的指针
  private index = 0

  /** The start of the last entity. */
  /** HTML 实体（如 &gt;）的起点位置 */
  private entityStart = 0

  /** Some behavior, eg. when decoding entities, is done while we are in another state. This keeps track of the other state type. */
  /** 实体解码时，词法分析器原本的状态，用于临时切换回来 */
  // 在解析 &amp; 时，临时跳转状态 → 解析完毕后要回到原始状态
  private baseState = State.Text

  /** For special parsing behavior inside of script and style tags. */
  // 特殊标签与模式处理
  // 是否处于 RCDATA 模式（如 <textarea>, <title>），会限制标签解析行为（允许内容中出现 <）
  public inRCDATA = false

  /** For disabling RCDATA tags handling */
  // 是否以 XML 方式解析（如 SVG、MathML），跳过特殊规则，比如不自动关闭标签
  public inXML = false

  /** For disabling interpolation parsing in v-pre */
  // 当前是否处于 v-pre 指令作用范围内，影响是否需要解析插值表达式（{{ msg }}）
  public inVPre = false

  /** Record newline positions for fast line / column calculation */
  // 新行记录（用于定位）
  // 记录换行符的位置，用于之后快速定位错误、构建 loc: SourceLocation
  private newlines: number[] = []

  // HTML 实体解析器
  // 在非浏览器构建中初始化
  // 用于将 &amp; 转换为 &，&#x3C; 转换为 <，避免写死规则
  private readonly entityDecoder?: EntityDecoder

  // 当前解析模式：BASE、SFC、HTML 影响解析方式
  public mode: ParseMode = ParseMode.BASE

  // 如果当前处于 SFC 模式，且 stack 为空 → 说明正在解析 SFC 的根节点 <template>...</template>
  public get inSFCRoot(): boolean {
    return this.mode === ParseMode.SFC && this.stack.length === 0
  }

  // 接收标签栈 stack（用于嵌套结构）
  // 回调集合 cbs（用于通知 parser 构造 AST）
  // 如果在非浏览器环境，初始化实体解码器 EntityDecoder
  constructor(
    private readonly stack: ElementNode[],
    private readonly cbs: Callbacks,
  ) {
    // 在非浏览器环境（如 Node.js）下，创建 EntityDecoder
    // 使用 htmlDecodeTree（包含所有 HTML 实体的解码表，如 &lt;, &amp; 等）
    // 当发现 & 开头的实体时，会调用 emitCodePoint(cp, consumed) 将其转为字符
    if (!__BROWSER__) {
      this.entityDecoder = new EntityDecoder(htmlDecodeTree, (cp, consumed) =>
        this.emitCodePoint(cp, consumed),
      )
    }
  }

  public reset(): void {
    this.state = State.Text // 默认从文本状态开始
    this.mode = ParseMode.BASE // 基础解析模式
    this.buffer = '' // 清空输入缓冲
    this.sectionStart = 0 // 当前结构起点清空
    this.index = 0 // 当前指针位置清空
    this.baseState = State.Text // 实体解析前状态
    this.inRCDATA = false // 非特殊标签模式
    this.currentSequence = undefined! // 取消特殊序列匹配状态
    this.newlines.length = 0 // 清空换行位置记录
    this.delimiterOpen = defaultDelimitersOpen // 恢复默认插值定界符 {{
    this.delimiterClose = defaultDelimitersClose // 恢复默认插值定界符 }}
  }

  /**
   * Generate Position object with line / column information using recorded
   * newline positions. We know the index is always going to be an already
   * processed index, so all the newlines up to this index should have been
   * recorded.
   */
  // 获取源码位置信息
  public getPos(index: number): Position {
    let line = 1
    let column = index + 1
    for (let i = this.newlines.length - 1; i >= 0; i--) {
      const newlineIndex = this.newlines[i]
      if (index > newlineIndex) {
        line = i + 2 // 当前行 = 最后一个换行 + 1
        column = index - newlineIndex // 列号 = 当前字符距离该行起点的偏移
        break
      }
    }
    return {
      column, // 当前行中的列号，从 1 开始
      line, // 行号，从 1 开始
      offset: index, // 文件中第几个字符（从 0 开始）
    }
  }

  // 预读下一个字符
  // 获取当前扫描位置之后的一个字符（未移动位置）
  // 通常用于判断是否是 <, {{, -- 等两字符开始结构
  // tokenizer 中常用 char 和 peek() 配对：
  private peek() {
    return this.buffer.charCodeAt(this.index + 1)
  }

  private stateText(c: number): void {
    // 进入标签模式
    if (c === CharCodes.Lt) {
      // 如果在此之前存在文本（如 hello <div> 中的 hello）
      // 就触发 ontext() 回调通知 parser 抓取 [sectionStart, index] 的文本段
      if (this.index > this.sectionStart) {
        this.cbs.ontext(this.sectionStart, this.index)
      }
      // 切换状态为标签开始准备状态 BeforeTagName
      // 重设 sectionStart 为当前 < 的位置，供下一个结构使用
      this.state = State.BeforeTagName
      this.sectionStart = this.index
    } else if (!__BROWSER__ && c === CharCodes.Amp) {
      // 如果不是浏览器环境，且字符是 &（ASCII 38）
      // 准备进入 HTML 实体解析流程（如 &amp; → &）

      // 调用实体解析器（会处理 entityDecoder，解析后触发回调）
      this.startEntity()
    } else if (!this.inVPre && c === this.delimiterOpen[0]) {
      // 如果不在 v-pre 指令范围内（v-pre 区域跳过插值编译）
      // 并且当前字符是插值符号开头（默认 {{ → [123, 123]，所以第一个是 {）

      // 切换到 InterpolationOpen 状态，准备识别 {{ msg }}
      // 重置 delimiterIndex = 0，表示正在匹配第一个插值符号
      // 立即调用 stateInterpolationOpen() 继续匹配后续字符（如第二个 {）
      this.state = State.InterpolationOpen
      this.delimiterIndex = 0
      this.stateInterpolationOpen(c)
    }
  }

  // 插值表达式起始符（默认 {{）
  public delimiterOpen: Uint8Array = defaultDelimitersOpen
  // 插值表达式终止符（默认 }}）
  public delimiterClose: Uint8Array = defaultDelimitersClose
  // 插值符匹配进度（匹配第几个字符）
  private delimiterIndex = -1

  // 负责逐字符匹配插值起始符号（如 {{），成功后切换到 State.Interpolation 状态，失败则恢复回文本或特殊模式。
  private stateInterpolationOpen(c: number): void {
    // 检查当前字符是否与 delimiterOpen 中当前位置字符一致
    // 默认 delimiterOpen = [123, 123] → {{
    if (c === this.delimiterOpen[this.delimiterIndex]) {
      // 如果这是最后一个字符（如 {{ 的第二个 {）
      if (this.delimiterIndex === this.delimiterOpen.length - 1) {
        // 计算插值表达式的起始位置（跳过 {{）
        const start = this.index + 1 - this.delimiterOpen.length
        // 如果 {{ 之前还有文本（如 hello {{ msg }} 中的 hello），就发出 ontext() 回调
        if (start > this.sectionStart) {
          this.cbs.ontext(this.sectionStart, start)
        }
        // 成功进入插值内容状态
        // 设置 sectionStart 为表达式实际起点（例如 msg 的开头）
        this.state = State.Interpolation
        this.sectionStart = start
      } else {
        // 否则：继续匹配下一个字符
        // 匹配下一个 {（对于更长插值符如 [[ 也通用）
        this.delimiterIndex++
      }
    } else if (this.inRCDATA) {
      // 如果当前在 <textarea> 或 <title>（即 RCDATA）, 恢复为 RCDATA 状态，重新走那套逻辑
      this.state = State.InRCDATA
      this.stateInRCDATA(c)
    } else {
      // 不是插值起始，回退为普通文本
      this.state = State.Text
      this.stateText(c)
    }
  }

  // 插值表达式中间的状态处理器，负责检测是否遇到插值的结束符（通常是 }}），并开始匹配它。
  // 当前处于 State.Interpolation 状态
  // 正在处理插值表达式内容中间字符，如：{{ msg + 1 }} 中的 m, s, +, 1 等
  private stateInterpolation(c: number): void {
    // 默认情况下，插值结束符是 }}，其编码是 [125, 125]
    // delimiterClose[0] 是第一个 }（ASCII 125）
    // 如果遇到第一个 }，就准备进入关闭匹配状态
    if (c === this.delimiterClose[0]) {
      // 切换状态为 InterpolationClose，开始匹配 }}
      // 重置 delimiterIndex = 0，表示匹配第一个 } 成功
      // 立即调用 stateInterpolationClose(c) 来继续处理当前字符（可支持更长定界符如 ]]）
      this.state = State.InterpolationClose
      this.delimiterIndex = 0
      this.stateInterpolationClose(c)
    }
  }

  // 逐字符匹配插值表达式的结束定界符（默认 }}），匹配成功后触发 oninterpolation() 回调，并切换状态回 Text 或 RCDATA。
  private stateInterpolationClose(c: number) {
    // 默认 delimiterClose = [125, 125] → }}
    // 检查当前字符是否等于 }，并与 delimiterIndex 对应位置匹配
    if (c === this.delimiterClose[this.delimiterIndex]) {
      // 比如对 }} 来说，匹配到第二个 }（index = 1）
      if (this.delimiterIndex === this.delimiterClose.length - 1) {
        // 调用 oninterpolation(start, end)
        // sectionStart 是表达式起点（例如 {{ msg }} 中 m 的位置）
        // this.index + 1 是表达式结尾位置（包括 }}）
        this.cbs.oninterpolation(this.sectionStart, this.index + 1)
        // 如果当前是在 <textarea>、<title> 等 RCDATA 标签中，切回 RCDATA 状态
        // 否则切回普通文本状态 Text
        if (this.inRCDATA) {
          this.state = State.InRCDATA
        } else {
          this.state = State.Text
        }
        // 更新起点，供下一个文本节点或结构使用
        this.sectionStart = this.index + 1
      } else {
        // 匹配成功一部分，比如对 }}} 来说，还要匹配第三个
        // 继续保持 InterpolationClose 状态，等待下一个字符
        this.delimiterIndex++
      }
    } else {
      // 如果当前字符不匹配 → 回退到 State.Interpolation
      // 重新将这个字符当作表达式内容处理（可能是误判，比如 msg }+ 1 }}）
      this.state = State.Interpolation
      this.stateInterpolation(c)
    }
  }

  // 当前要匹配的标签名序列（如 script, style） 进入 State.SpecialStartSequence 状态时已经被设置好
  public currentSequence: Uint8Array = undefined!
  // 当前匹配到的位置索引 进入 State.SpecialStartSequence 状态时已经被设置好
  private sequenceIndex = 0
  // 逐字符匹配特定标签名，确认是否为 <script>、<style> 等 RCDATA 类型标签，如果完全匹配，则设置 inRCDATA = true，进入对应的解析模式。
  private stateSpecialStartSequence(c: number): void {
    // 当前已经匹配到了标签名末尾
    const isEnd = this.sequenceIndex === this.currentSequence.length

    // isEndOfTagSection(c)：判断当前字符是否是标签结束信号（如 >, /, 空格）
    // (c | 0x20)：这是一个小技巧，让大写字母变小写（ASCII 码位），实现 大小写不敏感匹配
    const isMatch = isEnd
      ? // If we are at the end of the sequence, make sure the tag name has ended
        isEndOfTagSection(c)
      : // Otherwise, do a case-insensitive comparison
        (c | 0x20) === this.currentSequence[this.sequenceIndex]

    // 如果不匹配，说明不是 <script> 等特殊标签 → 取消 RCDATA 模式
    if (!isMatch) {
      this.inRCDATA = false
    } else if (!isEnd) {
      // 正在匹配 s, c, r, i... 直到 t
      // 没匹配完，就递增索引，继续等待下一个字符
      this.sequenceIndex++
      return
    }

    // 匹配成功并结束：
    // 完全匹配了标签名（并检查了闭合标志），进入 InTagName 状态
    // 开始处理 <script> 或 <style> 后续的属性等内容
    this.sequenceIndex = 0
    this.state = State.InTagName
    this.stateInTagName(c)
  }

  /** Look for an end tag. For <title> and <textarea>, also decode entities. */
  // 在特殊标签中（RCDATA 模式）查找闭合标签（如 </script>），并在 <title>、<textarea> 标签中处理插值 ({{ msg }}) 和 HTML 实体（如 &gt;）。
  // stateInRCDATA() 负责处理 <script>/<style>/<title>/<textarea> 标签内部内容，寻找 `</` 结尾标志并触发 ontext 回调，同时支持实体解码和插值识别。
  private stateInRCDATA(c: number): void {
    //  判断是否已经匹配到标签名末尾
    // 当前匹配到 </script>、</style> 等的末尾了
    // 注意：这里的 currentSequence 是 script、style 等字节数组（不含 </）
    if (this.sequenceIndex === this.currentSequence.length) {
      // 如果下一个字符是 >，说明闭合标签完整（例如 </script>）
      // 空格也是合法闭合标签的部分（比如 </script >）
      if (c === CharCodes.Gt || isWhitespace(c)) {
        const endOfText = this.index - this.currentSequence.length

        if (this.sectionStart < endOfText) {
          // 把 <script> 中的内容作为普通文本发出
          // 例如 <script>console.log(1)</script> 中的 console.log(1) → ontext
          // Spoof the index so that reported locations match up.
          const actualIndex = this.index
          this.index = endOfText
          this.cbs.ontext(this.sectionStart, endOfText)
          this.index = actualIndex
        }

        // 跳过 `</`
        // 准备读取关闭标签名（进入 InClosingTagName 状态）
        // 关闭 RCDATA 模式
        this.sectionStart = endOfText + 2 // Skip over the `</`
        this.stateInClosingTagName(c)
        this.inRCDATA = false
        return // We are done; skip the rest of the function.
      }
      // 匹配失败（还没完整匹配标签名）重置索引
      this.sequenceIndex = 0
    }

    // 逐字符大小写不敏感地匹配：</ScRiPt> 也被接受
    if ((c | 0x20) === this.currentSequence[this.sequenceIndex]) {
      this.sequenceIndex += 1
    } else if (this.sequenceIndex === 0) {
      // 如果当前在 <title> 或 <textarea> 标签，并且匹配中断
      if (
        this.currentSequence === Sequences.TitleEnd ||
        (this.currentSequence === Sequences.TextareaEnd && !this.inSFCRoot)
      ) {
        // We have to parse entities in <title> and <textarea> tags.
        // 处理 HTML 实体
        // 在 <title> 和 <textarea> 中，需要支持 &gt; → > 的解析
        // 实体处理只在非浏览器（服务端编译）中进行
        if (!__BROWSER__ && c === CharCodes.Amp) {
          this.startEntity()
        } else if (!this.inVPre && c === this.delimiterOpen[0]) {
          // 处理插值表达式（仅非 v-pre）

          // We also need to handle interpolation
          // 插值表达式如 {{ msg }} 是可以在 <textarea>/<title> 中出现的
          // 所以这里转入 InterpolationOpen 状态继续匹配
          this.state = State.InterpolationOpen
          this.delimiterIndex = 0
          this.stateInterpolationOpen(c)
        }
      } else if (this.fastForwardTo(CharCodes.Lt)) {
        // 如果当前不在 <title> 或 <textarea>，且字符不是 entity/interpolation，就快速跳过无效字符
        // Outside of <title> and <textarea> tags, we can fast-forward.

        // 尝试快速定位下一个 <，加速结束标签匹配过程
        // 如果找到了，就假设是新一轮的 </，从第一个字符重新匹配
        this.sequenceIndex = 1
      }
    } else {
      // If we see a `<`, set the sequence index to 1; useful for eg. `<</script>`.
      // 特殊情况 <</script>：重新设定 sequenceIndex = 1
      // 例如 <<script>，第一个 < 被错识别为文本，第二个 < 应该用于起始匹配
      // 所以重设匹配索引为 1，仅当当前字符是 < 时
      this.sequenceIndex = Number(c === CharCodes.Lt)
    }
  }

  // 用于匹配 <![CDATA[，匹配成功后转入 CDATA 内容状态，失败则转回通用声明状态。
  // CDATA 是 Character Data 的缩写
  // 通常出现在 XML、SVG 中，表示：
  // "这里的内容不要解析为标签、实体，只保留原始文本"
  private stateCDATASequence(c: number): void {
    // Sequences.Cdata 是一个 Uint8Array，表示字符序列 [0x43, 0x44, 0x41, 0x54, 0x41, 0x5b] → CDATA[
    // 当前 c 是否等于当前目标字符
    if (c === Sequences.Cdata[this.sequenceIndex]) {
      // 累加索引
      // 如果已经匹配完整个 CDATA[ 序列
      if (++this.sequenceIndex === Sequences.Cdata.length) {
        // 转入 State.InCommentLike（这里复用评论状态来读取 CDATA 内容）
        // 设置目标为 ]]>（CDATA 的结束标志）
        // 记录 sectionStart 作为 CDATA 内容的起点
        this.state = State.InCommentLike
        this.currentSequence = Sequences.CdataEnd
        this.sequenceIndex = 0
        this.sectionStart = this.index + 1
      }
    } else {
      // 匹配失败：转回声明状态

      // 如果当前字符不匹配 CDATA 目标字符
      // 放弃匹配，退回到 <!...> 的声明通用处理状态
      // 重新处理当前字符（不是跳过，而是重投喂）
      this.sequenceIndex = 0
      this.state = State.InDeclaration
      this.stateInDeclaration(c) // Reconsume the character
    }
  }

  /**
   * When we wait for one specific character, we can speed things up
   * by skipping through the buffer until we find it.
   *
   * @returns Whether the character was found.
   *
   * 是一个高性能扫描函数，用于跳过不需要逐字符分析的部分，直到找到指定字符位置。
   */
  private fastForwardTo(c: number): boolean {
    // 每次自增 this.index，从当前位置继续扫描字符流
    while (++this.index < this.buffer.length) {
      // 当前字符的编码
      const cc = this.buffer.charCodeAt(this.index)

      // 如果是换行符（\n），就记录位置
      // 供后续构建 Position 使用（行列信息）
      if (cc === CharCodes.NewLine) {
        this.newlines.push(this.index)
      }
      if (cc === c) {
        // 如果当前字符就是我们想找的，比如 < → 找到就提前结束
        return true
      }
    }

    /*
     * We increment the index at the end of the `parse` loop,
     * so set it to `buffer.length - 1` here.
     *
     * TODO: Refactor `parse` to increment index before calling states.
     */
    // 将索引手动设为最后一个字符位置（因为外层 parse() 还会 ++index）
    this.index = this.buffer.length - 1

    // 没找到目标字符，返回 false
    return false
  }

  /**
   * Comments and CDATA end with `-->` and `]]>`.
   *
   * Their common qualities are:
   * - Their end sequences have a distinct character they start with.
   * - That character is then repeated, so we have to check multiple repeats.
   * - All characters but the start character of the sequence can be skipped.
   */
  // 处理注释 (<!-- ... -->) 和 CDATA (<![CDATA[ ... ]]>) 的状态函数：stateInCommentLike()。
  // 匹配 HTML 注释 --> 和 CDATA ]]> 的状态逻辑，匹配成功后触发 oncomment() 或 oncdata() 回调。
  private stateInCommentLike(c: number): void {
    // 判断当前字符是否匹配结束序列中的某一位
    // --> 逐字符匹配 -、-、>
    // ]]> 匹配 ]、]、>
    if (c === this.currentSequence[this.sequenceIndex]) {
      // this.sequenceIndex++：推进匹配进度
      // 如果刚好匹配完最后一个字符
      if (++this.sequenceIndex === this.currentSequence.length) {
        // 调用回调：
        // CDATA：oncdata(start, end)
        // 注释：oncomment(start, end)
        // this.index - 2：因为 -->/]]> 是3个字符，但起点是闭合之前的部分
        if (this.currentSequence === Sequences.CdataEnd) {
          this.cbs.oncdata(this.sectionStart, this.index - 2)
        } else {
          this.cbs.oncomment(this.sectionStart, this.index - 2)
        }

        // 重置匹配状态
        // 切回文本状态，继续正常解析
        this.sequenceIndex = 0
        this.sectionStart = this.index + 1
        this.state = State.Text
      }
    } else if (this.sequenceIndex === 0) {
      // Fast-forward to the first character of the sequence
      // 匹配起点失败，快速跳过不必要字符
      // 如果还没开始匹配，就跳过当前无效字符
      // 快速扫描直到找到第一个有效字符（例如 - 或 ]）
      if (this.fastForwardTo(this.currentSequence[0])) {
        this.sequenceIndex = 1
      }
    } else if (c !== this.currentSequence[this.sequenceIndex - 1]) {
      // 中途匹配失败（但之前已有匹配）：

      // 如果匹配失败了，但前面曾有成功的字符（例如 --->）
      // 只要不是重复字符（例如 -- 后是 -），就重置匹配
      // Allow long sequences, eg. --->, ]]]>
      this.sequenceIndex = 0
    }
  }

  // 在解析到特殊标签（如 <script>）开头时调用的函数，用于设置 RCDATA 模式，并进入后续字符匹配状态。
  private startSpecial(sequence: Uint8Array, offset: number) {
    this.enterRCDATA(sequence, offset)
    this.state = State.SpecialStartSequence
  }

  public enterRCDATA(sequence: Uint8Array, offset: number): void {
    // 设置 this.currentSequence = sequence（如 script, style 等）
    // 设置 this.sequenceIndex = offset（比如如果已经识别了 <s，从 1 开始）
    // 设置 this.inRCDATA = true（启用 RCDATA 模式，内容将被视为纯文本）
    this.inRCDATA = true
    this.currentSequence = sequence
    this.sequenceIndex = offset
  }

  // 判断接下来 <... 是什么结构（标签名、声明、注释、特殊标签、闭合标签等），并进入相应的解析状态。
  private stateBeforeTagName(c: number): void {
    if (c === CharCodes.ExclamationMark) {
      // 进入 BeforeDeclaration 状态
      // sectionStart 更新为 ! 后一位（声明内容起点）
      this.state = State.BeforeDeclaration
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.Questionmark) {
      // 处理指令（如 XML 中的 <?xml ... ?>）
      // 进入处理指令解析状态
      // 设置内容起点位置
      this.state = State.InProcessingInstruction
      this.sectionStart = this.index + 1
    } else if (isTagStartChar(c)) {
      // 如果是合法标签名的首字符（a-zA-Z）
      // <div>、<title> 等正常标签开头

      // 标签名从当前位置开始
      this.sectionStart = this.index

      // BASE 模式：直接进入标签名状态，无需处理特殊标签
      if (this.mode === ParseMode.BASE) {
        // no special tags in base mode
        this.state = State.InTagName
      } else if (this.inSFCRoot) {
        // SFC 模式（单文件组件）：
        // 根层级中除了 <template> 都视为原始文本
        // <template lang="pug"> 也视为原始内容（RAWTEXT）

        // SFC mode + root level
        // - everything except <template> is RAWTEXT
        // - <template> with lang other than html is also RAWTEXT
        this.state = State.InSFCRootTagName
      } else if (!this.inXML) {
        // HTML 模式（非 XML）
        // HTML mode

        // t → title 或 textarea → 转入 BeforeSpecialT（RCDATA）
        // s → script 或 style → 转入 BeforeSpecialS（RAWTEXT）
        // - <script>, <style> RAWTEXT
        // - <title>, <textarea> RCDATA
        if (c === 116 /* t */) {
          this.state = State.BeforeSpecialT
        } else {
          this.state =
            c === 115 /* s */ ? State.BeforeSpecialS : State.InTagName
        }
      } else {
        // 其他 → 普通标签名
        // XML 模式不处理特殊标签，直接进入标签名状态
        this.state = State.InTagName
      }
    } else if (c === CharCodes.Slash) {
      //  闭合标签
      // 进入闭合标签名读取状态，比如 </div>
      this.state = State.BeforeClosingTagName
    } else {
      // 其他非法字符 → 恢复为文本状态
      // 如果 < 后是非法字符（如 <1abc>）
      //
      // 恢复为 Text 状态，并把 < 当成普通字符处理
      this.state = State.Text
      this.stateText(c)
    }
  }

  // 会持续读取标签名字符，直到遇到结束信号（如空格、>、/），然后调用 handleTagName() 来处理标签名的结束逻辑。
  private stateInTagName(c: number): void {
    if (isEndOfTagSection(c)) {
      this.handleTagName(c)
    }
  }

  //  SFC 模式下根层标签的标签名处理器。
  // 如果不是 <template>，它会将其内容视为原始文本并启用 RCDATA 模式，避免 Vue 编译器深入解析。
  private stateInSFCRootTagName(c: number): void {
    if (isEndOfTagSection(c)) {
      // 从缓冲区中截取标签名字符串，例如 pug, markdown, div
      const tag = this.buffer.slice(this.sectionStart, this.index)
      // 如果不是 <template>，进入 RCDATA 模式
      if (tag !== 'template') {
        // Vue 的 SFC 中，只有 <template> 是真正参与编译的模板标签
        // 其余如：
        // <pug> → 使用外部 pug loader 处理
        // <markdown> → markdown 插件处理
        // <div> → 非法使用，默认转为文本
        // 所以这里转入 RCDATA 模式，整个内容当作字符串保留

        // 设置当前目标关闭标签名（例如 </pug>）
        // 从头开始匹配，进入 RCDATA 模式
        this.enterRCDATA(toCharCodes(`</` + tag), 0)
      }
      this.handleTagName(c)
    }
  }

  // 截取 buffer 中的标签名字符串（从 sectionStart 到 index）
  // 检查是否是自定义标签、特殊标签、组件等
  // 通知 parser 回调 onopentagname() 等
  // 根据结束字符 c 设置下一个状态（如进入属性、判断是否自闭合等）
  private handleTagName(c: number) {
    this.cbs.onopentagname(this.sectionStart, this.index)
    this.sectionStart = -1
    this.state = State.BeforeAttrName
    this.stateBeforeAttrName(c)
  }

  // 用于解析 </ 后面的字符，判断关闭标签名是否合法，或是否是特殊结构（如注释、非法写法），并引导进入对应状态。
  // 例如
  // </div>
  // </ script>
  // </!DOCTYPE html>
  // </123abc>
  private stateBeforeClosingTagName(c: number): void {
    if (isWhitespace(c)) {
      // Ignore
      // 在 </ （</ 后跟空格）情况下，暂时什么也不做
      // 下一个字符会再调用这个函数处理
    } else if (c === CharCodes.Gt) {
      // 表示标签立即关闭，形如 </>，这是非法的（缺失结束标签名）
      if (__DEV__ || !__BROWSER__) {
        // 在开发或服务端模式下报错
        this.cbs.onerr(ErrorCodes.MISSING_END_TAG_NAME, this.index)
      }
      this.state = State.Text
      // Ignore
      // 恢复为文本状态，跳过错误闭合标签
      this.sectionStart = this.index + 1
    } else {
      // 其他情况：根据字符判断是合法标签名或特殊结构

      // 如果当前字符是合法的标签名起始字符（a-zA-Z）：
      // 进入 State.InClosingTagName
      // 准备读取标签名，比如 </div>
      //
      // 否则进入 State.InSpecialComment
      // 用于处理形如 </!DOCTYPE> 之类的非法写法或奇怪注释
      // 也可能是 <--、</?xml 等
      this.state = isTagStartChar(c)
        ? State.InClosingTagName
        : State.InSpecialComment
      this.sectionStart = this.index
    }
  }

  // 解析状态机中的一个状态处理函数，用于处理关闭标签名称的状态（如 </div 中的 div）。
  // 参数 c 是当前处理的字符的 Unicode 编码（一个整数）
  private stateInClosingTagName(c: number): void {
    // 如果当前字符是 >（即关闭标签的结束）或者是空白字符（如空格、换行等），说明关闭标签名称已经结束，可以进入下一个状态。
    if (c === CharCodes.Gt || isWhitespace(c)) {
      // 触发关闭标签的回调函数（callback），参数是 this.sectionStart 到 this.index 之间的内容，
      // 也就是标签名称的位置区间。比如：</div> 中 div 的起止位置。
      this.cbs.onclosetag(this.sectionStart, this.index)
      // 将 sectionStart 重置，表示当前已经处理完这个 tag name 片段。
      this.sectionStart = -1
      // 状态切换：从当前状态切换到 AfterClosingTagName，意味着关闭标签的名字已经解析完，接下来要处理 > 或其他结束逻辑。
      this.state = State.AfterClosingTagName
      // 立即调用下一个状态的处理函数，继续用当前字符 c 来处理可能存在的 > 或空白符等情况。
      this.stateAfterClosingTagName(c)
    }
  }

  // 解析器状态机中，在“关闭标签名之后”处理字符的逻辑。
  private stateAfterClosingTagName(c: number): void {
    // Skip everything until ">"
    // 跳过所有字符，直到遇到 >，表示关闭标签结束。
    if (c === CharCodes.Gt) {
      // 如果当前字符是 >（也就是关闭标签 </div> 中的 >）。

      // 将解析状态机的状态切换为 Text，表示关闭标签结束了，接下来可以回到正常的文本内容解析状态。
      this.state = State.Text
      // 设置新的 section 起点为当前字符的下一个位置，用于后续解析，比如记录下一段文本的开始位置。
      this.sectionStart = this.index + 1
    }
  }

  // 用于处理 起始标签内部，在属性名出现之前 的状态处理逻辑。
  private stateBeforeAttrName(c: number): void {
    if (c === CharCodes.Gt) {
      // 如果当前字符是 >，说明标签已经结束，比如 <div>。
      // 此时不再解析属性了。

      // 触发回调，表示标签已闭合。传入当前索引用于记录标签结束位置。
      this.cbs.onopentagend(this.index)

      // 判断是否处于 RCDATA 模式（如 <textarea> 或 <title> 的内容解析），是的话就切换到 InRCDATA 状态，否则切换到普通文本 Text 状态。
      if (this.inRCDATA) {
        this.state = State.InRCDATA
      } else {
        this.state = State.Text
      }
      // 设置 sectionStart 为下一个字符的位置，用于后续文本解析时知道起点。
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.Slash) {
      // 如果遇到 /，可能是自闭合标签（如 <input />）。

      // 切换状态为 InSelfClosingTag，准备处理自闭合标志。
      this.state = State.InSelfClosingTag
      if ((__DEV__ || !__BROWSER__) && this.peek() !== CharCodes.Gt) {
        // 如果在开发模式或者非浏览器环境下，且 / 后不是 >，说明语法可能有误，触发错误回调。
        // 这是一个合理性检查：例如 <div/abc> 是非法的。
        this.cbs.onerr(ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG, this.index)
      }
    } else if (c === CharCodes.Lt && this.peek() === CharCodes.Slash) {
      // 如果当前字符是 <，而下一个字符是 /，可能是误写的关闭标签开始（如 <div</p>）。
      // 注释说明：这种情况在标准 HTML 中可能是语法错误，但对 IDE 中实时输入非常实用，容错性强。
      // Vue 做了适配，支持编辑器场景下的“不完整标签”。

      // special handling for </ appearing in open tag state
      // this is different from standard HTML parsing but makes practical sense
      // especially for parsing intermediate input state in IDEs.

      // 结束当前标签，重新开始识别新的标签。
      this.cbs.onopentagend(this.index)
      this.state = State.BeforeTagName
      this.sectionStart = this.index
    } else if (!isWhitespace(c)) {
      // 如果不是空白字符（如空格、换行等），可能是属性名的开始。
      if ((__DEV__ || !__BROWSER__) && c === CharCodes.Eq) {
        // 如果遇到的是 =，这显然不应该作为属性名的开头，是语法错误，抛出错误。
        this.cbs.onerr(
          ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME,
          this.index,
        )
      }
      // 处理属性的起始逻辑，进入解析属性名和值的过程。
      this.handleAttrStart(c)
    }
  }

  // 处理标签属性（或指令）解析开始的关键函数。它是从 stateBeforeAttrName 状态触发，
  // 用于判断当前属性的类型（普通属性 or Vue 指令）并设置相应状态。
  private handleAttrStart(c: number) {
    if (c === CharCodes.LowerV && this.peek() === CharCodes.Dash) {
      // 如果当前字符是 'v' 且下一个字符是 '-'，那么这是一个 Vue 指令，比如 v-bind、v-if 等。

      // 将状态切换为 InDirName，表示现在要解析的是一个指令名（比如 bind, if）。
      // 设置 sectionStart 为当前位置，方便后续提取这个指令名。
      this.state = State.InDirName
      this.sectionStart = this.index
    } else if (
      c === CharCodes.Dot ||
      c === CharCodes.Colon ||
      c === CharCodes.At ||
      c === CharCodes.Number
    ) {
      // .：修饰符前缀，如 .stop
      // :：绑定语法 :href
      // @：事件绑定 @click
      // #（CharCodes.Number）：可能是 slot name（如 #header）

      // 回调通知“这是指令名”，即 :、@、. 等简写指令的前缀部分。
      // 通知位置是当前索引到下一个字符，用于框出 :、@ 等符号。
      this.cbs.ondirname(this.index, this.index + 1)

      //切换到 InDirArg 状态，表示接下来解析的是指令的参数部分（如 href、click、header）。
      // sectionStart 向后跳一格，跳过前缀符号。
      this.state = State.InDirArg
      this.sectionStart = this.index + 1
    } else {
      // 如果不是 Vue 指令相关的字符（不是 v-、:、@ 等），那就是普通属性，如 id、class、type 等。

      // 切换状态为 InAttrName，表示现在解析的是普通属性名。
      // 设置 sectionStart 为当前索引，开始记录属性名。
      this.state = State.InAttrName
      this.sectionStart = this.index
    }
  }

  // 用于处理 自闭合标签 的状态逻辑
  private stateInSelfClosingTag(c: number): void {
    if (c === CharCodes.Gt) {
      // 如果当前字符是 >，说明这个自闭合标签已经完整（比如 <input /> 的 / 后面跟着 >）。

      // 触发自闭合标签回调，比如 AST 构建时记录标签是自闭合的（与普通标签不同）。
      // 参数是当前字符的索引位置，用于定位这个自闭合标签在源码中的位置。
      this.cbs.onselfclosingtag(this.index)

      // 标签结束了，恢复为普通文本状态，继续处理标签后的文本内容。
      this.state = State.Text
      // 设置文本段的开始位置（从 > 之后开始），方便继续扫描文本节点。
      this.sectionStart = this.index + 1
      // 这里是关键处理：
      // inRCDATA 是指当前是否在 RCDATA 标签内（如 <textarea>、<title> 等），这些标签即使是自闭合也需要“关闭”这个特殊模式。
      // 一旦遇到 />，意味着 <textarea /> 这种标签不能再处于 RCDATA 状态了。
      this.inRCDATA = false // Reset special state, in case of self-closing special tags
    } else if (!isWhitespace(c)) {
      // 如果不是 >，并且也不是空白字符（比如不是 / > 中间的空格），那可能写错了，或者其实不是自闭合。

      // 重新回退到“属性名前”的状态，交给属性处理逻辑继续解析。
      // 举个例子：<img /src="..." > 中 / 被误识为自闭合标志，其实接着是属性名，就要处理回来。
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    }
  }

  // 处理 HTML 属性名称 状态的函数，用于处理属性名字符的收尾、校验错误等行为。
  // 它出现在解析 HTML 元素标签内部时，例如：
  // <input type="text">
  // 在解析 type 这个属性名的时候就会进入这个状态。
  private stateInAttrName(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      // 如果当前字符是等号 =，表示属性名读取结束，属性值即将开始；
      // 或者当前字符是标签的结束部分（例如 /, >），也说明属性名部分结束了。

      // 触发回调 onattribname，通知已经识别出一个属性名，范围是从 sectionStart 到当前索引 index。
      // 比如从 <input type="text"> 中识别出 type。
      this.cbs.onattribname(this.sectionStart, this.index)

      // 调用辅助函数，处理属性名之后的解析逻辑（比如处理 =, >，或决定是否进入下一个状态）。
      this.handleAttrNameEnd(c)
    } else if (
      // 如果当前是在开发模式或者非浏览器环境，并且当前字符是：
      // 双引号 ",
      // 单引号 ',
      // 小于号 <，
      // 这些都不是合法的属性名字符，因此要触发错误提示。
      (__DEV__ || !__BROWSER__) &&
      (c === CharCodes.DoubleQuote ||
        c === CharCodes.SingleQuote ||
        c === CharCodes.Lt)
    ) {
      // 触发错误回调，指出出现了非法字符，位置是当前索引。
      // 比如 <input "type"="text"> 中引号不应出现在属性名中，就会报这个错误。
      this.cbs.onerr(
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        this.index,
      )
    }
  }

  // 中用于处理 Vue 指令名（如 v-if、v-bind） 的状态逻辑。
  // 当解析器已经识别出指令前缀（如 v-）并进入指令名部分时（即 v-if 中的 if），就会使用这个状态来解析接下来的字符。
  private stateInDirName(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      // 如果当前字符是 =，说明指令名部分结束，即将进入属性值；
      // 或者遇到标签的结束（如 > 或 />）；
      // 总之：说明 指令名已经完整解析完成。

      // 调用回调函数 ondirname，告知已经识别出的指令名（如 if, bind, model 等），位置从 sectionStart 到 index。
      this.cbs.ondirname(this.sectionStart, this.index)

      // 转入处理属性名结束的逻辑（判断是属性赋值还是标签结束等）。
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.Colon) {
      // 如果当前字符是 :
      // 表示当前指令带有参数，进入指令参数解析，比如：
      // v-bind:href
      // v-on:click

      // 回调通知指令名识别完；
      // 切换状态为 InDirArg，开始解析参数（如 href, click）；
      // 更新起始索引，准备记录参数起始位置。
      this.cbs.ondirname(this.sectionStart, this.index)
      this.state = State.InDirArg
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.Dot) {
      // 如果遇到 .，说明出现修饰符，比如：
      // v-on:click.prevent
      // v-model.lazy

      // 回调通知指令名结束；
      // 切换状态为 InDirModifier，准备解析修饰符；
      // 更新 sectionStart 为修饰符开始处。
      this.cbs.ondirname(this.sectionStart, this.index)
      this.state = State.InDirModifier
      this.sectionStart = this.index + 1
    }
  }

  // 用于解析 Vue 指令的 参数部分，比如：
  // <input v-bind:placeholder="msg">
  // 参数就是 `placeholder`
  private stateInDirArg(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      // 如果遇到 =（说明参数部分结束，属性值即将开始），或者遇到标签结束（如 > 或 />）：

      // 触发回调 ondirarg，表示指令的参数已被解析出来，比如 placeholder、href、click 等；
      // 提交范围 [sectionStart, index)，用于提取参数文本。
      this.cbs.ondirarg(this.sectionStart, this.index)
      // 跳转到属性名结束处理逻辑，决定接下来是进入值解析还是标签结束。
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.LeftSquare) {
      // 如果当前字符是 [（左方括号），说明是 动态参数 的开始：
      // v-bind:[propName]="value"

      // 进入 InDirDynamicArg 状态，准备处理方括号内部的动态参数名（例如 propName）；
      // 注意这里不需要设置 sectionStart，因为 dynamic 参数处理逻辑内部会单独处理。
      this.state = State.InDirDynamicArg
    } else if (c === CharCodes.Dot) {
      // 如果当前字符是 .，说明参数部分结束，开始进入 修饰符：
      // v-on:click.prevent

      // 通知参数识别完成；
      // 切换状态为 InDirModifier，开始解析修饰符（如 .prevent, .stop, .lazy）；
      // 更新 sectionStart，准备记录修饰符内容。
      this.cbs.ondirarg(this.sectionStart, this.index)
      this.state = State.InDirModifier
      this.sectionStart = this.index + 1
    }
  }

  // 处理 Vue 动态指令参数（如 v-bind:[foo]） 的逻辑。
  // <input v-bind:[placeholder]="msg">
  // 这里的 [placeholder] 就是一个动态参数（用方括号包起来）。
  // 这个状态 InDynamicDirArg 就是在处理方括号 [ 开始之后、] 结束之前的字符。
  private stateInDynamicDirArg(c: number): void {
    if (c === CharCodes.RightSquare) {
      // 如果当前字符是 ]（右中括号），说明动态参数已经结束；
      // 状态切换回 InDirArg，继续处理指令参数后的修饰符或 = 等。

      // 例如
      // v-bind:[name].sync="val"
      // 当遇到 ] 后，接下来需要解析 .sync 修饰符，所以回到 InDirArg。
      this.state = State.InDirArg
    } else if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      // 如果在没遇到 ] 之前就遇到了 =（要赋值）或标签结尾（如 >），说明这个动态参数没有闭合，是语法错误。

      // 依然触发参数回调，把 [placeholder 这样的字符串当作参数名处理，范围包含当前字符（+1）。
      this.cbs.ondirarg(this.sectionStart, this.index + 1)

      // 调用属性名结尾处理函数，进入后续的值解析或标签处理流程。
      this.handleAttrNameEnd(c)
      if (__DEV__ || !__BROWSER__) {
        // 如果在开发模式或非浏览器环境下，触发一个错误提示：
        // 动态参数缺少右中括号 ]；
        // 给出错误位置，用于 IDE 提示或构建失败信息。
        this.cbs.onerr(
          ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END,
          this.index,
        )
      }
    }
  }

  // 处理指令修饰符（modifier）解析的状态函数：
  // stateInDirModifier —— 用于解析指令中 .prevent、.stop、.lazy 等修饰符部分。
  // 举个例子：
  // <button v-on:click.prevent.stop="handleClick">
  // 当解析到 .prevent 时，就会进入这个状态。
  private stateInDirModifier(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      // 如果当前字符是 =，说明修饰符结束，接下来要处理属性值；
      // 或者遇到标签结束（> 或 />）时，也认为修饰符解析结束。

      //调用修饰符回调 ondirmodifier，报告当前位置识别出的修饰符（如 prevent、stop 等）；
      // 区间是 [sectionStart, index)。
      this.cbs.ondirmodifier(this.sectionStart, this.index)

      // 转入处理属性名结束逻辑（判断是否进入值处理状态或回到文本状态）。
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.Dot) {
      // 如果再次遇到 .，表示还有下一个修饰符（如 .prevent.stop）。

      // 先提交当前修饰符（比如 prevent），并将其“切割”。
      this.cbs.ondirmodifier(this.sectionStart, this.index)

      // 更新 sectionStart，为下一个修饰符准备
      this.sectionStart = this.index + 1
    }
  }

  // 用于在解析完一个“属性名”或“指令名/参数/修饰符”之后，处理接下来的状态跳转。
  private handleAttrNameEnd(c: number): void {
    // 将 sectionStart 设置为当前位置；
    // 这意味着：接下来的解析（通常是属性值）从当前索引处开始记录。
    this.sectionStart = this.index

    // 切换状态为 AfterAttrName，表示“属性名之后”的状态；
    // 接下来的字符可能是：
    // =：表示将进入属性值解析；
    // > 或 /：表示属性没有值（布尔属性或自闭合标签）；
    this.state = State.AfterAttrName

    // 触发回调 onattribnameend，通知属性名结束的位置；
    // 用于后端 AST 构建器标记“属性名结尾”。
    this.cbs.onattribnameend(this.index)

    // 调用 stateAfterAttrName 来继续处理当前字符 c；
    // 也就是说：handleAttrNameEnd 不仅改变状态，还立即跳转并消费当前字符，不中断解析流程。
    this.stateAfterAttrName(c)
  }

  // 它负责在属性名解析完成后，根据当前字符决定下一步是否进入属性值解析、继续下一个属性、还是结束标签。
  private stateAfterAttrName(c: number): void {
    if (c === CharCodes.Eq) {
      // 如果遇到等号 =，说明属性后面有值（如 type="text"）；
      // 状态机切换为 BeforeAttrValue，准备解析属性值。
      this.state = State.BeforeAttrValue
    } else if (c === CharCodes.Slash || c === CharCodes.Gt) {
      // 如果遇到 /（自闭合）或 >（标签闭合），说明这个属性是布尔属性（如 <input disabled>）；
      // 回调 onattribend，表示属性解析完毕，但没有值（QuoteType.NoValue）。
      this.cbs.onattribend(QuoteType.NoValue, this.sectionStart)
      // 重置 sectionStart，表示当前属性处理完毕。
      this.sectionStart = -1
      // 切换回处理下一个属性或标签结束状态；
      // 把当前字符再交给 stateBeforeAttrName 处理（继续消费，比如识别 />）。
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    } else if (!isWhitespace(c)) {
      // 如果当前字符不是空格，说明属性名后没有空格、没有等号，直接接另一个属性（容错情况）；
      // 比如 <input type readonly>：type 是有值的，readonly 是布尔属性；
      // 当前属性当作无值结束（回调 onattribend）。
      this.cbs.onattribend(QuoteType.NoValue, this.sectionStart)
      // 把当前字符当作新的属性开头，进入下一个属性解析
      this.handleAttrStart(c)
    }
  }

  // 属性值开始前的判断逻辑。
  // 这是属性解析的最后阶段入口，判断即将出现的属性值是：
  // 用 双引号 包裹 "value"
  // 用 单引号 包裹 'value'
  // 还是直接写值（无引号） value
  private stateBeforeAttrValue(c: number): void {
    if (c === CharCodes.DoubleQuote) {
      // 如果遇到 "，说明属性值是双引号包裹的（比如 type="text"）；
      // 切换状态为 InAttrValueDq（Double Quote）；
      // 设置值内容的开始位置为下一个字符，跳过 "。
      this.state = State.InAttrValueDq
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.SingleQuote) {
      // 如果遇到 '，说明属性值是单引号包裹的（比如 key='abc'）；
      // 切换状态为 InAttrValueSq（Single Quote）；
      // 同样跳过当前字符，记录值内容从下一个字符开始。
      this.state = State.InAttrValueSq
      this.sectionStart = this.index + 1
    } else if (!isWhitespace(c)) {
      // 如果当前不是空格，也不是引号，说明是 无引号属性值（比如 <input type=text>）；
      // 设置值的开始位置为当前字符；
      // 切换状态为 InAttrValueNq（No Quotes）；
      // 调用 stateInAttrValueNoQuotes(c) 重新处理当前字符（reconsume）；
      this.sectionStart = this.index
      this.state = State.InAttrValueNq
      this.stateInAttrValueNoQuotes(c) // Reconsume token
    }
  }

  // 用于处理 引号包裹的属性值 的函数，适用于：
  // stateInAttrValueDq（双引号）
  // stateInAttrValueSq（单引号）
  // 这个函数会在每读取一个字符时判断属性值是否结束，或是否开始 HTML 实体（如 &amp;）。
  private handleInAttrValue(c: number, quote: number) {
    if (c === quote || (__BROWSER__ && this.fastForwardTo(quote))) {
      // 如果当前字符是传入的 quote（例如原本开始的是 "，现在也遇到 "），说明属性值已结束；
      // 或者在浏览器环境下使用 fastForwardTo 提前跳到结束引号，提高效率。

      // 触发属性值数据回调（onattribdata），提交属性值字符串的位置 [sectionStart, index)；
      // 比如 type="text" 中的 "text"。
      this.cbs.onattribdata(this.sectionStart, this.index)
      // 清除起始位置，表示这段值已处理完。
      this.sectionStart = -1
      // 触发属性结束的回调 onattribend，告知这段属性值的结尾；
      // 同时带上引号类型（双引号 or 单引号）作为辅助信息；
      // index + 1 是值结束的最后一个字符的下一个位置。
      this.cbs.onattribend(
        quote === CharCodes.DoubleQuote ? QuoteType.Double : QuoteType.Single,
        this.index + 1,
      )
      // 属性值结束后，切换状态为 BeforeAttrName，准备解析下一个属性（或结束标签）。
      this.state = State.BeforeAttrName
    } else if (!__BROWSER__ && c === CharCodes.Amp) {
      // 如果当前字符是 &，说明可能是 HTML 实体（如 &nbsp;, &gt;）；
      // 在非浏览器环境下（例如服务端编译器），调用 startEntity() 开始解析实体。
      this.startEntity()
    }

    // 示例流程：
    // <input type="text">
    // 处理 "text" 的状态流：
    // 进入 stateInAttrValueDq；
    // 每读一个字符：
    // 如果不是 "，继续读取；
    // 如果是 "（quote），触发 onattribdata + onattribend；
    // 切换状态为 BeforeAttrName，准备处理下一个属性或标签结束。
  }

  // 处理 属性值被双引号包裹 的具体状态逻辑。
  // 它本身非常简单，但背后的行为是关键的 —— 它将字符处理委托给通用处理函数 handleInAttrValue，并指定当前所用的引号是 "（双引号）"。
  private stateInAttrValueDoubleQuotes(c: number): void {
    this.handleInAttrValue(c, CharCodes.DoubleQuote)

    // 它对应的 HTML 场景是：
    // <input type="text">
    // 当解析器读取到 type="text" 时：
    // 进入 stateBeforeAttrValue 状态；
    // 识别到 ", 切换状态为 InAttrValueDq；
    // 然后逐字符读取 "text"，调用 stateInAttrValueDoubleQuotes；
    // 每个字符都被传入 handleInAttrValue(...) 处理；
    // 直到再次遇到 "，完成属性值解析。
  }

  // 用于处理 单引号包裹的属性值（如 'value'）的状态函数。
  // 它的作用几乎和双引号版本完全一样，只不过传入的引号类型是单引号 '，用的是 CharCodes.SingleQuote。
  private stateInAttrValueSingleQuotes(c: number): void {
    this.handleInAttrValue(c, CharCodes.SingleQuote)

    // 示例：
    // <input placeholder='Enter name'>
    // 读到 placeholder=' → 切换状态为 InAttrValueSq
    //
    // 依次处理 E, n, t, e, r, , n, a, m, e
    //
    // 读到 ' → 属性值结束，触发 onattribdata 和 onattribend
    //
    // 状态设计的优雅点：
    // 这段函数保持了与 stateInAttrValueDoubleQuotes 和 stateInAttrValueNoQuotes 的一致结构：
    //
    // 简洁统一；
    // 把具体判断逻辑封装到 handleInAttrValue；
    // 易于扩展和维护。
  }

  // 处理 无引号属性值（unquoted attribute value）的状态函数。
  // 举个例子：
  // <input type=text>
  // 这里的 text 是没有引号包裹的属性值，Vue 解析器允许这种合法但不推荐的写法，并用该状态来处理它。
  private stateInAttrValueNoQuotes(c: number): void {
    if (isWhitespace(c) || c === CharCodes.Gt) {
      // 如果遇到空白字符（如空格、换行）或标签结束符 >，说明值结束。

      // 提交属性值的内容位置 [sectionStart, index)；
      // 比如 type=text 中的 text
      this.cbs.onattribdata(this.sectionStart, this.index)

      // 清除 sectionStart 标记；
      // 触发 onattribend 回调，并注明这是未加引号的值。
      this.sectionStart = -1
      this.cbs.onattribend(QuoteType.Unquoted, this.index)

      // 切换状态为 BeforeAttrName，准备解析下一个属性或结束标签；
      // 当前字符继续被消费（可能是 >）。
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    } else if (
      ((__DEV__ || !__BROWSER__) && c === CharCodes.DoubleQuote) ||
      c === CharCodes.SingleQuote ||
      c === CharCodes.Lt ||
      c === CharCodes.Eq ||
      c === CharCodes.GraveAccent
    ) {
      // 如果当前字符是以下字符之一，它们在无引号属性值中是非法的：
      //
      // "：双引号
      // '：单引号
      // <：标签开头，不能出现在属性值中
      // =：等号
      // `：反引号

      // 触发错误回调，报告非法字符。
      this.cbs.onerr(
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        this.index,
      )
    } else if (!__BROWSER__ && c === CharCodes.Amp) {
      // 如果在非浏览器环境中遇到 &，说明是可能的 HTML 实体（如 &nbsp;）；
      // 进入实体解析状态。
      this.startEntity()
    }
  }

  // 用来处理当解析器遇到 <! 开头的结构时的分支判断逻辑。
  // 在 HTML 中，<! 可以是三种类型的结构：
  // <!-- 注释开始
  // <![CDATA[ CDATA 节（仅用于 XML）
  // <!DOCTYPE 声明（如 HTML5 文档类型）
  private stateBeforeDeclaration(c: number): void {
    if (c === CharCodes.LeftSquare) {
      // 如果遇到的是左方括号 [，那么可能是 CDATA 段落的开始：
      // <![CDATA[some raw text]]>
      // 切换状态为 CDATASequence，准备匹配完整的 CDATA[ 序列；
      // sequenceIndex = 0 表示开始匹配字符。
      this.state = State.CDATASequence
      this.sequenceIndex = 0
    } else {
      // 如果当前字符是 -，则有可能是注释开始 <!--：
      // 切换状态为 BeforeComment（判断是否是合法的 <!--）；
      // 否则，就认为这是其他类型的声明，如 <!DOCTYPE html>：
      // 切换状态为 InDeclaration，解析整个声明内容。
      this.state =
        c === CharCodes.Dash ? State.BeforeComment : State.InDeclaration
    }
  }

  // 用于处理类似 <!DOCTYPE html> 或其他自定义声明结构的内容。
  // 先看标准 HTML 中的声明结构：
  // <!DOCTYPE html>
  // 它不是注释、也不是标签或属性；
  // 通常出现在 HTML 顶部，用来声明 HTML 文档的类型；
  // 以 <! 开头，以 > 结尾。
  private stateInDeclaration(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      // 如果当前字符是 >（大于号），表示声明结束；
      // 或者使用 fastForwardTo('>') 快速跳到结束符，提高解析效率（跳过中间内容）。

      // 这行注释掉的代码本应是触发声明的回调 ondeclaration，用于通知解析器这段是 <!...> 声明；
      // 但被注释了，说明当前实现并不处理 <!DOCTYPE> 的具体内容；
      // 可能是因为 Vue 模板里很少使用此类声明。

      // this.cbs.ondeclaration(this.sectionStart, this.index)
      // 声明结构已结束，解析状态切换回正常文本状态。
      this.state = State.Text
      // 设置下一段文本或结构的开始索引为当前 > 字符之后的位置。
      this.sectionStart = this.index + 1
    }
  }

  // 用来处理 处理指令（Processing Instruction） 的内容，比如：
  // <?xml version="1.0"?>
  // 虽然在标准 HTML 中这种语法不常见，但 Vue 编译器为了兼容 XML-like 结构或处理某些模板编写风格，会保留类似处理指令的解析。
  private stateInProcessingInstruction(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      // 如果当前字符是 >，说明处理指令结束了；
      // 或者尝试使用 fastForwardTo(CharCodes.Gt) 跳过无用字符，直到找到 >；
      // 通常是处理像 <?xml version="1.0"?> 的结尾。

      // 触发处理指令的回调函数 onprocessinginstruction；
      // 提交区间是从 sectionStart 到当前字符的索引 index；
      // 这通常用于构建 AST 或保留处理指令信息。
      this.cbs.onprocessinginstruction(this.sectionStart, this.index)

      // 解析完处理指令后，回到普通的文本解析状态；
      // 继续解析模板中的其他内容。
      this.state = State.Text

      // 更新下一个解析段的起始位置，从 > 后面开始。
      this.sectionStart = this.index + 1
    }
  }

  // 在解析器读到 <!- 后判断是否为合法注释开始 <!--，然后进入正确的注释处理状态或退回声明状态。
  private stateBeforeComment(c: number): void {
    if (c === CharCodes.Dash) {
      // 如果下一个字符是 '-'，也就是说已经读到 <!--，是合法注释开始。
      // 举例：处理 <!- 后接 '–' 成为 <!--。

      // 状态机切换到 InCommentLike，表示我们要进入类似注释的内容（注释或特殊注释）。
      this.state = State.InCommentLike

      // 设置当前要匹配的结束标志为 CommentEnd，通常是 -->。
      // 也就是说，解析器接下来会找这个终结符来识别注释结束。
      this.currentSequence = Sequences.CommentEnd

      // 设置序列匹配的初始位置为 2，表示前两个 -- 已经被识别，接下来匹配 >。
      // 这个逻辑使得像 <!--> 这种短注释也能被识别为合法注释。
      // Allow short comments (eg. <!-->)
      this.sequenceIndex = 2
      // 设置注释内容的开始位置为当前索引的下一个字符，也就是 <!-- 之后的内容起点。
      this.sectionStart = this.index + 1
    } else {
      // 如果接下来的字符不是 -，说明不是合法的注释开头 <!--。
      // 那么解析器推断这是一个文档声明（如 <!DOCTYPE html>），进入 InDeclaration 状态处理。
      this.state = State.InDeclaration
    }
  }
  // 专门用于处理 特殊注释 的解析状态，主要用于处理浏览器条件注释或其他特殊标记，比如：
  // <!--[if IE]> ... <![endif]-->
  private stateInSpecialComment(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      // 如果当前字符是 >，说明注释结束。
      // 或者使用 fastForwardTo(CharCodes.Gt) 快进查找下一个 >，用于快速跳过无效字符，加快解析速度。
      // 这通常是因为特殊注释不一定是逐字符处理的，也可以快速跳过整块。

      // 触发注释的回调函数，把注释内容的位置 [sectionStart, index) 提交给处理器（通常用于构建 AST）。
      // 比如：<!--abc--> 中 abc 的位置会通过这个回调告诉处理器。
      this.cbs.oncomment(this.sectionStart, this.index)
      // 注释解析完毕后，恢复解析器状态为 Text，继续处理普通 HTML 文本。
      this.state = State.Text
      // 设置下一个解析段的起点，即跳过 > 后的下一个字符位置。
      // 用于继续后续节点的解析。
      this.sectionStart = this.index + 1
    }
  }

  // 用来识别以 <s 开头的特殊标签，也就是：
  // <script>
  // <style>
  private stateBeforeSpecialS(c: number): void {
    if (c === Sequences.ScriptEnd[3]) {
      //检查当前字符是否与 <script> 标签的第 4 个字符（即 'i'）匹配。
      // Sequences.ScriptEnd 代表 ['s', 'c', 'r', 'i', 'p', 't'] 这一序列。

      // 如果字符是 'i'，可能正在拼 <script>，就调用 startSpecial 从第 4 个字符开始继续匹配。
      // 目标是确认是否完整匹配到 <script>，从而进入特殊处理模式。
      this.startSpecial(Sequences.ScriptEnd, 4)
    } else if (c === Sequences.StyleEnd[3]) {
      //如果不是 <script>，则检查是不是 <style> 的第 4 个字符（即 'l'）。
      //调用 startSpecial 来继续判断是不是 <style> 标签
      this.startSpecial(Sequences.StyleEnd, 4)
    } else {
      // 如果既不是 <script> 也不是 <style>，说明这个 <s... 标签是其他普通标签。
      // 状态切回普通标签解析状态 InTagName，并重新处理当前字符。
      this.state = State.InTagName
      this.stateInTagName(c) // Consume the token again
    }
  }

  // 用于处理 特殊标签名的特殊逻辑起点，比如 <title> 和 <textarea> 这样的标签。
  // 这是一个状态机的“微妙分支点”，目的是为了更早地识别这些标签，从而正确地进入 RCDATA 模式解析（因为 <title> 和 <textarea> 不是普通的文本标签）。
  private stateBeforeSpecialT(c: number): void {
    if (c === Sequences.TitleEnd[3]) {
      // 检查当前字符是否和 <title> 标签的第 4 个字符（下标为 3）匹配。
      // Sequences.TitleEnd 是一个字符数组，代表字符串 ['t', 'i', 't', 'l', 'e']。
      // 所以这段的意思是：如果当前字符是 'l'，就有可能是 <title>。

      //调用 startSpecial，开始匹配 <title> 标签名后续字符。
      // 参数 4 表示当前已经匹配到第 4 个字符了（假设前面已经识别出 <tit）。
      this.startSpecial(Sequences.TitleEnd, 4)
    } else if (c === Sequences.TextareaEnd[3]) {
      //类似判断当前字符是否可能是 <textarea> 的一部分。

      // 如果是 <textarea> 标签，也调用 startSpecial 从第 4 个字符继续匹配。
      // 这样设计的好处是不用等整段标签名都读完才判断，而是边读边判断是否是特殊标签。
      this.startSpecial(Sequences.TextareaEnd, 4)
    } else {
      // 如果当前字符不符合 <title> 或 <textarea> 的预期格式，那它就是普通标签。
      // 所以将状态切换回 InTagName，并重新处理当前字符（递归调用 stateInTagName(c)）。
      this.state = State.InTagName
      this.stateInTagName(c) // Consume the token again
    }
  }

  // 析到 & 字符时触发的，也就是一个 HTML 实体（Entity）开始解析的起点。
  private startEntity() {
    if (!__BROWSER__) {
      // 这段逻辑只在非浏览器环境执行（比如 Node.js 端编译），浏览器端可能依赖原生解析，不走这套手动流程。

      // 把当前解析器的状态保存为 baseState，比如当前处于 Text、InAttrValue 等状态。
      // 这很关键！因为解析完实体后要回到原来的状态。
      this.baseState = this.state
      // 切换状态机为 InEntity，接下来进入实体解析逻辑
      this.state = State.InEntity
      // 记录实体开始的位置，即 & 的位置。
      // 方便在解析失败时能回退。
      this.entityStart = this.index
      // 启动实体解码器的处理流程，这个 entityDecoder 应该是一个内部类（类似 SAX 风格的 entity parser）。
      this.entityDecoder!.startEntity(
        // 设置解码模式：
        // 如果实体出现在文本内容中（<div>&nbsp;</div>），使用 Legacy 模式；
        // 如果实体出现在属性中（如 <img alt="AT&amp;T">），使用 Attribute 模式。
        // 这两种模式的行为略有不同，尤其在处理非法实体、尾部分号缺失等方面。
        this.baseState === State.Text || this.baseState === State.InRCDATA
          ? DecodingMode.Legacy
          : DecodingMode.Attribute,
      )
    }
  }

  // 用于处理 HTML 实体（HTML Entities），例如：
  // <span>&nbsp;</span>
  // 这里的 &nbsp; 就是一个 HTML 实体，它在解析时需要被转换成对应的字符（例如空格）。
  private stateInEntity(): void {
    if (!__BROWSER__) {
      // 这段逻辑只在非浏览器环境下启用，例如 Node.js（用于 SSR 或工具链）。
      // 浏览器中 HTML 实体解码可能借助原生能力，非浏览器则需要手动解码。

      // 使用一个 entityDecoder 实例（可能是一个实体解码器类）来处理当前缓冲区中的内容，起点是当前索引。
      // write 方法返回解码的实体长度（已匹配并成功解码）：
      // length > 0：成功解码了一个实体（如 &nbsp; →  ）。
      // length === 0：没有解析出有效实体。
      // length < 0：表示数据还不完整，需要继续等后续字符。

      const length = this.entityDecoder!.write(this.buffer, this.index)

      // If `length` is positive, we are done with the entity.
      if (length >= 0) {
        // 如果成功处理了实体（或处理失败但可以继续），就退出“实体”状态，恢复原来的状态 baseState。
        // 比如之前可能在 Text 状态中看到 & 开始实体，解析完继续回到 Text。
        this.state = this.baseState

        if (length === 0) {
          // 如果没有解析出实体（长度为 0），说明 & 后面不是一个有效实体（例如 &xzz;）。
          // 于是把索引退回到实体开始的位置 entityStart，当成普通字符处理。
          this.index = this.entityStart
        }
      } else {
        // 如果 length < 0，说明实体内容还没读完，需要继续读取更多字符（比如输入未完）。
        // 将 index 设置到缓冲区的最后一个字符处，等下一轮解析补全实体。
        // Mark buffer as consumed.
        this.index = this.buffer.length - 1
      }
    }
  }

  /**
   * Iterates through the buffer, calling the function corresponding to the current state.
   *
   * States that are more likely to be hit are higher up, as a performance improvement.
   */
  // 模板编译的“字符级状态机主循环”。
  // Vue 模板编译器的词法分析主引擎，
  // 它按字符读取模板字符串，并根据当前状态调用对应的状态函数，驱动 tokenizer 运转。
  public parse(input: string): void {
    // 设置待解析的字符串为内部 buffer
    // 接下来从这个 buffer 中逐字符读取
    this.buffer = input
    while (this.index < this.buffer.length) {
      // 每次处理一个字符（用 charCodeAt() 获取其 UTF-16 编码）
      const c = this.buffer.charCodeAt(this.index)

      // 如果当前字符是换行符，记录它的位置
      // 方便 getPos() 算出行列号，给 AST 节点定位
      if (c === CharCodes.NewLine) {
        this.newlines.push(this.index)
      }

      // 根据当前状态调用对应处理函数
      switch (this.state) {
        case State.Text: {
          this.stateText(c)
          break
        }
        case State.InterpolationOpen: {
          this.stateInterpolationOpen(c)
          break
        }
        case State.Interpolation: {
          this.stateInterpolation(c)
          break
        }
        case State.InterpolationClose: {
          this.stateInterpolationClose(c)
          break
        }
        case State.SpecialStartSequence: {
          this.stateSpecialStartSequence(c)
          break
        }
        case State.InRCDATA: {
          this.stateInRCDATA(c)
          break
        }
        case State.CDATASequence: {
          this.stateCDATASequence(c)
          break
        }
        case State.InAttrValueDq: {
          this.stateInAttrValueDoubleQuotes(c)
          break
        }
        case State.InAttrName: {
          this.stateInAttrName(c)
          break
        }
        case State.InDirName: {
          this.stateInDirName(c)
          break
        }
        case State.InDirArg: {
          this.stateInDirArg(c)
          break
        }
        case State.InDirDynamicArg: {
          this.stateInDynamicDirArg(c)
          break
        }
        case State.InDirModifier: {
          this.stateInDirModifier(c)
          break
        }
        case State.InCommentLike: {
          this.stateInCommentLike(c)
          break
        }
        case State.InSpecialComment: {
          this.stateInSpecialComment(c)
          break
        }
        case State.BeforeAttrName: {
          this.stateBeforeAttrName(c)
          break
        }
        case State.InTagName: {
          this.stateInTagName(c)
          break
        }
        case State.InSFCRootTagName: {
          this.stateInSFCRootTagName(c)
          break
        }
        case State.InClosingTagName: {
          this.stateInClosingTagName(c)
          break
        }
        case State.BeforeTagName: {
          this.stateBeforeTagName(c)
          break
        }
        case State.AfterAttrName: {
          this.stateAfterAttrName(c)
          break
        }
        case State.InAttrValueSq: {
          this.stateInAttrValueSingleQuotes(c)
          break
        }
        case State.BeforeAttrValue: {
          this.stateBeforeAttrValue(c)
          break
        }
        case State.BeforeClosingTagName: {
          this.stateBeforeClosingTagName(c)
          break
        }
        case State.AfterClosingTagName: {
          this.stateAfterClosingTagName(c)
          break
        }
        case State.BeforeSpecialS: {
          this.stateBeforeSpecialS(c)
          break
        }
        case State.BeforeSpecialT: {
          this.stateBeforeSpecialT(c)
          break
        }
        case State.InAttrValueNq: {
          this.stateInAttrValueNoQuotes(c)
          break
        }
        case State.InSelfClosingTag: {
          this.stateInSelfClosingTag(c)
          break
        }
        case State.InDeclaration: {
          this.stateInDeclaration(c)
          break
        }
        case State.BeforeDeclaration: {
          this.stateBeforeDeclaration(c)
          break
        }
        case State.BeforeComment: {
          this.stateBeforeComment(c)
          break
        }
        case State.InProcessingInstruction: {
          this.stateInProcessingInstruction(c)
          break
        }
        case State.InEntity: {
          this.stateInEntity()
          break
        }
      }
      this.index++
      // 每轮解析完一个字符，就移动到下一个
    }
    // 发出还没处理的文本或属性值段（避免遗漏）
    // 特别重要于流式处理/中断处理情况
    this.cleanup()
    // 处理 HTML 实体未闭合的情况
    // 调用 handleTrailingData() 处理遗留文本/注释
    // 最后调用 onend() 通知词法分析完成
    this.finish()
  }

  /**
   * Remove data that has already been consumed from the buffer.
   * 在某些特定状态下提前输出已读数据，防止数据堆积或错过 emit 时机，确保字符流保持同步。
   * 用于提前 emit 已读取但尚未提交的文本或属性值数据，并更新 sectionStart。
   */
  // 在 streaming 模式下（流式解析），我们不能一次性读取整个文档
  // 所以必须定期清理已处理的数据段
  // 否则会浪费内存，或者导致数据不被 emit（尤其是文本或属性）
  private cleanup() {
    // If we are inside of text or attributes, emit what we already have.
    // 如果 sectionStart < index，表示中间还有一段已扫描但没触发回调的数据
    if (this.sectionStart !== this.index) {
      if (
        this.state === State.Text ||
        (this.state === State.InRCDATA && this.sequenceIndex === 0)
      ) {
        //  如果当前状态是 文本 或 RCDATA 且没匹配结束标签

        // 正常的 HTML 文本（如 <p>Hello）
        // 或 <title>Hello 这类 RCDATA 模式下，还没遇到 </title>，也可以 emit

        // 调用 ontext(start, end) 回调
        // 然后将起点更新为当前位置
        this.cbs.ontext(this.sectionStart, this.index)
        this.sectionStart = this.index
      } else if (
        // 如果当前在属性值中（双引号、单引号、无引号）
        // 表示正在解析一个属性值（如 class="abc"）
        this.state === State.InAttrValueDq ||
        this.state === State.InAttrValueSq ||
        this.state === State.InAttrValueNq
      ) {
        // 调用 onattribdata(start, end) 发出属性值段
        this.cbs.onattribdata(this.sectionStart, this.index)
        this.sectionStart = this.index
      }
    }
  }

  // 用于收尾实体解析、处理遗留内容，并通知解析结束。
  private finish() {
    //  如果还在处理 HTML 实体，结束它
    if (!__BROWSER__ && this.state === State.InEntity) {
      // 非浏览器环境下，如果当前处于 &gt;、&#x3C; 等实体解析中
      // 调用 entityDecoder.end() 强制结束（即使没看到 ;）
      // 然后恢复状态到之前的 Text 或 RCDATA
      this.entityDecoder!.end()
      this.state = this.baseState
      // <p>&gt
      // 这里实体 &gt 没写 ;，但文件到结尾了，也得强行解码
    }

    // 发出尚未回调的数据
    this.handleTrailingData()

    // 调用回调 onend()，通知“输入流完全结束”
    //
    // 上层 parser 可以从此知道“AST 构建阶段可以开始了”
    this.cbs.onend()
  }

  /** Handle any trailing data. */
  // 负责在字符流结束后处理未发出的最后一段内容（文本、注释、CDATA），以确保词法分析完整性和语义完整性。
  private handleTrailingData() {
    // 获取当前缓冲区的结束位置（即模板字符的末尾
    const endIndex = this.buffer.length

    // If there is no remaining data, we are done.
    // 没有剩余内容，直接返回
    if (this.sectionStart >= endIndex) {
      return
    }

    // 注释 / CDATA 尚未闭合，但文件已结束
    if (this.state === State.InCommentLike) {
      // 如果仍处于 <!-- 或 <![CDATA[ 的注释状态，且文件已结束：
      // 触发回调（即使 --> 或 ]]> 没闭合）
      // 仍然保留内容，让 parser 有机会处理它
      if (this.currentSequence === Sequences.CdataEnd) {
        this.cbs.oncdata(this.sectionStart, endIndex)
      } else {
        this.cbs.oncomment(this.sectionStart, endIndex)
      }
    } else if (
      // 如果在标签或属性状态中，不触发任何回调（静默忽略）
      this.state === State.InTagName ||
      this.state === State.BeforeAttrName ||
      this.state === State.BeforeAttrValue ||
      this.state === State.AfterAttrName ||
      this.state === State.InAttrName ||
      this.state === State.InDirName ||
      this.state === State.InDirArg ||
      this.state === State.InDirDynamicArg ||
      this.state === State.InDirModifier ||
      this.state === State.InAttrValueSq ||
      this.state === State.InAttrValueDq ||
      this.state === State.InAttrValueNq ||
      this.state === State.InClosingTagName
    ) {
      /*
       * If we are currently in an opening or closing tag, us not calling the
       * respective callback signals that the tag should be ignored.
       */
    } else {
      // 正常纯文本末尾 → 发出回调
      this.cbs.ontext(this.sectionStart, endIndex)
    }
  }

  // 处理 HTML 实体解析完成后，触发回调的函数
  private emitCodePoint(cp: number, consumed: number): void {
    // 浏览器环境一般不走这个路径，实体直接交由 DOM 处理
    // 编译器自身仅在非浏览器环境中解析实体（如 SSR）
    if (!__BROWSER__) {
      if (this.baseState !== State.Text && this.baseState !== State.InRCDATA) {
        // 如果当前在属性中（如 class="&gt;"） → 触发属性相关的实体回调 onattribentity()
        // 如果是在普通文本中（如 Hello &lt;div&gt;） → 触发文本相关的实体回调 ontextentity(
        if (this.sectionStart < this.entityStart) {
          // 在实体前可能还有一段未处理的文本，比如：
          // <p>2 &gt; 1</p>
          //      ^     ^
          //      |     entityStart
          //   sectionStart

          // 把 2 部分先发出去
          this.cbs.onattribdata(this.sectionStart, this.entityStart)
        }

        // 设定下一个起点，并修正当前索引
        // 更新 sectionStart：实体之后的第一个字符位置
        // this.index - 1 是为了外部循环再 index++ 时能对得上
        this.sectionStart = this.entityStart + consumed
        this.index = this.sectionStart - 1

        // 触发实体字符回调
        // 将实体内容回调出去
        // 回调参数为：
        // 解码后的字符（通过 fromCodePoint(cp)）
        // 起始位置
        // 结束位置
        this.cbs.onattribentity(
          fromCodePoint(cp),
          this.entityStart,
          this.sectionStart,
        )
      } else {
        // 先触发前面剩余内容
        if (this.sectionStart < this.entityStart) {
          this.cbs.ontext(this.sectionStart, this.entityStart)
        }

        // 设定下一个起点，并修正当前索引
        // 更新 sectionStart：实体之后的第一个字符位置
        // this.index - 1 是为了外部循环再 index++ 时能对得上
        this.sectionStart = this.entityStart + consumed
        this.index = this.sectionStart - 1

        // 触发实体字符回调
        // 将实体内容回调出去
        // 回调参数为：
        // 解码后的字符（通过 fromCodePoint(cp)）
        // 起始位置
        // 结束位置
        this.cbs.ontextentity(
          fromCodePoint(cp),
          this.entityStart,
          this.sectionStart,
        )
      }
    }
  }
}
