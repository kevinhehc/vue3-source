import {
  EMPTY_OBJ,
  NOOP,
  hasChanged,
  isArray,
  isFunction,
  isMap,
  isObject,
  isPlainObject,
  isSet,
  remove,
} from '@vue/shared'
import { warn } from './warning'
import type { ComputedRef } from './computed'
import { ReactiveFlags } from './constants'
import {
  type DebuggerOptions,
  EffectFlags,
  type EffectScheduler,
  ReactiveEffect,
  pauseTracking,
  resetTracking,
} from './effect'
import { isReactive, isShallow } from './reactive'
import { type Ref, isRef } from './ref'
import { getCurrentScope } from './effectScope'

// These errors were transferred from `packages/runtime-core/src/errorHandling.ts`
// to @vue/reactivity to allow co-location with the moved base watch logic, hence
// it is essential to keep these values unchanged.
// 这些错误码最初在 `packages/runtime-core/src/errorHandling.ts` 中，
// 为了配合 watch 核心逻辑的迁移，转移到了 @vue/reactivity 中。
// 所以这些值必须保持不变以避免错误码错乱。
export enum WatchErrorCodes {
  WATCH_GETTER = 2, // getter 函数执行出错
  WATCH_CALLBACK, // 回调函数出错
  WATCH_CLEANUP, // 清理函数出错
}

// WatchEffect 是 watchEffect 接收的函数类型，传入 onCleanup 函数用于注册清理逻辑
export type WatchEffect = (onCleanup: OnCleanup) => void

// WatchSource 表示 watch 的监听来源，可以是：
// - Ref
// - ComputedRef
// - getter 函数（函数式响应式源）
export type WatchSource<T = any> = Ref<T, any> | ComputedRef<T> | (() => T)

// WatchCallback 是 watch 的回调函数类型
// value 是新值，oldValue 是旧值，onCleanup 用于注册清理函数
export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onCleanup: OnCleanup,
) => any

// onCleanup 是 watch/watchEffect 中注册清理逻辑的工具函数
export type OnCleanup = (cleanupFn: () => void) => void

// WatchOptions 是 watch API 的配置项
export interface WatchOptions<Immediate = boolean> extends DebuggerOptions {
  // 是否立即执行一次回调（默认否）
  immediate?: Immediate
  // 是否深度监听（对象内部属性变化）
  deep?: boolean | number
  // 是否仅执行一次后停止监听
  once?: boolean
  // 自定义调度器，用于控制回调何时运行
  scheduler?: WatchScheduler
  // 触发警告时的回调
  onWarn?: (msg: string, ...args: any[]) => void

  /**
   * @internal 内部使用：允许扩展 watch 的回调包装（例如加入调试信息）
   */
  augmentJob?: (job: (...args: any[]) => void) => void
  /**
   * @internal 内部使用：统一处理错误的函数
   */
  call?: (
    fn: Function | Function[], // 要执行的函数或函数数组
    type: WatchErrorCodes, // 错误类型枚举
    args?: unknown[], // 函数参数
  ) => void
}

// WatchStopHandle 表示一个函数，用于停止监听（watch 返回值）
export type WatchStopHandle = () => void

// WatchHandle 扩展了 WatchStopHandle，添加了 pause 和 resume 方法
// 用于暂停/恢复监听（用于更复杂的使用场景）
export interface WatchHandle extends WatchStopHandle {
  // 暂停监听
  pause: () => void
  // 恢复监听
  resume: () => void
  // 停止监听（等同于调用自身）
  stop: () => void
}

// initial value for watchers to trigger on undefined initial values
// 初始值常量，用于触发初始对比（因为 undefined 不一定能正确触发变化）
const INITIAL_WATCHER_VALUE = {}

// WatchScheduler 是调度器函数类型，用于控制副作用执行的时机
// job 是副作用函数，isFirstRun 表示是否首次运行
export type WatchScheduler = (job: () => void, isFirstRun: boolean) => void

// 用于存储每个 effect 对应的清理函数数组，WeakMap 避免内存泄漏
const cleanupMap: WeakMap<ReactiveEffect, (() => void)[]> = new WeakMap()
// 当前活跃的 watcher（副作用函数），用于依赖追踪
let activeWatcher: ReactiveEffect | undefined = undefined

/**
 * Returns the current active effect if there is one.
 */
/**
 * 获取当前正在运行的 watcher（副作用函数）
 * 如果没有活跃 watcher，返回 undefined
 */
