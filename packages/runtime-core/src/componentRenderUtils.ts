import {
  type ComponentInternalInstance,
  type Data,
  type FunctionalComponent,
  getComponentName,
} from './component'
import {
  Comment,
  type VNode,
  type VNodeArrayChildren,
  blockStack,
  cloneVNode,
  createVNode,
  isVNode,
  normalizeVNode,
} from './vnode'
import { ErrorCodes, handleError } from './errorHandling'
import { PatchFlags, ShapeFlags, isModelListener, isOn } from '@vue/shared'
import { warn } from './warning'
import { isHmrUpdating } from './hmr'
import type { NormalizedProps } from './componentProps'
import { isEmitListener } from './componentEmits'
import { setCurrentRenderingInstance } from './componentRenderContext'
import {
  DeprecationTypes,
  isCompatEnabled,
  warnDeprecation,
} from './compat/compatConfig'
import { shallowReadonly } from '@vue/reactivity'
import { setTransitionHooks } from './components/BaseTransition'

/**
 * dev only flag to track whether $attrs was used during render.
 * If $attrs was used during render then the warning for failed attrs
 * fallthrough can be suppressed.
 */
let accessedAttrs: boolean = false

// 记录属性是否被访问（用于开发模式下检测 attrs 是否被消费）。
export function markAttrsAccessed(): void {
  accessedAttrs = true
}

type SetRootFn = ((root: VNode) => void) | undefined

// 用于 执行组件的渲染函数并生成最终的 VNode，同时处理各种边界情况、属性继承、指令、过渡等逻辑。
// 渲染组件根节点，生成 VNode，用于后续 patch 过程。
// → 判断组件类型（Stateful / Functional）
// → 执行 render 函数，生成 VNode
// → 处理 fallthroughAttrs（透传属性）
// → 处理兼容层（class/style 等）
// → 添加指令、过渡
// → 返回最终 root VNode
export function renderComponentRoot(
  instance: ComponentInternalInstance,
): VNode {
  // 获取相关信息
  const {
    type: Component,
    vnode,
    proxy,
    withProxy,
    propsOptions: [propsOptions],
    slots,
    attrs,
    emit,
    render,
    renderCache,
    props,
    data,
    setupState,
    ctx,
    inheritAttrs,
  } = instance
  // 设置渲染实例
  const prev = setCurrentRenderingInstance(instance)

  let result
  let fallthroughAttrs
  if (__DEV__) {
    accessedAttrs = false
  }

  try {
    // 带状态的组件
    if (vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) {
      // withProxy is a proxy with a different `has` trap only for
      // runtime-compiled render functions using `with` block.
      // 获取渲染代理
      const proxyToUse = withProxy || proxy
      // 'this' isn't available in production builds with `<script setup>`,
      // so warn if it's used in dev.
      const thisProxy =
        __DEV__ && setupState.__isScriptSetup
          ? new Proxy(proxyToUse!, {
              get(target, key, receiver) {
                warn(
                  `Property '${String(
                    key,
                  )}' was accessed via 'this'. Avoid using 'this' in templates.`,
                )
                return Reflect.get(target, key, receiver)
              },
            })
          : proxyToUse
      // 执行render函数
      result = normalizeVNode(
        render!.call(
          thisProxy,
          proxyToUse!,
          renderCache,
          __DEV__ ? shallowReadonly(props) : props,
          setupState,
          data,
          ctx,
        ),
      )
      fallthroughAttrs = attrs
    } else {
      // functional
      // 函数式组件
      const render = Component as FunctionalComponent
      // in dev, mark attrs accessed if optional props (attrs === props)
      if (__DEV__ && attrs === props) {
        markAttrsAccessed()
      }
      // 直接执行组件函数
      result = normalizeVNode(
        // 查看是否需要第二个参数
        render.length > 1
          ? render(
              __DEV__ ? shallowReadonly(props) : props,
              __DEV__
                ? {
                    get attrs() {
                      markAttrsAccessed()
                      return shallowReadonly(attrs)
                    },
                    slots,
                    emit,
                  }
                : { attrs, slots, emit },
            )
          : render(
              __DEV__ ? shallowReadonly(props) : props,
              null as any /* we know it doesn't need it */,
            ),
      )
      fallthroughAttrs = Component.props
        ? attrs
        : getFunctionalFallthrough(attrs)
    }
  } catch (err) {
    blockStack.length = 0
    handleError(err, instance, ErrorCodes.RENDER_FUNCTION)
    result = createVNode(Comment)
  }

  // attr merging
  // in dev mode, comments are preserved, and it's possible for a template
  // to have comments along side the root element which makes it a fragment
  let root = result
  let setRoot: SetRootFn = undefined
  if (
    __DEV__ &&
    result.patchFlag > 0 &&
    result.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
  ) {
    ;[root, setRoot] = getChildRoot(result)
  }

  if (fallthroughAttrs && inheritAttrs !== false) {
    const keys = Object.keys(fallthroughAttrs)
    const { shapeFlag } = root
    if (keys.length) {
      if (shapeFlag & (ShapeFlags.ELEMENT | ShapeFlags.COMPONENT)) {
        if (propsOptions && keys.some(isModelListener)) {
          // If a v-model listener (onUpdate:xxx) has a corresponding declared
          // prop, it indicates this component expects to handle v-model and
          // it should not fallthrough.
          // related: #1543, #1643, #1989
          fallthroughAttrs = filterModelListeners(
            fallthroughAttrs,
            propsOptions,
          )
        }
        root = cloneVNode(root, fallthroughAttrs, false, true)
      } else if (__DEV__ && !accessedAttrs && root.type !== Comment) {
        const allAttrs = Object.keys(attrs)
        const eventAttrs: string[] = []
        const extraAttrs: string[] = []
        for (let i = 0, l = allAttrs.length; i < l; i++) {
          const key = allAttrs[i]
          if (isOn(key)) {
            // ignore v-model handlers when they fail to fallthrough
            if (!isModelListener(key)) {
              // remove `on`, lowercase first letter to reflect event casing
              // accurately
              eventAttrs.push(key[2].toLowerCase() + key.slice(3))
            }
          } else {
            extraAttrs.push(key)
          }
        }
        if (extraAttrs.length) {
          warn(
            `Extraneous non-props attributes (` +
              `${extraAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text or teleport root nodes.`,
          )
        }
        if (eventAttrs.length) {
          warn(
            `Extraneous non-emits event listeners (` +
              `${eventAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text root nodes. ` +
              `If the listener is intended to be a component custom event listener only, ` +
              `declare it using the "emits" option.`,
          )
        }
      }
    }
  }

  if (
    __COMPAT__ &&
    isCompatEnabled(DeprecationTypes.INSTANCE_ATTRS_CLASS_STYLE, instance) &&
    vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT &&
    root.shapeFlag & (ShapeFlags.ELEMENT | ShapeFlags.COMPONENT)
  ) {
    const { class: cls, style } = vnode.props || {}
    if (cls || style) {
      if (__DEV__ && inheritAttrs === false) {
        warnDeprecation(
          DeprecationTypes.INSTANCE_ATTRS_CLASS_STYLE,
          instance,
          getComponentName(instance.type),
        )
      }
      root = cloneVNode(
        root,
        {
          class: cls,
          style: style,
        },
        false,
        true,
      )
    }
  }

  // inherit directives
  if (vnode.dirs) {
    if (__DEV__ && !isElementRoot(root)) {
      warn(
        `Runtime directive used on component with non-element root node. ` +
          `The directives will not function as intended.`,
      )
    }
    // clone before mutating since the root may be a hoisted vnode
    root = cloneVNode(root, null, false, true)
    root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs
  }
  // inherit transition data
  if (vnode.transition) {
    if (__DEV__ && !isElementRoot(root)) {
      warn(
        `Component inside <Transition> renders non-element root node ` +
          `that cannot be animated.`,
      )
    }
    setTransitionHooks(root, vnode.transition)
  }

  if (__DEV__ && setRoot) {
    setRoot(root)
  } else {
    result = root
  }

  setCurrentRenderingInstance(prev)
  return result
}

