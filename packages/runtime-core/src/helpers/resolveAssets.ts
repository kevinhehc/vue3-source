import {
  type ComponentOptions,
  type ConcreteComponent,
  currentInstance,
  getComponentName,
} from '../component'
import { currentRenderingInstance } from '../componentRenderContext'
import type { Directive } from '../directives'
import { camelize, capitalize, isString } from '@vue/shared'
import { warn } from '../warning'
import type { VNodeTypes } from '../vnode'

// 统一处理各种资源（assets）的解析流程：
//
// ✅ 组件 resolveComponent('MyComp')
// ✅ 指令 resolveDirective('v-my-dir')
// ✅ 过滤器（v2 兼容）resolveFilter('capitalize')
// ✅ 动态组件 <component :is="dynamicComp" />

export const COMPONENTS = 'components'
export const DIRECTIVES = 'directives'
export const FILTERS = 'filters'

export type AssetTypes = typeof COMPONENTS | typeof DIRECTIVES | typeof FILTERS

/**
 * @private
 */
// 根据组件名解析本地或全局注册组件。
export function resolveComponent(
  name: string,
  maybeSelfReference?: boolean,
): ConcreteComponent | string {
  // 成功：返回组件定义；
  // 失败：返回原始字符串名（用于警告提示等）。
  return resolveAsset(COMPONENTS, name, true, maybeSelfReference) || name
}

export const NULL_DYNAMIC_COMPONENT: unique symbol = Symbol.for('v-ndc')

/**
 * @private
 */
// 用于 <component :is="..."> 动态组件语法。
export function resolveDynamicComponent(component: unknown): VNodeTypes {
  // 如果 component 是字符串 → 去注册表查找；
  //
  // 如果不是字符串（是组件定义、异步组件、null 等）：
  // 直接返回（交给 createVNode() 后续处理）；
  // 若为 falsy，则返回 NULL_DYNAMIC_COMPONENT 占位符（用于触发警告等处理）。
  if (isString(component)) {
    return resolveAsset(COMPONENTS, component, false) || component
  } else {
    // invalid types will fallthrough to createVNode and raise warning
    return (component || NULL_DYNAMIC_COMPONENT) as any
  }
}

/**
 * @private
 */
// 用于解析指令名，实际就是 resolveAsset(DIRECTIVES, name)。
export function resolveDirective(name: string): Directive | undefined {
  return resolveAsset(DIRECTIVES, name)
}

/**
 * v2 compat only
 * @internal
 */
export function resolveFilter(name: string): Function | undefined {
  return resolveAsset(FILTERS, name)
}

/**
 * @private
 * overload 1: components
 */
// 资源解析的核心逻辑，统一处理组件、指令、过滤器。
function resolveAsset(
  type: typeof COMPONENTS,
  name: string,
  warnMissing?: boolean,
  maybeSelfReference?: boolean,
): ConcreteComponent | undefined
// overload 2: directives
function resolveAsset(
  type: typeof DIRECTIVES,
  name: string,
): Directive | undefined
// implementation
// overload 3: filters (compat only)
function resolveAsset(type: typeof FILTERS, name: string): Function | undefined
// implementation
// 1. 局部注册（options API: instance.components / directives / filters）
// 2. 组件定义上的静态注册（setup-less options）
// 3. 应用上下文 appContext 注册的全局组件 / 指令
// 4. maybeSelfReference: 回退到组件自身（self-reference）
function resolveAsset(
  type: AssetTypes,
  name: string,
  warnMissing = true,
  maybeSelfReference = false,
) {
  const instance = currentRenderingInstance || currentInstance
  if (instance) {
    const Component = instance.type

    // explicit self name has highest priority
    if (type === COMPONENTS) {
      const selfName = getComponentName(
        Component,
        false /* do not include inferred name to avoid breaking existing code */,
      )
      if (
        selfName &&
        (selfName === name ||
          selfName === camelize(name) ||
          selfName === capitalize(camelize(name)))
      ) {
        return Component
      }
    }

    const res =
      // local registration
      // check instance[type] first which is resolved for options API
      resolve(instance[type] || (Component as ComponentOptions)[type], name) ||
      // global registration
      resolve(instance.appContext[type], name)

    if (!res && maybeSelfReference) {
      // fallback to implicit self-reference
      return Component
    }

    if (__DEV__ && warnMissing && !res) {
      const extra =
        type === COMPONENTS
          ? `\nIf this is a native custom element, make sure to exclude it from ` +
            `component resolution via compilerOptions.isCustomElement.`
          : ``
      warn(`Failed to resolve ${type.slice(0, -1)}: ${name}${extra}`)
    }

    return res
  } else if (__DEV__) {
    warn(
      `resolve${capitalize(type.slice(0, -1))} ` +
        `can only be used in render() or setup().`,
    )
  }
}

function resolve(registry: Record<string, any> | undefined, name: string) {
  return (
    registry &&
    (registry[name] ||
      registry[camelize(name)] ||
      registry[capitalize(camelize(name))])
  )
}
