import type { ComponentInternalInstance } from '../component'
import type { SuspenseBoundary } from './Suspense'
import {
  type ElementNamespace,
  MoveType,
  type RendererElement,
  type RendererInternals,
  type RendererNode,
  type RendererOptions,
  queuePostRenderEffect,
  traverseStaticChildren,
} from '../renderer'
import type { VNode, VNodeArrayChildren, VNodeProps } from '../vnode'
import { ShapeFlags, isString } from '@vue/shared'
import { warn } from '../warning'
import { isHmrUpdating } from '../hmr'

// <Teleport> 组件完整的 runtime 实现源码，包括：
//
// Teleport 的挂载（process）
//
// 卸载（remove）
//
// 移动（moveTeleport）
//
// hydration（hydrateTeleport）
//
// 辅助逻辑如 resolveTarget、prepareAnchor、updateCssVars
//
// 我可以为你概括核心实现逻辑、关键设计点、以及特殊边界处理：
//
// <Teleport> 实现关键点总结
// 1. Teleport 的核心职责：
// 将其子节点挂载到 DOM 树中“另一个位置”，而非父组件默认的插入位置。
//
// 2. 初次挂载流程（process(n1 = null)）：
// 本体插入：
// 在当前容器插入两个占位锚点：n2.el 和 n2.anchor（通常是 comment node）。
//
// 此区域只是逻辑占位，不会实际渲染子内容。
//
// 子节点挂载：
// 根据 props.to 解析真实目标容器（resolveTarget()）。
//
// disabled=true：直接挂载子节点到本体锚点之间。
//
// 否则：挂载子节点到目标容器内，前后也插入锚点（prepareAnchor()）。
//
// defer=true：挂载推迟到 queuePostRenderEffect 中。
//
// 3. 更新流程（patchTeleport）：
// DOM 引用继承：
// n2.el, n2.anchor, n2.targetStart, n2.targetAnchor 都继承自 n1。
//
// 如果目标 to 改变，或 disabled 状态改变，就要执行 DOM 节点移动。
//
// 关键情况：
// 状态变更	处理动作
// disabled → enabled	子节点从 main container 移到目标
// enabled → disabled	子节点从目标移回 main container
// to 目标变更	Teleport 子节点重新插入新目标
// dynamicChildren 存在	用 block diff 优化
//
// 4. 卸载流程（remove）：
// 移除占位符和目标容器内的锚点。
//
// 无论是否 disabled，都卸载子节点（children 总是要卸载的）。
//
// 5. 子树移动（moveTeleport）：
// 根据 TeleportMoveTypes 三种类型：
//
// REORDER: 重排当前容器中的 Teleport（如 v-for）。
//
// TARGET_CHANGE: 迁移到新目标容器。
//
// TOGGLE: 启用/禁用 Teleport 时内容位置切换。
//
// 6. Hydration 支持（hydrateTeleport）：
// 根据服务端 DOM 的结构查找 targetStart/targetAnchor。
//
// 如果找不到 fallback anchor，就自动插入空文本锚点保证一致性。
//
// 7. Target Resolution（resolveTarget()）：
// props.to 为字符串时，使用 querySelector() 获取元素。
//
// 目标不存在时会 warn（除非 disabled）。
//
// 也支持直接传入 DOM 元素。
//
// 8. updateCssVars() 支持：
// 用于支持 v-bind 绑定的 CSS 变量在 teleport 内容上仍能生效。
//
// 通过添加 data-v-owner 并调用组件的 .ut() 方法来更新 CSS。

export type TeleportVNode = VNode<RendererNode, RendererElement, TeleportProps>

export interface TeleportProps {
  to: string | RendererElement | null | undefined
  disabled?: boolean
  defer?: boolean
}

export const TeleportEndKey: unique symbol = Symbol('_vte')

export const isTeleport = (type: any): boolean => type.__isTeleport

const isTeleportDisabled = (props: VNode['props']): boolean =>
  props && (props.disabled || props.disabled === '')

