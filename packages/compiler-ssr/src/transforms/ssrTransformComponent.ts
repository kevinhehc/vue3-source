import {
  CREATE_VNODE,
  type CallExpression,
  type CompilerOptions,
  type ComponentNode,
  DOMDirectiveTransforms,
  DOMNodeTransforms,
  type DirectiveNode,
  ElementTypes,
  type ExpressionNode,
  type FunctionExpression,
  type JSChildNode,
  Namespaces,
  type NodeTransform,
  NodeTypes,
  RESOLVE_DYNAMIC_COMPONENT,
  type ReturnStatement,
  type RootNode,
  SUSPENSE,
  type SlotFnBuilder,
  TELEPORT,
  TRANSITION,
  TRANSITION_GROUP,
  type TemplateChildNode,
  type TemplateNode,
  type TransformContext,
  type TransformOptions,
  buildProps,
  buildSlots,
  createCallExpression,
  createFunctionExpression,
  createIfStatement,
  createReturnStatement,
  createRoot,
  createSimpleExpression,
  createTransformContext,
  getBaseTransformPreset,
  locStub,
  resolveComponentType,
  stringifyExpression,
  traverseNode,
} from '@vue/compiler-dom'
import { SSR_RENDER_COMPONENT, SSR_RENDER_VNODE } from '../runtimeHelpers'
import {
  type SSRTransformContext,
  processChildren,
  processChildrenAsStatement,
} from '../ssrCodegenTransform'
import { ssrProcessTeleport } from './ssrTransformTeleport'
import {
  ssrProcessSuspense,
  ssrTransformSuspense,
} from './ssrTransformSuspense'
import {
  ssrProcessTransitionGroup,
  ssrTransformTransitionGroup,
} from './ssrTransformTransitionGroup'
import { extend, isArray, isObject, isPlainObject, isSymbol } from '@vue/shared'
import { buildSSRProps } from './ssrTransformElement'
import {
  ssrProcessTransition,
  ssrTransformTransition,
} from './ssrTransformTransition'

// 在 SSR 模式下，为了让组件能够正确渲染插槽内容，同时兼容客户端 fallback，需要将组件编译拆为两个阶段：

// We need to construct the slot functions in the 1st pass to ensure proper
// scope tracking, but the children of each slot cannot be processed until
// the 2nd pass, so we store the WIP slot functions in a weakMap during the 1st
// pass and complete them in the 2nd pass.
// 保存插槽函数壳子 + 子节点
// 插槽的 AST 函数结构（还没生成 body）
// 原始 children
// 备用 VNode 渲染的 fallback 分支（客户端 fallback）
const wipMap = new WeakMap<ComponentNode, WIPSlotEntry[]>()

// 这个 Symbol 代表“工作中插槽”（Work-In-Progress Slot），用于标识在 SSR 编译器中还未完成 body 内容生成的插槽函数。
// 它作为 WIPSlotEntry.type 字段的唯一值，使得你在运行时可以快速判断一个对象是不是“待完成插槽”。
const WIP_SLOT = Symbol()

// 表示一个插槽的编译中间结构（还未填充内容的函数）
interface WIPSlotEntry {
  // 固定为 WIP_SLOT，标识类型
  type: typeof WIP_SLOT
  // 插槽函数的 AST 结构（FunctionExpression），是 () => {} 的壳子
  fn: FunctionExpression
  // 插槽的原始子节点，用于后续转换成 SSR 语句
  children: TemplateChildNode[]
  // 同一个插槽的 fallback 分支（VNode 渲染时的 return xxx）
  vnodeBranch: ReturnStatement
}

// 一个记录**每个组件节点的“解析后的类型”**的 WeakMap，目的是为了在第二阶段处理组件时知道：
// 是静态组件？字符串类型？比如 "MyButton"
// 是动态组件？比如 resolveDynamicComponent(foo)
// 是内置组件？比如 KeepAlive、Suspense（symbol）
const componentTypeMap = new WeakMap<
  ComponentNode,
  string | symbol | CallExpression
>()

