import {
  Comment,
  Fragment,
  Static,
  Text,
  type VNode,
  type VNodeArrayChildren,
  type VNodeHook,
  type VNodeProps,
  cloneIfMounted,
  createVNode,
  invokeVNodeHook,
  isSameVNodeType,
  normalizeVNode,
} from './vnode'
import {
  type ComponentInternalInstance,
  type ComponentOptions,
  type Data,
  type LifecycleHook,
  createComponentInstance,
  setupComponent,
} from './component'
import {
  filterSingleRoot,
  renderComponentRoot,
  shouldUpdateComponent,
  updateHOCHostEl,
} from './componentRenderUtils'
import {
  EMPTY_ARR,
  EMPTY_OBJ,
  NOOP,
  PatchFlags,
  ShapeFlags,
  def,
  getGlobalThis,
  invokeArrayFns,
  isArray,
  isReservedProp,
} from '@vue/shared'
import {
  type SchedulerJob,
  SchedulerJobFlags,
  type SchedulerJobs,
  flushPostFlushCbs,
  flushPreFlushCbs,
  queueJob,
  queuePostFlushCb,
} from './scheduler'
import {
  EffectFlags,
  ReactiveEffect,
  pauseTracking,
  resetTracking,
} from '@vue/reactivity'
import { updateProps } from './componentProps'
import { updateSlots } from './componentSlots'
import { popWarningContext, pushWarningContext, warn } from './warning'
import { type CreateAppFunction, createAppAPI } from './apiCreateApp'
import { setRef } from './rendererTemplateRef'
import {
  type SuspenseBoundary,
  type SuspenseImpl,
  isSuspense,
  queueEffectWithSuspense,
} from './components/Suspense'
import {
  TeleportEndKey,
  type TeleportImpl,
  type TeleportVNode,
} from './components/Teleport'
import { type KeepAliveContext, isKeepAlive } from './components/KeepAlive'
import { isHmrUpdating, registerHMR, unregisterHMR } from './hmr'
import { type RootHydrateFunction, createHydrationFunctions } from './hydration'
import { invokeDirectiveHook } from './directives'
import { endMeasure, startMeasure } from './profiling'
import {
  devtoolsComponentAdded,
  devtoolsComponentRemoved,
  devtoolsComponentUpdated,
  setDevtoolsHook,
} from './devtools'
import { initFeatureFlags } from './featureFlags'
import { isAsyncWrapper } from './apiAsyncComponent'
import { isCompatEnabled } from './compat/compatConfig'
import { DeprecationTypes } from './compat/compatConfig'
import type { TransitionHooks } from './components/BaseTransition'
// 表示“宿主环境的元素类型”
// 浏览器 DOM 中，它是 HTMLElement
// SSR 中，是虚拟字符串节点
// 自定义平台可以是任意类型（如 canvas、Weex 元素等）
export interface Renderer<HostElement = RendererElement> {
  // 渲染函数，用于挂载组件树：
  render: RootRenderFunction<HostElement>
  // 创建应用实例的方法：
  // 用于生成应用实例（App 对象）
  // 返回对象含 .mount()、.component() 等方法
  createApp: CreateAppFunction<HostElement>
}

// 用于支持 SSR 客户端水合（hydrate）功能
export interface HydrationRenderer extends Renderer<Element | ShadowRoot> {
  // 用于将 SSR 渲染的 HTML 与客户端组件树绑定（进行“激活”）
  hydrate: RootHydrateFunction
}

// document.createElementNS('http://www.w3.org/2000/svg', 'svg')
// 为了支持这一点，Vue 在虚拟节点（VNode）或渲染上下文中可能会携带 ns 字段：
// interface VNode {
//   ...
//   ns?: ElementNamespace
// }
// Vue 会根据这个 ns 值选择：
// undefined → 使用 document.createElement()
// 'svg' → 使用 document.createElementNS(SVG_NS, ...)
// 'mathml' → 使用 document.createElementNS(MATHML_NS, ...)

// 'svg'：SVG 命名空间
// 'mathml'：MathML 命名空间
// undefined：普通 HTML 命名空间（默认）
export type ElementNamespace = 'svg' | 'mathml' | undefined

//  Vue 渲染器中的根级渲染函数类型，即 render() 函数的签名。
export type RootRenderFunction<HostElement = RendererElement> = (
  // 表示要渲染的虚拟节点树（VNode）
  // 若为 null，表示卸载（unmount）
  vnode: VNode | null,
  // 渲染的目标容器
  // 默认为 RendererElement（通常是 DOM Element）
  // 可自定义为其他宿主元素类型（如 canvas 节点、字符串缓冲区等）
  container: HostElement,
  // 指定 DOM 命名空间（可选）
  // 类型为 'svg' | 'mathml' | undefined
  // 用于 <svg>、<math> 等标签正确渲染子节点
  namespace?: ElementNamespace,
) => void

// 定义了一个平台无关（platform-agnostic）渲染 API集合，Vue runtime-core 利用它构建 DOM 渲染器、SSR 渲染器或自定义渲染器。
// RendererOptions 是 createRenderer() 的参数，用来告诉 Vue：
// 如何在当前平台上执行基础 DOM 操作，比如创建元素、插入节点、设置属性等。
// Vue 的渲染器本质就是通过这些“钩子”执行平台相关的实际渲染工作。
export interface RendererOptions<
  HostNode = RendererNode,
  HostElement = RendererElement,
> {
  // diffprops的函数
  // 更新属性、事件、指令等核心逻辑（diff props）
  // 核心 diff 方法
  // 处理 class、style、事件（如 onClick）、原生属性（如 value）等更新逻辑
  // DOM 渲染器中由 patchProp.ts 实现
  patchProp(
    el: HostElement,
    key: string,
    prevValue: any,
    nextValue: any,
    namespace?: ElementNamespace,
    parentComponent?: ComponentInternalInstance | null,
  ): void
  // 插入方法 插入一个节点到容器中（支持 anchor）
  // 将节点插入到容器中，支持定位（anchor）
  // 对应 DOM 中的 parent.insertBefore(el, anchor)
  insert(el: HostNode, parent: HostElement, anchor?: HostNode | null): void
  // 移除方法 删除一个节点
  remove(el: HostNode): void
  // 创建元素方法 创建元素节点（支持命名空间）
  // 创建带命名空间和自定义元素支持的元素节点
  // DOM 平台中会用 document.createElement() 或 createElementNS()
  createElement(
    type: string,
    namespace?: ElementNamespace,
    isCustomizedBuiltIn?: string,
    vnodeProps?: (VNodeProps & { [key: string]: any }) | null,
  ): HostElement
  // 创建文本方法 创建文本节点
  createText(text: string): HostNode
  // 创建注释方法 创建注释节点
  createComment(text: string): HostNode
  // 设置文本方法 设置文本节点内容
  setText(node: HostNode, text: string): void
  // 设置元素文本内容方法 设置元素的文本内容（innerText）
  setElementText(node: HostElement, text: string): void
  // 查找父元素的方法 获取父元素
  parentNode(node: HostNode): HostElement | null
  // 查找下一个兄弟元素的方法 获取下一个兄弟节点
  nextSibling(node: HostNode): HostNode | null
  // 静态选择器 用于 SSR hydration 的静态查找
  querySelector?(selector: string): HostElement | null
  // 设置 data-v-scopeId（用于 scoped CSS）
  setScopeId?(el: HostElement, id: string): void
  // 克隆元素 克隆 DOM 节点（SSR、静态优化用）
  cloneNode?(node: HostNode): HostNode
  // 插入静态节点的方法 插入静态 HTML 内容的钩子（静态提升优化用）
  insertStaticContent?(
    content: string,
    parent: HostElement,
    anchor: HostNode | null,
    namespace: ElementNamespace,
    start?: HostNode | null,
    end?: HostNode | null,
  ): [HostNode, HostNode]
}

// Renderer Node can technically be any object in the context of core renderer
// logic - they are never directly operated on and always passed to the node op
// functions provided via options, so the internal constraint is really just
// a generic object.
// 宽泛类型接口，代表“渲染目标平台中的单个节点”，即：
// 渲染器中可接受的最基础单位节点类型。
export interface RendererNode {
  [key: string | symbol]: any
}

export interface RendererElement extends RendererNode {}

// An object exposing the internals of a renderer, passed to tree-shakeable
// features so that they can be decoupled from this file. Keys are shortened
// to optimize bundle size.
// Vue 渲染流程的“内部管线控制中心”，封装了渲染器各阶段的行为函数。其主要作用是：
// 将核心的渲染功能打包成一个内部对象，传递给需要它的模块（如：组件、指令、过渡处理等），
// 同时避免直接依赖整个渲染器文件，从而实现 tree-shaking + 解耦。
export interface RendererInternals<
  HostNode = RendererNode,
  HostElement = RendererElement,
> {
  // 缩写	真实含义	作用
  // p	patch	比较并更新 vnode（diff）
  // um	unmount	卸载 vnode
  // r	remove	移除真实 DOM 节点
  // m	move	移动节点位置（transition/group 用）
  // mt	mountComponent	挂载组件
  // mc	mountChildren	挂载子节点
  // pc	patchChildren	diff 子节点列表
  // pbc	patchBlockChildren	diff block 节点的子节点
  // n	next	获取下一个 sibling 节点
  // o	options	RendererOptions，即平台操作 API
  p: PatchFn
  um: UnmountFn
  r: RemoveFn
  m: MoveFn
  mt: MountComponentFn
  mc: MountChildrenFn
  pc: PatchChildrenFn
  pbc: PatchBlockChildrenFn
  n: NextFn
  o: RendererOptions<HostNode, HostElement>
  // 如何使用它
  // Vue 的 <Transition> 组件就是通过接收 RendererInternals 来实现通用控制的：
  // function createBaseTransition(props, children, context, internals: RendererInternals) {
  //   // 使用 internals.p / internals.m / internals.um 来控制 vnode 生命周期
  // }
}

// These functions are created inside a closure and therefore their types cannot
// be directly exported. In order to avoid maintaining function signatures in
// two places, we declare them once here and use them inside the closure.
// 段代码定义了 Vue 渲染器内部一系列核心生命周期操作函数的类型，用于在 renderer 实现中组织功能模块，并作为 RendererInternals 的组成部分。

// 核心 diff 算法，挂载/更新 VNode
type PatchFn = (
  n1: VNode | null, // null means this is a mount
  n2: VNode,
  container: RendererElement,
  anchor?: RendererNode | null,
  parentComponent?: ComponentInternalInstance | null,
  parentSuspense?: SuspenseBoundary | null,
  namespace?: ElementNamespace,
  slotScopeIds?: string[] | null,
  optimized?: boolean,
) => void

// 挂载 VNode 的子节点数组
type MountChildrenFn = (
  children: VNodeArrayChildren,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
  start?: number,
) => void

// diff 普通子节点（非 block）
type PatchChildrenFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
) => void

// diff block 节点的子节点（优化过）
type PatchBlockChildrenFn = (
  oldChildren: VNode[],
  newChildren: VNode[],
  fallbackContainer: RendererElement,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
) => void

// 节点位置移动（例如过渡切换）
type MoveFn = (
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  type: MoveType,
  parentSuspense?: SuspenseBoundary | null,
) => void

// 获取下一个兄弟节点（用于 anchor 定位）
type NextFn = (vnode: VNode) => RendererNode | null

// 卸载单个 vnode
type UnmountFn = (
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean,
) => void

// 从 DOM 中移除节点（低级操作）
type RemoveFn = (vnode: VNode) => void

// 卸载多个子节点
type UnmountChildrenFn = (
  children: VNode[],
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean,
  start?: number,
) => void

// 挂载组件节点
export type MountComponentFn = (
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  optimized: boolean,
) => void

// 处理文本节点或注释节点的 patch 逻辑
type ProcessTextOrCommentFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
) => void

// 设置组件渲染副作用（用于响应式绑定）
export type SetupRenderEffectFn = (
  instance: ComponentInternalInstance,
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  optimized: boolean,
) => void

export enum MoveType {
  ENTER, // 进入动画
  LEAVE, // 离开动画
  REORDER, // 子节点顺序调整
}

// Vue 3 内部调度机制中用于**推迟执行渲染后副作用（如 transition、DOM 操作等）**的一个函数别名或封装。
// 它的定义是带有条件编译的。
// 将一个函数（通常是 副作用函数，如 transition 动画的 afterEnter 等）安排到 渲染结束之后再执行。
// 这个“渲染后”指的是：
// Vue 完成了当前组件的 DOM patch/update；
// 并且执行了微任务队列中的其他更新；
// 然后再执行这些回调。
// 也就是 Vue 的响应式调度队列中的 post-render 阶段。
export const queuePostRenderEffect: (
  fn: SchedulerJobs,
  suspense: SuspenseBoundary | null,
) => void = __FEATURE_SUSPENSE__
  ? __TEST__
    ? // vitest can't seem to handle eager circular dependency
      (fn: Function | Function[], suspense: SuspenseBoundary | null) =>
        // queueEffectWithSuspense(fn, suspense)
        // 用于将副作用加入到当前 SuspenseBoundary 的副作用队列中；
        // 如果没有 suspense，则直接进入 queuePostFlushCb;
        // 支持嵌套异步子树挂载完成后再统一触发副作用，确保时序一致。
        queueEffectWithSuspense(fn, suspense)
    : queueEffectWithSuspense
  : // queuePostFlushCb(fn)
    // 是 Vue 核心的调度器中的一个 API，用于将 fn 加入 postFlushCbs 队列；
    // 会在当前渲染队列全部 flush 后执行；
    // 是非 suspense 环境下的默认行为。
    queuePostFlushCb

/**
 * The createRenderer function accepts two generic arguments:
 * HostNode and HostElement, corresponding to Node and Element types in the
 * host environment. For example, for runtime-dom, HostNode would be the DOM
 * `Node` interface and HostElement would be the DOM `Element` interface.
 *
 * Custom renderers can pass in the platform specific types like this:
 *
 * ``` js
 * const { render, createApp } = createRenderer<Node, Element>({
 *   patchProp,
 *   ...nodeOps
 * })
 * ```
 */
// nodeOps 是 DOM 基础操作的封装，比如 insert, remove, createElement。
// patchProp 是属性更新逻辑，比如设置 class, style, onClick 等。

// 接收一个平台相关的 options 参数（比如操作 DOM 的函数）。
// 返回一个渲染器对象，包含：
// render()
// createApp()
//
// 还有内部用于 patch、mount、unmount 的函数等。
// 这个函数是 Vue 跨平台渲染能力的基础，例如：
// @vue/runtime-dom 调用 createRenderer<Node, Element>()，构造浏览器渲染器；
// @vue/runtime-core 提供核心逻辑，不绑定任何平台；
// 自定义平台（如微信小程序）可以自己实现一套 nodeOps 和 patchProp，然后用它生成自己的 Vue 渲染器。
export function createRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement,
>(options: RendererOptions<HostNode, HostElement>): Renderer<HostElement> {
  return baseCreateRenderer<HostNode, HostElement>(options)
}

// Separate API for creating hydration-enabled renderer.
// Hydration logic is only used when calling this function, making it
// tree-shakable.
// 创建一个支持 SSR hydration 的渲染器。
//
// 在 SSR 场景中，Vue 在客户端不会完全重新创建 DOM，而是要“激活”已有 HTML 内容。
//
// 这个函数会额外注入 hydration 逻辑（createHydrationFunctions）。
export function createHydrationRenderer(
  options: RendererOptions<Node, Element>,
): HydrationRenderer {
  return baseCreateRenderer(options, createHydrationFunctions)
}

// overload 1: no hydration
function baseCreateRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement,
>(options: RendererOptions<HostNode, HostElement>): Renderer<HostElement>

