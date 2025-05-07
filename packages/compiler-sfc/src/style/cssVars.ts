import {
  type BindingMetadata,
  NodeTypes,
  type SimpleExpressionNode,
  createRoot,
  createSimpleExpression,
  createTransformContext,
  processExpression,
} from '@vue/compiler-dom'
import type { SFCDescriptor } from '../parse'
import type { PluginCreator } from 'postcss'
import hash from 'hash-sum'
import { getEscapedCssVarName } from '@vue/shared'

export const CSS_VARS_HELPER = `useCssVars`

// 将变量数组转为 CSS 变量对象字面量字符串，供 Vue runtime _useCssVars() 使用。
export function genCssVarsFromList(
  vars: string[],
  id: string,
  isProd: boolean,
  isSSR = false,
): string {
  return `{\n  ${vars
    .map(
      key =>
        `"${isSSR ? `--` : ``}${genVarName(id, key, isProd, isSSR)}": (${key})`,
    )
    .join(',\n  ')}\n}`
}

// 生成 CSS 变量名，带组件 ID 和可选混淆（生产模式下使用 hash），也支持 SSR 时双重转义。
function genVarName(
  id: string,
  raw: string,
  isProd: boolean,
  isSSR = false,
): string {
  if (isProd) {
    return hash(id + raw)
  } else {
    // escape ASCII Punctuation & Symbols
    // #7823 need to double-escape in SSR because the attributes are rendered
    // into an HTML string
    return `${id}-${getEscapedCssVarName(raw, isSSR)}`
  }
}

// 去除表达式前后的 ' 或 " 字符（因为 v-bind('foo') 是合法用法）
function normalizeExpression(exp: string) {
  exp = exp.trim()
  if (
    (exp[0] === `'` && exp[exp.length - 1] === `'`) ||
    (exp[0] === `"` && exp[exp.length - 1] === `"`)
  ) {
    return exp.slice(1, -1)
  }
  return exp
}

const vBindRE = /v-bind\s*\(/g

// 从 SFCDescriptor 的 styles 数组中，提取所有 v-bind(...) 表达式中引用的变量名。
export function parseCssVars(sfc: SFCDescriptor): string[] {
  // 删除注释（/* ... */ 和 //）
  // 正则匹配 v-bind(...) 调用（只支持函数式）
  // 使用 lexBinding() 提取 (...) 中表达式范围
  // 通过 normalizeExpression 清除引号
  // 去重加入 vars 列表
  const vars: string[] = []
  sfc.styles.forEach(style => {
    let match
    // ignore v-bind() in comments, eg /* ... */
    // and // (Less, Sass and Stylus all support the use of // to comment)
    const content = style.content.replace(/\/\*([\s\S]*?)\*\/|\/\/.*/g, '')
    while ((match = vBindRE.exec(content))) {
      const start = match.index + match[0].length
      const end = lexBinding(content, start)
      if (end !== null) {
        const variable = normalizeExpression(content.slice(start, end))
        if (!vars.includes(variable)) {
          vars.push(variable)
        }
      }
    }
  })
  return vars
}

enum LexerState {
  inParens,
  inSingleQuoteString,
  inDoubleQuoteString,
}

// 扫描 CSS 内容中 v-bind(...) 的括号内容，正确提取表达式范围，支持嵌套括号和字符串字面量。
function lexBinding(content: string, start: number): number | null {
  let state: LexerState = LexerState.inParens
  let parenDepth = 0

  // 使用有限状态自动机（FSM）：
  // 状态：inParens, inSingleQuoteString, inDoubleQuoteString
  // 识别出右括号 ) 后停止
  for (let i = start; i < content.length; i++) {
    const char = content.charAt(i)
    switch (state) {
      case LexerState.inParens:
        if (char === `'`) {
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          state = LexerState.inDoubleQuoteString
        } else if (char === `(`) {
          parenDepth++
        } else if (char === `)`) {
          if (parenDepth > 0) {
            parenDepth--
          } else {
            return i
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          state = LexerState.inParens
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          state = LexerState.inParens
        }
        break
    }
  }
  return null
}

// for compileStyle
export interface CssVarsPluginOptions {
  id: string
  isProd: boolean
}

// 作为 PostCSS 插件，处理所有 CSS 中包含 v-bind(...) 的样式属性值，转为合法 CSS 变量引用：
export const cssVarsPlugin: PluginCreator<CssVarsPluginOptions> = opts => {
  const { id, isProd } = opts!
  return {
    postcssPlugin: 'vue-sfc-vars',
    Declaration(decl) {
      // rewrite CSS variables
      const value = decl.value
      if (vBindRE.test(value)) {
        vBindRE.lastIndex = 0
        let transformed = ''
        let lastIndex = 0
        let match
        while ((match = vBindRE.exec(value))) {
          const start = match.index + match[0].length
          const end = lexBinding(value, start)
          if (end !== null) {
            const variable = normalizeExpression(value.slice(start, end))
            transformed +=
              value.slice(lastIndex, match.index) +
              `var(--${genVarName(id, variable, isProd)})`
            lastIndex = end + 1
          }
        }
        decl.value = transformed + value.slice(lastIndex)
      }
    },
  }
}
cssVarsPlugin.postcss = true

export function genCssVarsCode(
  vars: string[],
  bindings: BindingMetadata,
  id: string,
  isProd: boolean,
) {
  const varsExp = genCssVarsFromList(vars, id, isProd)
  const exp = createSimpleExpression(varsExp, false)
  const context = createTransformContext(createRoot([]), {
    prefixIdentifiers: true,
    inline: true,
    bindingMetadata: bindings.__isScriptSetup === false ? undefined : bindings,
  })
  const transformed = processExpression(exp, context)
  const transformedString =
    transformed.type === NodeTypes.SIMPLE_EXPRESSION
      ? transformed.content
      : transformed.children
          .map(c => {
            return typeof c === 'string'
              ? c
              : (c as SimpleExpressionNode).content
          })
          .join('')

  return `_${CSS_VARS_HELPER}(_ctx => (${transformedString}))`
}

// <script setup> already gets the calls injected as part of the transform
// this is only for single normal <script>
// 用于传统 <script> 模式时，将上述 _useCssVars 的调用注入到组件 setup() 中。
export function genNormalScriptCssVarsCode(
  cssVars: string[],
  bindings: BindingMetadata,
  id: string,
  isProd: boolean,
  defaultVar: string,
): string {
  return (
    `\nimport { ${CSS_VARS_HELPER} as _${CSS_VARS_HELPER} } from 'vue'\n` +
    `const __injectCSSVars__ = () => {\n${genCssVarsCode(
      cssVars,
      bindings,
      id,
      isProd,
    )}}\n` +
    `const __setup__ = ${defaultVar}.setup\n` +
    `${defaultVar}.setup = __setup__\n` +
    `  ? (props, ctx) => { __injectCSSVars__();return __setup__(props, ctx) }\n` +
    `  : __injectCSSVars__\n`
  )
}
