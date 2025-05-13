import {
  camelize,
  extend,
  hyphenate,
  isArray,
  isObject,
  isReservedProp,
  normalizeClass,
} from '@vue/shared'
import type { ComponentInternalInstance, Data } from '../component'
import type { Slot } from '../componentSlots'
import { createSlots } from '../helpers/createSlots'
import { renderSlot } from '../helpers/renderSlot'
import { toHandlers } from '../helpers/toHandlers'
import { type VNode, mergeProps } from '../vnode'

// Vue 3 compat build 中对 Vue 2 渲染函数相关辅助工具的完整兼容实现，主要用于：
// 兼容 Vue 2 的 render 函数和编译输出；
// 保证旧语法、旧行为继续正常运行；
// 提供 runtime helper，以支持 $createElement、_c、_m 等指令生成代码的执行。

function toObject(arr: Array<any>): Object {
  const res = {}
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]) {
      extend(res, arr[i])
    }
  }
  return res
}

// 用于处理 Vue 2 的 v-bind="object" 指令语法：
// <div v-bind="obj" />
// 处理 class、style 合并；
// 普通属性注入到 data.attrs；
// 保留 Vue 2 中的 .sync 修饰符行为（为 onUpdate:x 生成监听器）；
// 支持数组合并：v-bind="[obj1, obj2]"
export function legacyBindObjectProps(
  data: any,
  _tag: string,
  value: any,
  _asProp: boolean,
  isSync?: boolean,
): any {
  if (value && isObject(value)) {
    if (isArray(value)) {
      value = toObject(value)
    }
    for (const key in value) {
      if (isReservedProp(key)) {
        data[key] = value[key]
      } else if (key === 'class') {
        data.class = normalizeClass([data.class, value.class])
      } else if (key === 'style') {
        data.style = normalizeClass([data.style, value.style])
      } else {
        const attrs = data.attrs || (data.attrs = {})
        const camelizedKey = camelize(key)
        const hyphenatedKey = hyphenate(key)
        if (!(camelizedKey in attrs) && !(hyphenatedKey in attrs)) {
          attrs[key] = value[key]

          if (isSync) {
            const on = data.on || (data.on = {})
            on[`update:${key}`] = function ($event: any) {
              value[key] = $event
            }
          }
        }
      }
    }
  }
  return data
}

// 处理 Vue 2 的：
// <div v-on="listeners" />
// 合并事件监听器；
// 使用 Vue 3 的 toHandlers() 和 mergeProps() 转换为 props 格式。
export function legacyBindObjectListeners(props: any, listeners: any): Data {
  return mergeProps(props, toHandlers(listeners))
}

// 兼容 Vue 2 的 _t() 渲染函数：
// _t("default", fallback, props, bindObject)
// 内部调用 Vue 3 的 renderSlot()；
// 支持 bindObject 合并；
// 支持 fallback slots。
export function legacyRenderSlot(
  instance: ComponentInternalInstance,
  name: string,
  fallback?: VNode[],
  props?: any,
  bindObject?: any,
): VNode {
  if (bindObject) {
    props = mergeProps(props, bindObject)
  }
  return renderSlot(instance.slots, name, props, fallback && (() => fallback))
}

type LegacyScopedSlotsData = Array<
  | {
      key: string
      fn: Function
    }
  | LegacyScopedSlotsData
>

// 用于 Vue 2 的 scopedSlots 编译结构：
// const slots = [
//   { key: 'default', fn: () => ... },
//   { key: 'header', fn: () => ... },
// ]
// 把 key 转为 .name；
// 调用 Vue 3 的 createSlots() 生成 slot 对象；
// 支持嵌套数组、动态 key。
export function legacyresolveScopedSlots(
  fns: LegacyScopedSlotsData,
  raw?: Record<string, Slot>,
  // the following are added in 2.6
  hasDynamicKeys?: boolean,
): ReturnType<typeof createSlots> {
  // v2 default slot doesn't have name
  return createSlots(
    raw || ({ $stable: !hasDynamicKeys } as any),
    mapKeyToName(fns),
  )
}

function mapKeyToName(slots: LegacyScopedSlotsData) {
  for (let i = 0; i < slots.length; i++) {
    const fn = slots[i]
    if (fn) {
      if (isArray(fn)) {
        mapKeyToName(fn)
      } else {
        ;(fn as any).name = fn.key || 'default'
      }
    }
  }
  return slots as any
}

const staticCacheMap = /*@__PURE__*/ new WeakMap<
  ComponentInternalInstance,
  any[]
>()

// 支持 Vue 2 的静态节点渲染 _m(index)：
// _m(0)
// 查找 component.staticRenderFns[index]；
// 缓存结果到 WeakMap<instance, []>；
// 调用 static render 函数并返回结果。
export function legacyRenderStatic(
  instance: ComponentInternalInstance,
  index: number,
): any {
  let cache = staticCacheMap.get(instance)
  if (!cache) {
    staticCacheMap.set(instance, (cache = []))
  }
  if (cache[index]) {
    return cache[index]
  }
  const fn = (instance.type as any).staticRenderFns[index]
  const ctx = instance.proxy
  return (cache[index] = fn.call(ctx, null, ctx))
}

// 支持 Vue 2 的 $event.keyCode 修饰符检查：
// <input @keydown.enter="...">
// 等价于 _k($event.keyCode, 'enter', ...);
// 对照 config.keyCodes 中的自定义键；
// 对比 keyName/keyCode 是否匹配；
// 用于兼容 Vue 2 的 _k() helper。
export function legacyCheckKeyCodes(
  instance: ComponentInternalInstance,
  eventKeyCode: number,
  key: string,
  builtInKeyCode?: number | number[],
  eventKeyName?: string,
  builtInKeyName?: string | string[],
): boolean | undefined {
  const config = instance.appContext.config as any
  const configKeyCodes = config.keyCodes || {}
  const mappedKeyCode = configKeyCodes[key] || builtInKeyCode
  if (builtInKeyName && eventKeyName && !configKeyCodes[key]) {
    return isKeyNotMatch(builtInKeyName, eventKeyName)
  } else if (mappedKeyCode) {
    return isKeyNotMatch(mappedKeyCode, eventKeyCode)
  } else if (eventKeyName) {
    return hyphenate(eventKeyName) !== key
  }
}

function isKeyNotMatch<T>(expect: T | T[], actual: T): boolean {
  if (isArray(expect)) {
    return !expect.includes(actual)
  } else {
    return expect !== actual
  }
}

// 占位函数，对应 Vue 2 的 _o()（v-once）：
// _o(render(), 0)
// 在 Vue 3 中无意义，直接返回原 vnode。
export function legacyMarkOnce(tree: VNode): VNode {
  return tree
}

// 用于 Vue 2 的动态对象绑定语法：
// { [_key]: value }
// 等价于 _d(props, [_key, value])
// 遍历数组，每两个元素为一组；
// 设置为 props[key] = value。
export function legacyBindDynamicKeys(props: any, values: any[]): any {
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]
    if (typeof key === 'string' && key) {
      props[values[i]] = values[i + 1]
    }
  }
  return props
}

// 用于处理事件修饰符合并：
// click.native → native + click
// _p(handler, '~') // prepend `~` for once
// 若为字符串则拼接，否则直接返回原值。
export function legacyPrependModifier(value: any, symbol: string): any {
  return typeof value === 'string' ? symbol + value : value
}
