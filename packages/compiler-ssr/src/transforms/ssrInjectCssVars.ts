import {
  ElementTypes,
  type NodeTransform,
  NodeTypes,
  type RootNode,
  type TemplateChildNode,
  createSimpleExpression,
  findDir,
  locStub,
} from '@vue/compiler-dom'

// 背景理解：为什么客户端不需要 ssrCssVars
// 在客户端渲染（CSR）中：
// Vue 模板里的 style 绑定（如 :style="{ '--color': color }"）会自动追踪响应式依赖。
// 当 color 变化时，Vue 会自动更新 DOM 样式。
// 所以在客户端，无需显式声明 cssVars。
//
// SSR 的问题
// 在 SSR 中：
// 模板是在 Node.js 中一次性渲染为 HTML 字符串。
// 没有响应式系统运行时，不会自动追踪和收集 style 中用到的变量。
// 因此 :style="{ '--color': color }" 这样的绑定不会自动出现在服务器渲染结果中。

// 用于在服务端渲染过程中注入 CSS 变量的处理逻辑。
// 记录并处理 _cssVars 引用
// 向对应 AST 节点注入样式依赖信息，供最终代码生成使用
export const ssrInjectCssVars: NodeTransform = (node, context) => {
  // 判断当前是否启用 cssVars
  // context.ssrCssVars 是 Vue SFC 编译时分析出的 CSS 变量表达式数组（如：--color: x）
  // 如果没有 CSS 变量，就直接跳过
  if (!context.ssrCssVars) {
    return
  }

  // _cssVars is initialized once per render function
  // the code is injected in ssrCodegenTransform when creating the
  // ssr transform context
  // 如果是根节点，注册 _cssVars 变量
  // 这里的 _cssVars 是一个在每个 render 函数中初始化一次的变量
  // 在 SSR 中不会自动保留 setup() 中的响应式作用域，需要手动记录
  if (node.type === NodeTypes.ROOT) {
    context.identifiers._cssVars = 1
  }

  // 只在顶层节点时处理子节点
  const parent = context.parent
  if (!parent || parent.type !== NodeTypes.ROOT) {
    return
  }

  // 注入样式变量表达式
  if (node.type === NodeTypes.IF_BRANCH) {
    // 如果当前节点是 v-if 分支（IF_BRANCH），说明它的子节点是实际的元素，必须逐个注入
    for (const child of node.children) {
      injectCssVars(child)
    }
  } else {
    // 否则直接对当前节点调用 injectCssVars
    injectCssVars(node)
  }
}

// 在合适的 AST 节点（元素或组件）上注入 :style="_cssVars"，确保服务端渲染时样式变量正确输出。
function injectCssVars(node: RootNode | TemplateChildNode) {
  // RootNode：模板根节点
  // TemplateChildNode：模板中的子元素（元素、文本、注释、指令等）

  if (
    // 判断是否是合适的元素节点
    // 必须是 HTML 原生元素或 Vue 组件（排除 v-for 因为它们自己管理作用域）
    // 不能是 v-for 循环生成的节点（避免多次注入）
    node.type === NodeTypes.ELEMENT &&
    (node.tagType === ElementTypes.ELEMENT ||
      node.tagType === ElementTypes.COMPONENT) &&
    !findDir(node, 'for')
  ) {
    // 处理 <suspense> 特殊情况
    if (node.tag === 'suspense' || node.tag === 'Suspense') {
      // Suspense 组件的结构特殊，子节点可能是 <template>（插槽）
      // 所以要递归进入其子节点，继续注入样式绑定
      for (const child of node.children) {
        if (
          child.type === NodeTypes.ELEMENT &&
          child.tagType === ElementTypes.TEMPLATE
        ) {
          // suspense slot
          child.children.forEach(injectCssVars)
        } else {
          injectCssVars(child)
        }
      }
    } else {
      // 给普通元素添加 :style="_cssVars" 绑定
      node.props.push({
        type: NodeTypes.DIRECTIVE,
        name: 'bind',
        arg: undefined,
        exp: createSimpleExpression(`_cssVars`, false),
        modifiers: [],
        loc: locStub,
      })
    }
  }
}
