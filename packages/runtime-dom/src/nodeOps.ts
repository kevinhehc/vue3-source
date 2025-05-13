import { warn } from '@vue/runtime-core'
import type { RendererOptions } from '@vue/runtime-core'
import type {
  TrustedHTML,
  TrustedTypePolicy,
  TrustedTypesWindow,
} from 'trusted-types/lib'

let policy: Pick<TrustedTypePolicy, 'name' | 'createHTML'> | undefined =
  undefined

// Trusted Types 安全策略（CSP）
// 使用 Trusted Types API 防止 DOM XSS。
// Vue 创建了一个名为 "vue" 的 policy，允许构建安全的 TrustedHTML 对象。
const tt =
  typeof window !== 'undefined' &&
  (window as unknown as TrustedTypesWindow).trustedTypes

if (tt) {
  try {
    policy = /*@__PURE__*/ tt.createPolicy('vue', {
      createHTML: val => val,
    })
  } catch (e: unknown) {
    // `createPolicy` throws a TypeError if the name is a duplicate
    // and the CSP trusted-types directive is not using `allow-duplicates`.
    // So we have to catch that error.
    __DEV__ && warn(`Error creating trusted types policy: ${e}`)
  }
}

// __UNSAFE__
// Reason: potentially setting innerHTML.
// This function merely perform a type-level trusted type conversion
// for use in `innerHTML` assignment, etc.
// Be careful of whatever value passed to this function.
// 用于包装 innerHTML 内容赋值，只用于模板编译的内容，开发者无法插入任意 HTML。
export const unsafeToTrustedHTML: (value: string) => TrustedHTML | string =
  policy ? val => policy.createHTML(val) : val => val

export const svgNS = 'http://www.w3.org/2000/svg'
export const mathmlNS = 'http://www.w3.org/1998/Math/MathML'

const doc = (typeof document !== 'undefined' ? document : null) as Document

const templateContainer = doc && /*@__PURE__*/ doc.createElement('template')

// 定义了 Vue 3 DOM 平台的底层实现对象 nodeOps，它是 Vue 的 运行时 DOM 操作抽象层，提供给虚拟 DOM 渲染器（createRenderer）使用
// 其本质作用是封装所有与浏览器 DOM API 的交互，使 Vue 的核心渲染逻辑可复用于其他平台（如 SSR、Custom Renderer）。
// 方法名	描述
// insert	插入节点
// remove	删除节点
// createElement	创建元素（含 SVG / MathML）
// createText / createComment	创建文本 / 注释节点
// setText / setElementText	设置文本内容
// setScopeId	设置 data-v-* 作用域 ID
// insertStaticContent	插入预编译的静态 HTML（优化）
export const nodeOps: Omit<RendererOptions<Node, Element>, 'patchProp'> = {
  insert: (child, parent, anchor) => {
    parent.insertBefore(child, anchor || null)
  },

  remove: child => {
    const parent = child.parentNode
    if (parent) {
      parent.removeChild(child)
    }
  },

  createElement: (tag, namespace, is, props): Element => {
    const el =
      namespace === 'svg'
        ? doc.createElementNS(svgNS, tag)
        : namespace === 'mathml'
          ? doc.createElementNS(mathmlNS, tag)
          : is
            ? doc.createElement(tag, { is })
            : doc.createElement(tag)

    if (tag === 'select' && props && props.multiple != null) {
      // <select multiple> 必须强制设置属性，兼容性要求。
      ;(el as HTMLSelectElement).setAttribute('multiple', props.multiple)
    }

    return el
  },

  createText: text => doc.createTextNode(text),

  createComment: text => doc.createComment(text),

  setText: (node, text) => {
    node.nodeValue = text
  },

  setElementText: (el, text) => {
    el.textContent = text
  },

  parentNode: node => node.parentNode as Element | null,

  nextSibling: node => node.nextSibling,

  querySelector: selector => doc.querySelector(selector),

  setScopeId(el, id) {
    el.setAttribute(id, '')
  },

  // __UNSAFE__
  // Reason: innerHTML.
  // Static content here can only come from compiled templates.
  // As long as the user only uses trusted templates, this is safe.
  // insertStaticContent：最特殊的函数
  // 这是 Vue 3 中用于 静态内容批量插入（如 SSR 输出节点 hydrate 时） 的逻辑：
  insertStaticContent(content, parent, anchor, namespace, start, end) {
    // <parent> before | first ... last | anchor </parent>
    // 功能：
    // 快速批量插入静态 HTML 片段（不走 diff）
    // 内容来自编译阶段确定的字符串
    // 逻辑路径：
    // 如果 start → 使用缓存节点 clone 后插入（提升性能）
    // 否则 → 使用 <template> + innerHTML 解析成节点插入
    const before = anchor ? anchor.previousSibling : parent.lastChild
    // #5308 can only take cached path if:
    // - has a single root node
    // - nextSibling info is still available
    if (start && (start === end || start.nextSibling)) {
      // cached
      while (true) {
        parent.insertBefore(start!.cloneNode(true), anchor)
        if (start === end || !(start = start!.nextSibling)) break
      }
    } else {
      // fresh insert
      // 为 SVG/MathML 包裹后再解析，移除包装元素只保留内部结构。
      templateContainer.innerHTML = unsafeToTrustedHTML(
        namespace === 'svg'
          ? `<svg>${content}</svg>`
          : namespace === 'mathml'
            ? `<math>${content}</math>`
            : content,
      ) as string

      const template = templateContainer.content
      if (namespace === 'svg' || namespace === 'mathml') {
        // remove outer svg/math wrapper
        const wrapper = template.firstChild!
        while (wrapper.firstChild) {
          template.appendChild(wrapper.firstChild)
        }
        template.removeChild(wrapper)
      }
      parent.insertBefore(template, anchor)
    }
    // 返回插入内容的边界节点，供后续 patch 用于更新范围。
    return [
      // first
      before ? before.nextSibling! : parent.firstChild!,
      // last
      anchor ? anchor.previousSibling! : parent.lastChild!,
    ]
  },
}