export function getCurrentWatcher(): ReactiveEffect<any> | undefined {
  return activeWatcher
}

/**
 * Registers a cleanup callback on the current active effect. This
 * registered cleanup callback will be invoked right before the
 * associated effect re-runs.
 *
 * @param cleanupFn - The callback function to attach to the effect's cleanup.
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 * @param owner - The effect that this cleanup function should be attached to.
 * By default, the current active effect.
 */
export function onWatcherCleanup(
  cleanupFn: () => void,
  failSilently = false,
  owner: ReactiveEffect | undefined = activeWatcher,
): void {
  if (owner) {
    let cleanups = cleanupMap.get(owner)
    if (!cleanups) cleanupMap.set(owner, (cleanups = []))
    cleanups.push(cleanupFn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onWatcherCleanup() was called when there was no active watcher` +
        ` to associate with.`,
    )
  }
}

// watch 是 Vue 的响应式监听函数，可以监听 ref、reactive、getter 等
export function watch(
  source: WatchSource | WatchSource[] | WatchEffect | object, // 监听的来源
  cb?: WatchCallback | null, // 值变化时的回调函数
  options: WatchOptions = EMPTY_OBJ, // 配置项
): WatchHandle {
  // 解构参数中的一些控制选项，如是否立即执行、深度监听、自定义调度器等
  const { immediate, deep, once, scheduler, augmentJob, call } = options

  // 定义一个用于打印无效 source 的警告函数
  const warnInvalidSource = (s: unknown) => {
    ;(options.onWarn || warn)(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`,
    )
  }

  // 定义处理 reactive 对象的 getter
  const reactiveGetter = (source: object) => {
    // traverse will happen in wrapped getter below
    // 如果 deep 为 true，则直接返回整个对象（后面会 traverse）
    if (deep) return source
    // for `deep: false | 0` or shallow reactive, only traverse root-level properties
    // 如果是 shallow 或者显式 deep 为 false/0，则只遍历第一层
    if (isShallow(source) || deep === false || deep === 0)
      return traverse(source, 1)
    // for `deep: undefined` on a reactive object, deeply traverse all properties
    // 默认深度遍历所有属性
    return traverse(source)
  }

  // 当前副作用对象
  let effect: ReactiveEffect
  // 实际获取值的 getter 函数
  let getter: () => any
  // 上次监听清理函数
  let cleanup: (() => void) | undefined
  // 注册清理函数工具
  let boundCleanup: typeof onWatcherCleanup
  // 是否强制触发（避免值相等时跳过）
  let forceTrigger = false
  // 是否监听多个来源
  let isMultiSource = false

  // 处理不同类型的 source
  if (isRef(source)) {
    // ref：访问其 value
    getter = () => source.value
    // shallow ref 强制触发
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    getter = () => reactiveGetter(source)
    forceTrigger = true
  } else if (isArray(source)) {
    isMultiSource = true
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return reactiveGetter(s)
        } else if (isFunction(s)) {
          return call ? call(s, WatchErrorCodes.WATCH_GETTER) : s()
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    if (cb) {
      // getter with cb
      // watch(source, cb) 类型
      getter = call
        ? () => call(source, WatchErrorCodes.WATCH_GETTER)
        : (source as () => any)
    } else {
      // no cb -> simple effect
      // watchEffect(source) 类型
      getter = () => {
        if (cleanup) {
          pauseTracking()
          try {
            cleanup()
          } finally {
            resetTracking()
          }
        }
        const currentEffect = activeWatcher
        activeWatcher = effect
        try {
          return call
            ? call(source, WatchErrorCodes.WATCH_CALLBACK, [boundCleanup])
            : source(boundCleanup)
        } finally {
          activeWatcher = currentEffect
        }
      }
    }
  } else {
    // 不支持的 source，getter 为空函数
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 如果需要深度监听并提供回调函数
  if (cb && deep) {
    const baseGetter = getter
    const depth = deep === true ? Infinity : deep
    getter = () => traverse(baseGetter(), depth)
  }

  // 获取当前组件的响应式作用域
  const scope = getCurrentScope()
  // 创建返回的 watch handle（包括 stop/pause/resume）
  const watchHandle: WatchHandle = () => {
    effect.stop()
    if (scope && scope.active) {
      remove(scope.effects, effect)
    }
  }

  // once: true 则只触发一次后自动停止监听
  if (once && cb) {
    const _cb = cb
    cb = (...args) => {
      _cb(...args)
      watchHandle()
    }
  }

  // 初始 oldValue，watch(source[]) 时是数组
  let oldValue: any = isMultiSource
    ? new Array((source as []).length).fill(INITIAL_WATCHER_VALUE)
    : INITIAL_WATCHER_VALUE

  // 定义监听触发时的回调 job（核心逻辑）
  const job = (immediateFirstRun?: boolean) => {
    if (
      !(effect.flags & EffectFlags.ACTIVE) ||
      (!effect.dirty && !immediateFirstRun)
    ) {
      return
    }
    if (cb) {
      // watch(source, cb) 分支
      const newValue = effect.run()
      if (
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) => hasChanged(v, oldValue[i]))
          : hasChanged(newValue, oldValue))
      ) {
        // cleanup before running cb again
        // 回调前清理旧的副作用
        if (cleanup) {
          cleanup()
        }
        const currentWatcher = activeWatcher
        activeWatcher = effect
        try {
          const args = [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            oldValue === INITIAL_WATCHER_VALUE
              ? undefined
              : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE
                ? []
                : oldValue,
            boundCleanup,
          ]
          call
            ? call(cb!, WatchErrorCodes.WATCH_CALLBACK, args)
            : // @ts-expect-error
              cb!(...args)
          oldValue = newValue
        } finally {
          activeWatcher = currentWatcher
        }
      }
    } else {
      // watchEffect 分支：没有 cb，直接执行副作用
      effect.run()
    }
  }

  // 如果有 augmentJob 则对 job 做一层包装（如增加调试信息）
  if (augmentJob) {
    augmentJob(job)
  }

  // 创建副作用对象（绑定 getter）
  effect = new ReactiveEffect(getter)

  // 设置副作用的调度器
  effect.scheduler = scheduler
    ? () => scheduler(job, false)
    : (job as EffectScheduler)

  // 绑定 cleanup 注册器
  boundCleanup = fn => onWatcherCleanup(fn, false, effect)

  // 设置 stop 时的 cleanup 清理逻辑
  cleanup = effect.onStop = () => {
    const cleanups = cleanupMap.get(effect)
    if (cleanups) {
      if (call) {
        call(cleanups, WatchErrorCodes.WATCH_CLEANUP)
      } else {
        for (const cleanup of cleanups) cleanup()
      }
      cleanupMap.delete(effect)
    }
  }

  // DEV 环境下设置调试用的追踪钩子
  if (__DEV__) {
    effect.onTrack = options.onTrack
    effect.onTrigger = options.onTrigger
  }

  // initial run
  // 初始执行逻辑（首次监听）
  if (cb) {
    if (immediate) {
      job(true)
      // 立即执行回调
    } else {
      // 延迟到下次变化才执行
      oldValue = effect.run()
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true)
  } else {
    effect.run()
  }

  // 设置返回对象的 pause/resume/stop
  watchHandle.pause = effect.pause.bind(effect)
  watchHandle.resume = effect.resume.bind(effect)
  watchHandle.stop = watchHandle

  return watchHandle
}

