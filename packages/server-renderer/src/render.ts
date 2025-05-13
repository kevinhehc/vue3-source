import {
  Comment,
  type Component,
  type ComponentInternalInstance,
  type DirectiveBinding,
  Fragment,
  type FunctionalComponent,
  Static,
  Text,
  type VNode,
  type VNodeArrayChildren,
  type VNodeProps,
  mergeProps,
  ssrUtils,
  warn,
} from 'vue'
import {
  NOOP,
  ShapeFlags,
  escapeHtml,
  escapeHtmlComment,
  isArray,
  isFunction,
  isPromise,
  isString,
  isVoidTag,
} from '@vue/shared'
import { ssrRenderAttrs } from './helpers/ssrRenderAttrs'
import { ssrCompile } from './helpers/ssrCompile'
import { ssrRenderTeleport } from './helpers/ssrRenderTeleport'

const {
  createComponentInstance,
  setCurrentRenderingInstance,
  setupComponent,
  renderComponentRoot,
  normalizeVNode,
  pushWarningContext,
  popWarningContext,
} = ssrUtils

// 这是一个 扩展数组类型，数组元素是 SSRBufferItem。
// 同时它还附加了一个布尔属性 hasAsync，表示 buffer 中是否包含异步内容。
// 为何这么设计？
// 为了兼容标准数组操作的同时又能携带额外标记（hasAsync），Vue 使用了 TypeScript 的“交叉类型”技巧。
export type SSRBuffer = SSRBufferItem[] & { hasAsync?: boolean }
// 每个 buffer 中的项可以是：
// string：直接渲染好的 HTML 片段。
// SSRBuffer：嵌套结构（比如子组件的渲染结果）。
// Promise<SSRBuffer>：表示异步组件或 Suspense，异步完成后才返回 buffer。
export type SSRBufferItem = string | SSRBuffer | Promise<SSRBuffer>
// 一个函数类型，代表向 buffer 中“推入”渲染结果项的行为。
// 这个函数通常在组件渲染期间作为 push 回调传递给子组件。
export type PushFn = (item: SSRBufferItem) => void
// 通用组件 props 类型，表示是一个任意属性的对象。
export type Props = Record<string, unknown>

// 字段	类型	说明
// [key: string]: any	可扩展字段	支持用户自定义字段，如自定义 meta、状态等
// teleports?	{ [target: string]: string }	最终渲染的 teleport 目标 HTML
// __teleportBuffers?	{ [target: string]: SSRBuffer }	渲染期间用于收集各 teleport 的内容
// __watcherHandles?	(() => void)[]	渲染过程中注册的副作用卸载函数（用于响应式清理）
export type SSRContext = {
  [key: string]: any
  teleports?: Record<string, string>
  /**
   * @internal
   */
  __teleportBuffers?: Record<string, SSRBuffer>
  /**
   * @internal
   */
  __watcherHandles?: (() => void)[]
}