const isTeleportDeferred = (props: VNode['props']): boolean =>
  props && (props.defer || props.defer === '')

const isTargetSVG = (target: RendererElement): boolean =>
  typeof SVGElement !== 'undefined' && target instanceof SVGElement

const isTargetMathML = (target: RendererElement): boolean =>
  typeof MathMLElement === 'function' && target instanceof MathMLElement

const resolveTarget = <T = RendererElement>(
  props: TeleportProps | null,
  select: RendererOptions['querySelector'],
): T | null => {
  const targetSelector = props && props.to
  if (isString(targetSelector)) {
    if (!select) {
      __DEV__ &&
        warn(
          `Current renderer does not support string target for Teleports. ` +
            `(missing querySelector renderer option)`,
        )
      return null
    } else {
      const target = select(targetSelector)
      if (__DEV__ && !target && !isTeleportDisabled(props)) {
        warn(
          `Failed to locate Teleport target with selector "${targetSelector}". ` +
            `Note the target element must exist before the component is mounted - ` +
            `i.e. the target cannot be rendered by the component itself, and ` +
            `ideally should be outside of the entire Vue component tree.`,
        )
      }
      return target as T
    }
  } else {
    if (__DEV__ && !targetSelector && !isTeleportDisabled(props)) {
      warn(`Invalid Teleport target: ${targetSelector}`)
    }
    return targetSelector as T
  }
}

