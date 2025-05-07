import { analyzeScriptBindings } from './analyzeScriptBindings'
import type { ScriptCompileContext } from './context'
import MagicString from 'magic-string'
import { rewriteDefaultAST } from '../rewriteDefault'
import { genNormalScriptCssVarsCode } from '../style/cssVars'
import type { SFCScriptBlock } from '../parse'

export const normalScriptDefaultVar = `__default__`

// Vue SFC 编译器中用来处理 <script> 普通脚本块的。
// 主要目标是：
// 对默认导出进行重写，将 export default {} 转换为变量形式；
// 生成 CSS 变量注入代码，当组件使用了 CSS 变量时；
// 返回更新后的 script 区块内容和相关信息。
export function processNormalScript(
  ctx: ScriptCompileContext,
  scopeId: string,
): SFCScriptBlock {
  // 首先获取 ctx.descriptor.script，也就是原始的 <script> 内容。
  const script = ctx.descriptor.script!
  if (script.lang && !ctx.isJS && !ctx.isTS) {
    // 如果这个 script 使用的是非 JavaScript/TypeScript 的语言（如 CoffeeScript、Pug 等），
    // 并且当前不是 JS/TS 模式，就跳过处理，直接返回原内容。
    // do not process non js/ts script blocks
    return script
  }
  try {
    // 获取 script 内容、source map、AST 和变量绑定分析结果。
    let content = script.content
    let map = script.map
    const scriptAst = ctx.scriptAst!
    const bindings = analyzeScriptBindings(scriptAst.body)
    const { cssVars } = ctx.descriptor
    // 读取 CSS 变量信息（来自 SFC 分析器）和一些配置项，比如：
    // genDefaultAs: 如果设置了该值，表示要把默认导出改写为指定变量名；
    // isProd: 是否为生产模式；
    const { genDefaultAs, isProd } = ctx.options

    // 如果存在 CSS 变量或启用了 genDefaultAs，则进行以下处理：
    if (cssVars.length || genDefaultAs) {
      // 使用 MagicString 包装源码，进行可追踪的代码改写；
      // 调用 rewriteDefaultAST 将 export default {} 改写为 const __default__ = {}，或自定义变量名；
      // 如果有 CSS 变量，且不是 SSR，调用 genNormalScriptCssVarsCode 生成相关注入代码；
      // 如果没有设置 genDefaultAs，补上一行 export default __default__。
      const defaultVar = genDefaultAs || normalScriptDefaultVar
      const s = new MagicString(content)
      rewriteDefaultAST(scriptAst.body, s, defaultVar)
      content = s.toString()
      if (cssVars.length && !ctx.options.templateOptions?.ssr) {
        content += genNormalScriptCssVarsCode(
          cssVars,
          bindings,
          scopeId,
          !!isProd,
          defaultVar,
        )
      }
      if (!genDefaultAs) {
        content += `\nexport default ${defaultVar}`
      }
    }
    // 最终返回一个新的 script 块对象，其中包含修改后的代码内容、变量绑定、AST 等信息。
    return {
      ...script,
      content,
      map,
      bindings,
      scriptAst: scriptAst.body,
    }
  } catch (e: any) {
    // silently fallback if parse fails since user may be using custom
    // babel syntax
    // 如果中途出错（例如使用了非标准 babel 插件导致 AST 解析失败），会捕获异常并静默回退到原始 script 内容。
    return script
  }
}