// Each component has a buffer array.
// A buffer array can contain one of the following:
// - plain string
// - A resolved buffer (recursive arrays of strings that can be unrolled
//   synchronously)
// - An async buffer (a Promise that resolves to a resolved buffer)
// 用于为每个组件创建独立的输出缓冲区。
// 返回一个带有 push() 和 getBuffer() 方法的对象。
export function createBuffer() {
  // appendable: 表示上一个 push 项是否是字符串（用于是否可合并）。
  // buffer: 实际的 SSRBuffer 实例（数组）存储渲染输出项。
  let appendable = false
  const buffer: SSRBuffer = []
  return {
    // 返回最终渲染用的 buffer。
    // 展开（unroll）阶段会处理其中的字符串 / 嵌套 buffer / Promise。
    getBuffer(): SSRBuffer {
      // Return static buffer and await on items during unroll stage
      return buffer
    },
    // 推入一个项到当前组件的缓冲区中。
    // 项的类型是 SSRBufferItem，即 string | SSRBuffer | Promise<SSRBuffer>。
    push(item: SSRBufferItem): void {
      const isStringItem = isString(item)
      if (appendable && isStringItem) {
        // 如果上一个项是字符串（appendable = true），且当前也是字符串，
        // 就将当前字符串直接合并到前一项。
        // 避免大量小字符串碎片 → 性能优化（减少 buffer.length）。
        buffer[buffer.length - 1] += item as string
        return
      }

      // 否则正常 push 当前项。
      // 更新 appendable 状态。
      // 如果当前项是：
      // Promise → 明确是异步
      // 嵌套 buffer 且其含 hasAsync → 子项异步
      // → 将当前 buffer 标记为异步（hasAsync = true）。
      // 目的：在之后的 unrollBuffer() 中能快速判断是否需要 await，提高性能。
      buffer.push(item)
      appendable = isStringItem
      if (isPromise(item) || (isArray(item) && item.hasAsync)) {
        // promise, or child buffer with async, mark as async.
        // this allows skipping unnecessary await ticks during unroll stage
        buffer.hasAsync = true
      }
    },
  }
}

// 用于将组件 VNode 渲染为 SSRBuffer
export function renderComponentVNode(
  // vnode: 当前要渲染的组件虚拟节点。
  // parentComponent: 父组件实例。
  // slotScopeId: 用于处理作用域插槽（v-slot）。
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null = null,
  slotScopeId?: string,
): SSRBuffer | Promise<SSRBuffer> {
  // 返回同步的 SSRBuffer（普通组件），或异步的 Promise<SSRBuffer>（如 setup() 返回 Promise 的异步组件或含 serverPrefetch 的组件）。
  // 调用 createComponentInstance 构建组件实例。
  // 会挂载到 vnode.component，后续渲染依赖它。
  const instance = (vnode.component = createComponentInstance(
    vnode,
    parentComponent,
    null,
  ))
  // 开发模式中用于调试组件 warning 的上下文追踪。
  if (__DEV__) pushWarningContext(vnode)
  // 初始化组件的响应式状态。
  // 执行 setup() 函数。
  // 第二个参数 true 表示这是 SSR 场景。
  const res = setupComponent(instance, true /* isSSR */)
  // 开发模式中用于调试组件 warning 的上下文追踪。
  if (__DEV__) popWarningContext()
  // 如果 setup() 返回 Promise → 异步组件（例如使用了 async setup()）。
  const hasAsyncSetup = isPromise(res)
  // instance.sp 是 SSR 中专用的 serverPrefetch 钩子数组。
  // 在 setup 执行完成后才会有（异步组件可能要等 await）。
  let prefetches = instance.sp /* LifecycleHooks.SERVER_PREFETCH */
  if (hasAsyncSetup || prefetches) {
    // 使用 Promise.resolve(res) 来兼容 setup() 可能是同步的情况。
    // 在 .then() 中再提取并运行 serverPrefetch 钩子。
    // 所有 prefetch 都完成后，调用 renderComponentSubTree() 生成最终渲染缓冲区。
    // 返回值是 Promise<SSRBuffer>。
    // 注意：serverPrefetch 是 Vue SSR 中专门用于组件“预拉取数据”的生命周期钩子。
    const p: Promise<unknown> = Promise.resolve(res as Promise<void>)
      .then(() => {
        // instance.sp may be null until an async setup resolves, so evaluate it here
        if (hasAsyncSetup) prefetches = instance.sp
        if (prefetches) {
          return Promise.all(
            prefetches.map(prefetch => prefetch.call(instance.proxy)),
          )
        }
      })
      // Note: error display is already done by the wrapped lifecycle hook function.
      .catch(NOOP)
    return p.then(() => renderComponentSubTree(instance, slotScopeId))
  } else {
    // 普通组件、同步 setup，无 serverPrefetch 时直接同步渲染。
    // 返回 SSRBuffer。
    return renderComponentSubTree(instance, slotScopeId)
  }
}

