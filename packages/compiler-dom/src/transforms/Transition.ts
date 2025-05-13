import {
  type ComponentNode,
  ElementTypes,
  type IfBranchNode,
  type NodeTransform,
  NodeTypes,
} from '@vue/compiler-core'
import { TRANSITION } from '../runtimeHelpers'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

// 在编译阶段检查并规范 <transition> 组件的子内容结构，确保符合 Vue 的运行时要求，并在某些情况下自动注入属性。
export const transformTransition: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.COMPONENT
  ) {
    // 仅处理组件节点，并且该组件是 Vue 内置 Transition；
    // 使用 context.isBuiltInComponent() 判断标签是否是 <Transition>（大小写无关）；
    const component = context.isBuiltInComponent(node.tag)
    if (component === TRANSITION) {
      return () => {
        // Vue 编译器的 NodeTransform 支持“延迟处理”子节点后的回调；
        // 这里的处理逻辑发生在子节点全部处理完之后。

        if (!node.children.length) {
          // <transition> 没有内容则不做任何处理。
          return
        }

        // warn multiple transition children
        if (hasMultipleChildren(node)) {
          // <transition> 必须只包裹一个子元素；
          // 若包含多个节点（包括空文本或注释），会报错；
          // 错误位置通过首尾子节点位置标示出来。
          context.onError(
            createDOMCompilerError(
              DOMErrorCodes.X_TRANSITION_INVALID_CHILDREN,
              {
                start: node.children[0].loc.start,
                end: node.children[node.children.length - 1].loc.end,
                source: '',
              },
            ),
          )
        }

        // check if it's s single child w/ v-show
        // if yes, inject "persisted: true" to the transition props
        // Vue 的 <transition> 在包裹使用 v-show 的元素时，为了避免退出动画时丢失节点，需要加 persisted 属性//
        // 编译器在这里 自动注入 persisted 属性，无需用户手动声明。
        const child = node.children[0]
        if (child.type === NodeTypes.ELEMENT) {
          for (const p of child.props) {
            if (p.type === NodeTypes.DIRECTIVE && p.name === 'show') {
              node.props.push({
                type: NodeTypes.ATTRIBUTE,
                name: 'persisted',
                nameLoc: node.loc,
                value: undefined,
                loc: node.loc,
              })
            }
          }
        }
      }
    }
  }
}

// 用于判断 <transition> 子内容是否合法：
// 过滤掉无意义的空白文本节点与注释；
// 若仍存在多个子节点，或包含 v-for、v-if 分支多个子节点的情况，则视为非法；
// 递归处理 v-if 的分支。
function hasMultipleChildren(node: ComponentNode | IfBranchNode): boolean {
  // #1352 filter out potential comment nodes.
  const children = (node.children = node.children.filter(
    c =>
      c.type !== NodeTypes.COMMENT &&
      !(c.type === NodeTypes.TEXT && !c.content.trim()),
  ))
  const child = children[0]
  return (
    children.length !== 1 ||
    child.type === NodeTypes.FOR ||
    (child.type === NodeTypes.IF && child.branches.some(hasMultipleChildren))
  )
}
