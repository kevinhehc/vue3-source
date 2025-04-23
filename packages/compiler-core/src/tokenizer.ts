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

  private stateInTagName(c: number): void {
    if (isEndOfTagSection(c)) {
      this.handleTagName(c)
    }
  }

  private stateInSFCRootTagName(c: number): void {
    if (isEndOfTagSection(c)) {
      const tag = this.buffer.slice(this.sectionStart, this.index)
      if (tag !== 'template') {
        this.enterRCDATA(toCharCodes(`</` + tag), 0)
      }
      this.handleTagName(c)
    }
  }

  private handleTagName(c: number) {
    this.cbs.onopentagname(this.sectionStart, this.index)
    this.sectionStart = -1
    this.state = State.BeforeAttrName
    this.stateBeforeAttrName(c)
  }
  private stateBeforeClosingTagName(c: number): void {
    if (isWhitespace(c)) {
      // Ignore
    } else if (c === CharCodes.Gt) {
      if (__DEV__ || !__BROWSER__) {
        this.cbs.onerr(ErrorCodes.MISSING_END_TAG_NAME, this.index)
      }
      this.state = State.Text
      // Ignore
      this.sectionStart = this.index + 1
    } else {
      this.state = isTagStartChar(c)
        ? State.InClosingTagName
        : State.InSpecialComment
      this.sectionStart = this.index
    }
  }
  private stateInClosingTagName(c: number): void {
    if (c === CharCodes.Gt || isWhitespace(c)) {
      this.cbs.onclosetag(this.sectionStart, this.index)
      this.sectionStart = -1
      this.state = State.AfterClosingTagName
      this.stateAfterClosingTagName(c)
    }
  }
  private stateAfterClosingTagName(c: number): void {
    // Skip everything until ">"
    if (c === CharCodes.Gt) {
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateBeforeAttrName(c: number): void {
    if (c === CharCodes.Gt) {
      this.cbs.onopentagend(this.index)
      if (this.inRCDATA) {
        this.state = State.InRCDATA
      } else {
        this.state = State.Text
      }
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.Slash) {
      this.state = State.InSelfClosingTag
      if ((__DEV__ || !__BROWSER__) && this.peek() !== CharCodes.Gt) {
        this.cbs.onerr(ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG, this.index)
      }
    } else if (c === CharCodes.Lt && this.peek() === CharCodes.Slash) {
      // special handling for </ appearing in open tag state
      // this is different from standard HTML parsing but makes practical sense
      // especially for parsing intermediate input state in IDEs.
      this.cbs.onopentagend(this.index)
      this.state = State.BeforeTagName
      this.sectionStart = this.index
    } else if (!isWhitespace(c)) {
      if ((__DEV__ || !__BROWSER__) && c === CharCodes.Eq) {
        this.cbs.onerr(
          ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME,
          this.index,
        )
      }
      this.handleAttrStart(c)
    }
  }
  private handleAttrStart(c: number) {
    if (c === CharCodes.LowerV && this.peek() === CharCodes.Dash) {
      this.state = State.InDirName
      this.sectionStart = this.index
    } else if (
      c === CharCodes.Dot ||
      c === CharCodes.Colon ||
      c === CharCodes.At ||
      c === CharCodes.Number
    ) {
      this.cbs.ondirname(this.index, this.index + 1)
      this.state = State.InDirArg
      this.sectionStart = this.index + 1
    } else {
      this.state = State.InAttrName
      this.sectionStart = this.index
    }
  }
  private stateInSelfClosingTag(c: number): void {
    if (c === CharCodes.Gt) {
      this.cbs.onselfclosingtag(this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
      this.inRCDATA = false // Reset special state, in case of self-closing special tags
    } else if (!isWhitespace(c)) {
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    }
  }
  private stateInAttrName(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.onattribname(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (
      (__DEV__ || !__BROWSER__) &&
      (c === CharCodes.DoubleQuote ||
        c === CharCodes.SingleQuote ||
        c === CharCodes.Lt)
    ) {
      this.cbs.onerr(
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        this.index,
      )
    }
  }
  private stateInDirName(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.ondirname(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.Colon) {
      this.cbs.ondirname(this.sectionStart, this.index)
      this.state = State.InDirArg
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.Dot) {
      this.cbs.ondirname(this.sectionStart, this.index)
      this.state = State.InDirModifier
      this.sectionStart = this.index + 1
    }
  }
  private stateInDirArg(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.ondirarg(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.LeftSquare) {
      this.state = State.InDirDynamicArg
    } else if (c === CharCodes.Dot) {
      this.cbs.ondirarg(this.sectionStart, this.index)
      this.state = State.InDirModifier
      this.sectionStart = this.index + 1
    }
  }
  private stateInDynamicDirArg(c: number): void {
    if (c === CharCodes.RightSquare) {
      this.state = State.InDirArg
    } else if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.ondirarg(this.sectionStart, this.index + 1)
      this.handleAttrNameEnd(c)
      if (__DEV__ || !__BROWSER__) {
        this.cbs.onerr(
          ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END,
          this.index,
        )
      }
    }
  }
  private stateInDirModifier(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.ondirmodifier(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.Dot) {
      this.cbs.ondirmodifier(this.sectionStart, this.index)
      this.sectionStart = this.index + 1
    }
  }
  private handleAttrNameEnd(c: number): void {
    this.sectionStart = this.index
    this.state = State.AfterAttrName
    this.cbs.onattribnameend(this.index)
    this.stateAfterAttrName(c)
  }
  private stateAfterAttrName(c: number): void {
    if (c === CharCodes.Eq) {
      this.state = State.BeforeAttrValue
    } else if (c === CharCodes.Slash || c === CharCodes.Gt) {
      this.cbs.onattribend(QuoteType.NoValue, this.sectionStart)
      this.sectionStart = -1
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    } else if (!isWhitespace(c)) {
      this.cbs.onattribend(QuoteType.NoValue, this.sectionStart)
      this.handleAttrStart(c)
    }
  }
  private stateBeforeAttrValue(c: number): void {
    if (c === CharCodes.DoubleQuote) {
      this.state = State.InAttrValueDq
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.SingleQuote) {
      this.state = State.InAttrValueSq
      this.sectionStart = this.index + 1
    } else if (!isWhitespace(c)) {
      this.sectionStart = this.index
      this.state = State.InAttrValueNq
      this.stateInAttrValueNoQuotes(c) // Reconsume token
    }
  }
  private handleInAttrValue(c: number, quote: number) {
    if (c === quote || (__BROWSER__ && this.fastForwardTo(quote))) {
      this.cbs.onattribdata(this.sectionStart, this.index)
      this.sectionStart = -1
      this.cbs.onattribend(
        quote === CharCodes.DoubleQuote ? QuoteType.Double : QuoteType.Single,
        this.index + 1,
      )
      this.state = State.BeforeAttrName
    } else if (!__BROWSER__ && c === CharCodes.Amp) {
      this.startEntity()
    }
  }
  private stateInAttrValueDoubleQuotes(c: number): void {
    this.handleInAttrValue(c, CharCodes.DoubleQuote)
  }
  private stateInAttrValueSingleQuotes(c: number): void {
    this.handleInAttrValue(c, CharCodes.SingleQuote)
  }
  private stateInAttrValueNoQuotes(c: number): void {
    if (isWhitespace(c) || c === CharCodes.Gt) {
      this.cbs.onattribdata(this.sectionStart, this.index)
      this.sectionStart = -1
      this.cbs.onattribend(QuoteType.Unquoted, this.index)
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    } else if (
      ((__DEV__ || !__BROWSER__) && c === CharCodes.DoubleQuote) ||
      c === CharCodes.SingleQuote ||
      c === CharCodes.Lt ||
      c === CharCodes.Eq ||
      c === CharCodes.GraveAccent
    ) {
      this.cbs.onerr(
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        this.index,
      )
    } else if (!__BROWSER__ && c === CharCodes.Amp) {
      this.startEntity()
    }
  }
  private stateBeforeDeclaration(c: number): void {
    if (c === CharCodes.LeftSquare) {
      this.state = State.CDATASequence
      this.sequenceIndex = 0
    } else {
      this.state =
        c === CharCodes.Dash ? State.BeforeComment : State.InDeclaration
    }
  }
  private stateInDeclaration(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      // this.cbs.ondeclaration(this.sectionStart, this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateInProcessingInstruction(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      this.cbs.onprocessinginstruction(this.sectionStart, this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateBeforeComment(c: number): void {
    if (c === CharCodes.Dash) {
      this.state = State.InCommentLike
      this.currentSequence = Sequences.CommentEnd
      // Allow short comments (eg. <!-->)
      this.sequenceIndex = 2
      this.sectionStart = this.index + 1
    } else {
      this.state = State.InDeclaration
    }
  }
  private stateInSpecialComment(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      this.cbs.oncomment(this.sectionStart, this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateBeforeSpecialS(c: number): void {
    if (c === Sequences.ScriptEnd[3]) {
      this.startSpecial(Sequences.ScriptEnd, 4)
    } else if (c === Sequences.StyleEnd[3]) {
      this.startSpecial(Sequences.StyleEnd, 4)
    } else {
      this.state = State.InTagName
      this.stateInTagName(c) // Consume the token again
    }
  }
  private stateBeforeSpecialT(c: number): void {
    if (c === Sequences.TitleEnd[3]) {
      this.startSpecial(Sequences.TitleEnd, 4)
    } else if (c === Sequences.TextareaEnd[3]) {
      this.startSpecial(Sequences.TextareaEnd, 4)
    } else {
      this.state = State.InTagName
      this.stateInTagName(c) // Consume the token again
    }
  }

  private startEntity() {
    if (!__BROWSER__) {
      this.baseState = this.state
      this.state = State.InEntity
      this.entityStart = this.index
      this.entityDecoder!.startEntity(
        this.baseState === State.Text || this.baseState === State.InRCDATA
          ? DecodingMode.Legacy
          : DecodingMode.Attribute,
      )
    }
  }

  private stateInEntity(): void {
    if (!__BROWSER__) {
      const length = this.entityDecoder!.write(this.buffer, this.index)

      // If `length` is positive, we are done with the entity.
      if (length >= 0) {
        this.state = this.baseState

        if (length === 0) {
          this.index = this.entityStart
        }
      } else {
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
  public parse(input: string): void {
    this.buffer = input
    while (this.index < this.buffer.length) {
      const c = this.buffer.charCodeAt(this.index)
      if (c === CharCodes.NewLine) {
        this.newlines.push(this.index)
      }
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
    }
    this.cleanup()
    this.finish()
  }

  /**
   * Remove data that has already been consumed from the buffer.
   */
  private cleanup() {
    // If we are inside of text or attributes, emit what we already have.
    if (this.sectionStart !== this.index) {
      if (
        this.state === State.Text ||
        (this.state === State.InRCDATA && this.sequenceIndex === 0)
      ) {
        this.cbs.ontext(this.sectionStart, this.index)
        this.sectionStart = this.index
      } else if (
        this.state === State.InAttrValueDq ||
        this.state === State.InAttrValueSq ||
        this.state === State.InAttrValueNq
      ) {
        this.cbs.onattribdata(this.sectionStart, this.index)
        this.sectionStart = this.index
      }
    }
  }

  private finish() {
    if (!__BROWSER__ && this.state === State.InEntity) {
      this.entityDecoder!.end()
      this.state = this.baseState
    }

    this.handleTrailingData()

    this.cbs.onend()
  }

  /** Handle any trailing data. */
  private handleTrailingData() {
    const endIndex = this.buffer.length

    // If there is no remaining data, we are done.
    if (this.sectionStart >= endIndex) {
      return
    }

    if (this.state === State.InCommentLike) {
      if (this.currentSequence === Sequences.CdataEnd) {
        this.cbs.oncdata(this.sectionStart, endIndex)
      } else {
        this.cbs.oncomment(this.sectionStart, endIndex)
      }
    } else if (
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
      this.cbs.ontext(this.sectionStart, endIndex)
    }
  }

  private emitCodePoint(cp: number, consumed: number): void {
    if (!__BROWSER__) {
      if (this.baseState !== State.Text && this.baseState !== State.InRCDATA) {
        if (this.sectionStart < this.entityStart) {
          this.cbs.onattribdata(this.sectionStart, this.entityStart)
        }
        this.sectionStart = this.entityStart + consumed
        this.index = this.sectionStart - 1

        this.cbs.onattribentity(
          fromCodePoint(cp),
          this.entityStart,
          this.sectionStart,
        )
      } else {
        if (this.sectionStart < this.entityStart) {
          this.cbs.ontext(this.sectionStart, this.entityStart)
        }
        this.sectionStart = this.entityStart + consumed
        this.index = this.sectionStart - 1

        this.cbs.ontextentity(
          fromCodePoint(cp),
          this.entityStart,
          this.sectionStart,
        )
      }
    }
  }
}