// ssr component transform is done in two phases:
// In phase 1. we use `buildSlot` to analyze the children of the component into
// WIP slot functions (it must be done in phase 1 because `buildSlot` relies on
// the core transform context).
// In phase 2. we convert the WIP slots from phase 1 into ssr-specific codegen
// nodes.
// 提前分析组件节点的 props 和 slots，构建初步的 SSR 渲染代码框架，并保存未完成的 slot 函数，等待第二阶段补全。
// 总体分两阶段
// 阶段 1（ssrTransformComponent）：
// 分析组件类型
// 构造 slots 的函数壳子（没有 body）
// 生成 node.ssrCodegenNode（SSR 渲染调用表达式）
// 阶段 2（ssrProcessComponent）：
// 遍历前面保存的 wipEntries
// 为 slot 函数填充 body
// 调用 _push(...) 或 renderVNode(...) 输出最终字符串
export const ssrTransformComponent: NodeTransform = (node, context) => {
  // 仅处理组件节点
  if (
    node.type !== NodeTypes.ELEMENT ||
    node.tagType !== ElementTypes.COMPONENT
  ) {
    return
  }

  // 解析组件类型并保存到 componentTypeMap
  // 这一步确定：
  // 是静态组件（字符串）？
  // 动态组件（resolveDynamicComponent(...)）？
  // 内置组件（Suspense、KeepAlive 等 symbol）？
  const component = resolveComponentType(node, context, true /* ssr */)
  const isDynamicComponent =
    isObject(component) && component.callee === RESOLVE_DYNAMIC_COMPONENT
  componentTypeMap.set(node, component)

  // 对内置组件特殊处理
  // 这些组件会走各自的 transform 逻辑。
  if (isSymbol(component)) {
    if (component === SUSPENSE) {
      return ssrTransformSuspense(node, context)
    } else if (component === TRANSITION_GROUP) {
      return ssrTransformTransitionGroup(node, context)
    } else if (component === TRANSITION) {
      return ssrTransformTransition(node, context)
    }
    return // other built-in components: fallthrough
  }

  // Build the fallback vnode-based branch for the component's slots.
  // We need to clone the node into a fresh copy and use the buildSlots' logic
  // to get access to the children of each slot. We then compile them with
  // a child transform pipeline using vnode-based transforms (instead of ssr-
  // based ones), and save the result branch (a ReturnStatement) in an array.
  // The branch is retrieved when processing slots again in ssr mode.
  // 准备 fallback 分支：VNode 分支插槽
  // 为每个插槽创建一个 vnode fallback 分支。用 clone 是为了避免修改真实的 node（给后续 SSR 渲染使用）。
  const vnodeBranches: ReturnStatement[] = []
  const clonedNode = clone(node)

  return function ssrPostTransformComponent() {
    // Using the cloned node, build the normal VNode-based branches (for
    // fallback in case the child is render-fn based). Store them in an array
    // for later use.
    if (clonedNode.children.length) {
      // 构建 fallback 插槽函数
      // buildSlots() 遍历 <template #xxx> 插槽声明
      // 每个插槽会产生一个 fallback 分支 return [VNode...]
      // 插入到 vnodeBranches 中
      buildSlots(clonedNode, context, (props, vFor, children) => {
        vnodeBranches.push(
          createVNodeSlotBranch(props, vFor, children, context),
        )
        return createFunctionExpression(undefined)
      })
    }

    let propsExp: string | JSChildNode = `null`
    if (node.props.length) {
      // note we are not passing ssr: true here because for components, v-on
      // handlers should still be passed
      const { props, directives } = buildProps(
        node,
        context,
        undefined,
        true,
        isDynamicComponent,
      )
      if (props || directives.length) {
        propsExp = buildSSRProps(props, directives, context)
      }
    }

    const wipEntries: WIPSlotEntry[] = []
    wipMap.set(node, wipEntries)

    const buildSSRSlotFn: SlotFnBuilder = (props, _vForExp, children, loc) => {
      const param0 = (props && stringifyExpression(props)) || `_`
      // 构造 SSR 用的插槽函数壳子（无 body）
      const fn = createFunctionExpression(
        [param0, `_push`, `_parent`, `_scopeId`],
        undefined, // no return, assign body later
        true, // newline
        true, // isSlot
        loc,
      )
      // 并将其存入 wipEntries，同时保存 fallback vnode 分支：
      wipEntries.push({
        type: WIP_SLOT,
        fn,
        children,
        // also collect the corresponding vnode branch built earlier
        vnodeBranch: vnodeBranches[wipEntries.length],
      })
      return fn
    }

    const slots = node.children.length
      ? buildSlots(node, context, buildSSRSlotFn).slots
      : `null`

    if (typeof component !== 'string') {
      // dynamic component that resolved to a `resolveDynamicComponent` call
      // expression - since the resolved result may be a plain element (string)
      // or a VNode, handle it with `renderVNode`.
      // 最终生成 SSR 渲染调用表达式
      node.ssrCodegenNode = createCallExpression(
        context.helper(SSR_RENDER_VNODE),
        [
          `_push`,
          createCallExpression(context.helper(CREATE_VNODE), [
            component,
            propsExp,
            slots,
          ]),
          `_parent`,
        ],
      )
    } else {
      node.ssrCodegenNode = createCallExpression(
        context.helper(SSR_RENDER_COMPONENT),
        [component, propsExp, slots, `_parent`],
      )
    }
  }
}

