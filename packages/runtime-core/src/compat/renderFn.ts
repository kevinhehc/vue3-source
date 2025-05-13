import {
  ShapeFlags,
  extend,
  hyphenate,
  isArray,
  isObject,
  isString,
  makeMap,
  normalizeClass,
  normalizeStyle,
  toHandlerKey,
} from '@vue/shared'
import type {
  Component,
  ComponentInternalInstance,
  ComponentOptions,
  Data,
  InternalRenderFunction,
} from '../component'
import { currentRenderingInstance } from '../componentRenderContext'
import { type DirectiveArguments, withDirectives } from '../directives'
import {
  resolveDirective,
  resolveDynamicComponent,
} from '../helpers/resolveAssets'
import {
  Comment,
  type VNode,
  type VNodeArrayChildren,
  type VNodeProps,
  createVNode,
  isVNode,
  normalizeChildren,
} from '../vnode'
import {
  DeprecationTypes,
  checkCompatEnabled,
  isCompatEnabled,
} from './compatConfig'
import { compatModelEventPrefix } from './componentVModel'

// 包装 Vue 2 的 render(h) 函数为 Vue 3 能用的形式
export function convertLegacyRenderFn(
  instance: ComponentInternalInstance,
): void {
  // 识别 Vue 2 的 render 函数格式：
  // render(h) {
  //   return h('div', this.msg)
  // }
  // 包装为：
  // Component.render = function compatRender() {
  //   return render.call(this, compatH)
  // }
  // 并设置标记 _compatWrapped = true，避免重复包裹。
  const Component = instance.type as ComponentOptions
  const render = Component.render as InternalRenderFunction | undefined

  // v3 runtime compiled, or already checked / wrapped
  if (!render || render._rc || render._compatChecked || render._compatWrapped) {
    return
  }

  if (render.length >= 2) {
    // v3 pre-compiled function, since v2 render functions never need more than
    // 2 arguments, and v2 functional render functions would have already been
    // normalized into v3 functional components
    render._compatChecked = true
    return
  }

  // v2 render function, try to provide compat
  if (checkCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance)) {
    const wrapped = (Component.render = function compatRender() {
      // @ts-expect-error
      return render.call(this, compatH)
    })
    // @ts-expect-error
    wrapped._compatWrapped = true
  }
}

interface LegacyVNodeProps {
  key?: string | number
  ref?: string
  refInFor?: boolean

  staticClass?: string
  class?: unknown
  staticStyle?: Record<string, unknown>
  style?: Record<string, unknown>
  attrs?: Record<string, unknown>
  domProps?: Record<string, unknown>
  on?: Record<string, Function | Function[]>
  nativeOn?: Record<string, Function | Function[]>
  directives?: LegacyVNodeDirective[]

  // component only
  props?: Record<string, unknown>
  slot?: string
  scopedSlots?: Record<string, Function>
  model?: {
    value: any
    callback: (v: any) => void
    expression: string
  }
}

interface LegacyVNodeDirective {
  name: string
  value: unknown
  arg?: string
  modifiers?: Record<string, boolean>
}

type LegacyVNodeChildren =
  | string
  | number
  | boolean
  | VNode
  | VNodeArrayChildren

export function compatH(
  type: string | Component,
  children?: LegacyVNodeChildren,
): VNode
export function compatH(
  type: string | Component,
  props?: Data & LegacyVNodeProps,
  children?: LegacyVNodeChildren,
): VNode