// 负责将一个已经 setup 完成的组件实例最终渲染为 SSRBuffer（HTML 输出片段的缓冲区），可以是同步也可以包含异步内容。
function renderComponentSubTree(
  // instance：已 setup 的组件实例。
  // slotScopeId：当前作用域插槽的 scope ID（用于 v-slot）。
  // 返回值：渲染结果缓冲区 SSRBuffer（可能包含异步内容）。
  instance: ComponentInternalInstance,
  slotScopeId?: string,
): SSRBuffer | Promise<SSRBuffer> {
  if (__DEV__) pushWarningContext(instance.vnode)
  const comp = instance.type as Component
  // 使用 createBuffer() 创建一个用于接收渲染内容的缓冲区。
  // push() 会被传给子组件或 vnode 渲染函数。
  // getBuffer() 用于返回最终的渲染结果。
  const { getBuffer, push } = createBuffer()
  // 如果组件类型本身是函数，表示是“函数式组件”（如 setup() { return () => ... }）。
  // 调用 renderComponentRoot() 渲染出 root vnode。
  if (isFunction(comp)) {
    let root = renderComponentRoot(instance)
    // #5817 scope ID attrs not falling through if functional component doesn't
    // have props
    // 如果函数式组件没有声明 props，但带有作用域样式（如 data-v-abc），就将这些 scope ID attrs 人为塞进 vnode props，避免样式丢失。
    if (!(comp as FunctionalComponent).props) {
      for (const key in instance.attrs) {
        if (key.startsWith(`data-v-`)) {
          ;(root.props || (root.props = {}))[key] = ``
        }
      }
    }
    // 调用 renderVNode() 开始渲染生成的 root vnode。
    // 渲染过程中所有输出都会通过 push() 添加到当前组件的 buffer 中。
    renderVNode(push, (instance.subTree = root), instance, slotScopeId)
  } else {
    // 否则是正常组件

    if (
      (!instance.render || instance.render === NOOP) &&
      !instance.ssrRender &&
      !comp.ssrRender &&
      isString(comp.template)
    ) {
      // 没有 render/ssrRender，但有 template（动态编译）
      // 如果没有 render 也没有 ssrRender，但有 template 字符串：
      // 使用 SSR 编译器 ssrCompile() 动态编译模板为 ssrRender() 函数。
      // 这个步骤只在 SSR 编译器开启时生效。
      comp.ssrRender = ssrCompile(comp.template, instance)
    }

    // 存在 ssrRender，走优化路径
    const ssrRender = instance.ssrRender || comp.ssrRender
    if (ssrRender) {
      // 使用 compiler 编译出来的 ssrRender() 方法，性能更高。
      // 会手动合并继承的 attrs 和作用域 ID（如下）。
      // optimized
      // resolve fallthrough attrs
      // 合并作用域 ID 和 teleport ID
      let attrs = instance.inheritAttrs !== false ? instance.attrs : undefined
      let hasCloned = false

      let cur = instance
      while (true) {
        // 逐层向上查找父组件 vnode.scopeId，合并为 attrs。
        // 添加到当前组件渲染结果中，使 scoped CSS 生效。
        // 也处理 slot 的作用域 ID。
        const scopeId = cur.vnode.scopeId
        if (scopeId) {
          if (!hasCloned) {
            attrs = { ...attrs }
            hasCloned = true
          }
          attrs![scopeId] = ''
        }
        const parent = cur.parent
        if (parent && parent.subTree && parent.subTree === cur.vnode) {
          // parent is a non-SSR compiled component and is rendering this
          // component as root. inherit its scopeId if present.
          cur = parent
        } else {
          break
        }
      }

      if (slotScopeId) {
        if (!hasCloned) attrs = { ...attrs }
        const slotScopeIdList = slotScopeId.trim().split(' ')
        for (let i = 0; i < slotScopeIdList.length; i++) {
          attrs![slotScopeIdList[i]] = ''
        }
      }

      // set current rendering instance for asset resolution
      // 设置当前渲染实例（用于 resolveComponent、resolveDirective 等）
      const prev = setCurrentRenderingInstance(instance)
      try {
        ssrRender(
          instance.proxy,
          push,
          instance,
          attrs,
          // compiler-optimized bindings
          instance.props,
          instance.setupState,
          instance.data,
          instance.ctx,
        )
      } finally {
        // 在调用 ssrRender() 前设置当前渲染上下文。
        // 渲染时所有内容通过 push() 输出到 buffer。
        // 最终 push() 收集的内容构成组件的渲染结果。
        setCurrentRenderingInstance(prev)
      }
    } else if (instance.render && instance.render !== NOOP) {
      renderVNode(
        push,
        (instance.subTree = renderComponentRoot(instance)),
        instance,
        slotScopeId,
      )
    } else {
      const componentName = comp.name || comp.__file || `<Anonymous>`
      warn(`Component ${componentName} is missing template or render function.`)
      push(`<!---->`)
    }
  }
  if (__DEV__) popWarningContext()
  return getBuffer()
}

