import {
  type BlockStatement,
  type CallExpression,
  type CompilerError,
  type CompilerOptions,
  ElementTypes,
  type IfStatement,
  type JSChildNode,
  NodeTypes,
  type RootNode,
  type TemplateChildNode,
  type TemplateLiteral,
  createBlockStatement,
  createCallExpression,
  createCompoundExpression,
  createRoot,
  createSimpleExpression,
  createTemplateLiteral,
  createTransformContext,
  isText,
  processExpression,
} from '@vue/compiler-dom'
import { escapeHtml, isString } from '@vue/shared'
import { SSR_INTERPOLATE, ssrHelpers } from './runtimeHelpers'
import { ssrProcessIf } from './transforms/ssrVIf'
import { ssrProcessFor } from './transforms/ssrVFor'
import { ssrProcessSlotOutlet } from './transforms/ssrTransformSlotOutlet'
import { ssrProcessComponent } from './transforms/ssrTransformComponent'
import { ssrProcessElement } from './transforms/ssrTransformElement'
import { SSRErrorCodes, createSSRCompilerError } from './errors'

// 第二遍遍历的核心执行器，称为 ssrCodegenTransform，它最终会把模板的 AST（抽象语法树）转为服务端可执行的 JavaScript 渲染函数代码。
// 核心目标
// 将模板 AST 编译为 SSR 渲染函数体，例如：
// function ssrRender(_ctx, _push, _parent, _attrs) {
//   _push(`<div>Hello</div>`)
// }

// Because SSR codegen output is completely different from client-side output
// (e.g. multiple elements can be concatenated into a single template literal
// instead of each getting a corresponding call), we need to apply an extra
// transform pass to convert the template AST into a fresh JS AST before
// passing it to codegen.

// 这是 SSR 代码生成的主入口函数
export function ssrCodegenTransform(
  ast: RootNode,
  options: CompilerOptions,
): void {
  // 创建 SSR 编译上下文
  // 这个 context 封装了：
  // 输出代码块 context.body
  // 工具函数：如 pushStringPart() / pushStatement()
  // helpers 收集器：用于跟踪需要 import 的 runtime 函数
  const context = createSSRTransformContext(ast, options)

  // inject SFC <style> CSS variables
  // we do this instead of inlining the expression to ensure the vars are
  // only resolved once per render
  // 注入 _cssVars（若有）
  if (options.ssrCssVars) {
    const cssContext = createTransformContext(createRoot([]), options)
    const varsExp = processExpression(
      createSimpleExpression(options.ssrCssVars, false),
      cssContext,
    )
    context.body.push(
      createCompoundExpression([`const _cssVars = { style: `, varsExp, `}`]),
    )
    Array.from(cssContext.helpers.keys()).forEach(helper => {
      ast.helpers.add(helper)
    })
  }

  // 调用 processChildren(...) 渲染所有子节点
  // 会根据每个节点的类型调用对应的处理函数：
  // <div> → ssrProcessElement
  // <Comp> → ssrProcessComponent
  // v-if → ssrProcessIf
  // {{ expression }} → 插入 _push(_interpolate(...))
  const isFragment =
    ast.children.length > 1 && ast.children.some(c => !isText(c))
  processChildren(ast, context, isFragment)
  // 构建最终的 codegenNode
  // 这就是 SSR 渲染函数的函数体。
  ast.codegenNode = createBlockStatement(context.body)

  // Finalize helpers.
  // We need to separate helpers imported from 'vue' vs. '@vue/server-renderer'
  // 拆分 helpers：
  ast.ssrHelpers = Array.from(
    new Set([
      ...Array.from(ast.helpers).filter(h => h in ssrHelpers),
      ...context.helpers,
    ]),
  )

  ast.helpers = new Set(Array.from(ast.helpers).filter(h => !(h in ssrHelpers)))
}

export interface SSRTransformContext {
  root: RootNode
  options: CompilerOptions
  body: (JSChildNode | IfStatement)[]
  helpers: Set<symbol>
  withSlotScopeId: boolean
  onError: (error: CompilerError) => void
  helper<T extends symbol>(name: T): T
  pushStringPart(part: TemplateLiteral['elements'][0]): void
  pushStatement(statement: IfStatement | CallExpression): void
}