// overload 2: with hydration
function baseCreateRenderer(
  options: RendererOptions<Node, Element>,
  createHydrationFns: typeof createHydrationFunctions,
): HydrationRenderer

// implementation
function baseCreateRenderer(
  options: RendererOptions,
  createHydrationFns?: typeof createHydrationFunctions,
): any {
  // compile-time feature flags check
  // __ESM_BUNDLER__: 表示当前构建目标是 ESM 模块（如 Vite、Rollup）。
  // __TEST__: 测试环境中不执行。
  if (__ESM_BUNDLER__ && !__TEST__) {
    // initFeatureFlags 这个函数通常会从环境变量读取功能标志（例如 __FEATURE_SUSPENSE__, __FEATURE_OPTIONS_API__），
    // 启用/禁用编译时特性。这些特性会影响运行时和编译器的行为，比如是否支持 <Suspense>、是否支持选项式 API。
    initFeatureFlags()
  }

  // 获取当前全局对象（浏览器中是 window，Node 中是 global）；
  // 设置 __VUE__ = true，用于识别当前环境中是否有 Vue 在运行（DevTools 会用到）。
  const target = getGlobalThis()
  target.__VUE__ = true
  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    // 如果处于开发模式或启用了生产环境调试支持，就注册 Vue Devtools 的全局 hook。
    // 这个 hook 是 DevTools 和 Vue 通信的桥梁。
    setDevtoolsHook(target.__VUE_DEVTOOLS_GLOBAL_HOOK__, target)
  }

  // 从options中拿出宿主平台的api
  const {
    insert: hostInsert, // 插入一个节点到父节点中，用于 mount、patch（例如 parent.insertBefore）
    remove: hostRemove, // 删除一个节点，用于 unmount
    patchProp: hostPatchProp, // 更新属性/事件/样式，是 updateProps 的核心依赖
    createElement: hostCreateElement, // 创建元素节点（如 <div>），返回宿主平台的节点
    createText: hostCreateText, // 创建文本节点，返回宿主平台的 text node
    createComment: hostCreateComment, // 创建注释节点（如 v-if 的占位）
    setText: hostSetText, // 设置文本节点的内容（用于 textVNode）
    setElementText: hostSetElementText, // 设置元素的 textContent（用于清空 children）
    parentNode: hostParentNode, // 获取某个节点的父节点
    nextSibling: hostNextSibling, // 获取下一个兄弟节点
    setScopeId: hostSetScopeId = NOOP, // 仅 SSR 中使用，注入作用域 ID（默认是 NOOP）
    insertStaticContent: hostInsertStaticContent, // 批量插入静态内容 vnode（用于优化静态节点块）
  } = options

  // Note: functions inside this closure should use `const xxx = () => {}`
  // style in order to prevent being inlined by minifiers.
  const patch: PatchFn = (
    // 旧VNode
    n1,
    // 新VNode
    n2,
    // 挂载容器
    container,
    // 调用web dom API的insertBefore时传递的相对节点
    anchor = null,
    parentComponent = null,
    parentSuspense = null,
    namespace = undefined,
    slotScopeIds = null,
    optimized = __DEV__ && isHmrUpdating ? false : !!n2.dynamicChildren,
  ) => {
    if (n1 === n2) {
      return
    }

    // patching & not same type, unmount old tree
    // 判断不是同一个VNode直接卸载旧的子树
    if (n1 && !isSameVNodeType(n1, n2)) {
      // 获取插入的标识位
      anchor = getNextHostNode(n1)
      unmount(n1, parentComponent, parentSuspense, true)
      n1 = null
    }

    // // 退出优化路径，执行完整 diff
    if (n2.patchFlag === PatchFlags.BAIL) {
      optimized = false
      n2.dynamicChildren = null
    }

    // 取出关键信息
    const { type, ref, shapeFlag } = n2
    switch (type) {
      case Text:
        // 处理文本节点...
        processText(n1, n2, container, anchor)
        break
      case Comment:
        // 处理注释节点...
        processCommentNode(n1, n2, container, anchor)
        break
      case Static:
        // 处理静态节点...
        if (n1 == null) {
          mountStaticNode(n2, container, anchor, namespace)
        } else if (__DEV__) {
          patchStaticNode(n1, n2, container, namespace)
        }
        break
      case Fragment:
        // 处理fragment ...
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        break
      default:
        // 判断VNode类型
        if (shapeFlag & ShapeFlags.ELEMENT) {
          // 处理元素节点
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else if (shapeFlag & ShapeFlags.COMPONENT) {
          // 处理组件
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else if (shapeFlag & ShapeFlags.TELEPORT) {
          // 处理 teleport组件
          ;(type as typeof TeleportImpl).process(
            n1 as TeleportVNode,
            n2 as TeleportVNode,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals,
          )
        } else if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
          // 处理suspense组件
          ;(type as typeof SuspenseImpl).process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals,
          )
        } else if (__DEV__) {
          warn('Invalid VNode type:', type, `(${typeof type})`)
        }
    }

    // set ref 阶段
    if (ref != null && parentComponent) {
      setRef(ref, n1 && n1.ref, parentSuspense, n2 || n1, !n2)
    }
  }

  // 用于处理 文本节点（Text VNode）的挂载和更新，是 patch() 分支中专门针对 type === Text 的 vnode 的处理函数。
  //   n1,              // 旧的 Text vnode，可能为 null（表示初次挂载）
  //   n2,              // 新的 Text vnode
  //   container,       // 父容器（真实 DOM 元素）
  //   anchor           // 锚点，插入时用于定位位置（insertBefore）
  const processText: ProcessTextOrCommentFn = (n1, n2, container, anchor) => {
    // 初次挂载（n1 == null）
    if (n1 == null) {
      // 使用 hostInsert() 插入到真实 DOM 中（如 insertBefore）。
      hostInsert(
        // 创建一个真实的 DOM 文本节点：
        // 设置到 vnode 的 el 属性上。
        (n2.el = hostCreateText(n2.children as string)),
        container,
        anchor,
      )
    } else {
      // 更新文本节点（n1 != null）
      const el = (n2.el = n1.el!)
      // 将旧 vnode 的 el 传递给新的 vnode。
      // 如果文本内容发生了变化，则调用：
      if (n2.children !== n1.children) {
        // 实际上是：el.nodeValue = newText
        // 这样可以只修改文本内容而不是重新创建节点。
        hostSetText(el, n2.children as string)
      }
    }
  }

  // 是虚拟节点（VNode）处理流程中专门处理注释节点（Comment VNode）的逻辑。
  // 它的结构与 processText 很相似，但逻辑更加简单，因为注释节点在 Vue 中是静态的，不支持动态更新。
  //   n1,         // 旧 VNode，可能为 null（初次挂载）
  //   n2,         // 新的注释类型 VNode
  //   container,  // 父容器
  //   anchor      // 插入锚点
  const processCommentNode: ProcessTextOrCommentFn = (
    n1,
    n2,
    container,
    anchor,
  ) => {
    // 初次挂载（n1 == null）
    if (n1 == null) {
      // 将返回的 DOM 节点挂到 n2.el；
      // 使用 hostInsert 插入到指定位置。
      // 即使 n2.children 是 undefined，也会创建一个空注释节点。
      hostInsert(
        // 创建一个注释节点（例如 <-- some comment -->）：
        (n2.el = hostCreateComment((n2.children as string) || '')),
        container,
        anchor,
      )
    } else {
      // 更新注释节点（n1 != null）
      // Vue 不支持动态注释节点内容的更新；
      // 所以直接复用旧的 DOM 节点，不做任何内容对比或修改；
      // 仅将 n1.el 赋值给 n2.el，确保 vnode 链接正确。
      // there's no support for dynamic comments
      n2.el = n1.el
    }
  }

  // 属于渲染器中的优化逻辑，用于挂载静态节点（static VNode）
  // 将编译器生成的静态 vnode（即不变的 HTML 结构）插入 DOM，并缓存其起始和结束位置（用于后续 diff 快速复用或跳过）。
  const mountStaticNode = (
    n2: VNode, // 当前 static VNode
    container: RendererElement, // 挂载的父 DOM 元素
    anchor: RendererNode | null, // DOM 插入位置的锚点
    namespace: ElementNamespace, // 命名空间（HTML、SVG 等）
  ) => {
    // static nodes are only present when used with compiler-dom/runtime-dom
    // which guarantees presence of hostInsertStaticContent.
    ;[n2.el, n2.anchor] = hostInsertStaticContent!(
      n2.children as string,
      container,
      anchor,
      namespace,
      n2.el,
      n2.anchor,
    )
  }

  /**
   * Dev / HMR only
   */
  // 用于处理**静态节点（static vnode）在开发模式下的热重载更新（HMR）**的逻辑。
  // 这个函数只在开发环境中生效，生产环境下静态节点不会被 patch，因为它们被视为“永远不会变”的内容。
  const patchStaticNode = (
    n1: VNode, // 旧的静态 vnode
    n2: VNode, // 新的静态 vnode
    container: RendererElement, // 容器 DOM 节点
    namespace: ElementNamespace, // HTML/SVG/MathML 命名空间
  ) => {
    // static nodes are only patched during dev for HMR
    // children 是静态内容的字符串（比如 <div>hello</div>）；
    // 只有当内容变化时才会触发重新 patch。
    if (n2.children !== n1.children) {
      // 如果变了：重建 DOM 结构
      // 找到旧静态节点后面的位置（anchor）：
      // 用于确定新插入节点的位置；
      // n1.anchor 是之前挂载时记录的尾节点。
      // 移除旧的静态节点树：
      // removeStaticNode(n1) 会从 DOM 中移除起始到结束范围内的所有节点。
      // 插入新的静态节点：
      // 使用 hostInsertStaticContent() 重新根据新的 HTML 字符串插入内容；
      // 返回新的起始节点和 anchor 节点。
      const anchor = hostNextSibling(n1.anchor!)
      // remove existing
      removeStaticNode(n1)
      // insert new
      ;[n2.el, n2.anchor] = hostInsertStaticContent!(
        n2.children as string,
        container,
        anchor,
        namespace,
      )
    } else {
      // 如果内容没变：复用旧节点
      // 不执行任何 DOM 操作，只是让新 vnode 持有旧 vnode 的 DOM 引用。
      n2.el = n1.el
      n2.anchor = n1.anchor
    }
  }

  // 用于移动静态节点的 DOM 内容到新的位置，一般发生在如下场景：
  // Keyed Fragment 中静态 vnode 的位置发生变化；
  // TransitionGroup 动画过程中节点排序变化；
  // 模板中的静态内容需要整体移动
  const moveStaticNode = (
    { el, anchor }: VNode, // 当前静态 vnode 的起始和结束 DOM 节点
    container: RendererElement, // 目标父容器
    nextSibling: RendererNode | null, // 要插入的目标位置锚点
  ) => {
    // el: 静态 vnode 渲染后在 DOM 中的起始节点。
    // anchor: 静态 vnode 的结束节点，即 vnode 的最后一个 DOM 元素。
    // 静态 vnode 可能是一组连续节点（如一段 HTML 结构），不是单个节点。
    let next
    //  遍历并移动从 el 到 anchor 的所有节点
    while (el && el !== anchor) {
      // 从起始节点 el 开始，直到遇到 anchor 为止：
      // 使用 hostNextSibling(el) 获取下一个兄弟节点；
      // 使用 hostInsert(el, container, nextSibling) 插入到目标位置；
      // 继续处理下一个节点。
      // 这个过程等价于把 DOM 中连续的一段节点剪切并粘贴到新位置。
      next = hostNextSibling(el)
      hostInsert(el, container, nextSibling)
      el = next
    }
    // 循环最后没有处理 anchor 本身，因此单独插入一次。
    hostInsert(anchor!, container, nextSibling)
  }

  // 从 DOM 中移除一段静态 VNode 对应的连续节点（即从 el 到 anchor）。
  // el 是这段静态内容的第一个真实 DOM 节点；
  // anchor 是这段静态内容的最后一个 DOM 节点。
  const removeStaticNode = ({ el, anchor }: VNode) => {
    let next
    while (el && el !== anchor) {
      next = hostNextSibling(el) // 缓存下一个兄弟节点
      hostRemove(el) // 从 DOM 中移除当前节点
      el = next // 移动到下一个节点
    }
    // 从 el 开始，一直删除到 anchor 之前的所有节点。
    // hostNextSibling(el) 是宿主平台提供的 API（例如 el.nextSibling）。
    // 最后移除 anchor 节点本身
    hostRemove(anchor!)
  }

  // 处理 普通元素节点（Element VNode） 的函数 processElement，它是 patch() 主流程中负责挂载或更新 HTML 元素的分支处理函数。
  // 它同时处理初次挂载和更新两个阶段。
  const processElement = (
    //   n1,                // 旧 vnode（为 null 表示首次挂载）
    //   n2,                // 新 vnode
    //   container,         // 父 DOM 容器
    //   anchor,            // 插入的锚点位置
    //   parentComponent,   // 所属的父组件实例
    //   parentSuspense,    // 所属的 Suspense 边界
    //   namespace,         // 当前命名空间（如 SVG、MathML）
    //   slotScopeIds,      // 当前 slot 的作用域 ID（用于 SSR）
    //   optimized          // 是否开启了编译器优化模式（带 patchFlags）
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 命名空间处理（SVG / MathML）
    // 用于处理 <svg> 或 <math> 元素，它们的 DOM 操作需要特殊命名空间。
    // 会递归传递下去，确保子节点继承正确的 namespace。
    if (n2.type === 'svg') {
      namespace = 'svg'
    } else if (n2.type === 'math') {
      namespace = 'mathml'
    }

    if (n1 == null) {
      // 挂载元素 （首次渲染）
      // 调用 mountElement() 执行：
      // 创建元素节点；
      // 设置属性和事件；
      // 处理 children；
      // 插入到 DOM 中。
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    } else {
      // 更新元素 （diff 阶段）
      // 旧 vnode 存在，表示组件正在更新；
      // 调用 patchElement() 执行：
      // 判断是否是相同的 DOM 类型；
      // 使用 patchProps() 比较和更新属性、事件等；
      // 调用 patchChildren() 更新子节点；
      // 可能触发 transition、ref、指令钩子等副作用。
      patchElement(
        n1,
        n2,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    }
  }

  // 用于将一个普通 HTML 元素类型的虚拟节点（VNode）挂载为真实 DOM 元素。
  const mountElement = (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    let el: RendererElement
    let vnodeHook: VNodeHook | undefined | null
    const { props, shapeFlag, transition, dirs } = vnode

    // 创建div元素
    // 1. 创建 DOM 元素节点
    el = vnode.el = hostCreateElement(
      vnode.type as string,
      namespace,
      props && props.is, // 支持 is="custom-element"
      props,
    )

    // mount children first, since some props may rely on child content
    // being already rendered, e.g. `<select value>`
    // 文本节点的children
    // 2. 渲染子节点（children）
    // Vue 会根据 shapeFlag 决定是文本还是数组型 children：
    // 文本：直接设置 .textContent；
    // 数组：递归挂载子节点。
    // 注意必须先挂载子节点，因为有些属性（如 <select :value="...">）依赖其内部 <option> 已存在。
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      hostSetElementText(el, vnode.children as string)
    } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      // 数组型的children
      mountChildren(
        vnode.children as VNodeArrayChildren,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(vnode, namespace),
        slotScopeIds,
        optimized,
      )
    }

    // 3. 指令钩子：created
    // 在有指令（v-model, v-show, 自定义指令）时触发 created 生命周期钩子。
    if (dirs) {
      // invokeDirectiveHook
      invokeDirectiveHook(vnode, null, parentComponent, 'created')
    }

    // 4. 设置作用域 ID（CSS scope）
    // scopeId
    // 用于 <style scoped> 或 SSR 下的 scopeId 标记。
    // 会设置 el.setAttribute('data-v-xxxx') 以支持 CSS 隔离。
    setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent)

    // 设置属性（props）
    // 遍历 props，调用 hostPatchProp() 设置属性、class、style、事件等；
    // 排除 value 和保留属性（如 key, ref, onVnodeXXX）。
    if (props) {
      for (const key in props) {
        // 特殊处理 value：
        // 避免设置顺序错误，比如 <input :min="5" :value="3">；
        // 保证强制更新 value，不依赖默认行为。
        if (key !== 'value' && !isReservedProp(key)) {
          hostPatchProp(el, key, null, props[key], namespace, parentComponent)
        }
      }
      /**
       * Special case for setting value on DOM elements:
       * - it can be order-sensitive (e.g. should be set *after* min/max, #2325, #4024)
       * - it needs to be forced (#1471)
       * #2353 proposes adding another renderer option to configure this, but
       * the properties affects are so finite it is worth special casing it
       * here to reduce the complexity. (Special casing it also should not
       * affect non-DOM renderers)
       */
      if ('value' in props) {
        hostPatchProp(el, 'value', null, props.value, namespace)
      }
      // 6. VNode 钩子：onVnodeBeforeMount
      // 允许用户在 VNode 渲染前执行逻辑，类似生命周期钩子；
      // 常用于 HOC、自定义渲染控制等。
      if ((vnodeHook = props.onVnodeBeforeMount)) {
        invokeVNodeHook(vnodeHook, parentComponent, vnode)
      }
    }

    // 7. devtools 支持
    // 给 DOM 节点打上调试标记；
    // DevTools 通过这些字段追踪 vnode 和组件关系。
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      def(el, '__vnode', vnode, true)
      def(el, '__vueParentComponent', parentComponent, true)
    }

    // 8. 指令钩子：beforeMount
    if (dirs) {
      // invokeDirectiveHook
      invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount')
    }
    // #1583 For inside suspense + suspense not resolved case, enter hook should call when suspense resolved
    // #1689 For inside suspense + suspense resolved case, just call it
    // 9. 过渡动画（transition）
    // 在支持过渡的情况下调用 beforeEnter；
    // 通常用于 v-enter-from, v-enter-active 设置初始样式。
    const needCallTransitionHooks = needTransition(parentSuspense, transition)
    if (needCallTransitionHooks) {
      transition!.beforeEnter(el)
    }

    // 10. 插入 DOM
    // 将 DOM 元素插入父容器中；
    // 使用 insertBefore 模式支持 anchor 定位。
    hostInsert(el, container, anchor)

    // 11. 渲染后副作用队列（生命周期、指令、过渡）
    // 挂载完成后将 onVnodeMounted、指令的 mounted、过渡 enter 动画等统一推迟执行；
    // 利用 scheduler 确保执行时机在 DOM 全部挂载完成之后。
    if (
      (vnodeHook = props && props.onVnodeMounted) ||
      needCallTransitionHooks ||
      dirs
    ) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        needCallTransitionHooks && transition!.enter(el)
        // invokeDirectiveHook
        dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted')
      }, parentSuspense)
    }
  }

  // 用于设置 CSS 作用域 ID（scope ID） 的关键逻辑之一。
  // 在渲染 DOM 元素时，将组件、插槽的作用域 ID 正确地设置到真实 DOM 元素上，确保作用域样式生效。
  const setScopeId = (
    //   el,              // 当前要设置属性的 DOM 元素
    //   vnode,           // 当前 vnode
    //   scopeId,         // 当前组件的 scopeId（如 data-v-123abc）
    //   slotScopeIds,    // 当前 vnode 渲染时作用域插槽的 scopeIds
    //   parentComponent  // 父组件实例（用于递归处理根节点）
    el: RendererElement,
    vnode: VNode,
    scopeId: string | null,
    slotScopeIds: string[] | null,
    parentComponent: ComponentInternalInstance | null,
  ) => {
    // 1. 设置当前 vnode 的作用域 ID
    if (scopeId) {
      // 会调用平台提供的 hostSetScopeId()（DOM 中为 el.setAttribute(scopeId, '')）；
      // 通常作用于组件自身模板中的节点。
      hostSetScopeId(el, scopeId)
    }

    // 2. 设置作用域插槽的 ID（来自父组件）
    if (slotScopeIds) {
      // Vue 的插槽内容可以被嵌套渲染在多个组件中；
      // 如果父组件使用了 <style scoped>，那么插槽中的 DOM 也需要带上父组件的 scope ID；
      // slotScopeIds 就是这类来自父组件的作用域 ID。
      for (let i = 0; i < slotScopeIds.length; i++) {
        hostSetScopeId(el, slotScopeIds[i])
      }
    }

    // 3. 递归处理组件根 vnode 的作用域继承
    // 如果当前 vnode 是其父组件的“根节点”，则还需要继承父组件的作用域 ID。
    if (parentComponent) {
      // 为什么需要：
      // 因为作用域样式是从父组件向下传递的，但只会加在根节点；
      // Vue 会在子组件根 vnode 渲染时递归地向上查找，并将 scopeId 应用于根节点。
      //
      // 处理 Fragment 根（开发模式下）：
      // 如果父组件是 Fragment 类型的根节点（如带注释的模板），会尝试提取真正的单个根；
      // 使用 filterSingleRoot() 函数提取子树的“实际根”。
      let subTree = parentComponent.subTree
      if (
        __DEV__ &&
        subTree.patchFlag > 0 &&
        subTree.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
      ) {
        subTree =
          filterSingleRoot(subTree.children as VNodeArrayChildren) || subTree
      }
      if (
        vnode === subTree ||
        (isSuspense(subTree.type) &&
          (subTree.ssContent === vnode || subTree.ssFallback === vnode))
      ) {
        const parentVNode = parentComponent.vnode
        setScopeId(
          el,
          parentVNode,
          parentVNode.scopeId,
          parentVNode.slotScopeIds,
          parentComponent.parent,
        )
      }
    }
  }

  // 用于挂载 VNode 的数组子节点的核心函数
  // 通常出现在如下情况：
  // <div><span>1</span><span>2</span></div>，即一个元素拥有多个子元素；
  // 渲染 v-for；
  // 渲染 <slot> 内容时传入多个子 vnode；
  // 或任何 children 是 VNode[] 的情况。
  const mountChildren: MountChildrenFn = (
    //  children,          // VNode 子节点数组
    //   container,         // DOM 容器
    //   anchor,            // 插入锚点
    //   parentComponent,   // 当前组件实例
    //   parentSuspense,    // 所属 suspense 边界
    //   namespace,         // HTML / SVG / MathML
    //   slotScopeIds,      // slot 的 scope ID（支持 scoped slot）
    //   optimized,         // 是否开启编译器优化（带 patchFlags）
    //   start = 0          // 可选：从第几个节点开始挂载（默认从头）
    children,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    slotScopeIds,
    optimized,
    start = 0,
  ) => {
    // 从指定下标 start 开始遍历所有子节点，支持偏移量挂载。
    for (let i = start; i < children.length; i++) {
      // 每个 child 的处理逻辑：
      // 这里有个关键的区别：根据是否开启 优化模式（编译器生成 patchFlags）处理方式不同：
      // optimized = true：
      // 表示渲染函数是由模板编译器生成，具备结构可靠性；
      // 所以不需要规范化 vnode，只需要判断：如果子 vnode 是已挂载的，要先 clone 一份再挂载（避免副作用）。
      const child = (children[i] = optimized
        ? cloneIfMounted(children[i] as VNode)
        : normalizeVNode(children[i]))

      // patch(null, ...) 表示 这是首次挂载（没有旧 vnode）；
      // 会触发 processElement、processComponent、processText 等等；
      // 实际的 vnode 渲染就在这里展开。
      patch(
        null,
        child,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    }
  }

  // 组件更新流程里用于 更新普通 DOM 元素节点（element vnode） 的核心逻辑。
  // 用于比较两个 vnode 的差异（n1 是旧 vnode，n2 是新 vnode），然后将变化同步到真实 DOM 元素（el）上。
  const patchElement = (
    n1: VNode,
    n2: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 基本信息
    // 1. 继承旧 vnode 的 DOM 引用
    // 新 vnode 需要拿到旧 vnode 的真实 DOM 节点；
    // 所以把旧的 el 赋值给新的 n2.el；
    // Vue patch 是 “就地复用 DOM” 的设计。
    const el = (n2.el = n1.el!)

    // 2. devtools vnode 追踪
    // 在 devtools 或调试模式下，把 vnode 挂到 DOM 元素上，方便调试。
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      el.__vnode = n2
    }

    // 3. 拿出 patchFlag、dynamicChildren、dirs
    // patchFlag: 编译器生成的优化标志，用来跳过不必要的 diff；
    // dynamicChildren: 当前 vnode 中的动态子节点（Block 模式）；
    // dirs: 指令数组，如 v-model, v-show 等。
    let { patchFlag, dynamicChildren, dirs } = n2

    // #1426 take the old vnode's patch flag into account since user may clone a
    // compiler-generated vnode, which de-opts to FULL_PROPS
    // 4. 兼容 cloneVNode：确保 FULL_PROPS 情况被考虑进来
    // 如果用户 cloneVNode(n1)，会丢失部分编译时信息；
    // 此处确保 FULL_PROPS 不被丢掉；
    // |= 表示将其并入当前 patchFlag。
    patchFlag |= n1.patchFlag & PatchFlags.FULL_PROPS

    // 5. 获取旧/新 props
    const oldProps = n1.props || EMPTY_OBJ
    const newProps = n2.props || EMPTY_OBJ
    let vnodeHook: VNodeHook | undefined | null

    // disable recurse in beforeUpdate hooks
    // 6. beforeUpdate 生命周期钩子处理
    // 禁止递归（防止 setup 时访问自己）
    parentComponent && toggleRecurse(parentComponent, false)
    if ((vnodeHook = newProps.onVnodeBeforeUpdate)) {
      // 调用 onVnodeBeforeUpdate
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
    }

    // 调用指令的 beforeUpdate
    if (dirs) {
      // invokeDirectiveHook
      invokeDirectiveHook(n2, n1, parentComponent, 'beforeUpdate')
    }
    // 恢复递归权限
    parentComponent && toggleRecurse(parentComponent, true)

    // 7. 开发环境热更新兼容
    // 强制禁用优化，走完整 diff 流程；
    // 保证 HMR 能准确更新 DOM。
    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // #9135 innerHTML / textContent unset needs to happen before possible
    // new children mount
    // 8. 清空 innerHTML / textContent（非常重要）
    // 重点：处理 innerHTML/textContent 的“撤销”行为
    // 例如：
    // <div :innerHTML="htmlStr"></div>
    // 如果 htmlStr 原来有内容，后来设为 null，则需要清空 DOM。Vue 会提前处理这一步，避免内容残留。
    if (
      (oldProps.innerHTML && newProps.innerHTML == null) ||
      (oldProps.textContent && newProps.textContent == null)
    ) {
      hostSetElementText(el, '')
    }

    // 1. diff children
    // ✔ 优化路径：有 dynamicChildren（Block 模式）
    if (dynamicChildren) {
      // dynamicChildren 是编译器生成的 当前 block 中有 patchFlag 的子节点数组；
      // Vue 会跳过未变的 static vnode，只遍历需要更新的子节点，提升性能；
      patchBlockChildren(
        n1.dynamicChildren!,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds,
      )
      if (__DEV__) {
        // necessary for HMR
        // traverseStaticChildren 仅在开发环境用于 HMR 时补充 static vnode 的 DOM el 引用。
        traverseStaticChildren(n1, n2)
      }
    } else if (!optimized) {
      // optimized = false 表示非编译产物（如手写 render 函数）；
      // 或者是某些动态结构；
      // 会完整比较 n1.children 和 n2.children。
      // full diff 非优化路径：需要完整 diff
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds,
        false,
      )
    }

    // 2. diff props（使用 patchFlag 决定路径） 走 fast-path 分支
    if (patchFlag > 0) {
      // the presence of a patchFlag means this element's render code was
      // generated by the compiler and can take the fast path.
      // in this path old node and new node are guaranteed to have the same shape
      // (i.e. at the exact same position in the source template)
      // 1. FULL_PROPS: 动态 key，必须全量对比
      if (patchFlag & PatchFlags.FULL_PROPS) {
        // element props contain dynamic keys, full diff needed
        // 更新props
        // 例子：v-bind="someObject" 中的动态键名
        // 因为旧 key 有可能不存在于新对象中，所以必须全量比对 + 清理旧值。
        patchProps(el, oldProps, newProps, parentComponent, namespace)
      } else {
        // class
        // this flag is matched when the element has dynamic class bindings.
        // 2. CLASS
        // 针对 :class 动态绑定；
        // 仅当 class 值发生变化时才 patch。
        if (patchFlag & PatchFlags.CLASS) {
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, 'class', null, newProps.class, namespace)
          }
        }

        // 3. STYLE
        // 针对 :style 动态绑定；
        // 支持 object 和 string 两种写法。
        // this flag is matched when the element has dynamic style bindings
        if (patchFlag & PatchFlags.STYLE) {
          hostPatchProp(el, 'style', oldProps.style, newProps.style, namespace)
        }

        // 4. PROPS
        // 优化路径下，dynamicProps 是一个已知变化的 prop key 列表；
        // 逐一对比更新；
        // 特殊处理 value：哪怕值没变也强制 patch（防止 DOM 没变但影响逻辑）。
        // This flag is matched when the element has dynamic prop/attr bindings
        // other than class and style. The keys of dynamic prop/attrs are saved for
        // faster iteration.
        // Note dynamic keys like :[foo]="bar" will cause this optimization to
        // bail out and go through a full diff because we need to unset the old key
        if (patchFlag & PatchFlags.PROPS) {
          // if the flag is present then dynamicProps must be non-null
          const propsToUpdate = n2.dynamicProps!
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i]
            const prev = oldProps[key]
            const next = newProps[key]
            // #1471 force patch value
            if (next !== prev || key === 'value') {
              hostPatchProp(el, key, prev, next, namespace, parentComponent)
            }
          }
        }
      }

      // 5. TEXT
      // 当 vnode 的 children 是文本节点且动态变化；
      // Vue 会只 patch .textContent，跳过 children diff，极快。
      // This flag is matched when the element has only dynamic text children.
      if (patchFlag & PatchFlags.TEXT) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children as string)
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      // fallback 分支：未优化、无 patchFlag、无 dynamicChildren
      // unoptimized, full diff
      // 最保守的情况：手写 render、动态结构等；
      // 走完整属性比对。
      patchProps(el, oldProps, newProps, parentComponent, namespace)
    }

    // 生命周期钩子和指令钩子
    // 如果 vnode 上有 onVnodeUpdated 钩子，或者含有指令（如 v-model, v-show）：
    // 延迟到 patch 完成后统一触发；
    // 使用 queuePostRenderEffect 确保执行顺序。
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
        // invokeDirectiveHook
        dirs && invokeDirectiveHook(n2, n1, parentComponent, 'updated')
      }, parentSuspense)
    }
  }

  // The fast path for blocks.
  // Block Tree diff 的快速路径，用于高性能地更新编译器标记为 block 的子节点
  // 遍历两个 block 中的 动态子节点数组 dynamicChildren，只对比这些有变化的 vnode。
  // 跳过不变的静态 vnode，提升 diff 性能。
  const patchBlockChildren: PatchBlockChildrenFn = (
    oldChildren, // 上一个 block 中的 dynamicChildren
    newChildren, // 当前 block 中的 dynamicChildren
    fallbackContainer, // 备用 DOM 父容器
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    slotScopeIds,
  ) => {
    // 1. 遍历每一对 old & new vnode
    // 假设旧 vnode 和新 vnode 是一一对应的；
    // Vue 编译器保证这一点 —— 每个动态节点在模板中顺序固定。
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren[i]
      const newVNode = newChildren[i]
      // Determine the container (parent element) for the patch.
      // 2. 选择正确的 DOM 容器
      // 选择用于 patch 的 container（父 DOM 元素），因为 patch() 需要它。
      // 条件	含义
      // oldVNode.el	vnode 有真实 DOM（防止异步组件 setup 报错未挂载）
      // Fragment	需要实际 DOM 父节点来移动多个子节点
      // !isSameVNodeType(...)	类型变了，需要新插入节点，需要父容器
      // `Component	Teleport`
      const container =
        // oldVNode may be an errored async setup() component inside Suspense
        // which will not have a mounted element
        oldVNode.el &&
        // - In the case of a Fragment, we need to provide the actual parent
        // of the Fragment itself so it can move its children.
        (oldVNode.type === Fragment ||
          // - In the case of different nodes, there is going to be a replacement
          // which also requires the correct parent container
          !isSameVNodeType(oldVNode, newVNode) ||
          // - In the case of a component, it could contain anything.
          oldVNode.shapeFlag & (ShapeFlags.COMPONENT | ShapeFlags.TELEPORT))
          ? hostParentNode(oldVNode.el)!
          : // In other cases, the parent container is not actually used so we
            // just pass the block element here to avoid a DOM parentNode call.
            fallbackContainer // 否则：默认用 fallbackContainer（传入的上层元素）就行。
      patch(
        // 真正对 vnode 做更新操作； 最后一个参数 true 告诉 patch 这是优化路径，可以使用 patchFlag。
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        true,
      )
    }
  }

  // 是元素 vnode 更新时对比旧属性和新属性并更新到真实 DOM的逻辑。
  // 它用于非优化模式或 patchFlag = FULL_PROPS 时进行完整属性 diff，是更新流程中的重要一环。
  // 对比 oldProps 和 newProps，更新、添加或删除需要变化的属性到真实 DOM 元素 el 上。
  const patchProps = (
    // el: RendererElement                     // DOM 元素
    // oldProps: Data                          // 旧属性对象
    // newProps: Data                          // 新属性对象
    // parentComponent: ComponentInternalInstance | null // 父组件实例
    // namespace: ElementNamespace             // HTML / SVG 命名空间
    el: RendererElement,
    oldProps: Data,
    newProps: Data,
    parentComponent: ComponentInternalInstance | null,
    namespace: ElementNamespace,
  ) => {
    // 前提：props 不同才进入处理，如果对象引用相同（常见于静态 vnode），则跳过全部对比。
    if (oldProps !== newProps) {
      // 处理被删除的属性（旧有、新没有 → 删除）
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          // 判断条件：
          // 不是内部保留属性（如 key, ref, onVnodeXXX）；
          // 新属性中不存在这个 key。
          if (!isReservedProp(key) && !(key in newProps)) {
            // 调用 hostPatchProp，将属性值设为 null，触发 DOM 层级删除。
            hostPatchProp(
              el,
              key,
              oldProps[key],
              null,
              namespace,
              parentComponent,
            )
          }
        }
      }
      // 处理新增/更新的属性（新有、旧无 or 值变了）
      for (const key in newProps) {
        // empty string is not valid prop
        // 判断条件：
        // 排除内部保留属性；
        // 值发生变化；
        // 排除 value 属性，延后处理。
        if (isReservedProp(key)) continue
        const next = newProps[key]
        const prev = oldProps[key]
        // defer patching value
        if (next !== prev && key !== 'value') {
          hostPatchProp(el, key, prev, next, namespace, parentComponent)
        }
      }
      // 特殊处理 value 属性（例如 <input>）
      if ('value' in newProps) {
        hostPatchProp(el, 'value', oldProps.value, newProps.value, namespace)
      }
    }
  }

  // 是 Vue diff 算法中专门用于挂载、更新 Fragment 节点的逻辑。
  // 用于处理形如 <template>...</template>、<Fragment>...</Fragment> 或无根元素结构（如 <></>）的 vnode。
  // 在 Vue 中，Fragment vnode 是由多个子节点组成的一段连续结构，
  // 本身并不对应真实的 DOM 元素。Vue 通过“锚点节点”（el 和 anchor，两个注释节点）来定位 Fragment 的起止位置。
  const processFragment = (
    // 参数	含义
    // n1	旧 Fragment vnode（null 代表首次挂载）
    // n2	新 Fragment vnode
    // container	DOM 容器
    // anchor	锚点（插入位置）
    // parentComponent	所属组件
    // parentSuspense	所属 Suspense 边界
    // namespace	命名空间（HTML、SVG）
    // slotScopeIds	插槽作用域 ID
    // optimized	是否编译优化路径
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 1. 初始化锚点节点
    // Fragment 不是真实元素，用两个空文本节点（注释）作为起止锚点；
    // 在挂载或 patch 时，用于插入或识别范围。
    const fragmentStartAnchor = (n2.el = n1 ? n1.el : hostCreateText(''))!
    const fragmentEndAnchor = (n2.anchor = n1 ? n1.anchor : hostCreateText(''))!

    let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2

    // 2. HMR 开发模式兼容处理
    // 如果是 HMR 更新，强制走完整 diff；
    // 避免因为旧 vnode 被替换而丢失静态 vnode 的 el 引用。
    if (
      __DEV__ &&
      // #5523 dev root fragment may inherit directives
      (isHmrUpdating || patchFlag & PatchFlags.DEV_ROOT_FRAGMENT)
    ) {
      // HMR updated / Dev root fragment (w/ comments), force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // check if this is a slot fragment with :slotted scope ids
    // 3. 插槽作用域拼接
    // 支持 <slot :foo="bar"> 这种 slotted 插槽在 Fragment 中的传递。
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds
        ? slotScopeIds.concat(fragmentSlotScopeIds)
        : fragmentSlotScopeIds
    }

    // 4. 首次挂载 Fragment（n1 == null）
    if (n1 == null) {
      // 插入开始和结束锚点；
      // 调用 mountChildren 渲染并挂载中间的 vnode 列表。
      hostInsert(fragmentStartAnchor, container, anchor)
      hostInsert(fragmentEndAnchor, container, anchor)
      // a fragment can only have array children
      // since they are either generated by the compiler, or implicitly created
      // from arrays.
      mountChildren(
        // #10007
        // such fragment like `<></>` will be compiled into
        // a fragment which doesn't have a children.
        // In this case fallback to an empty array
        (n2.children || []) as VNodeArrayChildren,
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    } else {
      // 5. 更新 Fragment（n1 存在）
      if (
        patchFlag > 0 &&
        patchFlag & PatchFlags.STABLE_FRAGMENT &&
        dynamicChildren &&
        // #2715 the previous fragment could've been a BAILed one as a result
        // of renderSlot() with no valid children
        n1.dynamicChildren
      ) {
        // A. 优化路径：稳定 Fragment + dynamicChildren
        // a stable fragment (template root or <template v-for>) doesn't need to
        // patch children order, but it may contain dynamicChildren.
        // 编译器生成的 <template v-for> 会加上 STABLE_FRAGMENT；
        // 如果子节点是 block vnode，会生成 dynamicChildren；
        // 只需要 patch 有变化的子节点。
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          container,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
        )
        if (__DEV__) {
          // necessary for HMR
          traverseStaticChildren(n1, n2)
        } else if (
          // #2080 if the stable fragment has a key, it's a <template v-for> that may
          //  get moved around. Make sure all root level vnodes inherit el.
          // #2134 or if it's a component root, it may also get moved around
          // as the component is being moved.
          n2.key != null ||
          (parentComponent && n2 === parentComponent.subTree)
        ) {
          traverseStaticChildren(n1, n2, true /* shallow */)
        }
      } else {
        // keyed / unkeyed, or manual fragments.
        // for keyed & unkeyed, since they are compiler generated from v-for,
        // each child is guaranteed to be a block so the fragment will never
        // have dynamicChildren.
        // B. 普通路径（非优化）
        // 如果没有优化标记，就使用常规 patchChildren 比较新旧 vnode；
        // 可以是 keyed、unkeyed、文本变数组等。
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
      }
    }
  }

  // 负责根据组件是首次挂载还是更新阶段，选择执行 mountComponent 或 updateComponent，是组件级别 diff 的调度器。
  // 这个函数用于在 patch 阶段：
  // 挂载新组件（n1 === null）
  // 更新已存在组件（n1 !== null）
  // 支持 KeepAlive 激活
  // 传递 slot 作用域 ID（用于 CSS 作用域）
  const processComponent = (
    // 参数名	含义
    // n1	旧组件 vnode，null 表示首次挂载
    // n2	新组件 vnode
    // container	目标 DOM 容器
    // anchor	插入锚点
    // parentComponent	所属父组件
    // parentSuspense	Suspense 容器
    // namespace	命名空间，如 SVG
    // slotScopeIds	当前作用域插槽 ID
    // optimized	是否编译优化路径
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 1. 设置 slot 作用域 ID
    // 用于 CSS Scoped + <slot> 的结合场景；
    // 让组件子树拥有正确的作用域 class。
    n2.slotScopeIds = slotScopeIds
    // 2. 判断是否首次挂载
    if (n1 == null) {
      // 2.1 是 KeepAlive 的缓存组件 → 执行激活
      if (n2.shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE) {
        // 组件之前被缓存（而非销毁），此时走的是重新激活逻辑；
        // 会调用 KeepAlive 的 activate() 方法：
        // 恢复 DOM
        // 恢复响应式
        // 执行 activated 钩子
        ;(parentComponent!.ctx as KeepAliveContext).activate(
          n2,
          container,
          anchor,
          namespace,
          optimized,
        )
      } else {
        // 挂载组件
        // 2.2 普通新组件 → 挂载
        // 调用 setupComponent 初始化；
        // 创建组件渲染副作用（setupRenderEffect）；
        // 渲染组件 vnode；
        // patch 子树；
        // 调用生命周期钩子。
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          optimized,
        )
      }
    } else {
      // 更新组件
      // 组件 vnode 存在，说明是父组件触发的更新；
      //
      // 执行 updateComponent() 判断是否需要更新（shouldUpdateComponent()）；
      //
      // 如果需要更新：
      // 设置 instance.next = n2
      // 把 update() 加入调度队列，执行 patch。
      updateComponent(n1, n2, optimized)
    }
  }

  // 组件首次挂载的核心入口函数，它负责：
  // 创建组件实例；
  // 初始化 props 和 slots；
  // 调用 setupComponent() 准备好组件的 setup 内容；
  // 如果是异步组件，挂起等待；
  // 启动响应式渲染（通过 setupRenderEffect）；
  // 支持 KeepAlive 和 Suspense；
  // 调用调试和 HMR 逻辑。

  // 对传入的组件 vnode（即 <Comp /> ），创建运行时实例、调用 setup()，准备好响应式系统，并开始首次渲染。
  // mountComponent()
  // ├── createComponentInstance()
  // ├── setupComponent()
  // │   ├── init props, slots, ctx
  // │   ├── 执行 setup()
  // │   └── resolve render()
  // ├── 判断是否异步组件
  // │   ├── 是：挂起 + 注入占位
  // │   └── 否：执行 setupRenderEffect()
  // └── 结束
  const mountComponent: MountComponentFn = (
    initialVNode,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    optimized,
  ) => {
    // 2.x compat may pre-create the component instance before actually
    // mounting
    // 创建组件实例
    const compatMountInstance =
      __COMPAT__ && initialVNode.isCompatRoot && initialVNode.component
    // 兼容 2.x compat 模式可能预先创建了实例；
    // 正常流程是通过 createComponentInstance 构造组件的 runtime 实例（含 ctx, props, setupState, effect, update, vnode, subTree 等关键字段）。
    const instance: ComponentInternalInstance =
      compatMountInstance ||
      (initialVNode.component = createComponentInstance(
        initialVNode,
        parentComponent,
        parentSuspense,
      ))

    // 2. 注册 HMR 支持（开发模式）
    if (__DEV__ && instance.type.__hmrId) {
      // 热更新标识下，记录组件信息以便后续热重载时 diff。
      registerHMR(instance)
    }

    if (__DEV__) {
      pushWarningContext(initialVNode)
      startMeasure(instance, `mount`)
    }

    // inject renderer internals for keepAlive
    // 3. KeepAlive 绑定渲染器能力
    if (isKeepAlive(initialVNode)) {
      // 让 KeepAlive 组件可以访问 patch、unmount 等能力；
      // 用于后续的缓存、激活、回收 DOM。
      ;(instance.ctx as KeepAliveContext).renderer = internals
    }

    // resolve props and slots for setup context
    if (!(__COMPAT__ && compatMountInstance)) {
      if (__DEV__) {
        startMeasure(instance, `init`)
      }
      // 启动组件 4. 初始化组件内容
      // 会处理：
      // props 的初始化；
      // 解析 setup() 返回值；
      // 绑定响应式 proxy；
      // 创建 render() 函数；
      // 解析 emits；
      // 初始化 slots；
      // 组件自身响应式 scope。
      setupComponent(instance, false, optimized)
      if (__DEV__) {
        endMeasure(instance, `init`)
      }
    }

    // setup() is async. This component relies on async logic to be resolved
    // before proceeding
    // 5. 判断是否是异步组件  setup函数为异步的相关处理 忽略相关逻辑
    if (__FEATURE_SUSPENSE__ && instance.asyncDep) {
      // asyncDep 存在说明 setup() 返回了 Promise；
      // 该组件将挂起并等待 async setup 结束；
      // 注册依赖关系到当前 Suspense；
      // 若非 hydration，插入占位注释节点。
      // avoid hydration for hmr updating
      if (__DEV__ && isHmrUpdating) initialVNode.el = null

      parentSuspense &&
        parentSuspense.registerDep(instance, setupRenderEffect, optimized)

      // Give it a placeholder if this is not hydration
      // TODO handle self-defined fallback
      if (!initialVNode.el) {
        const placeholder = (instance.subTree = createVNode(Comment))
        processCommentNode(null, placeholder, container!, anchor)
      }
    } else {
      // 6. 正常组件立即渲染  启动带副作用的render函数
      // 启动响应式渲染系统，首次调用 render()，进行 patch；
      // 内部通过 ReactiveEffect 管理更新逻辑；
      // 第一次调用执行挂载流程（!isMounted）；
      // 后续依赖变更时再次执行为更新。
      setupRenderEffect(
        instance,
        initialVNode,
        container,
        anchor,
        parentSuspense,
        namespace,
        optimized,
      )
    }

    if (__DEV__) {
      popWarningContext()
      endMeasure(instance, `mount`)
    }
  }

  // 这是 patch 过程中判断两个组件 vnode（n1 → n2）是否需要执行更新逻辑的调度函数。其作用是：
  // 判断组件是否需要更新，并根据情况调用 update() 或仅更新 vnode 绑定关系。
  // 判断新旧组件 vnode 是否需要更新；
  // 如果是异步组件未准备好，则仅更新 props/slots；
  // 否则调用 instance.update() 触发渲染；
  // 如果无需更新，则复用 DOM、更新 vnode 实例关系。
  const updateComponent = (n1: VNode, n2: VNode, optimized: boolean) => {
    // 参数名	含义
    // n1	旧组件 vnode
    // n2	新组件 vnode
    // optimized	是否启用编译器优化路径
    // 1. 绑定实例到新 vnode 上
    // Vue 的组件 vnode 会挂载真实的运行时组件实例；
    // 更新时直接继承 n1.component。
    const instance = (n2.component = n1.component)!
    // 组件是否需要更新
    if (shouldUpdateComponent(n1, n2, optimized)) {
      // 调用的是内部函数 shouldUpdateComponent()，它根据以下内容判断：
      // props 是否发生变化；
      // children（slots）是否是动态的；
      // 静态 vnode 被 clone 的情况；
      // 是否编译器标记了 patchFlag。
      // 如果需要更新，进入下一步。

      //3. 异步组件仍未 resolve
      // 这类组件还未完成异步 setup()；
      // 此时无法执行 instance.update()，因为还没注册；
      if (
        __FEATURE_SUSPENSE__ &&
        instance.asyncDep &&
        !instance.asyncResolved
      ) {
        // async & still pending - just update props and slots
        // since the component's reactive effect for render isn't set-up yet
        if (__DEV__) {
          pushWarningContext(n2)
        }
        // 仅同步更新 props 和 slots，使得组件后续 hydration/update 时可以用上这些新值。
        updateComponentPreRender(instance, n2, optimized)
        if (__DEV__) {
          popWarningContext()
        }
        return
      } else {
        // 4. 正常组件更新路径
        // 将 n2 挂载到组件的 instance.next，表示是“即将更新的 vnode”；
        // 调用 instance.update()，这个函数是注册的 ReactiveEffect.run，会：
        // 调用 render() 生成新的 subTree；
        // 执行 patch(oldSubTree, newSubTree)；
        // 执行生命周期钩子。
        // normal update
        instance.next = n2
        // instance.update is the reactive effect.
        // 同步执行组件更新
        instance.update()
      }
    } else {
      // 5. 不需要更新，复用 vnode 和 DOM
      // no update needed. just copy over properties
      // 更新 instance和VNode 关系
      n2.el = n1.el
      instance.vnode = n2
    }
  }

  // 组件挂载和更新过程中最核心的逻辑之一。
  // 创建并注册组件的渲染副作用（render effect），用于挂载和后续响应式更新。
  // 这也是 Vue 组件响应式更新系统的起点，负责：
  // 首次挂载组件
  // 响应式数据变化后的更新
  // 调度和队列控制
  // 生命周期钩子调用
  // 与异步组件、keep-alive、hydration 等交互
  const setupRenderEffect: SetupRenderEffectFn = (
    instance,
    initialVNode,
    container,
    anchor,
    parentSuspense,
    namespace: ElementNamespace,
    optimized,
  ) => {
    const componentUpdateFn = () => {
      //1、首次挂载逻辑
      if (!instance.isMounted) {
        // 挂载组件
        let vnodeHook: VNodeHook | null | undefined
        const { el, props } = initialVNode
        const { bm, m, parent, root, type } = instance
        const isAsyncWrapperVNode = isAsyncWrapper(initialVNode)

        toggleRecurse(instance, false)
        // beforeMount hook
        if (bm) {
          invokeArrayFns(bm)
        }
        // onVnodeBeforeMount
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeBeforeMount)
        ) {
          invokeVNodeHook(vnodeHook, parent, initialVNode)
        }
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          instance.emit('hook:beforeMount')
        }
        toggleRecurse(instance, true)

        // el: 当前 vnode 已经绑定了服务端生成的 DOM；
        // hydrateNode: 当前渲染器（如 runtime-dom）是否实现了 hydration 方法；
        // 满足上述条件才会进行 hydration，否则走正常挂载。
        if (el && hydrateNode) {
          // 这段代码只在以下场景执行：
          // 当前组件的 vnode 已经拥有 DOM（由 SSR 渲染出的 HTML），且当前渲染器支持 hydrateNode 方法。
          // 这意味着：
          // 服务端 HTML 已经渲染到页面；
          // 客户端只需要“激活”这段 HTML，而不是重新创建和插入；
          // Vue 使用 hydration 方式复用已有 DOM，建立响应式和事件绑定。
          // vnode has adopted host node - perform hydration instead of mount.

          // 2. 构造 hydrate 函数
          const hydrateSubTree = () => {
            // 和普通挂载一样，先执行 render() 得到 vnode 树；
            // 然后调用 hydrateNode：
            // 遍历 vnode 树；
            // 与已有 DOM 一一对应；
            // 建立 vnode → DOM 的 .el 绑定；
            // 添加事件监听等。
            if (__DEV__) {
              startMeasure(instance, `render`)
            }
            instance.subTree = renderComponentRoot(instance)
            if (__DEV__) {
              endMeasure(instance, `render`)
            }
            if (__DEV__) {
              startMeasure(instance, `hydrate`)
            }
            hydrateNode!(
              el as Node,
              instance.subTree,
              instance,
              parentSuspense,
              null,
            )
            if (__DEV__) {
              endMeasure(instance, `hydrate`)
            }
          }

          // 判断是否是异步组件封装（defineAsyncComponent()）
          if (
            isAsyncWrapperVNode &&
            (type as ComponentOptions).__asyncHydrate
          ) {
            // 对异步组件（defineAsyncComponent）包装的 vnode；
            // 它会注入 __asyncHydrate() 方法，用于处理异步内容的挂载；
            // 例如：
            // 异步组件完成前的 placeholder；
            // 异步解析后再执行 hydration。

            // 执行 hydrate
            // 如果异步组件定义了 __asyncHydrate → 延迟执行；
            // 否则立即执行 hydrateSubTree()。
            ;(type as ComponentOptions).__asyncHydrate!(
              el as Element,
              instance,
              hydrateSubTree,
            )
          } else {
            hydrateSubTree()
          }
        } else {
          // custom element style injection
          // 注入自定义元素样式（Web Components 场景）
          if (root.ce) {
            // root.ce 是 defineCustomElement() 返回的自定义组件包装器；
            // 用于将 style 注入 shadow DOM；
            // 只在 CustomElement 模式下运行，不影响常规组件。
            root.ce._injectChildStyle(type)
          }

          if (__DEV__) {
            startMeasure(instance, `render`)
          }
          // 以当前组件为根渲染子节点
          // 2. 渲染 subTree 并 patch 到 DOM 中
          // 调用 render 函数，生成组件的 VNode 树；
          // 首次挂载传入旧 vnode 为 null，走创建逻辑；
          // 设置 initialVNode.el，用于 vnode → DOM 的绑定；
          // 同时 instance.subTree.el 也记录了根 DOM。
          const subTree = (instance.subTree = renderComponentRoot(instance))
          if (__DEV__) {
            endMeasure(instance, `render`)
          }
          if (__DEV__) {
            startMeasure(instance, `patch`)
          }
          // patch子树
          patch(
            null,
            subTree,
            container,
            anchor,
            instance,
            parentSuspense,
            namespace,
          )
          if (__DEV__) {
            endMeasure(instance, `patch`)
          }
          // 挂载后处理
          initialVNode.el = subTree.el
        }
        // mounted hook
        // 3. 注册生命周期钩子：mounted
        if (m) {
          // m 是组件实例收集的 mounted 钩子数组；
          // 延迟到 patch 后的 flush 阶段异步执行；
          // 保证在 DOM 挂载完成后触发。
          queuePostRenderEffect(m, parentSuspense)
        }
        // onVnodeMounted
        // 注册 VNode Hook：onVnodeMounted
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeMounted)
        ) {
          // 来自 props 的 vnode 级别生命周期钩子；
          // 常用于外部手动控制组件的某些生命周期行为。
          const scopedInitialVNode = initialVNode
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, scopedInitialVNode),
            parentSuspense,
          )
        }
        // 注册兼容模式的 hook:mounted
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          // 为 Vue 2 兼容性提供支持；
          // 在组件上发出 hook:mounted 事件。
          queuePostRenderEffect(
            () => instance.emit('hook:mounted'),
            parentSuspense,
          )
        }

        // activated hook for keep-alive roots.
        // #1742 activated hook must be accessed after first render
        // since the hook may be injected by a child keep-alive
        // 注册 KeepAlive 相关的 activated 钩子
        // 如果组件被 KeepAlive 包裹，将注册 activated 钩子；
        // instance.a 就是 activated 钩子；
        // hook:activated 为 Vue 2 兼容事件。
        if (
          initialVNode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE ||
          (parent &&
            isAsyncWrapper(parent.vnode) &&
            parent.vnode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE)
        ) {
          instance.a && queuePostRenderEffect(instance.a, parentSuspense)
          if (
            __COMPAT__ &&
            isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
          ) {
            queuePostRenderEffect(
              () => instance.emit('hook:activated'),
              parentSuspense,
            )
          }
        }
        // 标记组件已挂载
        instance.isMounted = true

        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          // 开发工具：通知 Devtools 添加组件
          // 通知 Vue Devtools 添加这个组件实例；
          // 提供状态追踪、调试信息、事件监听等能力。
          devtoolsComponentAdded(instance)
        }

        // #2458: deference mount-only object parameters to prevent memleaks
        // 清除首次挂载参数引用，防止内存泄漏
        // 首次挂载后，这些变量不再需要；
        // 显式清空引用，帮助 GC 回收。
        initialVNode = container = anchor = null as any
      } else {
        // 2、更新组件
        // 组件自身发起的更新 next 为 null
        // 父组件发起的更新 next 为 下一个状态的组件VNode
        let { next, bu, u, parent, vnode } = instance

        if (__FEATURE_SUSPENSE__) {
          const nonHydratedAsyncRoot = locateNonHydratedAsyncRoot(instance)
          // we are trying to update some async comp before hydration
          // this will cause crash because we don't know the root node yet
          if (nonHydratedAsyncRoot) {
            // only sync the properties and abort the rest of operations
            if (next) {
              // 如果存在next 我们需要更新组件实例相关信息
              // 修正instance 和 nextVNode相关指向关系
              // 更新Props和Slots
              next.el = vnode.el
              updateComponentPreRender(instance, next, optimized)
            }
            // and continue the rest of operations once the deps are resolved
            nonHydratedAsyncRoot.asyncDep!.then(() => {
              // the instance may be destroyed during the time period
              if (!instance.isUnmounted) {
                componentUpdateFn()
              }
            })
            return
          }
        }

        // updateComponent
        // This is triggered by mutation of component's own state (next: null)
        // OR parent calling processComponent (next: VNode)
        // originNext 用于判断是不是内部触发更新；
        // next 是父组件生成的新 vnode，用于更新当前组件。
        let originNext = next
        let vnodeHook: VNodeHook | null | undefined
        if (__DEV__) {
          pushWarningContext(next || instance.vnode)
        }

        // Disallow component effect recursion during pre-lifecycle hooks.
        // 2. 禁止递归更新，防止生命周期钩子内部无限触发更新
        toggleRecurse(instance, false)
        // 3. 如果有新 vnode（父组件传入新的 props/slots）
        if (next) {
          // 如果存在next 我们需要更新组件实例相关信息
          // 修正instance 和 nextVNode相关指向关系
          // 更新Props和Slots
          next.el = vnode.el
          updateComponentPreRender(instance, next, optimized)
        } else {
          next = vnode
        }

        // beforeUpdate hook
        // 4. 执行 beforeUpdate 生命周期钩子
        if (bu) {
          invokeArrayFns(bu)
        }
        // onVnodeBeforeUpdate
        if ((vnodeHook = next.props && next.props.onVnodeBeforeUpdate)) {
          invokeVNodeHook(vnodeHook, parent, next, vnode)
        }
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          instance.emit('hook:beforeUpdate')
        }
        // 5. 重新打开递归更新
        toggleRecurse(instance, true)

        // render
        if (__DEV__) {
          startMeasure(instance, `render`)
        }
        // 渲染新的子树
        // 6. 执行 render，得到新的 subTree
        // 这是最关键的一步：
        // 调用组件的 render 函数（或者 setup 返回的函数）；
        // 得到新的 vnode 树；
        // 准备对比和 patch。
        const nextTree = renderComponentRoot(instance)
        if (__DEV__) {
          endMeasure(instance, `render`)
        }
        // 渲染新的子树
        const prevTree = instance.subTree
        instance.subTree = nextTree

        if (__DEV__) {
          startMeasure(instance, `patch`)
        }
        // diff子树
        // 7. patch（diff）新旧子树
        // 对比新旧 vnode 树；
        // 更新 DOM；
        // DOM 节点的移动、更新、删除都在这里完成。
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          // 排除teleport的情况，即时获取父节点
          hostParentNode(prevTree.el!)!,
          // anchor may have changed if it's in a fragment
          // 排除fragement情况，即时获取下一个节点
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          namespace,
        )
        if (__DEV__) {
          endMeasure(instance, `patch`)
        }
        // 8. 更新 vnode.el
        // 把新 vnode 绑定新的根 DOM；
        // 是为了 HOC 或 keep-alive 中复用 DOM 节点。
        next.el = nextTree.el
        // 9. 如果是组件内部触发的更新（非 props），同步更新父 vnode.el
        if (originNext === null) {
          // self-triggered update. In case of HOC, update parent component
          // vnode el. HOC is indicated by parent instance's subTree pointing
          // to child component's vnode
          updateHOCHostEl(instance, nextTree.el)
        }
        // updated hook
        if (u) {
          // 10. 执行 updated 生命周期钩子（异步调度）
          queuePostRenderEffect(u, parentSuspense)
        }
        // onVnodeUpdated
        if ((vnodeHook = next.props && next.props.onVnodeUpdated)) {
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, next!, vnode),
            parentSuspense,
          )
        }
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          queuePostRenderEffect(
            () => instance.emit('hook:updated'),
            parentSuspense,
          )
        }

        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          devtoolsComponentUpdated(instance)
        }

        if (__DEV__) {
          popWarningContext()
        }
      }
    }

    // create reactive effect for rendering
    // 1. 启用当前组件的响应式作用域
    // 每个组件都有自己的 EffectScope；
    // 这样它的副作用（effect、watcher）都可统一销毁；
    // 常用于组件卸载时调用 scope.stop() 自动停止所有关联副作用。
    instance.scope.on()
    // 2. 创建副作用对象
    // componentUpdateFn 是首次挂载或更新组件的函数（逻辑你在 setupRenderEffect 中已经贴过）；
    // ReactiveEffect 是 Vue 响应式系统的核心执行器；
    // 它会追踪响应式依赖，并在依赖变更时被调度。
    const effect = (instance.effect = new ReactiveEffect(componentUpdateFn))
    instance.scope.off()

    // 3. 绑定运行方法和调度 job

    //  .run()：
    // 立即执行一次副作用（同步运行）；
    // 用于首次挂载。

    // .runIfDirty()：
    // 判断依赖是否脏了再执行；
    // 用于调度优化（避免重复执行）；
    //
    // 被包裹为 job，用于 scheduler。
    const update = (instance.update = effect.run.bind(effect))
    const job: SchedulerJob = (instance.job = effect.runIfDirty.bind(effect))
    job.i = instance
    job.id = instance.uid
    // 4. 配置调度器 scheduler
    // 当依赖变更时不会立即执行，而是通过 scheduler 异步加入任务队列；
    // queueJob() 会将 job 推入 flushJobs() 中统一批处理，避免频繁更新。
    effect.scheduler = () => queueJob(job)

    // allowRecurse
    // #1801, #2043 component render effects should allow recursive updates
    // 5. 允许递归更新（避免生命周期死锁）
    // 有些生命周期钩子内可能会触发自身更新；
    // 需要允许递归调用 update()。
    toggleRecurse(instance, true)

    // 6. 开发模式：调试工具钩子
    // onTrack：收集依赖时触发（如 ref.value 被读取）；
    // onTrigger：依赖变更时触发（如 ref.value = xxx）；
    // 用于 devtools 依赖可视化。
    if (__DEV__) {
      effect.onTrack = instance.rtc
        ? e => invokeArrayFns(instance.rtc!, e)
        : void 0
      effect.onTrigger = instance.rtg
        ? e => invokeArrayFns(instance.rtg!, e)
        : void 0
    }

    // 7. 首次立即执行一次挂载
    update()
  }

  // 它用于组件更新过程的准备阶段，在组件 update() 执行前调用，负责更新组件实例的 vnode、props 和 slots。
  // 这个函数的本质作用是：
  // 当父组件传入新的 vnode（如更新 props 或插槽）时，把这些新数据同步到子组件实例上，为后续的 render 做准备。
  const updateComponentPreRender = (
    instance: ComponentInternalInstance,
    nextVNode: VNode,
    optimized: boolean,
  ) => {
    // 下一个状态的组件VNode.component指向实例
    // 1. 将新 vnode 绑定到当前组件实例
    // Vue 的组件 vnode 会记录其真实运行时实例；
    // 新 vnode 是从父组件 render 中新生成的，需要绑定现有实例。
    nextVNode.component = instance
    // 缓存旧的props 后续 diff props 时用来比对新旧值。
    const prevProps = instance.vnode.props
    // 修改instance.vnode的指向 3. 用新 vnode 替换组件当前的 vnode
    // 当前实例的 vnode 被替换为新的 vnode；
    // 是整个组件更新的核心来源数据。
    instance.vnode = nextVNode
    // 重新设置next为空
    instance.next = null
    // 更新props
    // 更新组件实例上的 instance.props；
    // 对于 setup 组件，会同时触发 proxy._props 响应式更新；
    // 支持编译优化（patchFlag & PROPS）只更新变更字段。
    updateProps(instance, nextVNode.props, prevProps, optimized)
    // 更新插槽slots
    updateSlots(instance, nextVNode.children, optimized)

    // 7. 暂停依赖追踪 + 刷新 pre-flush 回调
    // 在 updateProps() 和 updateSlots() 中可能触发了一些 watcher（比如响应式依赖）；
    // 暂停追踪可避免错误的依赖收集；
    // 再刷新那些 pre-flush 回调（如 watchEffect）；
    // 最后重置依赖收集状态。
    pauseTracking()
    // props update may have triggered pre-flush watchers.
    // flush them before the render update.
    flushPreFlushCbs(instance)
    resetTracking()

    // 使用场景
    // 在组件的更新阶段，Vue 会先调用：
    // updateComponentPreRender(instance, nextVNode, optimized)
    // 再执行 instance.update() 去触发 render -> patch 流程。
  }

  // vnode diff 阶段的关键调度函数，用于处理任意两个 vnode 之间 children 的对比和更新。
  // 根据新旧 vnode 的 children 类型（文本、数组、null）以及 shapeFlag 和 patchFlag，选择合适的策略对比 children，并
  // 调用相应的处理函数（如 patchKeyedChildren、patchUnkeyedChildren、mountChildren、unmountChildren 等）。
  // 它负责做“决策分发”：不处理具体 diff，而是选择调用哪个函数处理 diff。
  const patchChildren: PatchChildrenFn = (
    n1,
    n2,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    slotScopeIds,
    optimized = false,
  ) => {
    // 获取基本信息
    const c1 = n1 && n1.children
    const prevShapeFlag = n1 ? n1.shapeFlag : 0
    const c2 = n2.children

    const { patchFlag, shapeFlag } = n2
    // fast path
    if (patchFlag > 0) {
      if (patchFlag & PatchFlags.KEYED_FRAGMENT) {
        // this could be either fully-keyed or mixed (some keyed some not)
        // presence of patchFlag means children are guaranteed to be arrays
        patchKeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        return
      } else if (patchFlag & PatchFlags.UNKEYED_FRAGMENT) {
        // unkeyed
        patchUnkeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        return
      }
    }

    // children has 3 possibilities: text, array or no children.
    // children 存在 三种可能： 文本节点、数组型、无children
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      // text children fast path
      // 新children文本类型的子节点
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // 旧children是数组型，直接卸载
        unmountChildren(c1 as VNode[], parentComponent, parentSuspense)
      }
      if (c2 !== c1) {
        // 新旧都是文本，但是文本不相同直接替换
        hostSetElementText(container, c2 as string)
      }
    } else {
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // prev children was array
        // 旧children是数组
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // two arrays, cannot assume anything, do full diff
          // 新children是数组
          patchKeyedChildren(
            c1 as VNode[],
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else {
          // no new children, just unmount old
          // 不存在新children，直接卸载旧children
          unmountChildren(c1 as VNode[], parentComponent, parentSuspense, true)
        }
      } else {
        // prev children was text OR null
        // new children is array OR null
        // 旧children可能是文本或者空
        // 新children可能是数组或者空
        if (prevShapeFlag & ShapeFlags.TEXT_CHILDREN) {
          // 如果旧children是文本，无论新children是哪个可能都需要先清除文本内容
          hostSetElementText(container, '')
        }
        // mount new if array
        // 此时原dom内容应该为空
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // 如果新children为数组 直接挂载
          mountChildren(
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        }
      }
    }
  }

  // 它用于处理 v-for 或数组子节点 未使用 key 的情况，是 Vue diff 算法中比较“保守”的路径。
  // 用于对比旧的 vnode 列表 c1 和新的 c2，两者都没有 key，所以只能按索引位置逐一比较和 patch，不能进行智能的复用或移动优化。
  // 这种 diff 策略被称为 按顺序比对（by-index diff），效率和准确性都远低于 patchKeyedChildren。
  const patchUnkeyedChildren = (
    // 参数	含义
    // c1	旧 vnode 列表（未 keyed）
    // c2	新 vnode 列表（未 keyed）
    // container	父 DOM 元素
    // anchor	锚点
    // parentComponent	父组件实例
    // parentSuspense	所属 suspense 边界
    // namespace	命名空间，如 SVG
    // slotScopeIds	作用域插槽 ID
    // optimized	是否启用编译器优化路径
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 1. 容错初始化 防止空传参。
    c1 = c1 || EMPTY_ARR
    c2 = c2 || EMPTY_ARR
    // 2. 获取长度信息
    const oldLength = c1.length
    const newLength = c2.length
    // commonLength: 两边都存在的那部分 vnode（可以 patch）；
    // 超出的部分要么 卸载（旧节点多），要么 挂载（新节点多）。
    const commonLength = Math.min(oldLength, newLength)
    let i
    // 3. 遍历 patch 公共部分
    for (i = 0; i < commonLength; i++) {
      // cloneIfMounted()：避免复用已挂载 vnode；
      // normalizeVNode()：规范化 vnode（字符串转文本节点等）；
      // 核心是 patch(oldVNode, newVNode) 对比并更新。
      const nextChild = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    }
    // 4. 多余旧节点需要卸载
    if (oldLength > newLength) {
      // remove old
      // 多出来的旧节点在新列表中不存在；
      // 从 commonLength 开始批量卸载。
      unmountChildren(
        c1,
        parentComponent,
        parentSuspense,
        true,
        false,
        commonLength,
      )
    } else {
      // mount new
      // 5. 多余新节点需要挂载
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
        commonLength,
      )
    }
  }

  // can be all-keyed or mixed
  // Vue 3 渲染器中 diff 算法的核心部分之一，用于处理旧子节点 (c1) 和新子节点 (c2) 都带有 key 的情况。
  // 这个函数实现了 Vue 的 keyed diff 算法，采用了双端比较 + 最长递增子序列（LIS）优化策略，在更新列表结构（如 v-for）时性能非常高效。
  // 对比 c1 和 c2 中的每个 VNode，根据 key 值进行高效的 最小操作 diff，包括：
  // 更新节点
  // 移动节点
  // 新增节点
  // 删除节点
  // 适用于模板如下结构：
  // <div v-for="item in list" :key="item.id">{{ item.name }}</div>
  const patchKeyedChildren = (
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    parentAnchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 索引 i
    let i = 0
    // 新children长度
    const l2 = c2.length
    // 旧children结束索引
    let e1 = c1.length - 1 // prev ending index
    // 新children结束索引
    let e2 = l2 - 1 // next ending index

    // 1. sync from start
    // (a b) c
    // (a b) d e
    // 1.同步开始索引
    while (i <= e1 && i <= e2) {
      const n1 = c1[i]
      const n2 = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      // 相同节点
      if (isSameVNodeType(n1, n2)) {
        // 直接patch
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
      } else {
        // 不同跳出
        break
      }
      i++
    }

    // 2. sync from end
    // a (b c)
    // d e (b c)
    // 2.同步尾部
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1]
      const n2 = (c2[e2] = optimized
        ? cloneIfMounted(c2[e2] as VNode)
        : normalizeVNode(c2[e2]))
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
      } else {
        break
      }
      e1--
      e2--
    }

    // 3. common sequence + mount
    // (a b)
    // (a b) c
    // i = 2, e1 = 1, e2 = 2
    // (a b)
    // c (a b)
    // i = 0, e1 = -1, e2 = 0
    // 3. 同步后 需要mount的情况
    if (i > e1) {
      // 旧children 同步完毕
      if (i <= e2) {
        // 如果新children还有剩下，说明新增了需要挂载
        const nextPos = e2 + 1
        // 获取插入的相对位置
        const anchor = nextPos < l2 ? (c2[nextPos] as VNode).el : parentAnchor
        while (i <= e2) {
          // 循环mount
          patch(
            null,
            (c2[i] = optimized
              ? cloneIfMounted(c2[i] as VNode)
              : normalizeVNode(c2[i])),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
          i++
        }
      }
    }

    // 4. common sequence + unmount
    // (a b) c
    // (a b)
    // i = 2, e1 = 2, e2 = 1
    // a (b c)
    // (b c)
    // i = 0, e1 = 0, e2 = -1
    // 4. 同步后 需要卸载
    else if (i > e2) {
      // 新children已经同步完成
      while (i <= e1) {
        // 如果旧children还剩，说明需要卸载
        unmount(c1[i], parentComponent, parentSuspense, true)
        i++
      }
    }

    // 5. unknown sequence
    // [i ... e1 + 1]: a b [c d e] f g
    // [i ... e2 + 1]: a b [e d c h] f g
    // i = 2, e1 = 4, e2 = 5
    // 5. 同步后两者都还剩余，需要更细致判断
    else {
      // 新旧开始索引
      const s1 = i // prev starting index
      const s2 = i // next starting index

      // 5.1 build key:index map for newChildren
      // 5.1 建立key--->index的哈希表（新children中的对应关系）
      const keyToNewIndexMap: Map<PropertyKey, number> = new Map()
      for (i = s2; i <= e2; i++) {
        const nextChild = (c2[i] = optimized
          ? cloneIfMounted(c2[i] as VNode)
          : normalizeVNode(c2[i]))
        if (nextChild.key != null) {
          if (__DEV__ && keyToNewIndexMap.has(nextChild.key)) {
            warn(
              `Duplicate keys found during update:`,
              JSON.stringify(nextChild.key),
              `Make sure keys are unique.`,
            )
          }
          keyToNewIndexMap.set(nextChild.key, i)
        }
      }

      // 5.2 loop through old children left to be patched and try to patch
      // matching nodes & remove nodes that are no longer present
      // 5.2 建立新children剩余子序列对应在旧children中的索引
      let j
      // 已经patch的个数
      let patched = 0
      // 待patch的个数
      const toBePatched = e2 - s2 + 1
      // 是否需要移动
      let moved = false
      // used to track whether any node has moved
      let maxNewIndexSoFar = 0
      // works as Map<newIndex, oldIndex>
      // Note that oldIndex is offset by +1
      // and oldIndex = 0 is a special value indicating the new node has
      // no corresponding old node.
      // used for determining longest stable subsequence
      // 新children每个VNode对应索引在旧children中索引的映射表
      const newIndexToOldIndexMap = new Array(toBePatched)
      // 附上初始值为 0
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0
      // 开始遍历旧children同步剩下的序列
      for (i = s1; i <= e1; i++) {
        const prevChild = c1[i]
        if (patched >= toBePatched) {
          // 如果已经patch个数大于待patch
          // 说明是需要卸载的元素
          // all new children have been patched so this can only be a removal
          unmount(prevChild, parentComponent, parentSuspense, true)
          continue
        }
        // 获取当前旧child在新children中的索引
        let newIndex
        if (prevChild.key != null) {
          newIndex = keyToNewIndexMap.get(prevChild.key)
        } else {
          // key-less node, try to locate a key-less node of the same type
          for (j = s2; j <= e2; j++) {
            if (
              newIndexToOldIndexMap[j - s2] === 0 &&
              isSameVNodeType(prevChild, c2[j] as VNode)
            ) {
              newIndex = j
              break
            }
          }
        }
        if (newIndex === undefined) {
          // 如果索引不存在，找不到 直接卸载
          unmount(prevChild, parentComponent, parentSuspense, true)
        } else {
          // 存储当前child在新children索引 ---> 在旧children索引
          newIndexToOldIndexMap[newIndex - s2] = i + 1
          if (newIndex >= maxNewIndexSoFar) {
            // child在新children中的索引为递增就直接更新
            maxNewIndexSoFar = newIndex
          } else {
            // newIndex如果不是递增，说明新children剩余序列相对旧children不是相同的顺序，需要移动某些元素
            moved = true
          }
          // 同时存在于新旧children中的直接patch
          patch(
            prevChild,
            c2[newIndex] as VNode,
            container,
            null,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
          patched++
        }
      }

      // 5.3 move and mount
      // generate longest stable subsequence only when nodes have moved
      // 得到newIndexToOldIndexMap的最长上升子序列对应的索引下标
      // 也就意味着得到了旧children 最长的不需要移动的子序列
      // 这里采用了最长递增子序列的方式来查找出，新子序中最长的保持了旧子序顺序的元素下标（也就是在新子序中的下标）
      const increasingNewIndexSequence = moved
        ? getSequence(newIndexToOldIndexMap)
        : EMPTY_ARR
      j = increasingNewIndexSequence.length - 1
      // looping backwards so that we can use last patched node as anchor
      // 反向循环
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i
        const nextChild = c2[nextIndex] as VNode
        // 通过新children获取插入的相对位置（dom的后一个元素）
        const anchor =
          nextIndex + 1 < l2 ? (c2[nextIndex + 1] as VNode).el : parentAnchor
        if (newIndexToOldIndexMap[i] === 0) {
          // mount new
          // 没有建立新child在旧children中的索引说明是新增元素需要挂载
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else if (moved) {
          // move if:
          // There is no stable subsequence (e.g. a reverse)
          // OR current node is not among the stable sequence
          // 如果需要移动的情况
          // 不需要移动的元素已经没有了那就只剩下需要移动的
          // 当前索引不在最长递增子序列中
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            // 移动
            move(nextChild, container, anchor, MoveType.REORDER)
          } else {
            j--
          }
        }
      }
    }
  }

  // 处理 VNode 在 DOM 中移动位置（如更新、挂载、动画、Fragment、Teleport 等） 的核心函数之一。
  // 它在以下几种场景中扮演关键角色：
  // <TransitionGroup> 的子节点移动；
  // Fragment 节点结构调整；
  // Teleport 目标切换；
  // 组件或 Suspense 的根 vnode 被移动；
  // 静态内容、带过渡动画的元素重新插入
  const move: MoveFn = (
    vnode,
    container, // 要移动到的新容器
    anchor, // 插入位置锚点
    moveType, // 移动的类型（进入、离开、重排）
    parentSuspense = null,
  ) => {
    const { el, type, transition, children, shapeFlag } = vnode
    // 1. 如果是组件节点，递归进入子树
    if (shapeFlag & ShapeFlags.COMPONENT) {
      // 组件本身没有 DOM；
      // 递归进入它的 subTree。
      move(vnode.component!.subTree, container, anchor, moveType)
      return
    }

    // 2. Suspense 特殊处理
    if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
      // Suspense 组件拥有内部控制机制；
      // 调用 suspense.move() 来移动它的内容。
      vnode.suspense!.move(container, anchor, moveType)
      return
    }

    // 3. Teleport 特殊处理
    if (shapeFlag & ShapeFlags.TELEPORT) {
      // Teleport 是跨层插入节点的机制；
      // 它有自己的 move() 方法（由 TeleportImpl 提供）；
      // 插槽切换或 props 更新会触发目标位置变化。
      ;(type as typeof TeleportImpl).move(vnode, container, anchor, internals)
      return
    }

    // 4. Fragment：批量移动子节点 + 开头、结尾锚点
    if (type === Fragment) {
      // Fragment 是多个子 vnode 的集合；
      // el 是 Fragment 的起始注释节点；
      // anchor 是结束注释节点；
      // 它们在 DOM 中成对出现，起标记作用；
      // 子节点逐个递归移动。
      hostInsert(el!, container, anchor)
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move((children as VNode[])[i], container, anchor, moveType)
      }
      hostInsert(vnode.anchor!, container, anchor)
      return
    }

    // 5. Static VNode（如 v-once）
    // 静态节点可能是静态内容提升后生成的；
    // 使用单独的 moveStaticNode。
    if (type === Static) {
      moveStaticNode(vnode, container, anchor)
      return
    }

    // single nodes
    // 6. 普通元素节点的过渡处理
    const needTransition =
      moveType !== MoveType.REORDER &&
      shapeFlag & ShapeFlags.ELEMENT &&
      transition
    if (needTransition) {
      // 如果是 进入动画（ENTER）：
      if (moveType === MoveType.ENTER) {
        // 先调用 beforeEnter 设置初始状态
        // 再插入节点；
        // 然后延迟触发 enter 动画逻辑。
        transition!.beforeEnter(el!)
        hostInsert(el!, container, anchor)
        queuePostRenderEffect(() => transition!.enter(el!), parentSuspense)
      } else {
        // 如果是 离开动画（LEAVE）：
        // 调用 transition.leave，并传入回调；
        // 完成后判断是否已卸载，决定是否真正移除；
        // 或将其重新插入指定位置。
        // delayLeave 是可选钩子，允许用户延迟离开处理（如 staggered transition）。
        const { leave, delayLeave, afterLeave } = transition!
        const remove = () => {
          if (vnode.ctx!.isUnmounted) {
            hostRemove(el!)
          } else {
            hostInsert(el!, container, anchor)
          }
        }
        const performLeave = () => {
          leave(el!, () => {
            remove()
            afterLeave && afterLeave()
          })
        }
        if (delayLeave) {
          delayLeave(el!, remove, performLeave)
        } else {
          performLeave()
        }
      }
    } else {
      // 7. 非动画直接插入
      // 没有动画时，直接插入新位置；
      // 用 anchor 控制插入位置。
      hostInsert(el!, container, anchor)
    }
  }

  // 组件和元素 vnode 生命周期的统一卸载入口，非常核心。
  // 这个函数会根据 vnode 类型（组件、元素、Fragment、Teleport、Suspense）决定用何种方式销毁 vnode，同时处理生命周期钩子、ref 清理、过渡动画等。
  // 清除 vnode 对应的副作用（ref、指令、生命周期等）；
  // 卸载子树（包括递归卸载 children）；
  // 如果 doRemove = true，移除 vnode 对应的 DOM 节点。
  const unmount: UnmountFn = (
    vnode,
    parentComponent,
    parentSuspense,
    doRemove = false,
    optimized = false,
  ) => {
    const {
      type,
      props,
      ref,
      children,
      dynamicChildren,
      shapeFlag,
      patchFlag,
      dirs,
      cacheIndex,
    } = vnode

    // 1. 特殊情况处理
    if (patchFlag === PatchFlags.BAIL) {
      // patchFlag 为 BAIL 时表示不走优化路径（如手写 render，或运行时 clone vnode），必须关闭优化。
      optimized = false
    }

    // unset ref 阶段
    // 2. 清除 ref
    if (ref != null) {
      // 设置 ref 为 null；
      // 最终会导致调用 unref() 或 $refs.xxx = null。
      setRef(ref, null, parentSuspense, vnode, true)
    }

    // #6593 should clean memo cache when unmount
    // 3. 清除组件缓存值（render cache）
    // 这是编译优化中用于缓存 v-once、v-slot 结构的数组；
    // 卸载时要清空缓存，防止复用旧数据。
    if (cacheIndex != null) {
      parentComponent!.renderCache[cacheIndex] = undefined
    }

    // 4. KeepAlive 组件不能直接卸载
    if (shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE) {
      // 被 <KeepAlive> 包裹的组件不是真卸载，只是被缓存；
      // 会调用 deactivate()，进入“停用”状态。
      ;(parentComponent!.ctx as KeepAliveContext).deactivate(vnode)
      return
    }

    const shouldInvokeDirs = shapeFlag & ShapeFlags.ELEMENT && dirs
    const shouldInvokeVnodeHook = !isAsyncWrapper(vnode)

    let vnodeHook: VNodeHook | undefined | null
    // 5. onVnodeBeforeUnmount 钩子
    // 如果不是异步组件包裹，且 props 有钩子；
    // 调用 beforeUnmount 钩子。
    if (
      shouldInvokeVnodeHook &&
      (vnodeHook = props && props.onVnodeBeforeUnmount)
    ) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode)
    }

    //  类型分支处理 A. Component（子组件）
    if (shapeFlag & ShapeFlags.COMPONENT) {
      // 调用组件专用的 unmountComponent，内部会：
      // 停止 effectScope；
      // 卸载子树；
      // 执行组件生命周期钩子。
      unmountComponent(vnode.component!, parentSuspense, doRemove)
    } else {
      // B. Suspense（异步内容结构）
      if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
        // 会调用 SuspenseBoundary.unmount() 卸载其中内容；
        // 处理异步加载的延迟节点、fallback 区域等。
        vnode.suspense!.unmount(parentSuspense, doRemove)
        return
      }

      // C. 指令钩子（beforeUnmount）
      if (shouldInvokeDirs) {
        // invokeDirectiveHook
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeUnmount')
      }

      // D. Teleport
      if (shapeFlag & ShapeFlags.TELEPORT) {
        ;(vnode.type as typeof TeleportImpl).remove(
          vnode,
          parentComponent,
          parentSuspense,
          internals,
          doRemove,
        )
      } else if (
        dynamicChildren &&
        // #5154
        // when v-once is used inside a block, setBlockTracking(-1) marks the
        // parent block with hasOnce: true
        // so that it doesn't take the fast path during unmount - otherwise
        // components nested in v-once are never unmounted.
        !dynamicChildren.hasOnce &&
        // #1153: fast path should not be taken for non-stable (v-for) fragments
        (type !== Fragment ||
          (patchFlag > 0 && patchFlag & PatchFlags.STABLE_FRAGMENT))
      ) {
        // fast path for block nodes: only need to unmount dynamic children.
        // E. 快速卸载 block 的动态 children
        unmountChildren(
          dynamicChildren,
          parentComponent,
          parentSuspense,
          false,
          true,
        )
        // 只卸载 dynamicChildren；
        // 不处理静态 vnode，节省性能；
        // 典型于使用编译优化生成的 Block vnode。
      } else if (
        (type === Fragment &&
          patchFlag &
            (PatchFlags.KEYED_FRAGMENT | PatchFlags.UNKEYED_FRAGMENT)) ||
        (!optimized && shapeFlag & ShapeFlags.ARRAY_CHILDREN)
      ) {
        // F. Fragment 或 普通数组 children
        unmountChildren(children as VNode[], parentComponent, parentSuspense)
      }

      // G. 最终 DOM 移除
      // 只在需要时移除实际 DOM 节点；
      // 调用前面分析过的 remove() 函数，支持过渡动画等。
      if (doRemove) {
        remove(vnode)
      }
    }

    // 最后阶段：触发卸载钩子
    if (
      (shouldInvokeVnodeHook &&
        (vnodeHook = props && props.onVnodeUnmounted)) ||
      shouldInvokeDirs
    ) {
      // 推入副作用队列，在 DOM 被移除后执行；
      // 支持：
      // onVnodeUnmounted
      // 指令的 unmounted
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        shouldInvokeDirs &&
          // invokeDirectiveHook
          invokeDirectiveHook(vnode, null, parentComponent, 'unmounted')
      }, parentSuspense)
    }
  }

  // 负责将 vnode 对应的 DOM 节点从页面中移除，并配合 transition 做动画处理。
  // 根据 vnode 的类型和特征，分不同情况处理：
  // 普通元素
  // Fragment
  // 静态 vnode（Static）
  // 动画过渡 vnode（带 transition）
  const remove: RemoveFn = vnode => {
    const { type, el, anchor, transition } = vnode
    // 1. Fragment 的特殊处理
    if (type === Fragment) {
      // Fragment 是由多个连续 DOM 节点组成的虚拟结构；
      if (
        __DEV__ &&
        vnode.patchFlag > 0 &&
        vnode.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT &&
        transition &&
        !transition.persisted
      ) {
        // 在开发模式下，如果是 DEV_ROOT_FRAGMENT 且有动画（如 <TransitionGroup>），则对子节点逐个调用 remove；
        ;(vnode.children as VNode[]).forEach(child => {
          if (child.type === Comment) {
            hostRemove(child.el!)
          } else {
            remove(child)
          }
        })
      } else {
        // 否则调用 removeFragment() 直接从 el 到 anchor 范围内批量删除。
        removeFragment(el!, anchor!)
      }
      return
    }

    // 2. 静态节点的处理
    // 静态 vnode（比如使用了 v-once 或模板静态提升）使用专门的 removeStaticNode() 方法一次性移除 DOM 内容。
    if (type === Static) {
      removeStaticNode(vnode)
      return
    }

    // 3. 普通 vnode 的标准移除路径 准备好最终执行删除的函数：
    const performRemove = () => {
      // hostRemove(el!)：从 DOM 中移除该节点；
      // transition.afterLeave()：如果有定义，在 DOM 被移除后调用（如移除后回调）。
      hostRemove(el!)
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave()
      }
    }

    // 4. 判断是否有 transition.leave 动画
    if (
      vnode.shapeFlag & ShapeFlags.ELEMENT &&
      transition &&
      !transition.persisted
    ) {
      // 有动画时：
      // leave() 是执行离场动画的方法；
      // delayLeave() 是在某些 transition-group 情况下的控制钩子，可以延迟开始动画；
      // 完成后执行 performRemove() 以真正移除 DOM。
      const { leave, delayLeave } = transition
      const performLeave = () => leave(el!, performRemove)
      if (delayLeave) {
        delayLeave(vnode.el!, performRemove, performLeave)
      } else {
        performLeave()
      }
    } else {
      // 没有动画时：直接同步移除。
      performRemove()
    }
  }

  // 用于从 DOM 中移除一整个 Fragment 的真实节点区域。
  // 从 cur 到 end（含），把这段 DOM 节点全部移除。
  const removeFragment = (cur: RendererNode, end: RendererNode) => {
    // cur：起始节点；
    // end：结束节点；
    // 通常这两个节点来自 fragment vnode 的 el 和 anchor。
    // For fragments, directly remove all contained DOM nodes.
    // (fragment child nodes cannot have transition)

    // 核心逻辑：
    // 从 cur 开始，一直向后查找；
    // 使用 hostNextSibling(cur) 找到下一个兄弟节点；
    // 调用 hostRemove(cur) 从 DOM 中删除当前节点；
    // 重复直到遇到 end；
    // 最后把 end 节点也删掉。
    // 为什么 cur !== end，然后最后再删 end？
    // 因为 end 是循环的终止条件，所以它必须最后再删。
    let next
    while (cur !== end) {
      next = hostNextSibling(cur)!
      hostRemove(cur)
      cur = next
    }
    hostRemove(end)
  }

  // 这个函数是卸载组件实例的核心逻辑，包含生命周期、资源清理、过渡管理、Suspense 支持、DevTools hook 等。
  // 安全地卸载组件，并清理它关联的副作用、子树、transition、ref、指令、Devtools hook 等。
  const unmountComponent = (
    instance: ComponentInternalInstance, // 当前组件实例
    parentSuspense: SuspenseBoundary | null, // 所在的 Suspense 边界
    doRemove?: boolean, // 是否同时移除 DOM
  ) => {
    // 1. 热更新支持：HMR 卸载
    // 在开发环境，如果组件开启了 HMR（热模块替换），需要注销它。
    if (__DEV__ && instance.type.__hmrId) {
      unregisterHMR(instance)
    }

    // 2. 拿出常用字段
    // bum: beforeUnmount 钩子数组；
    // scope: 响应式作用域（effectScope）；
    // job: 渲染 effect（用于调度更新）；
    // subTree: 渲染出来的 VNode 子树；
    // um: unmounted 钩子；
    // m/a: mounted / activated 钩子，需标记为失效。
    const { bum, scope, job, subTree, um, m, a } = instance

    // 3. 标记挂载生命周期失效（用于 transition）
    // 将这些钩子的 scheduler job 标记为 DISPOSED，防止意外调用。
    invalidateMount(m)
    invalidateMount(a)

    // beforeUnmount hook
    // 4. 调用 beforeUnmount 生命周期钩子
    // 调用组件选项或组合式 API 中的 onBeforeUnmount() 注册的逻辑。
    if (bum) {
      invokeArrayFns(bum)
    }

    // 5. 兼容 Vue 2：beforeDestroy
    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      instance.emit('hook:beforeDestroy')
    }

    // stop effects in component scope
    // 6. 停止响应式作用域：清除所有副作用（watchers、computed、render effect）
    // 所有关联的响应式副作用都在这里停止。
    scope.stop()

    // job may be null if a component is unmounted before its async
    // setup has resolved.
    // 7. 调度器中标记 render job 为已失效
    // 子树（组件渲染出来的 vnode）也要递归卸载；
    // 这会走普通 vnode 的 unmount()，可能继续递归处理 DOM 元素、Teleport、Fragment 等。
    if (job) {
      // so that scheduler will no longer invoke it
      job.flags! |= SchedulerJobFlags.DISPOSED
      unmount(subTree, instance, parentSuspense, doRemove)
    }
    // unmounted hook
    // 8. 注册 unmounted 生命周期钩子（推迟执行）
    // onUnmounted() 或 unmounted() 钩子将在 patch 完成后调用。
    if (um) {
      queuePostRenderEffect(um, parentSuspense)
    }

    // 9. 兼容 Vue 2：destroyed
    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      queuePostRenderEffect(
        () => instance.emit('hook:destroyed'),
        parentSuspense,
      )
    }

    // 10. 标记组件已卸载
    // 用于后续逻辑判断组件状态；
    // ref、Devtools、transition 会判断它是否被卸载。
    queuePostRenderEffect(() => {
      instance.isUnmounted = true
    }, parentSuspense)

    // A component with async dep inside a pending suspense is unmounted before
    // its async dep resolves. This should remove the dep from the suspense, and
    // cause the suspense to resolve immediately if that was the last dep.
    // 11. 如果组件处于 Suspense 中，且尚未解析完成，需要手动从父 suspense 的 dep 中移除
    // 这种情况发生在：
    // <Suspense> 内部挂载了异步组件；
    // 还没加载完成，用户就提前卸载；
    // Vue 会移除这个异步依赖，避免 Suspense 卡死；
    // 如果这是最后一个 dep，还会触发 suspense 的解析。
    if (
      __FEATURE_SUSPENSE__ &&
      parentSuspense &&
      parentSuspense.pendingBranch &&
      !parentSuspense.isUnmounted &&
      instance.asyncDep &&
      !instance.asyncResolved &&
      instance.suspenseId === parentSuspense.pendingId
    ) {
      parentSuspense.deps--
      if (parentSuspense.deps === 0) {
        parentSuspense.resolve()
      }
    }

    // 12. Devtools 支持：通知组件被移除
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      devtoolsComponentRemoved(instance)
    }
  }

  // 递归卸载一组子 VNode（通常是数组 children）
  const unmountChildren: UnmountChildrenFn = (
    children, // VNode[]
    parentComponent, // 父组件实例（用于触发生命周期等）
    parentSuspense, // 父 suspense 边界
    doRemove = false, // 是否执行真实 DOM remove（false 表示仅卸载逻辑）
    optimized = false, // 是否来自编译器优化模式（带 patchFlag）
    start = 0, // 支持偏移卸载：从某个下标开始卸载
  ) => {
    for (let i = start; i < children.length; i++) {
      // 它逐个调用 unmount() 函数，传入每一个子 vnode。
      unmount(children[i], parentComponent, parentSuspense, doRemove, optimized)
    }
  }

  // 获取下一个真实 DOM 节点
  // 用于在 patch 阶段查找某个 vnode 对应的“下一个兄弟 DOM 节点”，以便正确插入新的节点。
  const getNextHostNode: NextFn = vnode => {
    // 1. 如果是组件节点：
    if (vnode.shapeFlag & ShapeFlags.COMPONENT) {
      // 组件 vnode 没有真实 DOM；
      // 需要进入 component.subTree 继续找；
      // 递归到底部真实节点。
      return getNextHostNode(vnode.component!.subTree)
    }

    // 2. 如果是 <Suspense> 节点：
    if (__FEATURE_SUSPENSE__ && vnode.shapeFlag & ShapeFlags.SUSPENSE) {
      // 调用 vnode.suspense!.next() 获取 suspense 尾部 DOM 节点；
      // Suspense 的 DOM 结构比较特殊，有内容区/备用区。
      return vnode.suspense!.next()
    }

    //3. 常规 vnode：
    // 查找当前 vnode 的末尾节点后面的 DOM 节点；
    // vnode.anchor 表示一组静态或 fragment 的尾节点；
    // 如果没有 anchor，用 el。
    const el = hostNextSibling((vnode.anchor || vnode.el)!)
    // #9071, #9313
    // teleported content can mess up nextSibling searches during patch so
    // we need to skip them during nextSibling search
    // 4. 特殊处理：Teleport 传送内容
    // Teleport 会“跳过”真实 DOM 节点位置；
    // 必须从传送结束点（teleportEnd）后继续查找。
    const teleportEnd = el && el[TeleportEndKey]
    return teleportEnd ? hostNextSibling(teleportEnd) : el
  }

  let isFlushing = false
  // 创建渲染函数
  // 根渲染函数（Vue 应用入口）
  const render: RootRenderFunction = (vnode, container, namespace) => {
    // 1. 卸载逻辑：
    if (vnode == null) {
      // 表示“卸载当前组件”；
      // 比如 <App /> 改为 null，或服务端调用 app.unmount()。
      if (container._vnode) {
        // 无新的vnode入参 则代表是卸载
        unmount(container._vnode, null, null, true)
      }
    } else {
      // 挂载分支
      // 2. 初次或更新渲染：
      patch(
        container._vnode || null,
        vnode,
        container,
        null,
        null,
        null,
        namespace,
      )
    }
    // 保存当前渲染完毕的根VNode在容器上
    // 3. 记录根 vnode
    // 把当前 vnode 记录在容器上；
    // 下次渲染时作为旧 vnode 使用。
    container._vnode = vnode

    // 4. 调度渲染后任务：
    // flushPreFlushCbs(): flush 生命周期 beforeUpdate, watch 等前置任务；
    // flushPostFlushCbs(): flush 生命周期 mounted/updated、transition、directive 等后置任务；
    // isFlushing 防止递归嵌套执行。
    if (!isFlushing) {
      isFlushing = true
      // 执行postFlush任务队列
      flushPreFlushCbs()
      flushPostFlushCbs()
      isFlushing = false
    }
  }

  // 使用目的：
  // Vue 内部 patch 流程需要这些基础操作；
  // 如果启用了 SSR hydration，也需要用这些方法创建 hydrate 函数。
  // 这是一种“注入依赖”的做法，让 createHydrationFunctions() 不直接访问全局函数，而是通过显式传参拿到这些原语。
  const internals: RendererInternals = {
    p: patch, // 递归 patch vnode 树
    um: unmount, // 卸载 vnode
    m: move, // 移动 vnode（用于 transition, fragment）
    r: remove, // 移除 vnode（通常配合 anchor）
    mt: mountComponent, // 挂载组件
    mc: mountChildren, // 挂载数组子节点
    pc: patchChildren, // diff 子节点
    pbc: patchBlockChildren, // diff 编译优化的 block children
    n: getNextHostNode, // 获取 vnode 对应的下一个真实 DOM 节点
    o: options, // 宿主平台操作（createElement、patchProp 等）
  }

  // 功能：
  // 如果传入了 createHydrationFns，说明当前正在构建一个支持 SSR 的渲染器；
  // 会调用 createHydrationFunctions()，生成：
  // hydrate()：入口方法，用于激活整个 vnode 树；
  // hydrateNode()：处理单个 vnode 和已有 DOM 对应关系的核心方法。
  //
  // 特别说明：
  // 这段逻辑只在你使用 createHydrationRenderer() 时才存在；
  // 如果只是用 createRenderer()，这两个变量是 undefined。
  let hydrate: ReturnType<typeof createHydrationFunctions>[0] | undefined
  let hydrateNode: ReturnType<typeof createHydrationFunctions>[1] | undefined
  if (createHydrationFns) {
    ;[hydrate, hydrateNode] = createHydrationFns(
      internals as RendererInternals<Node, Element>,
    )
  }
  // 返回渲染器对象
  return {
    // ender	渲染 vnode 到指定容器（初次 or 更新）
    // hydrate	激活 SSR 已生成的 HTML 结构（可选，SSR only）
    // createApp	创建 Vue 应用实例，调用的是 createAppAPI()
    render,
    hydrate,
    createApp: createAppAPI(render, hydrate),
  }
}