// 根据传入的 VNode 类型，选择合适的渲染逻辑，并将最终结果通过 push() 输出到 SSR 缓冲区。
export function renderVNode(
  // push: 用于输出 HTML 字符串的函数。
  // vnode: 当前虚拟节点。
  // parentComponent: 当前组件上下文。
  // slotScopeId: 作用域插槽 ID，作用于 scoped slots 和嵌套组件样式隔离。
  push: PushFn,
  vnode: VNode,
  parentComponent: ComponentInternalInstance,
  slotScopeId?: string,
): void {
  const { type, shapeFlag, children, dirs, props } = vnode
  // SSR 指令处理（如 v-xxx）
  // 如果绑定了自定义指令（带 getSSRProps 的），就将其返回的 props 注入 vnode。
  // 这一步只发生在 SSR（非 DOM）。
  if (dirs) {
    vnode.props = applySSRDirectives(vnode, props, dirs)
  }

  // 类型判断分支（核心调度）
  switch (type) {
    // 直接输出转义后的文本。
    case Text:
      push(escapeHtml(children as string))
      break
    // 输出注释或空占位节点。
    case Comment:
      push(
        children
          ? `<!--${escapeHtmlComment(children as string)}-->`
          : `<!---->`,
      )
      break
    // 直接输出缓存好的 HTML 字符串（v-once 优化场景）。
    case Static:
      push(children as string)
      break
    // 包装为注释节点，输出其中所有子节点。
    // 同时继承和合并 slotScopeIds（用于 CSS 隔离）。
    case Fragment:
      if (vnode.slotScopeIds) {
        slotScopeId =
          (slotScopeId ? slotScopeId + ' ' : '') + vnode.slotScopeIds.join(' ')
      }
      push(`<!--[-->`) // open
      renderVNodeChildren(
        push,
        children as VNodeArrayChildren,
        parentComponent,
        slotScopeId,
      )
      push(`<!--]-->`) // close
      break
    default:
      // 默认分支：组件、元素、Teleport、Suspense 等
      if (shapeFlag & ShapeFlags.ELEMENT) {
        renderElementVNode(push, vnode, parentComponent, slotScopeId)
      } else if (shapeFlag & ShapeFlags.COMPONENT) {
        push(renderComponentVNode(vnode, parentComponent, slotScopeId))
      } else if (shapeFlag & ShapeFlags.TELEPORT) {
        renderTeleportVNode(push, vnode, parentComponent, slotScopeId)
      } else if (shapeFlag & ShapeFlags.SUSPENSE) {
        renderVNode(push, vnode.ssContent!, parentComponent, slotScopeId)
      } else {
        warn(
          '[@vue/server-renderer] Invalid VNode type:',
          type,
          `(${typeof type})`,
        )
      }
  }
}

