/**
 * Copied from https://github.com/MananTank/validate-html-nesting
 * with ISC license
 *
 * To avoid runtime dependency on validate-html-nesting
 * This file should not change very often in the original repo
 * but we may need to keep it up-to-date from time to time.
 */
// Vue 出于 构建时优化 的考虑，将第三方库代码直接拷贝内联，而不是作为 npm 依赖引用，避免引入不必要的运行时包。

/**
 * returns true if given parent-child nesting is valid HTML
 */
// 判断某一对标签（parent, child）的嵌套是否合法，内部逻辑按优先级如下：
export function isValidHTMLNesting(parent: string, child: string): boolean {
  // if we know the list of children that are the only valid children for the given parent
  // 如果父节点的子节点必须是某一类特定标签，只允许这些标签作为子节点。
  // 示例：<select> 只能包含 <option> 或 <optgroup>。
  if (parent in onlyValidChildren) {
    return onlyValidChildren[parent].has(child)
  }

  // if we know the list of parents that are the only valid parents for the given child
  // 某些标签只能有特定的父节点。
  // 示例：<td> 只能出现在 <tr> 中。
  if (child in onlyValidParents) {
    return onlyValidParents[child].has(parent)
  }

  // if we know the list of children that are NOT valid for the given parent
  // 父节点明确不允许某些子节点出现。
  // 示例：<p> 中不能有另一个 <p> 或 <div>。
  if (parent in knownInvalidChildren) {
    // check if the child is in the list of invalid children
    // if so, return false
    if (knownInvalidChildren[parent].has(child)) return false
  }

  // if we know the list of parents that are NOT valid for the given child
  // 子节点不能出现在某些父节点中。
  // 示例：不能嵌套多个 <a> 标签。
  if (child in knownInvalidParents) {
    // check if the parent is in the list of invalid parents
    // if so, return false
    if (knownInvalidParents[child].has(parent)) return false
  }

  // 如果没有匹配以上规则，则认为嵌套合法。
  return true
}

const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const emptySet = new Set([])

/**
 * maps element to set of elements that can be it's children, no other */
// 某些标签只能包含指定子标签。
const onlyValidChildren: Record<string, Set<string>> = {
  head: new Set([
    'base',
    'basefront',
    'bgsound',
    'link',
    'meta',
    'title',
    'noscript',
    'noframes',
    'style',
    'script',
    'template',
  ]),
  optgroup: new Set(['option']),
  select: new Set(['optgroup', 'option', 'hr']),
  // table
  table: new Set(['caption', 'colgroup', 'tbody', 'tfoot', 'thead']),
  tr: new Set(['td', 'th']),
  colgroup: new Set(['col']),
  tbody: new Set(['tr']),
  thead: new Set(['tr']),
  tfoot: new Set(['tr']),
  // these elements can not have any children elements
  script: emptySet,
  iframe: emptySet,
  option: emptySet,
  textarea: emptySet,
  style: emptySet,
  title: emptySet,
}

/** maps elements to set of elements which can be it's parent, no other */
// 某些标签只能出现在指定的父标签中。
const onlyValidParents: Record<string, Set<string>> = {
  // sections
  html: emptySet,
  body: new Set(['html']),
  head: new Set(['html']),
  // table
  td: new Set(['tr']),
  colgroup: new Set(['table']),
  caption: new Set(['table']),
  tbody: new Set(['table']),
  tfoot: new Set(['table']),
  col: new Set(['colgroup']),
  th: new Set(['tr']),
  thead: new Set(['table']),
  tr: new Set(['tbody', 'thead', 'tfoot']),
  // data list
  dd: new Set(['dl', 'div']),
  dt: new Set(['dl', 'div']),
  // other
  figcaption: new Set(['figure']),
  // li: new Set(["ul", "ol"]),
  summary: new Set(['details']),
  area: new Set(['map']),
} as const

/** maps element to set of elements that can not be it's children, others can */
// 某些标签不能作为某些父标签的子节点。
const knownInvalidChildren: Record<string, Set<string>> = {
  p: new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'center',
    'details',
    'dialog',
    'dir',
    'div',
    'dl',
    'fieldset',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'li',
    'main',
    'nav',
    'menu',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'ul',
  ]),
  svg: new Set([
    'b',
    'blockquote',
    'br',
    'code',
    'dd',
    'div',
    'dl',
    'dt',
    'em',
    'embed',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'li',
    'menu',
    'meta',
    'ol',
    'p',
    'pre',
    'ruby',
    's',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'u',
    'ul',
    'var',
  ]),
} as const

/** maps element to set of elements that can not be it's parent, others can */
// 某些标签不能嵌套自身或与某些其他标签共存。
const knownInvalidParents: Record<string, Set<string>> = {
  a: new Set(['a']),
  button: new Set(['button']),
  dd: new Set(['dd', 'dt']),
  dt: new Set(['dd', 'dt']),
  form: new Set(['form']),
  li: new Set(['li']),
  h1: headings,
  h2: headings,
  h3: headings,
  h4: headings,
  h5: headings,
  h6: headings,
}