// 兼容 Vue 2 的 h() 调用（即 $createElement）
export function compatH(
  type: any,
  propsOrChildren?: any,
  children?: any,
): VNode {
  // 兼容 Vue 2 的 h(type, props?, children?) 调用方式。
  //
  // 转换逻辑：
  //
  // 输入类型	                            处理方式
  // 字符串组件名（如 'div', 'transition'）	转为 resolveDynamicComponent() 形式
  // 第二参数是 VNode	                        包装为 [vnode]
  // 有 directives	                        应用 withDirectives()
  // 有 slot	                            转换为 Vue 3 插槽格式
  //
  // 最终调用 createVNode(type, props, children)。
  if (!type) {
    type = Comment
  }

  // to support v2 string component name look!up
  if (typeof type === 'string') {
    const t = hyphenate(type)
    if (t === 'transition' || t === 'transition-group' || t === 'keep-alive') {
      // since transition and transition-group are runtime-dom-specific,
      // we cannot import them directly here. Instead they are registered using
      // special keys in @vue/compat entry.
      type = `__compat__${t}`
    }
    type = resolveDynamicComponent(type)
  }

  const l = arguments.length
  const is2ndArgArrayChildren = isArray(propsOrChildren)
  if (l === 2 || is2ndArgArrayChildren) {
    if (isObject(propsOrChildren) && !is2ndArgArrayChildren) {
      // single vnode without props
      if (isVNode(propsOrChildren)) {
        return convertLegacySlots(createVNode(type, null, [propsOrChildren]))
      }
      // props without children
      return convertLegacySlots(
        convertLegacyDirectives(
          createVNode(type, convertLegacyProps(propsOrChildren, type)),
          propsOrChildren,
        ),
      )
    } else {
      // omit props
      return convertLegacySlots(createVNode(type, null, propsOrChildren))
    }
  } else {
    if (isVNode(children)) {
      children = [children]
    }
    return convertLegacySlots(
      convertLegacyDirectives(
        createVNode(type, convertLegacyProps(propsOrChildren, type), children),
        propsOrChildren,
      ),
    )
  }
}

const skipLegacyRootLevelProps = /*@__PURE__*/ makeMap(
  'staticStyle,staticClass,directives,model,hook',
)

// 兼容 Vue 2 VNode 的 props 格式
// 将 Vue 2 的复杂 props 结构转为 Vue 3 的 VNode props：
// 合并 attrs、domProps、props；
// 合并 on 和 nativeOn 事件（并处理修饰符前缀，如 ~click, !focus）；
// 处理 staticClass + class 合并；
// 处理 model 字段（Vue 2 编译生成的 v-model）；
// 关键点是支持 Vue 2 的编译结构。
function convertLegacyProps(
  legacyProps: LegacyVNodeProps | undefined,
  type: any,
): (Data & VNodeProps) | null {
  if (!legacyProps) {
    return null
  }

  const converted: Data & VNodeProps = {}

  for (const key in legacyProps) {
    if (key === 'attrs' || key === 'domProps' || key === 'props') {
      extend(converted, legacyProps[key])
    } else if (key === 'on' || key === 'nativeOn') {
      const listeners = legacyProps[key]
      for (const event in listeners) {
        let handlerKey = convertLegacyEventKey(event)
        if (key === 'nativeOn') handlerKey += `Native`
        const existing = converted[handlerKey]
        const incoming = listeners[event]
        if (existing !== incoming) {
          if (existing) {
            converted[handlerKey] = [].concat(existing as any, incoming as any)
          } else {
            converted[handlerKey] = incoming
          }
        }
      }
    } else if (!skipLegacyRootLevelProps(key)) {
      converted[key] = legacyProps[key as keyof LegacyVNodeProps]
    }
  }

  if (legacyProps.staticClass) {
    converted.class = normalizeClass([legacyProps.staticClass, converted.class])
  }
  if (legacyProps.staticStyle) {
    converted.style = normalizeStyle([legacyProps.staticStyle, converted.style])
  }

  if (legacyProps.model && isObject(type)) {
    // v2 compiled component v-model
    const { prop = 'value', event = 'input' } = (type as any).model || {}
    converted[prop] = legacyProps.model.value
    converted[compatModelEventPrefix + event] = legacyProps.model.callback
  }

  return converted
}