/**
 * dev only
 * In dev mode, template root level comments are rendered, which turns the
 * template into a fragment root, but we need to locate the single element
 * root for attrs and scope id processing.
 */
// 递归寻找真正的单个元素根节点，跳过注释和 Fragment。
const getChildRoot = (vnode: VNode): [VNode, SetRootFn] => {
  const rawChildren = vnode.children as VNodeArrayChildren
  const dynamicChildren = vnode.dynamicChildren
  const childRoot = filterSingleRoot(rawChildren, false)
  if (!childRoot) {
    return [vnode, undefined]
  } else if (
    __DEV__ &&
    childRoot.patchFlag > 0 &&
    childRoot.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
  ) {
    return getChildRoot(childRoot)
  }

  const index = rawChildren.indexOf(childRoot)
  const dynamicIndex = dynamicChildren ? dynamicChildren.indexOf(childRoot) : -1
  const setRoot: SetRootFn = (updatedRoot: VNode) => {
    rawChildren[index] = updatedRoot
    if (dynamicChildren) {
      if (dynamicIndex > -1) {
        dynamicChildren[dynamicIndex] = updatedRoot
      } else if (updatedRoot.patchFlag > 0) {
        vnode.dynamicChildren = [...dynamicChildren, updatedRoot]
      }
    }
  }
  return [normalizeVNode(childRoot), setRoot]
}

// 从一组 vnode children 中筛选出唯一有效的元素根节点。
export function filterSingleRoot(
  children: VNodeArrayChildren,
  recurse = true,
): VNode | undefined {
  let singleRoot
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (isVNode(child)) {
      // ignore user comment
      if (child.type !== Comment || child.children === 'v-if') {
        if (singleRoot) {
          // has more than 1 non-comment child, return now
          return
        } else {
          singleRoot = child
          if (
            __DEV__ &&
            recurse &&
            singleRoot.patchFlag > 0 &&
            singleRoot.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
          ) {
            return filterSingleRoot(singleRoot.children as VNodeArrayChildren)
          }
        }
      }
    } else {
      return
    }
  }
  return singleRoot
}