// 根据组件在 transform 阶段（即 ssrTransformComponent）所生成的信息，生成最终的 SSR 渲染代码。
// 这是组件节点（如 <MyComponent>）在 SSR 中完成 slot 渲染、特殊处理、代码输出的关键一环。
// 有两个主路径：
// 1、没有 ssrCodegenNode（说明是内置组件或被跳过的组件） → 特殊处理或 fallback 渲染其子内容
// 2、有 ssrCodegenNode（transform 阶段已处理） → 渲染并完成插槽函数代码补全
export function ssrProcessComponent(
  node: ComponentNode,
  context: SSRTransformContext,
  parent: { children: TemplateChildNode[] },
): void {
  const component = componentTypeMap.get(node)!
  if (!node.ssrCodegenNode) {
    // 说明这个组件在 ssrTransformComponent() 时未生成 SSR 渲染代码，说明它是：
    // 内置组件：<Teleport> / <Suspense> / <TransitionGroup>...
    // 或真正的 fall-through 组件（<Transition> / <KeepAlive>）
    // this is a built-in component that fell-through.
    if (component === TELEPORT) {
      return ssrProcessTeleport(node, context)
    } else if (component === SUSPENSE) {
      return ssrProcessSuspense(node, context)
    } else if (component === TRANSITION_GROUP) {
      return ssrProcessTransitionGroup(node, context)
    } else {
      // real fall-through: Transition / KeepAlive
      // just render its children.
      // #5352: if is at root level of a slot, push an empty string.
      // this does not affect the final output, but avoids all-comment slot
      // content of being treated as empty by ssrRenderSlot().
      if ((parent as WIPSlotEntry).type === WIP_SLOT) {
        context.pushStringPart(``)
      }
      if (component === TRANSITION) {
        return ssrProcessTransition(node, context)
      }
      processChildren(node, context)
    }
  } else {
    // 正常组件 — 完成插槽函数补全 + 输出
    // finish up slot function expressions from the 1st pass.
    const wipEntries = wipMap.get(node) || []
    for (let i = 0; i < wipEntries.length; i++) {
      const { fn, vnodeBranch } = wipEntries[i]
      // For each slot, we generate two branches: one SSR-optimized branch and
      // one normal vnode-based branch. The branches are taken based on the
      // presence of the 2nd `_push` argument (which is only present if the slot
      // is called by `_ssrRenderSlot`.
      // 对每个插槽函数补全 fn.body
      fn.body = createIfStatement(
        createSimpleExpression(`_push`, false),
        processChildrenAsStatement(
          wipEntries[i],
          context,
          false,
          true /* withSlotScopeId */,
        ),
        vnodeBranch,
      )
    }

    // component is inside a slot, inherit slot scope Id
    // 如果组件处于插槽作用域中（如 <slot> 中），需要带上 _scopeId 参数，供渲染时用于正确作用于 scoped CSS。
    if (context.withSlotScopeId) {
      node.ssrCodegenNode.arguments.push(`_scopeId`)
    }

    // 对静态组件（'MyComp'）使用 _push(...)
    // 对动态组件（resolveDynamicComponent(...)）使用 renderVNode(...)，SSR 会调用它自己生成 DOM
    if (typeof component === 'string') {
      // static component
      context.pushStatement(
        createCallExpression(`_push`, [node.ssrCodegenNode]),
      )
    } else {
      // dynamic component (`resolveDynamicComponent` call)
      // the codegen node is a `renderVNode` call
      context.pushStatement(node.ssrCodegenNode)
    }
  }
}