function convertLegacyEventKey(event: string): string {
  // normalize v2 event prefixes
  if (event[0] === '&') {
    event = event.slice(1) + 'Passive'
  }
  if (event[0] === '~') {
    event = event.slice(1) + 'Once'
  }
  if (event[0] === '!') {
    event = event.slice(1) + 'Capture'
  }
  return toHandlerKey(event)
}

// 转换 Vue 2 的 directives 为 Vue 3 的 withDirectives() 调用
function convertLegacyDirectives(
  vnode: VNode,
  props?: LegacyVNodeProps,
): VNode {
  // 将 Vue 2 的 directives: [...] 数组，转换为：
  // withDirectives(vnode, [[resolveDirective('name'), value, arg, modifiers]])
  // 这是 Vue 3 支持的指令方式。
  if (props && props.directives) {
    return withDirectives(
      vnode,
      props.directives.map(({ name, value, arg, modifiers }) => {
        return [
          resolveDirective(name)!,
          value,
          arg,
          modifiers,
        ] as DirectiveArguments[number]
      }),
    )
  }
  return vnode
}

// 将 Vue 2 的插槽数组/函数转换为 Vue 3 插槽格式
function convertLegacySlots(vnode: VNode): VNode {
  // 将 Vue 2 中的 slot 用法（包括具名插槽、作用域插槽）转换为 Vue 3 格式：
  // 从 VNode 的 children 中提取 .slot 属性构建 slots；
  // 如果有 scopedSlots 直接合并；
  // 每个 slot 变为一个返回 VNode 数组的函数；
  // 最终调用 normalizeChildren(vnode, slots) 注入到 VNode 中。
  const { props, children } = vnode

  let slots: Record<string, any> | undefined

  if (vnode.shapeFlag & ShapeFlags.COMPONENT && isArray(children)) {
    slots = {}
    // check "slot" property on vnodes and turn them into v3 function slots
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const slotName =
        (isVNode(child) && child.props && child.props.slot) || 'default'
      const slot = slots[slotName] || (slots[slotName] = [] as any[])
      if (isVNode(child) && child.type === 'template') {
        slot.push(child.children)
      } else {
        slot.push(child)
      }
    }
    if (slots) {
      for (const key in slots) {
        const slotChildren = slots[key]
        slots[key] = () => slotChildren
        slots[key]._ns = true /* non-scoped slot */
      }
    }
  }

  const scopedSlots = props && props.scopedSlots
  if (scopedSlots) {
    delete props!.scopedSlots
    if (slots) {
      extend(slots, scopedSlots)
    } else {
      slots = scopedSlots
    }
  }

  if (slots) {
    normalizeChildren(vnode, slots)
  }

  return vnode
}

// 给 VNode 添加 Vue 2 风格的属性，例如 vnode.data, vnode.context, vnode.child
export function defineLegacyVNodeProperties(vnode: VNode): void {
  /* v8 ignore start */
  if (
    isCompatEnabled(
      DeprecationTypes.RENDER_FUNCTION,
      currentRenderingInstance,
      true /* enable for built-ins */,
    ) &&
    isCompatEnabled(
      DeprecationTypes.PRIVATE_APIS,
      currentRenderingInstance,
      true /* enable for built-ins */,
    )
  ) {
    const context = currentRenderingInstance
    const getInstance = () => vnode.component && vnode.component.proxy
    let componentOptions: any
    Object.defineProperties(vnode, {
      tag: { get: () => vnode.type },
      data: { get: () => vnode.props || {}, set: p => (vnode.props = p) },
      elm: { get: () => vnode.el },
      componentInstance: { get: getInstance },
      child: { get: getInstance },
      text: { get: () => (isString(vnode.children) ? vnode.children : null) },
      context: { get: () => context && context.proxy },
      componentOptions: {
        get: () => {
          if (vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) {
            if (componentOptions) {
              return componentOptions
            }
            return (componentOptions = {
              Ctor: vnode.type,
              propsData: vnode.props,
              children: vnode.children,
            })
          }
        },
      },
    })
  }
  /* v8 ignore stop */
}