//  Vue 3 内部在生成 DOM 元素树（VNode -> DOM）过程中，用于确定子节点应该使用哪个 XML 命名空间（namespace） 的工具函数。
function resolveChildrenNamespace(
  // type: 当前 vnode 的标签名（如 'div', 'svg', 'foreignObject', 'annotation-xml' 等）。
  // props: vnode 的属性集合。
  // currentNamespace: 当前父级节点的命名空间，比如：
  // 'svg'：在 <svg> 元素内；
  // 'mathml'：在 <math> 元素内；
  // undefined：普通 HTML 空间。
  { type, props }: VNode,
  currentNamespace: ElementNamespace,
): ElementNamespace {
  return (currentNamespace === 'svg' && type === 'foreignObject') ||
    (currentNamespace === 'mathml' &&
      type === 'annotation-xml' &&
      props &&
      props.encoding &&
      props.encoding.includes('html'))
    ? undefined
    : currentNamespace
}

// 用于启用或禁用组件渲染副作用中的递归更新行为。
// 它通常与组件嵌套更新、调度器、suspense、transition 等机制协同工作。
function toggleRecurse(
  // effect: 是这个组件的渲染副作用（ReactiveEffect）。
  // job: 是组件的调度任务（SchedulerJob），通常就是 update()。
  // allowed: 一个布尔值，表示是否允许递归更新。
  { effect, job }: ComponentInternalInstance,
  allowed: boolean,
) {
  // 使用按位操作 |= 和 &= ~ 来设置或清除 ALLOW_RECURSE 标志位。
  // 目的是控制当前组件是否在更新过程中允许递归自身更新。
  if (allowed) {
    effect.flags |= EffectFlags.ALLOW_RECURSE
    job.flags! |= SchedulerJobFlags.ALLOW_RECURSE
  } else {
    effect.flags &= ~EffectFlags.ALLOW_RECURSE
    job.flags! &= ~SchedulerJobFlags.ALLOW_RECURSE
  }

  // 在 Vue 的组件更新调度机制中，有一种叫做“递归更新”（recurse update）的情况，例如：
  // 在组件的 updated 钩子里，触发自身响应式数据的变化；
  // 或在子组件更新过程中又触发父组件更新，进而又影响子组件（形成循环）；
  // 或组件嵌套使用 <Suspense> 或 <Transition> 时，在一些边界时刻需要暂时禁止递归触发更新，以确保稳定性和性能。
  // 所以 Vue 引入了一个“允许递归”标志位，在某些关键时刻临时关闭它：
  // ALLOW_RECURSE 为关 → 当前组件在本次调度中不可被再次递归触发更新；
  // ALLOW_RECURSE 为开 → 恢复正常的响应式递归行为。
}