function createSSRTransformContext(
  root: RootNode,
  options: CompilerOptions,
  helpers: Set<symbol> = new Set(),
  withSlotScopeId = false,
): SSRTransformContext {
  const body: BlockStatement['body'] = []
  let currentString: TemplateLiteral | null = null

  return {
    root,
    options,
    body,
    helpers,
    withSlotScopeId,
    onError:
      options.onError ||
      (e => {
        throw e
      }),
    helper<T extends symbol>(name: T): T {
      helpers.add(name)
      return name
    },
    pushStringPart(part) {
      if (!currentString) {
        const currentCall = createCallExpression(`_push`)
        body.push(currentCall)
        currentString = createTemplateLiteral([])
        currentCall.arguments.push(currentString)
      }
      const bufferedElements = currentString.elements
      const lastItem = bufferedElements[bufferedElements.length - 1]
      if (isString(part) && isString(lastItem)) {
        bufferedElements[bufferedElements.length - 1] += part
      } else {
        bufferedElements.push(part)
      }
    },
    pushStatement(statement) {
      // close current string
      currentString = null
      body.push(statement)
    },
  }
}

function createChildContext(
  parent: SSRTransformContext,
  withSlotScopeId = parent.withSlotScopeId,
): SSRTransformContext {
  // ensure child inherits parent helpers
  return createSSRTransformContext(
    parent.root,
    parent.options,
    parent.helpers,
    withSlotScopeId,
  )
}

interface Container {
  children: TemplateChildNode[]
}

// 递归遍历 AST 子节点的核心
// 如果 asFragment，会插入 <!--[--> ... <!--]-->
// 遍历每个 child：
// ELEMENT → 调用 ssrProcessElement
// COMPONENT → 调用 ssrProcessComponent
// TEXT → 插入字符串
// INTERPOLATION → 调用 _interpolate(...)
// COMMENT → 输出 <!-- comment -->
// IF → 调用 ssrProcessIf
// FOR → 调用 ssrProcessFor
export function processChildren(
  parent: Container,
  context: SSRTransformContext,
  asFragment = false,
  disableNestedFragments = false,
  disableComment = false,
): void {
  if (asFragment) {
    context.pushStringPart(`<!--[-->`)
  }
  const { children } = parent
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    switch (child.type) {
      case NodeTypes.ELEMENT:
        switch (child.tagType) {
          case ElementTypes.ELEMENT:
            ssrProcessElement(child, context)
            break
          case ElementTypes.COMPONENT:
            ssrProcessComponent(child, context, parent)
            break
          case ElementTypes.SLOT:
            ssrProcessSlotOutlet(child, context)
            break
          case ElementTypes.TEMPLATE:
            // TODO
            break
          default:
            context.onError(
              createSSRCompilerError(
                SSRErrorCodes.X_SSR_INVALID_AST_NODE,
                (child as any).loc,
              ),
            )
            // make sure we exhaust all possible types
            const exhaustiveCheck: never = child
            return exhaustiveCheck
        }
        break
      case NodeTypes.TEXT:
        context.pushStringPart(escapeHtml(child.content))
        break
      case NodeTypes.COMMENT:
        // no need to escape comment here because the AST can only
        // contain valid comments.
        if (!disableComment) {
          context.pushStringPart(`<!--${child.content}-->`)
        }
        break
      case NodeTypes.INTERPOLATION:
        context.pushStringPart(
          createCallExpression(context.helper(SSR_INTERPOLATE), [
            child.content,
          ]),
        )
        break
      case NodeTypes.IF:
        ssrProcessIf(child, context, disableNestedFragments, disableComment)
        break
      case NodeTypes.FOR:
        ssrProcessFor(child, context, disableNestedFragments)
        break
      case NodeTypes.IF_BRANCH:
        // no-op - handled by ssrProcessIf
        break
      case NodeTypes.TEXT_CALL:
      case NodeTypes.COMPOUND_EXPRESSION:
        // no-op - these two types can never appear as template child node since
        // `transformText` is not used during SSR compile.
        break
      default:
        context.onError(
          createSSRCompilerError(
            SSRErrorCodes.X_SSR_INVALID_AST_NODE,
            (child as any).loc,
          ),
        )
        // make sure we exhaust all possible types
        const exhaustiveCheck: never = child
        return exhaustiveCheck
    }
  }
  if (asFragment) {
    context.pushStringPart(`<!--]-->`)
  }
}

// 我们需要在 FunctionExpression.body 或 IfStatement.consequent 等位置插入 BlockStatement，会调用这个函数。
// 创建新的 SSRTransformContext（继承父上下文）
// 执行 processChildren(...)
// 把上下文中的 body 封装为 createBlockStatement(...)
// 用于生成：
// () => {
//   _push(`<div>slot content</div>`)
// }
export function processChildrenAsStatement(
  parent: Container,
  parentContext: SSRTransformContext,
  asFragment = false,
  withSlotScopeId: boolean = parentContext.withSlotScopeId,
): BlockStatement {
  const childContext = createChildContext(parentContext, withSlotScopeId)
  processChildren(parent, childContext, asFragment)
  return createBlockStatement(childContext.body)
}