export const TeleportImpl = {
  name: 'Teleport',
  __isTeleport: true,
  process(
    n1: TeleportVNode | null,
    n2: TeleportVNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
    internals: RendererInternals,
  ): void {
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment },
    } = internals

    const disabled = isTeleportDisabled(n2.props)
    let { shapeFlag, children, dynamicChildren } = n2

    // #3302
    // HMR updated, force full diff
    if (__DEV__ && isHmrUpdating) {
      optimized = false
      dynamicChildren = null
    }

    if (n1 == null) {
      // insert anchors in the main view
      const placeholder = (n2.el = __DEV__
        ? createComment('teleport start')
        : createText(''))
      const mainAnchor = (n2.anchor = __DEV__
        ? createComment('teleport end')
        : createText(''))
      insert(placeholder, container, anchor)
      insert(mainAnchor, container, anchor)

      const mount = (container: RendererElement, anchor: RendererNode) => {
        // Teleport *always* has Array children. This is enforced in both the
        // compiler and vnode children normalization.
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          if (parentComponent && parentComponent.isCE) {
            parentComponent.ce!._teleportTarget = container
          }
          mountChildren(
            children as VNodeArrayChildren,
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

      const mountToTarget = () => {
        const target = (n2.target = resolveTarget(n2.props, querySelector))
        const targetAnchor = prepareAnchor(target, n2, createText, insert)
        if (target) {
          // #2652 we could be teleporting from a non-SVG tree into an SVG tree
          if (namespace !== 'svg' && isTargetSVG(target)) {
            namespace = 'svg'
          } else if (namespace !== 'mathml' && isTargetMathML(target)) {
            namespace = 'mathml'
          }
          if (!disabled) {
            mount(target, targetAnchor)
            updateCssVars(n2, false)
          }
        } else if (__DEV__ && !disabled) {
          warn(
            'Invalid Teleport target on mount:',
            target,
            `(${typeof target})`,
          )
        }
      }

      if (disabled) {
        mount(container, mainAnchor)
        updateCssVars(n2, true)
      }

      if (isTeleportDeferred(n2.props)) {
        queuePostRenderEffect(() => {
          mountToTarget()
          n2.el!.__isMounted = true
        }, parentSuspense)
      } else {
        mountToTarget()
      }
    } else {
      if (isTeleportDeferred(n2.props) && !n1.el!.__isMounted) {
        queuePostRenderEffect(() => {
          TeleportImpl.process(
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
          delete n1.el!.__isMounted
        }, parentSuspense)
        return
      }
      // update content
      n2.el = n1.el
      n2.targetStart = n1.targetStart
      const mainAnchor = (n2.anchor = n1.anchor)!
      const target = (n2.target = n1.target)!
      const targetAnchor = (n2.targetAnchor = n1.targetAnchor)!
      const wasDisabled = isTeleportDisabled(n1.props)
      const currentContainer = wasDisabled ? container : target
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor

      if (namespace === 'svg' || isTargetSVG(target)) {
        namespace = 'svg'
      } else if (namespace === 'mathml' || isTargetMathML(target)) {
        namespace = 'mathml'
      }

      if (dynamicChildren) {
        // fast path when the teleport happens to be a block root
        patchBlockChildren(
          n1.dynamicChildren!,
          dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
        )
        // even in block tree mode we need to make sure all root-level nodes
        // in the teleport inherit previous DOM references so that they can
        // be moved in future patches.
        traverseStaticChildren(n1, n2, true)
      } else if (!optimized) {
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          false,
        )
      }

      if (disabled) {
        if (!wasDisabled) {
          // enabled -> disabled
          // move into main container
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            TeleportMoveTypes.TOGGLE,
          )
        } else {
          // #7835
          // When `teleport` is disabled, `to` may change, making it always old,
          // to ensure the correct `to` when enabled
          if (n2.props && n1.props && n2.props.to !== n1.props.to) {
            n2.props.to = n1.props.to
          }
        }
      } else {
        // target changed
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
          const nextTarget = (n2.target = resolveTarget(
            n2.props,
            querySelector,
          ))
          if (nextTarget) {
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              TeleportMoveTypes.TARGET_CHANGE,
            )
          } else if (__DEV__) {
            warn(
              'Invalid Teleport target on update:',
              target,
              `(${typeof target})`,
            )
          }
        } else if (wasDisabled) {
          // disabled -> enabled
          // move into teleport target
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            TeleportMoveTypes.TOGGLE,
          )
        }
      }
      updateCssVars(n2, disabled)
    }
  },

  remove(
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    { um: unmount, o: { remove: hostRemove } }: RendererInternals,
    doRemove: boolean,
  ): void {
    const {
      shapeFlag,
      children,
      anchor,
      targetStart,
      targetAnchor,
      target,
      props,
    } = vnode

    if (target) {
      hostRemove(targetStart!)
      hostRemove(targetAnchor!)
    }

    // an unmounted teleport should always unmount its children whether it's disabled or not
    doRemove && hostRemove(anchor!)
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      const shouldRemove = doRemove || !isTeleportDisabled(props)
      for (let i = 0; i < (children as VNode[]).length; i++) {
        const child = (children as VNode[])[i]
        unmount(
          child,
          parentComponent,
          parentSuspense,
          shouldRemove,
          !!child.dynamicChildren,
        )
      }
    }
  },

  move: moveTeleport as typeof moveTeleport,
  hydrate: hydrateTeleport as typeof hydrateTeleport,
}

export enum TeleportMoveTypes {
  TARGET_CHANGE,
  TOGGLE, // enable / disable
  REORDER, // moved in the main view
}

function moveTeleport(
  vnode: VNode,
  container: RendererElement,
  parentAnchor: RendererNode | null,
  { o: { insert }, m: move }: RendererInternals,
  moveType: TeleportMoveTypes = TeleportMoveTypes.REORDER,
): void {
  // move target anchor if this is a target change.
  if (moveType === TeleportMoveTypes.TARGET_CHANGE) {
    insert(vnode.targetAnchor!, container, parentAnchor)
  }
  const { el, anchor, shapeFlag, children, props } = vnode
  const isReorder = moveType === TeleportMoveTypes.REORDER
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(el!, container, parentAnchor)
  }
  // if this is a re-order and teleport is enabled (content is in target)
  // do not move children. So the opposite is: only move children if this
  // is not a reorder, or the teleport is disabled
  if (!isReorder || isTeleportDisabled(props)) {
    // Teleport has either Array children or no children.
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move(
          (children as VNode[])[i],
          container,
          parentAnchor,
          MoveType.REORDER,
        )
      }
    }
  }
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(anchor!, container, parentAnchor)
  }
}

