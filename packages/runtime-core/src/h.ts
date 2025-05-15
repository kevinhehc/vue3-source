import {
  type Comment,
  type Fragment,
  type Text,
  type VNode,
  type VNodeArrayChildren,
  type VNodeProps,
  createVNode,
  isVNode,
} from './vnode'
import type { Teleport, TeleportProps } from './components/Teleport'
import type { Suspense, SuspenseProps } from './components/Suspense'
import { type IfAny, isArray, isObject } from '@vue/shared'
import type { RawSlots } from './componentSlots'
import type {
  Component,
  ComponentOptions,
  ConcreteComponent,
  FunctionalComponent,
} from './component'
import type { EmitsOptions } from './componentEmits'
import type { DefineComponent } from './apiDefineComponent'

// `h` is a more user-friendly version of `createVNode` that allows omitting the
// props when possible. It is intended for manually written render functions.
// Compiler-generated code uses `createVNode` because
// 1. it is monomorphic and avoids the extra call overhead
// 2. it allows specifying patchFlags for optimization

/*
// type only
h('div')

// type + props
h('div', {})

// type + omit props + children
// Omit props does NOT support named slots
h('div', []) // array
h('div', 'foo') // text
h('div', h('br')) // vnode
h(Component, () => {}) // default slot

// type + props + children
h('div', {}, []) // array
h('div', {}, 'foo') // text
h('div', {}, h('br')) // vnode
h(Component, {}, () => {}) // default slot
h(Component, {}, {}) // named slots

// named slots without props requires explicit `null` to avoid ambiguity
h(Component, null, {})
**/

type RawProps = VNodeProps & {
  // used to differ from a single VNode object as children
  __v_isVNode?: never
  // used to differ from Array children
  [Symbol.iterator]?: never
} & Record<string, any>

type RawChildren =
  | string
  | number
  | boolean
  | VNode
  | VNodeArrayChildren
  | (() => any)

// fake constructor type returned from `defineComponent`
interface Constructor<P = any> {
  __isFragment?: never
  __isTeleport?: never
  __isSuspense?: never
  new (...args: any[]): { $props: P }
}

type HTMLElementEventHandler = {
  [K in keyof HTMLElementEventMap as `on${Capitalize<K>}`]?: (
    ev: HTMLElementEventMap[K],
  ) => any
}

// The following is a series of overloads for providing props validation of
// manually written render functions.

// element
export function h<K extends keyof HTMLElementTagNameMap>(
  type: K,
  children?: RawChildren,
): VNode
export function h<K extends keyof HTMLElementTagNameMap>(
  type: K,
  props?: (RawProps & HTMLElementEventHandler) | null,
  children?: RawChildren | RawSlots,
): VNode

// custom element
export function h(type: string, children?: RawChildren): VNode
export function h(
  type: string,
  props?: RawProps | null,
  children?: RawChildren | RawSlots,
): VNode

// text/comment
export function h(
  type: typeof Text | typeof Comment,
  children?: string | number | boolean,
): VNode
export function h(
  type: typeof Text | typeof Comment,
  props?: null,
  children?: string | number | boolean,
): VNode
// fragment
export function h(type: typeof Fragment, children?: VNodeArrayChildren): VNode
export function h(
  type: typeof Fragment,
  props?: RawProps | null,
  children?: VNodeArrayChildren,
): VNode

// teleport (target prop is required)
export function h(
  type: typeof Teleport,
  props: RawProps & TeleportProps,
  children: RawChildren | RawSlots,
): VNode

// suspense
export function h(type: typeof Suspense, children?: RawChildren): VNode
export function h(
  type: typeof Suspense,
  props?: (RawProps & SuspenseProps) | null,
  children?: RawChildren | RawSlots,
): VNode

// functional component
export function h<
  P,
  E extends EmitsOptions = {},
  S extends Record<string, any> = any,
>(
  type: FunctionalComponent<P, any, S, any>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | IfAny<S, RawSlots, S>,
): VNode

// catch-all for generic component types
export function h(type: Component, children?: RawChildren): VNode

// concrete component
export function h<P>(
  type: ConcreteComponent | string,
  children?: RawChildren,
): VNode
export function h<P>(
  type: ConcreteComponent<P> | string,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren,
): VNode

// component without props
export function h<P>(
  type: Component<P>,
  props?: (RawProps & P) | null,
  children?: RawChildren | RawSlots,
): VNode

// exclude `defineComponent` constructors
export function h<P>(
  type: ComponentOptions<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots,
): VNode

// fake constructor type returned by `defineComponent` or class component
export function h(type: Constructor, children?: RawChildren): VNode
export function h<P>(
  type: Constructor<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots,
): VNode

// fake constructor type returned by `defineComponent`
export function h(type: DefineComponent, children?: RawChildren): VNode
export function h<P>(
  type: DefineComponent<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots,
): VNode

// catch all types
export function h(type: string | Component, children?: RawChildren): VNode
export function h<P>(
  type: string | Component<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots,
): VNode

// Actual implementation
//  h() 函数（Hyperscript helper）的真实实现，用于在 渲染函数 中创建虚拟节点（VNode）。
//  它是用户态 h() 函数的入口，并最终调用 createVNode()。

// type：组件、元素标签、或一个函数（VNode 的类型）。
// propsOrChildren：第二个参数，可能是 props，也可能是 children。
// children：第三个参数，仅当第二个是 props 时存在。
export function h(type: any, propsOrChildren?: any, children?: any): VNode {
  // 判断传入了几个参数，以下分支分别处理不同情况。
  const l = arguments.length
  // 有两个参数时，propsOrChildren 可能是 props、VNode、数组或字符串。
  if (l === 2) {
    // propsOrChildren 是单个 VNode（省略 props）
    if (isObject(propsOrChildren) && !isArray(propsOrChildren)) {
      // single vnode without props
      if (isVNode(propsOrChildren)) {
        // 把 props 设为 null，把这个单个 VNode 包装成 children 数组。
        // h('div', h('span')) // => children = [VNode]
        return createVNode(type, null, [propsOrChildren])
      }
      // props without children
      // propsOrChildren 是 props 对象
      // h('div', { id: 'foo' }) // 没有 children
      return createVNode(type, propsOrChildren)
    } else {
      // omit props
      // propsOrChildren 是数组或字符串（省略 props）
      // h('div', 'hello') // => children = 'hello'
      // h('ul', [h('li'), h('li')]) // => children = VNode[]
      return createVNode(type, null, propsOrChildren)
    }
  } else {
    // 三个或更多参数
    if (l > 3) {
      // 超过三个参数，表示多个 children
      // 把参数 2 之后的所有值视为子节点，打包成数组。
      // h('div', null, h('p'), h('p')) // => children = [VNode, VNode]
      children = Array.prototype.slice.call(arguments, 2)
    } else if (l === 3 && isVNode(children)) {
      // 第三个参数是单个 VNode，转换成数组
      // h('div', null, h('p')) // => children = [VNode]
      children = [children]
    }
    return createVNode(type, propsOrChildren, children)
  }
}