// 用于判断某个组件或元素**是否应该执行过渡动画（transition）**的条件判断逻辑之一，通常在组件或元素进入、更新时决定是否启动过渡效果。
export function needTransition(
  // parentSuspense: 当前元素或组件的父 Suspense 实例，可能为 null。
  // transition: 当前元素或组件的过渡钩子对象（TransitionHooks），如果没有绑定 <transition>，则为 null。
  parentSuspense: SuspenseBoundary | null,
  transition: TransitionHooks | null,
): boolean | null {
  return (
    // 没有 Suspense：表示不是在一个 Suspense 控制的异步子树中。
    // 有 Suspense，但没有未解析的异步分支（pendingBranch）：说明已经 resolve，可以正常进行动画。
    (!parentSuspense || (parentSuspense && !parentSuspense.pendingBranch)) && // 组件或节点不被挂起状态控制。
    transition &&
    // transition.persisted === true 意味着这个过渡是在 SSR hydrate 时保留的状态，不应该在客户端重新执行动画。
    // 所以如果 persisted 是 false，才允许执行过渡。
    !transition.persisted
  )
}

/**
 * #1156
 * When a component is HMR-enabled, we need to make sure that all static nodes
 * inside a block also inherit the DOM element from the previous tree so that
 * HMR updates (which are full updates) can retrieve the element for patching.
 * HMR 更新是全量替换组件树（非 diff），如果静态 vnode 没有 el，就无法正确 patch。
 *
 * #2080
 * Inside keyed `template` fragment static children, if a fragment is moved,
 * the children will always be moved. Therefore, in order to ensure correct move
 * position, el should be inherited from previous nodes.
 * Keyed Fragment 的子节点在移动时，其所有静态子节点也要随之移动，需要保留原始 el。
 */