interface TeleportTargetElement extends Element {
  // last teleport target
  _lpa?: Node | null
}

function hydrateTeleport(
  node: Node,
  vnode: TeleportVNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  slotScopeIds: string[] | null,
  optimized: boolean,
  {
    o: { nextSibling, parentNode, querySelector, insert, createText },
  }: RendererInternals<Node, Element>,
  hydrateChildren: (
    node: Node | null,
    vnode: VNode,
    container: Element,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => Node | null,
): Node | null {
  const target = (vnode.target = resolveTarget<Element>(
    vnode.props,
    querySelector,
  ))
  if (target) {
    const disabled = isTeleportDisabled(vnode.props)
    // if multiple teleports rendered to the same target element, we need to
    // pick up from where the last teleport finished instead of the first node
    const targetNode =
      (target as TeleportTargetElement)._lpa || target.firstChild
    if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      if (disabled) {
        vnode.anchor = hydrateChildren(
          nextSibling(node),
          vnode,
          parentNode(node)!,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized,
        )
        vnode.targetStart = targetNode
        vnode.targetAnchor = targetNode && nextSibling(targetNode)
      } else {
        vnode.anchor = nextSibling(node)

        // lookahead until we find the target anchor
        // we cannot rely on return value of hydrateChildren() because there
        // could be nested teleports
        let targetAnchor = targetNode
        while (targetAnchor) {
          if (targetAnchor && targetAnchor.nodeType === 8) {
            if ((targetAnchor as Comment).data === 'teleport start anchor') {
              vnode.targetStart = targetAnchor
            } else if ((targetAnchor as Comment).data === 'teleport anchor') {
              vnode.targetAnchor = targetAnchor
              ;(target as TeleportTargetElement)._lpa =
                vnode.targetAnchor && nextSibling(vnode.targetAnchor as Node)
              break
            }
          }
          targetAnchor = nextSibling(targetAnchor)
        }

        // #11400 if the HTML corresponding to Teleport is not embedded in the
        // correct position on the final page during SSR. the targetAnchor will
        // always be null, we need to manually add targetAnchor to ensure
        // Teleport it can properly unmount or move
        if (!vnode.targetAnchor) {
          prepareAnchor(target, vnode, createText, insert)
        }

        hydrateChildren(
          targetNode && nextSibling(targetNode),
          vnode,
          target,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized,
        )
      }
    }
    updateCssVars(vnode, disabled)
  }
  return vnode.anchor && nextSibling(vnode.anchor as Node)
}

// Force-casted public typing for h and TSX props inference
export const Teleport = TeleportImpl as unknown as {
  __isTeleport: true
  new (): {
    $props: VNodeProps & TeleportProps
    $slots: {
      default(): VNode[]
    }
  }
}

function updateCssVars(vnode: VNode, isDisabled: boolean) {
  // presence of .ut method indicates owner component uses css vars.
  // code path here can assume browser environment.
  const ctx = vnode.ctx
  if (ctx && ctx.ut) {
    let node, anchor
    if (isDisabled) {
      node = vnode.el
      anchor = vnode.anchor
    } else {
      node = vnode.targetStart
      anchor = vnode.targetAnchor
    }
    while (node && node !== anchor) {
      if (node.nodeType === 1) node.setAttribute('data-v-owner', ctx.uid)
      node = node.nextSibling
    }
    ctx.ut()
  }
}

function prepareAnchor(
  target: RendererElement | null,
  vnode: TeleportVNode,
  createText: RendererOptions['createText'],
  insert: RendererOptions['insert'],
) {
  const targetStart = (vnode.targetStart = createText(''))
  const targetAnchor = (vnode.targetAnchor = createText(''))

  // attach a special property, so we can skip teleported content in
  // renderer's nextSibling search
  targetStart[TeleportEndKey] = targetAnchor

  if (target) {
    insert(targetStart, target)
    insert(targetAnchor, target)
  }

  return targetAnchor
}
