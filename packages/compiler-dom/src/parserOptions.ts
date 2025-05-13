import { Namespaces, NodeTypes, type ParserOptions } from '@vue/compiler-core'
import { isHTMLTag, isMathMLTag, isSVGTag, isVoidTag } from '@vue/shared'
import { TRANSITION, TRANSITION_GROUP } from './runtimeHelpers'
import { decodeHtmlBrowser } from './decodeHtmlBrowser'

// 用于控制模板解析器的行为。它决定如何识别标签、处理命名空间、处理内置组件等，是 Vue 编译器前端（前置处理阶段）的一部分。
export const parserOptions: ParserOptions = {
  // 模板解析模式，指定为 HTML
  parseMode: 'html',
  // 判断是否是 void 标签（自闭合标签，如 <br> <img>）
  isVoidTag,
  // 判断是否是原生标签（HTML、SVG、MathML）
  isNativeTag: tag => isHTMLTag(tag) || isSVGTag(tag) || isMathMLTag(tag),
  // 判断是否是 <pre> 标签（影响空白处理）
  isPreTag: tag => tag === 'pre',
  // 判断是否是忽略换行符的标签（<pre> 和 <textarea>）
  isIgnoreNewlineTag: tag => tag === 'pre' || tag === 'textarea',
  // 实体解码器（浏览器端用 decodeHtmlBrowser，服务端用其他实现）
  decodeEntities: __BROWSER__ ? decodeHtmlBrowser : undefined,

  // 判断是否是内置组件（如 <Transition>、<TransitionGroup>）
  isBuiltInComponent: tag => {
    if (tag === 'Transition' || tag === 'transition') {
      return TRANSITION
    } else if (tag === 'TransitionGroup' || tag === 'transition-group') {
      return TRANSITION_GROUP
    }
  },

  // https://html.spec.whatwg.org/multipage/parsing.html#tree-construction-dispatcher
  // 命名空间推导逻辑（HTML、SVG、MathML）
  // 依据 HTML 规范中的“树构建分发器”规则
  getNamespace(tag, parent, rootNamespace) {
    // 默认使用父节点的命名空间，或传入的根命名空间
    let ns = parent ? parent.ns : rootNamespace
    // MathML 中特殊处理某些标签
    if (parent && ns === Namespaces.MATH_ML) {
      if (parent.tag === 'annotation-xml') {
        if (tag === 'svg') {
          return Namespaces.SVG
        }
        if (
          parent.props.some(
            a =>
              a.type === NodeTypes.ATTRIBUTE &&
              a.name === 'encoding' &&
              a.value != null &&
              (a.value.content === 'text/html' ||
                a.value.content === 'application/xhtml+xml'),
          )
        ) {
          ns = Namespaces.HTML
        }
      } else if (
        // mtext, mi, mo, mn, ms 是 MathML 的文本容器
        // 它们的子节点如果不是特殊标签，则进入 HTML 命名空间
        /^m(?:[ions]|text)$/.test(parent.tag) &&
        tag !== 'mglyph' &&
        tag !== 'malignmark'
      ) {
        ns = Namespaces.HTML
      }
    } else if (parent && ns === Namespaces.SVG) {
      // SVG 中的某些子元素需要回退到 HTML 命名空间
      if (
        parent.tag === 'foreignObject' ||
        parent.tag === 'desc' ||
        parent.tag === 'title'
      ) {
        ns = Namespaces.HTML
      }
    }

    // HTML 中嵌套 <svg> 或 <math> 会切换命名空间
    if (ns === Namespaces.HTML) {
      if (tag === 'svg') {
        return Namespaces.SVG
      }
      if (tag === 'math') {
        return Namespaces.MATH_ML
      }
    }
    // 默认返回计算后的命名空间
    return ns
  },
}
