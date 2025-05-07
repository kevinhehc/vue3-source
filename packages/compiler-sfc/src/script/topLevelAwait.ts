import type { AwaitExpression } from '@babel/types'
import type { ScriptCompileContext } from './context'

/**
 * Support context-persistence between top-level await expressions:
 *
 * ```js
 * const instance = getCurrentInstance()
 * await foo()
 * expect(getCurrentInstance()).toBe(instance)
 * ```
 *
 * In the future we can potentially get rid of this when Async Context
 * becomes generally available: https://github.com/tc39/proposal-async-context
 *
 * ```js
 * // input
 * await foo()
 * // output
 * ;(
 *   ([__temp,__restore] = withAsyncContext(() => foo())),
 *   await __temp,
 *   __restore()
 * )
 *
 * // input
 * const a = await foo()
 * // output
 * const a = (
 *   ([__temp, __restore] = withAsyncContext(() => foo())),
 *   __temp = await __temp,
 *   __restore(),
 *   __temp
 * )
 * ```
 */

// 用于处理 <script setup> 中出现的 await 表达式，特别是当 await 直接位于顶层或语句中时，
// 需要将其包裹到 Vue 的 withAsyncContext() 语义结构中，以实现正确的异步处理和上下文跟踪。
export function processAwait(
  // ctx: 编译上下文对象，包含源码字符串、工具函数等。
  // node: 当前要处理的 AwaitExpression AST 节点。
  // needSemi: 布尔值，是否需要在前面加分号。
  // isStatement: 布尔值，表示当前 await 是否是一个独立语句（而不是表达式的一部分）。
  ctx: ScriptCompileContext,
  node: AwaitExpression,
  needSemi: boolean,
  isStatement: boolean,
): void {
  // 计算 await 后面表达式的起始位置 argumentStart：
  // 如果表达式被括号包裹（如 await (foo())），则取括号起始位置；
  // 否则直接取表达式的 start 位置。
  const argumentStart =
    node.argument.extra && node.argument.extra.parenthesized
      ? (node.argument.extra.parenStart as number)
      : node.argument.start!

  const startOffset = ctx.startOffset!
  // 计算偏移量并提取 await 表达式的源代码字符串：
  const argumentStr = ctx.descriptor.source.slice(
    argumentStart + startOffset,
    node.argument.end! + startOffset,
  )

  // 检查是否在表达式中还有嵌套的 await：
  const containsNestedAwait = /\bawait\b/.test(argumentStr)

  // 调用 ctx.s.overwrite 和 ctx.s.appendLeft 操作源码（使用 MagicString）：
  // 把原始 await xxx 重写为如下结构：
  // ([__temp,__restore] = withAsyncContext(() => xxx)),
  // __temp = await __temp,
  // __restore(),
  // __temp
  // 如果嵌套了 await，会在 () => 前加上 async；
  // 如果是语句（如 await foo() 独立成一行），最后不会返回 __temp；
  // 如果是表达式（如 const result = await foo()），则需要把结果赋值回去。
  ctx.s.overwrite(
    node.start! + startOffset,
    argumentStart + startOffset,
    `${needSemi ? `;` : ``}(\n  ([__temp,__restore] = ${ctx.helper(
      `withAsyncContext`,
    )}(${containsNestedAwait ? `async ` : ``}() => `,
  )
  ctx.s.appendLeft(
    node.end! + startOffset,
    `)),\n  ${isStatement ? `` : `__temp = `}await __temp,\n  __restore()${
      isStatement ? `` : `,\n  __temp`
    }\n)`,
  )
  // 例子：
  //
  // 原始代码：
  // const data = await fetchData()
  // 转换后（示意）：
  // const data = (
  //   ([__temp, __restore] = withAsyncContext(async () => fetchData())),
  //   __temp = await __temp,
  //   __restore(),
  //   __temp
  // )
  // 这样做的目的是：让 await 在 <script setup> 中也拥有和普通 setup() 一样的上下文追踪能力（比如访问当前组件实例、处理错误、追踪异步状态等）。
}