// 递归渲染子节点数组（children），通常用于：
// <div>child</div> 中的子元素
// 组件中的默认插槽
// slot 渲染结果
// <teleport>、<template> 等容器组件的 children
// 它会遍历 children 中的每一项 vnode，调用核心渲染函数 renderVNode(...) 逐一处理。
export function renderVNodeChildren(
  push: PushFn,
  children: VNodeArrayChildren,
  parentComponent: ComponentInternalInstance,
  slotScopeId?: string,
): void {
  for (let i = 0; i < children.length; i++) {
    renderVNode(push, normalizeVNode(children[i]), parentComponent, slotScopeId)
  }
}

// SSR 渲染中处理 HTML 原生元素（如 <div>, <p>, <input>）VNode 的核心逻辑之一。
// 它会将一个元素 VNode 渲染为 HTML 字符串并通过 push() 写入当前组件的 SSRBuffer。
function renderElementVNode(
  // push：用于将渲染结果写入当前 buffer 的函数。
  // vnode：表示一个 DOM 元素节点的虚拟节点。
  // parentComponent：当前渲染上下文的组件实例。
  // slotScopeId：用于支持 v-slot 的作用域 ID。
  push: PushFn,
  vnode: VNode,
  parentComponent: ComponentInternalInstance,
  slotScopeId?: string,
) {
  // 从 vnode 中提取标签名、props、children、scopeId。
  // 准备构造起始标签 <tag ...>。
  const tag = vnode.type as string
  let { props, children, shapeFlag, scopeId } = vnode
  let openTag = `<${tag}`

  if (props) {
    // 调用 ssrRenderAttrs：将属性对象（如 id, class, style）渲染为 HTML 字符串。
    openTag += ssrRenderAttrs(props, tag)
  }

  // 添加组件作用域 ID（Scoped CSS 支持）
  if (scopeId) {
    // 当前 vnode 自带的 scopeId（由 scoped CSS 注入的 data-v-abc）。
    openTag += ` ${scopeId}`
  }
  // inherit parent chain scope id if this is the root node
  //  继承父组件的 scopeId（跨组件样式隔离）
  let curParent: ComponentInternalInstance | null = parentComponent
  let curVnode = vnode
  // 如果该元素是某组件的根节点，那么它需要继承父组件的 scopeId。
  // 向上查找父组件链，把所有 scopeId 都合并。
  while (curParent && curVnode === curParent.subTree) {
    curVnode = curParent.vnode
    if (curVnode.scopeId) {
      openTag += ` ${curVnode.scopeId}`
    }
    curParent = curParent.parent
  }
  // 添加 slotScopeId（如果是 slot 内容）
  // 作用域插槽传递下来的 scope ID 也要加上
  if (slotScopeId) {
    openTag += ` ${slotScopeId}`
  }

  // 写入开标签
  // 将 <tag ...> 推入缓冲区。
  push(openTag + `>`)
  if (!isVoidTag(tag)) {
    // 渲染子内容（若不是自闭合标签）
    // isVoidTag 检查是否是自闭合标签（如 <img>, <br>）。
    // 只有非空标签才渲染子内容和闭标签。
    let hasChildrenOverride = false
    // 优先级：特殊属性控制内容（互斥）
    // 如果用户指定了 v-html / innerHTML，优先使用其内容。
    // 如果指定了 textContent，则输出文本。
    // 如果是 <textarea> 并指定了 value，其内容就是 value。
    // 这些都属于“覆盖子内容”的逻辑。
    if (props) {
      if (props.innerHTML) {
        hasChildrenOverride = true
        push(props.innerHTML)
      } else if (props.textContent) {
        hasChildrenOverride = true
        push(escapeHtml(props.textContent))
      } else if (tag === 'textarea' && props.value) {
        hasChildrenOverride = true
        push(escapeHtml(props.value))
      }
    }
    if (!hasChildrenOverride) {
      // 否则，根据 VNode 的 shapeFlag 判断 children 类型：
      // 文本 → 直接输出（转义后）
      // 子节点数组 → 递归渲染每个子 vnode（组件、元素等）
      if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
        push(escapeHtml(children as string))
      } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        renderVNodeChildren(
          push,
          children as VNodeArrayChildren,
          parentComponent,
          slotScopeId,
        )
      }
    }
    // 输出闭标签
    // 对于非空元素，输出 </tag>。
    push(`</${tag}>`)
  }
}