// 用于在静态节点之间继承 DOM 元素（el），
// 在 HMR（热模块替换）更新 或 keyed fragment 移动 的优化路径中非常关键。
// 将旧虚拟节点树（n1）中的静态子节点对应的 DOM 元素（el）拷贝给 新的虚拟节点树（n2）中的静态子节点。
export function traverseStaticChildren(
  n1: VNode,
  n2: VNode,
  shallow = false,
): void {
  const ch1 = n1.children
  const ch2 = n2.children
  // 保证两个节点都具有子节点，并且它们是数组（即一组 vnode）。
  if (isArray(ch1) && isArray(ch2)) {
    // 遍历两个 vnode 的子节点
    for (let i = 0; i < ch1.length; i++) {
      // this is only called in the optimized path so array children are
      // guaranteed to be vnodes
      // c1 是旧 vnode 的子节点，c2 是新 vnode 的子节点。
      // 要把 c1.el 的引用传递到 c2 中。
      const c1 = ch1[i] as VNode
      let c2 = ch2[i] as VNode
      // shapeFlag & ShapeFlags.ELEMENT: 表示当前 vnode 是一个 HTML 元素。
      // dynamicChildren: 只有 block 结构中的动态节点才会有这个属性，静态 vnode 没有。
      // 处理静态元素节点：
      if (c2.shapeFlag & ShapeFlags.ELEMENT && !c2.dynamicChildren) {
        // 判断是静态节点（patchFlag 为 0 或 hydration）。
        // 如果是挂载过的 vnode，会 clone 新 vnode（不能复用已挂载 vnode）。
        // 递归处理嵌套的静态 vnode。
        // patchFlag <= 0: 表示 vnode 是静态节点。
        // PatchFlags.NEED_HYDRATION: 表示 vnode 需要 hydration（SSR 相关），也可以当作静态 vnode 处理。
        if (c2.patchFlag <= 0 || c2.patchFlag === PatchFlags.NEED_HYDRATION) {
          // cloneIfMounted(vnode): 如果 vnode 已经挂载，会 clone 出一个新的 vnode 对象，以免直接修改已挂载结构。
          c2 = ch2[i] = cloneIfMounted(ch2[i] as VNode)
          c2.el = c1.el
        }
        // PatchFlags.BAIL: 静态节点的 patch 被跳过，不再深入比较。
        if (!shallow && c2.patchFlag !== PatchFlags.BAIL)
          traverseStaticChildren(c1, c2)
      }
      // #6852 also inherit for text nodes
      // 处理 Text 节点
      // 文本节点不是元素，但在 patch 中也需要正确的 DOM 引用。
      if (c2.type === Text) {
        c2.el = c1.el
      }
      // also inherit for comment nodes, but not placeholders (e.g. v-if which
      // would have received .el during block patch)
      // 处理 Comment 节点（只在开发模式生效）：
      if (__DEV__ && c2.type === Comment && !c2.el) {
        c2.el = c1.el
      }
    }
  }
}