// traverse 用于深度遍历对象的所有属性，从而触发 Vue 响应式系统的依赖收集
export function traverse(
  value: unknown, // 要遍历的目标值
  depth: number = Infinity, // 限制递归深度，默认无限
  seen?: Set<unknown>, // 用于防止循环引用的集合
): unknown {
  // 递归终止条件：
  // - 达到递归深度上限
  // - 不是对象（基础类型）
  // - 被标记为跳过响应式处理（如 markRaw 的对象）
  if (depth <= 0 || !isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }

  // 初始化循环检测 Set（防止无限递归）
  seen = seen || new Set()
  if (seen.has(value)) {
    // 已访问，跳过
    return value
  }
  // 标记已访问
  seen.add(value)
  // 递归深度减一
  depth--
  // 如果是 ref，则递归其内部的 value
  if (isRef(value)) {
    traverse(value.value, depth, seen)
  } else if (isArray(value)) {
    // 如果是数组，遍历每一项
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen)
    }
  } else if (isSet(value) || isMap(value)) {
    // 如果是 Set 或 Map，遍历其值
    value.forEach((v: any) => {
      traverse(v, depth, seen)
    })
  } else if (isPlainObject(value)) {
    // 如果是普通对象，遍历其键值对（包括 symbol 属性）
    for (const key in value) {
      traverse(value[key], depth, seen)
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      // 遍历可枚举的 symbol 属性
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key as any], depth, seen)
      }
    }
  }
  // 最终返回原始值（主要用于链式用途）
  return value
}