// 过滤 attrs 中可下发的部分（class、style、onXXX）。
const getFunctionalFallthrough = (attrs: Data): Data | undefined => {
  let res: Data | undefined
  for (const key in attrs) {
    if (key === 'class' || key === 'style' || isOn(key)) {
      ;(res || (res = {}))[key] = attrs[key]
    }
  }
  return res
}

// 移除 v-model 事件监听器，防止重复下发。
const filterModelListeners = (attrs: Data, props: NormalizedProps): Data => {
  const res: Data = {}
  for (const key in attrs) {
    if (!isModelListener(key) || !(key.slice(9) in props)) {
      res[key] = attrs[key]
    }
  }
  return res
}

const isElementRoot = (vnode: VNode) => {
  return (
    vnode.shapeFlag & (ShapeFlags.COMPONENT | ShapeFlags.ELEMENT) ||
    vnode.type === Comment // potential v-if branch switch
  )
}

// 判断组件是否需要更新：
// 通过 patchFlag 快速判断（动态 props、slots）
// 手动渲染或无 patchFlag 则进行逐项对比
// 核心是比较 props 和 children
export function shouldUpdateComponent(
  prevVNode: VNode,
  nextVNode: VNode,
  optimized?: boolean,
): boolean {
  const { props: prevProps, children: prevChildren, component } = prevVNode
  const { props: nextProps, children: nextChildren, patchFlag } = nextVNode
  const emits = component!.emitsOptions

  // Parent component's render function was hot-updated. Since this may have
  // caused the child component's slots content to have changed, we need to
  // force the child to update as well.
  if (__DEV__ && (prevChildren || nextChildren) && isHmrUpdating) {
    return true
  }

  // force child update for runtime directive or transition on component vnode.
  // 包含指令和transition的需要更新
  if (nextVNode.dirs || nextVNode.transition) {
    return true
  }

  // 优化模式
  if (optimized && patchFlag >= 0) {
    // 其他判断优化
    if (patchFlag & PatchFlags.DYNAMIC_SLOTS) {
      // slot content that references values that might have changed,
      // e.g. in a v-for
      // 动态插槽情况
      return true
    }
    if (patchFlag & PatchFlags.FULL_PROPS) {
      // 全量props的情况
      if (!prevProps) {
        // 没有旧props ---> 由新props决定
        return !!nextProps
      }
      // presence of this flag indicates props are always non-null
      // 都存在查询有无变化
      return hasPropsChanged(prevProps, nextProps!, emits)
    } else if (patchFlag & PatchFlags.PROPS) {
      // 模板编译阶段优化 动态props
      const dynamicProps = nextVNode.dynamicProps!
      for (let i = 0; i < dynamicProps.length; i++) {
        const key = dynamicProps[i]
        if (
          nextProps![key] !== prevProps![key] &&
          !isEmitListener(emits, key)
        ) {
          return true
        }
      }
    }
  } else {
    // this path is only taken by manually written render functions
    // so presence of any children leads to a forced update
    // 手写render函数时未优化flags 以下任意场景都需要更新
    if (prevChildren || nextChildren) {
      if (!nextChildren || !(nextChildren as any).$stable) {
        return true
      }
    }
    // props未改变
    if (prevProps === nextProps) {
      return false
    }
    if (!prevProps) {
      // 没有旧props ---> 由新props决定
      return !!nextProps
    }
    if (!nextProps) {
      // 存在旧props ---> 不存在新props
      return true
    }
    // 新旧props都存在检测否有变化的props
    return hasPropsChanged(prevProps, nextProps, emits)
  }

  return false
}

// 检测新旧 props 是否有变化，忽略 emits 事件。
function hasPropsChanged(
  prevProps: Data,
  nextProps: Data,
  emitsOptions: ComponentInternalInstance['emitsOptions'],
): boolean {
  const nextKeys = Object.keys(nextProps)
  if (nextKeys.length !== Object.keys(prevProps).length) {
    return true
  }
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i]
    if (
      nextProps[key] !== prevProps[key] &&
      !isEmitListener(emitsOptions, key)
    ) {
      return true
    }
  }
  return false
}

// 用于更新高阶组件（HOC）中真实宿主元素引用，确保递归父子组件结构中的 DOM 正确连接。
export function updateHOCHostEl(
  { vnode, parent }: ComponentInternalInstance,
  el: typeof vnode.el, // HostNode
): void {
  while (parent) {
    const root = parent.subTree
    if (root.suspense && root.suspense.activeBranch === vnode) {
      root.el = vnode.el
    }
    if (root === vnode) {
      ;(vnode = parent.vnode).el = el
      parent = parent.parent
    } else {
      break
    }
  }
}