// 用于将AST 的根节点与其对应的 编译选项 关联起来。
// 为什么需要这个？
// 插槽 fallback 分支是以一个新的子 RootNode 编译的。
// 但是子 transform 仍需要知道原始编译配置（比如是否启用某些 transform 插件等）。
// 所以编译器在 transform() 主流程中会调用：
// rawOptionsMap.set(root, options)
export const rawOptionsMap: WeakMap<RootNode, CompilerOptions> = new WeakMap<
  RootNode,
  CompilerOptions
>()

// 获取 transform 预设（针对 SSR）
// 调用 getBaseTransformPreset(true) 得到的是SSR 编译器的 transform 预设：
// baseNodeTransforms: 节点层级的转换，如 transformElement、transformText
// baseDirectiveTransforms: v-bind、v-on 等指令的转换函数集合
const [baseNodeTransforms, baseDirectiveTransforms] =
  getBaseTransformPreset(true)
// 构建 VNode fallback transform 配置
const vnodeNodeTransforms = [...baseNodeTransforms, ...DOMNodeTransforms]
// 将基础 transform + 浏览器相关 transform 组合成 vnode transform
// DOMNodeTransforms 是 @vue/compiler-dom 提供的针对真实 DOM 的 transform，如：
// transformStyle
// transformClass
// transformModel（v-model）
const vnodeDirectiveTransforms = {
  ...baseDirectiveTransforms,
  ...DOMDirectiveTransforms,
}

// 为插槽创建客户端 fallback 分支，用 vnode 编译方式将插槽内容包裹、变换，并返回一个 return 语句，
// 以供 ssrProcessComponent 中插入到插槽函数的 else 分支中。
function createVNodeSlotBranch(
  // slotProps: 插槽参数，如 v-slot="props" 中的 props
  // vFor: 若此插槽带有 v-for
  // children: 插槽子节点
  // parentContext: 父 transform 上下文，用于共享 scope/imports 等
  slotProps: ExpressionNode | undefined,
  vFor: DirectiveNode | undefined,
  children: TemplateChildNode[],
  parentContext: TransformContext,
): ReturnStatement {
  // apply a sub-transform using vnode-based transforms.
  // 获取原始 transform 配置，并覆写为 VNode 模式
  // 这里切换为“非 SSR transform 模式”，确保对 fallback 分支使用客户端 render 函数编译器。
  const rawOptions = rawOptionsMap.get(parentContext.root)!

  const subOptions = {
    ...rawOptions,
    // overwrite with vnode-based transforms
    nodeTransforms: [
      ...vnodeNodeTransforms,
      ...(rawOptions.nodeTransforms || []),
    ],
    directiveTransforms: {
      ...vnodeDirectiveTransforms,
      ...(rawOptions.directiveTransforms || {}),
    },
  }

  // wrap the children with a wrapper template for proper children treatment.
  // important: provide v-slot="props" and v-for="exp" on the wrapper for
  // proper scope analysis
  // 创建 <template> 包裹节点
  // 把插槽包在一个 <template> 节点里，是为了：
  // 提供插槽作用域 (v-slot)
  // 提供循环作用域 (v-for)
  // 正确建立 transform 分析作用域链
  const wrapperProps: TemplateNode['props'] = []
  if (slotProps) {
    wrapperProps.push({
      type: NodeTypes.DIRECTIVE,
      name: 'slot',
      exp: slotProps,
      arg: undefined,
      modifiers: [],
      loc: locStub,
    })
  }
  if (vFor) {
    wrapperProps.push(extend({}, vFor))
  }
  const wrapperNode: TemplateNode = {
    type: NodeTypes.ELEMENT,
    ns: Namespaces.HTML,
    tag: 'template',
    tagType: ElementTypes.TEMPLATE,
    props: wrapperProps,
    children,
    loc: locStub,
    codegenNode: undefined,
  }
  // 使用 vnode 编译器 对 wrapper 节点做一次完整 transform，得到 fallback 编译结果。
  subTransform(wrapperNode, subOptions, parentContext)
  return createReturnStatement(children)
}

