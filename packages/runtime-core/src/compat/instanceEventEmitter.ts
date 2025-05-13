import { isArray } from '@vue/shared'
import type { ComponentInternalInstance } from '../component'
import { ErrorCodes, callWithAsyncErrorHandling } from '../errorHandling'
import { DeprecationTypes, assertCompatEnabled } from './compatConfig'
import type { ComponentPublicInstance } from '../componentPublicInstance'

// 组件实例事件 API（$on / $off / $once / $emit）的完整兼容实现。下面是详细解析：
//
// ✅ Vue 2 中的事件系统回顾
// 在 Vue 2 中，组件实例支持这些事件方法：
// this.$on('event', callback)
// this.$once('event', callback)
// this.$off('event', callback)
// this.$emit('event', payload)
// 这些是基于组件内部的事件总线，用于组件内部通信（不同于 DOM 事件）。
//
// ✅ Vue 3 变动
// Vue 3 中完全移除了这些 $on/$once/$off 方法，推荐使用 emits + props、v-model、provide/inject 等方式替代。
//
// 为支持迁移，compat build 实现了这些方法，并注入为实例属性。

interface EventRegistry {
  [event: string]: Function[] | undefined
}

const eventRegistryMap = /*@__PURE__*/ new WeakMap<
  ComponentInternalInstance,
  EventRegistry
>()

// 内部事件注册表存储在 WeakMap 中：
// 确保每个组件实例都有独立的事件集合，避免污染。
export function getRegistry(
  instance: ComponentInternalInstance,
): EventRegistry {
  let events = eventRegistryMap.get(instance)
  if (!events) {
    eventRegistryMap.set(instance, (events = Object.create(null)))
  }
  return events!
}

// 注册一个或多个事件回调。
// 支持数组事件注册；
// 支持 hook: 开头的生命周期事件（兼容 hook:created 之类）；
// 触发对应 deprecation 警告；
// 注册在内部事件表上：eventRegistryMap.get(instance)
export function on(
  instance: ComponentInternalInstance,
  event: string | string[],
  fn: Function,
): ComponentPublicInstance | null {
  if (isArray(event)) {
    event.forEach(e => on(instance, e, fn))
  } else {
    if (event.startsWith('hook:')) {
      assertCompatEnabled(
        DeprecationTypes.INSTANCE_EVENT_HOOKS,
        instance,
        event,
      )
    } else {
      assertCompatEnabled(DeprecationTypes.INSTANCE_EVENT_EMITTER, instance)
    }
    const events = getRegistry(instance)
    ;(events[event] || (events[event] = [])).push(fn)
  }
  return instance.proxy
}

// 注册只触发一次的事件。
// once(instance, 'my-event', callback)
// 使用包装函数自动解绑；
// 包装函数存储原始函数 wrapped.fn = fn；
// 调用 on() 注册。
export function once(
  instance: ComponentInternalInstance,
  event: string,
  fn: Function,
): ComponentPublicInstance | null {
  const wrapped = (...args: any[]) => {
    off(instance, event, wrapped)
    fn.apply(instance.proxy, args)
  }
  wrapped.fn = fn
  on(instance, event, wrapped)
  return instance.proxy
}

// 解绑事件监听器。
// off(instance)                     // 清空所有事件
// off(instance, 'my-event')         // 清空特定事件
// off(instance, 'my-event', fn)     // 清除指定的回调
// 支持数组事件解绑；
// 会过滤 cb === fn 或 cb.fn === fn（once 中包装函数）；
// 如果不传 fn，移除整个事件。
export function off(
  instance: ComponentInternalInstance,
  event?: string | string[],
  fn?: Function,
): ComponentPublicInstance | null {
  assertCompatEnabled(DeprecationTypes.INSTANCE_EVENT_EMITTER, instance)
  const vm = instance.proxy
  // all
  if (!event) {
    eventRegistryMap.set(instance, Object.create(null))
    return vm
  }
  // array of events
  if (isArray(event)) {
    event.forEach(e => off(instance, e, fn))
    return vm
  }
  // specific event
  const events = getRegistry(instance)
  const cbs = events[event!]
  if (!cbs) {
    return vm
  }
  if (!fn) {
    events[event!] = undefined
    return vm
  }
  events[event!] = cbs.filter(cb => !(cb === fn || (cb as any).fn === fn))
  return vm
}

// 触发某个事件。
// emit(instance, 'my-event', [payload])
// 会调用注册的回调函数；
// 使用 callWithAsyncErrorHandling() 包裹执行，防止错误吞掉；
// 返回组件 proxy 实例。
export function emit(
  instance: ComponentInternalInstance,
  event: string,
  args: any[],
): ComponentPublicInstance | null {
  const cbs = getRegistry(instance)[event]
  if (cbs) {
    callWithAsyncErrorHandling(
      cbs.map(cb => cb.bind(instance.proxy)),
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args,
    )
  }
  return instance.proxy
}