// 在服务端渲染时执行所有带有 getSSRProps() 方法的自定义指令，并将它们生成的属性合并到 vnode 的 props 中。
function applySSRDirectives(
  // vnode：当前正在处理的虚拟节点。
  // rawProps：该节点已有的原始 props。
  // dirs：该节点绑定的所有自定义指令，每个是一个 DirectiveBinding 对象。
  // 返回值：最终合并后的 props，包含指令注入的 props。
  vnode: VNode,
  rawProps: VNodeProps | null,
  dirs: DirectiveBinding[],
): VNodeProps {
  // 用于收集所有 getSSRProps() 返回的 props 对象。
  const toMerge: VNodeProps[] = []
  for (let i = 0; i < dirs.length; i++) {
    // dirs[i] 是一个 DirectiveBinding，包含：
    // dir: 自定义指令定义对象（例如 { mounted, updated, getSSRProps }）
    // value, arg, modifiers 等参数信息。
    // 解构出 getSSRProps：这是 SSR 渲染期间指令用来“声明额外 props”的函数。
    const binding = dirs[i]
    const {
      dir: { getSSRProps },
    } = binding
    if (getSSRProps) {
      // 调用 getSSRProps(binding, vnode)，传入当前 binding 和 vnode。
      // 如果返回值是非空的 props 对象，则加入待合并列表。
      const props = getSSRProps(binding, vnode)
      if (props) toMerge.push(props)
    }
  }
  // 最后将所有收集的 props 与 rawProps 合并，生成最终 vnode 的 props。
  // mergeProps() 会正确处理 class, style, onXXX 等字段合并逻辑。
  return mergeProps(rawProps || {}, ...toMerge)
}

// 将 teleport 的子内容输出到正确的目标缓冲区（如果启用），或者直接原地渲染（如果 disabled 为真）。
function renderTeleportVNode(
  // push：渲染输出函数，负责把内容写入当前组件的 SSRBuffer。
  // vnode：Teleport 的虚拟节点。
  // parentComponent：父组件实例，用于传递上下文。
  // slotScopeId：作用域插槽的 scopeId。
  push: PushFn,
  vnode: VNode,
  parentComponent: ComponentInternalInstance,
  slotScopeId?: string,
) {
  // target: <teleport to="#footer"> 的目标选择器。
  // disabled: 如果设置了 <teleport disabled>, 则内容应“原地”渲染，而不是传送。
  const target = vnode.props && vnode.props.to
  const disabled = vnode.props && vnode.props.disabled
  if (!target) {
    if (!disabled) {
      // 没有指定 to，又不是 disabled，就发出警告。
      // 返回空数组表示没有渲染任何内容。
      warn(`[@vue/server-renderer] Teleport is missing target prop.`)
    }
    return []
  }
  if (!isString(target)) {
    // Teleport 的 to 必须是字符串（如 "#footer"）。
    // 如果传了对象或函数就报错。
    warn(
      `[@vue/server-renderer] Teleport target must be a query selector string.`,
    )
    return []
  }
  ssrRenderTeleport(
    push,
    push => {
      renderVNodeChildren(
        push,
        vnode.children as VNodeArrayChildren,
        parentComponent,
        slotScopeId,
      )
    },
    target,
    disabled || disabled === '',
    parentComponent,
  )
}