// 在 SSR 插槽处理流程中，使用 VNode 编译模式对 fallback 分支（即客户端渲染）进行一次“子变换”编译。
// 用于 SSR 插槽的 fallback 分支中，用来在 SSR 编译器上下文中模拟一次**“客户端模式”**的 VNode 编译流程。
// 它可以让 Vue 在 SSR 插槽中为每个插槽生成两套编译结果：
// SSR 渲染分支（输出字符串）
// fallback 分支（客户端需要的 VNode）
function subTransform(
  node: TemplateChildNode,
  options: TransformOptions,
  parentContext: TransformContext,
) {
  // 构建根节点和子上下文
  // 将传入的 TemplateChildNode 包装成一个临时 root
  // 创建一个独立的 transform context（新的编译环境）
  const childRoot = createRoot([node])
  const childContext = createTransformContext(childRoot, options)
  // this sub transform is for vnode fallback branch so it should be handled
  // like normal render functions
  // 标记为客户端模式（非 SSR）
  // 因为我们需要生成 VNode fallback，所以关闭 SSR 标志
  // 它会触发使用普通的 transformElement、transformSlotOutlet 等
  childContext.ssr = false
  // inherit parent scope analysis state
  // 继承作用域分析状态
  // 这些信息来自父上下文：
  // 字段名	用途
  // scopes	变量作用域计数器（v-for、slot、scope）
  // identifiers	已声明变量（如 props）
  // imports	静态资源或 helper 导入信息
  // 继承它们是为了让子 transform 在 scope 上保持一致性，避免重复声明。
  childContext.scopes = { ...parentContext.scopes }
  childContext.identifiers = { ...parentContext.identifiers }
  childContext.imports = parentContext.imports
  // traverse
  // 对包裹的 AST 进行一次完整的 vnode 编译流程。
  traverseNode(childRoot, childContext)
  // merge helpers/components/directives into parent context
  // 合并输出的 helpers/components/directives
  ;(['helpers', 'components', 'directives'] as const).forEach(key => {
    childContext[key].forEach((value: any, helperKey: any) => {
      if (key === 'helpers') {
        // 合并 helper 引用计数
        const parentCount = parentContext.helpers.get(helperKey)
        if (parentCount === undefined) {
          parentContext.helpers.set(helperKey, value)
        } else {
          parentContext.helpers.set(helperKey, value + parentCount)
        }
      } else {
        // // 合并组件和指令集合
        ;(parentContext[key] as any).add(value)
      }
    })
  })
  // helpers: 代码生成所依赖的 Vue runtime helper（如 openBlock, createVNode）
  // components: 使用到的组件（用于注册）
  // directives: 使用到的指令（如 v-show）
  //
  // 注意：不合并 imports 和 hoists，因为它们对 SSR/VNode 是分支独立的。
  // imports/hoists are not merged because:
  // - imports are only used for asset urls and should be consistent between
  //   node/client branches
  // - hoists are not enabled for the client branch here
}

// Vue SSR 编译器内部的一个浅而递归的通用对象克隆工具，用来复制 AST 节点或数据结构，确保修改副本不会影响原始对象。
// 对输入的数组或纯对象进行深拷贝（但不包括特殊对象、类实例等），对原始值或其他非数组/对象的值则直接返回本身（引用）。
function clone(v: any): any {
  // 如果是数组，则对每一项递归调用 clone
  // 返回一个新的数组（每项都已复制）
  if (isArray(v)) {
    return v.map(clone)
  } else if (isPlainObject(v)) {
    // 如果是普通对象（不包括类实例、Map、Set 等）
    // 创建一个新对象
    // 把每个字段递归 clone 后赋值到新对象中
    const res: any = {}
    for (const key in v) {
      res[key] = clone(v[key as keyof typeof v])
    }
    return res
  } else {
    // 原始值（string, number, boolean, null, undefined）
    // 或者函数、Symbol、类实例等 → 原样返回（引用）
    return v
  }
}