// 查找数组的最长递增子序列（LIS）。
// https://en.wikipedia.org/wiki/Longest_increasing_subsequence
function getSequence(arr: number[]): number[] {
  // 用于记录前驱索引，后续回溯路径
  const p = arr.slice()
  // result 保存的是 arr 中索引的列表，形成的是一个递增序列的索引路径
  const result = [0]
  let i, j, u, v, c
  const len = arr.length
  for (i = 0; i < len; i++) {
    const arrI = arr[i]
    if (arrI !== 0) {
      // 忽略值为 0 的元素（这些通常代表“新节点”）
      j = result[result.length - 1] // 当前 LIS 的最后一个索引
      if (arr[j] < arrI) {
        p[i] = j // 当前 LIS 的最后一个索引
        result.push(i)
        continue
      }

      // 二分查找 result 中第一个大于等于 arrI 的位置
      u = 0
      v = result.length - 1
      while (u < v) {
        c = (u + v) >> 1
        if (arr[result[c]] < arrI) {
          u = c + 1
        } else {
          v = c
        }
      }
      if (arrI < arr[result[u]]) {
        if (u > 0) {
          p[i] = result[u - 1] // 记录前驱
        }
        result[u] = i
      }
    }
  }

  // 回溯构建最终 LIS 的索引序列
  u = result.length
  v = result[u - 1]
  while (u-- > 0) {
    result[u] = v
    v = p[v]
  }
  return result
}

// 查找未被 hydration 的异步根组件。
function locateNonHydratedAsyncRoot(
  instance: ComponentInternalInstance,
): ComponentInternalInstance | undefined {
  const subComponent = instance.subTree.component // 当前 vnode 对应的子组件实例
  if (subComponent) {
    if (subComponent.asyncDep && !subComponent.asyncResolved) {
      return subComponent // 找到未 resolved 的异步组件
    } else {
      return locateNonHydratedAsyncRoot(subComponent) // 递归向下找
    }
  }
}

// 标记生命周期钩子为失效。
export function invalidateMount(hooks: LifecycleHook): void {
  if (hooks) {
    for (let i = 0; i < hooks.length; i++)
      // SchedulerJobFlags.DISPOSED 是 scheduler.ts 中定义的一个位掩码，表示当前任务不再有效。
      hooks[i].flags! |= SchedulerJobFlags.DISPOSED
  }
}
