import {
  type AttributeNode,
  type ComponentNode,
  type DirectiveNode,
  type JSChildNode,
  NodeTypes,
  type TransformContext,
  buildProps,
  createCallExpression,
  findProp,
} from '@vue/compiler-dom'
import { SSR_RENDER_ATTRS } from '../runtimeHelpers'
import {
  type SSRTransformContext,
  processChildren,
} from '../ssrCodegenTransform'
import { buildSSRProps } from './ssrTransformElement'

// 由于 <transition-group> 本质上是一个容器组件，
// 会渲染为某个指定的 HTML 标签（如 div、ul、span）或动态标签，所以编译逻辑和其他组件（如 <transition>）不同。

const wipMap = new WeakMap<ComponentNode, WIPEntry>()

interface WIPEntry {
  tag: AttributeNode | DirectiveNode
  propsExp: string | JSChildNode | null
  scopeId: string | null
}

// phase 1: build props
// 提取 tag 属性并构建 SSR props 表达式，存入 wipMap
// 这是第一阶段 transform，用于准备数据，后续 ssrProcess... 再真正生成输出。
export function ssrTransformTransitionGroup(
  node: ComponentNode,
  context: TransformContext,
) {
  // <transition-group tag="ul"> → 提取 tag="ul" 为 AttributeNode
  // <transition-group :tag="dynamicTag"> → 提取为 DirectiveNode
  // 然后提取其他 props 并生成：
  // propsExp = SSR_RENDER_ATTRS(MERGE_PROPS(...))
  // 最后放入 wipMap 缓存：
  return (): void => {
    const tag = findProp(node, 'tag')
    if (tag) {
      const otherProps = node.props.filter(p => p !== tag)
      const { props, directives } = buildProps(
        node,
        context,
        otherProps,
        true /* isComponent */,
        false /* isDynamicComponent */,
        true /* ssr (skip event listeners) */,
      )
      let propsExp = null
      if (props || directives.length) {
        propsExp = createCallExpression(context.helper(SSR_RENDER_ATTRS), [
          buildSSRProps(props, directives, context),
        ])
      }
      //         tag,          // tag prop (AttributeNode or DirectiveNode)
      //         propsExp,     // props 渲染表达式
      //         scopeId,      // CSS scoped ID
      wipMap.set(node, {
        tag,
        propsExp,
        scopeId: context.scopeId || null,
      })
    }
  }
}

// phase 2: process children
// 用构建好的 tag + props 输出标签结构，渲染 children
// 第二阶段，根据上一步的缓存，实际生成字符串：
export function ssrProcessTransitionGroup(
  node: ComponentNode,
  context: SSRTransformContext,
): void {
  const entry = wipMap.get(node)
  if (entry) {
    const { tag, propsExp, scopeId } = entry
    // 一样拼接 props、scopeId，最终变成：
    // <ul class="..." style="..." data-v-xxx>
    //   ...children...
    // </ul>
    if (tag.type === NodeTypes.DIRECTIVE) {
      // dynamic :tag
      // 动态 tag（:tag="el"）
      context.pushStringPart(`<`)
      context.pushStringPart(tag.exp!)
      if (propsExp) {
        context.pushStringPart(propsExp)
      }
      if (scopeId) {
        context.pushStringPart(` ${scopeId}`)
      }
      context.pushStringPart(`>`)

      processChildren(
        node,
        context,
        false,
        /**
         * TransitionGroup has the special runtime behavior of flattening and
         * concatenating all children into a single fragment (in order for them to
         * be patched using the same key map) so we need to account for that here
         * by disabling nested fragment wrappers from being generated.
         */
        true,
        /**
         * TransitionGroup filters out comment children at runtime and thus
         * doesn't expect comments to be present during hydration. We need to
         * account for that by disabling the empty comment that is otherwise
         * rendered for a falsy v-if that has no v-else specified. (#6715)
         */
        true,
      )
      context.pushStringPart(`</`)
      context.pushStringPart(tag.exp!)
      context.pushStringPart(`>`)
    } else {
      // static tag
      //  静态 tag（tag="ul"）
      context.pushStringPart(`<${tag.value!.content}`)
      if (propsExp) {
        context.pushStringPart(propsExp)
      }
      if (scopeId) {
        context.pushStringPart(` ${scopeId}`)
      }
      context.pushStringPart(`>`)
      processChildren(node, context, false, true, true)
      context.pushStringPart(`</${tag.value!.content}>`)
    }
  } else {
    // fragment
    processChildren(node, context, true, true, true)
  }
}
