import {
  ElementTypes,
  type NodeTransform,
  NodeTypes,
  type ParentNode,
  type RootNode,
  type TemplateChildNode,
  createSimpleExpression,
  findDir,
  locStub,
} from '@vue/compiler-dom'

// 在服务端渲染时处理“透传属性”（fallthrough attributes），也就是将组件接收到的非 prop 属性正确地绑定到根元素上（例如 $attrs 中的内容）。

// 过滤掉注释节点
const filterChild = (node: ParentNode) =>
  node.children.filter(n => n.type !== NodeTypes.COMMENT)

// 判断是否只有一个子节点
const hasSingleChild = (node: ParentNode): boolean =>
  filterChild(node).length === 1

export const ssrInjectFallthroughAttrs: NodeTransform = (node, context) => {
  // _attrs is provided as a function argument.
  // mark it as a known identifier so that it doesn't get prefixed by
  // transformExpression.
  // 注册 _attrs 变量
  // 注册 _attrs 为“已知标识符”
  // 避免后续 transform 给它加 ctx. 前缀
  if (node.type === NodeTypes.ROOT) {
    context.identifiers._attrs = 1
  }

  // 特例处理：<transition>、<keep-alive> 的子节点
  if (
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.COMPONENT &&
    (node.tag === 'transition' ||
      node.tag === 'Transition' ||
      node.tag === 'KeepAlive' ||
      node.tag === 'keep-alive')
  ) {
    // 如果根节点是这类“包装组件”，并且它里面只有一个元素子节点，那么把 _attrs 注入给这个实际渲染的子元素。
    const rootChildren = filterChild(context.root)
    if (rootChildren.length === 1 && rootChildren[0] === node) {
      if (hasSingleChild(node)) {
        injectFallthroughAttrs(node.children[0])
      }
      return
    }
  }

  // 普通组件场景：父节点是根节点，且当前节点是唯一子节点
  const parent = context.parent
  if (!parent || parent.type !== NodeTypes.ROOT) {
    return
  }

  // v-if 分支是唯一子节点
  if (node.type === NodeTypes.IF_BRANCH && hasSingleChild(node)) {
    // detect cases where the parent v-if is not the only root level node
    let hasEncounteredIf = false
    for (const c of filterChild(parent)) {
      if (
        c.type === NodeTypes.IF ||
        (c.type === NodeTypes.ELEMENT && findDir(c, 'if'))
      ) {
        // multiple root v-if
        if (hasEncounteredIf) return
        hasEncounteredIf = true
      } else if (
        // node before v-if
        !hasEncounteredIf ||
        // non else nodes
        !(c.type === NodeTypes.ELEMENT && findDir(c, /else/, true))
      ) {
        return
      }
    }
    injectFallthroughAttrs(node.children[0])
  } else if (hasSingleChild(parent)) {
    // 当前元素是根节点下唯一有效子节点
    injectFallthroughAttrs(node)
  }
}

// 相当于在模板中自动添加：
// <div v-bind="_attrs" />
// 最终 SSR 渲染函数中就会生成：
// ssrRenderAttrs(_attrs)
function injectFallthroughAttrs(node: RootNode | TemplateChildNode) {
  if (
    node.type === NodeTypes.ELEMENT &&
    (node.tagType === ElementTypes.ELEMENT ||
      node.tagType === ElementTypes.COMPONENT) &&
    !findDir(node, 'for')
  ) {
    node.props.push({
      type: NodeTypes.DIRECTIVE,
      name: 'bind',
      arg: undefined,
      exp: createSimpleExpression(`_attrs`, false),
      modifiers: [],
      loc: locStub,
    })
  }
}
