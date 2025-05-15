import {
  type WatchOptions as BaseWatchOptions,
  type DebuggerOptions,
  type ReactiveMarker,
  type WatchCallback,
  type WatchEffect,
  type WatchHandle,
  type WatchSource,
  watch as baseWatch,
} from '@vue/reactivity'
import { type SchedulerJob, SchedulerJobFlags, queueJob } from './scheduler'
import { EMPTY_OBJ, NOOP, extend, isFunction, isString } from '@vue/shared'
import {
  type ComponentInternalInstance,
  currentInstance,
  isInSSRComponentSetup,
  setCurrentInstance,
} from './component'
import { callWithAsyncErrorHandling } from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'
import type { ObjectWatchOptionItem } from './componentOptions'
import { useSSRContext } from './helpers/useSsrContext'

export type {
  WatchHandle,
  WatchStopHandle,
  WatchEffect,
  WatchSource,
  WatchCallback,
  OnCleanup,
} from '@vue/reactivity'

type MaybeUndefined<T, I> = I extends true ? T | undefined : T

type MapSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? MaybeUndefined<V, Immediate>
    : T[K] extends object
      ? MaybeUndefined<T[K], Immediate>
      : never
}

export interface WatchEffectOptions extends DebuggerOptions {
  flush?: 'pre' | 'post' | 'sync'
}

export interface WatchOptions<Immediate = boolean> extends WatchEffectOptions {
  immediate?: Immediate
  deep?: boolean | number
  once?: boolean
}

// Simple effect.
export function watchEffect(
  effect: WatchEffect,
  options?: WatchEffectOptions,
): WatchHandle {
  return doWatch(effect, null, options)
}

export function watchPostEffect(
  effect: WatchEffect,
  options?: DebuggerOptions,
): WatchHandle {
  return doWatch(
    effect,
    null,
    __DEV__ ? extend({}, options as any, { flush: 'post' }) : { flush: 'post' },
  )
}

export function watchSyncEffect(
  effect: WatchEffect,
  options?: DebuggerOptions,
): WatchHandle {
  return doWatch(
    effect,
    null,
    __DEV__ ? extend({}, options as any, { flush: 'sync' }) : { flush: 'sync' },
  )
}

export type MultiWatchSources = (WatchSource<unknown> | object)[]

// overload: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, MaybeUndefined<T, Immediate>>,
  options?: WatchOptions<Immediate>,
): WatchHandle

// overload: reactive array or tuple of multiple sources + cb
export function watch<
  T extends Readonly<MultiWatchSources>,
  Immediate extends Readonly<boolean> = false,
>(
  sources: readonly [...T] | T,
  cb: [T] extends [ReactiveMarker]
    ? WatchCallback<T, MaybeUndefined<T, Immediate>>
    : WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>,
): WatchHandle

// overload: array of multiple sources + cb
export function watch<
  T extends MultiWatchSources,
  Immediate extends Readonly<boolean> = false,
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>,
): WatchHandle

// overload: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false,
>(
  source: T,
  cb: WatchCallback<T, MaybeUndefined<T, Immediate>>,
  options?: WatchOptions<Immediate>,
): WatchHandle

// implementation
export function watch<T = any, Immediate extends Readonly<boolean> = false>(
  source: T | WatchSource<T>,
  cb: any,
  options?: WatchOptions<Immediate>,
): WatchHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`,
    )
  }
  return doWatch(source as any, cb, options)
}

// 是 watch 和 watchEffect 的底层引擎。所有的组合式监听最终都会走到这里，
// 无论是 watch(ref, cb)、watchEffect(fn)，还是 this.$watch(...)。
function doWatch(
  // source：要监听的响应式数据、getter、数组或对象。
  // cb：监听回调（null 表示 watchEffect）。
  // options：监听选项，如 deep、flush、immediate、once。
  // 返回 WatchHandle（可用于停止监听）。
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb: WatchCallback | null,
  options: WatchOptions = EMPTY_OBJ,
): WatchHandle {
  const { immediate, deep, flush, once } = options

  // 二、开发环境提示（非 watchEffect 时）
  // 如果 cb 为 null（即 watchEffect），警告这些选项将被忽略。
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`,
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`,
      )
    }
    if (once !== undefined) {
      warn(
        `watch() "once" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`,
      )
    }
  }

  // 三、初始化选项对象
  // 拷贝用户传入的 options。
  // 开发模式下设置统一的 onWarn 警告函数。
  const baseWatchOptions: BaseWatchOptions = extend({}, options)

  if (__DEV__) baseWatchOptions.onWarn = warn

  // immediate watcher or watchEffect
  // 四、SSR 特殊处理
  const runsImmediately = (cb && immediate) || (!cb && flush !== 'post')
  let ssrCleanup: (() => void)[] | undefined
  // 判断该 watch 是否应该立即执行。
  if (__SSR__ && isInSSRComponentSetup) {
    if (flush === 'sync') {
      // // 将 watcher 注册到 SSR context 的清理队列
      const ctx = useSSRContext()!
      ssrCleanup = ctx.__watcherHandles || (ctx.__watcherHandles = [])
    } else if (!runsImmediately) {
      // // 不立即执行的 watcher 被忽略（noop）
      const watchStopHandle = () => {}
      watchStopHandle.stop = NOOP
      watchStopHandle.resume = NOOP
      watchStopHandle.pause = NOOP
      return watchStopHandle
    }
  }
  // SSR 渲染中：
  // sync 的 watch 会执行一次，并加入清理队列；
  // 非立即执行的 watch 在 SSR 中会跳过执行，返回空句柄。

  // 五、错误处理绑定
  // watch 回调在执行时会自动包裹错误处理逻辑，确保错误能被 Vue 捕获。
  const instance = currentInstance
  baseWatchOptions.call = (fn, type, args) =>
    callWithAsyncErrorHandling(fn, instance, type, args)

  // scheduler
  // 六、调度机制（flush）
  let isPre = false
  // 调度策略决定 watch 执行时机：
  // flush: 'post'：组件渲染之后再执行（微任务）
  // flush: 'pre'（默认）：渲染前执行，且首次执行立即运行
  // flush: 'sync'：同步执行，立即运行所有变化
  if (flush === 'post') {
    baseWatchOptions.scheduler = job => {
      queuePostRenderEffect(job, instance && instance.suspense)
    }
  } else if (flush !== 'sync') {
    // default: 'pre'
    isPre = true
    baseWatchOptions.scheduler = (job, isFirstRun) => {
      if (isFirstRun) {
        job()
      } else {
        queueJob(job)
      }
    }
  }

  // 七、标记调度任务属性
  // 设置调度器标记，如：
  // ALLOW_RECURSE: 允许 watcher 递归触发自身
  // PRE: pre-flush 阶段的任务
  // id: 和组件实例绑定，方便调度系统管理 watcher
  baseWatchOptions.augmentJob = (job: SchedulerJob) => {
    // important: mark the job as a watcher callback so that scheduler knows
    // it is allowed to self-trigger (#1727)
    if (cb) {
      job.flags! |= SchedulerJobFlags.ALLOW_RECURSE
    }
    if (isPre) {
      job.flags! |= SchedulerJobFlags.PRE
      if (instance) {
        job.id = instance.uid
        ;(job as SchedulerJob).i = instance
      }
    }
  }

  // 八、创建 Watch 实例
  // 调用核心 watch 工具函数 baseWatch（该函数是真正执行响应式依赖追踪的实现）。
  // 返回一个可用来停止监听的句柄。
  const watchHandle = baseWatch(source, cb, baseWatchOptions)

  // 九、SSR 处理（补充）
  // 如果需要清理，在 SSR 上下文中记录句柄；
  // 否则（即立即执行的 watcher），直接执行它。
  if (__SSR__ && isInSSRComponentSetup) {
    if (ssrCleanup) {
      ssrCleanup.push(watchHandle)
    } else if (runsImmediately) {
      watchHandle()
    }
  }

  return watchHandle
}

//  Vue 3 中 this.$watch 的内部实现函数 instanceWatch，它是为兼容 Vue 2 的选项式 API 中 this.$watch(...) 而提供的实现。
// this.$watch
export function instanceWatch(
  // this：Vue 组件的内部实例对象（不是组件的 this，而是 ComponentInternalInstance）。
  // source：要观察的内容，可以是字符串路径或 getter 函数。
  // value：回调函数或选项对象（包含 handler 函数）。
  // options：可选的 watch 配置（immediate、deep 等）。
  // 返回一个 WatchHandle，可以用于取消监听。
  this: ComponentInternalInstance,
  source: string | Function,
  value: WatchCallback | ObjectWatchOptionItem,
  options?: WatchOptions,
): WatchHandle {
  // 步骤 1：获取 publicThis
  // this.proxy 是组件的代理对象，也就是 setup() 和模板中能访问到的 this。
  // 用它来访问用户定义的响应式数据。
  const publicThis = this.proxy as any
  // 步骤 2：构造 getter 函数
  // 如果 source 是字符串（如 "user.name"）：
  // 如果包含点路径，则通过 createPathGetter 生成访问函数。
  // 如果是简单键（如 "count"），直接取 publicThis[count]。
  // 如果 source 是函数，则绑定到组件实例的代理对象上（注意双参数绑定，确保旧值和新值都基于组件 this）。
  const getter = isString(source)
    ? source.includes('.')
      ? createPathGetter(publicThis, source)
      : () => publicThis[source]
    : source.bind(publicThis, publicThis)
  // 步骤 3：解析回调函数
  // Vue 兼容两种写法：
  // 简写：this.$watch('foo', (val) => {})
  // 完整写法：this.$watch('foo', { handler: fn, deep: true })
  let cb
  if (isFunction(value)) {
    cb = value
  } else {
    cb = value.handler as Function
    options = value
  }
  // 步骤 4：设置当前组件实例
  // 设置当前激活的组件实例，确保 watch 执行时 getCurrentInstance() 能获取正确实例。
  // 这样 watch 内部如果有响应式依赖收集、错误处理等，也能找到实例上下文。
  const reset = setCurrentInstance(this)
  // 步骤 5：调用核心 watch 实现
  // doWatch 是 Vue 3 的底层 watch 实现函数；
  // 回调函数通过 bind(publicThis) 保证用户访问 this 时是组件代理。
  const res = doWatch(getter, cb.bind(publicThis), options)
  reset()
  return res
}

// 用于根据字符串路径访问嵌套对象中的值。你可以理解它为实现了一个“动态的属性读取器”。
// ctx：要访问的上下文对象（可能是响应式的，也可能是普通对象）。
// path：以点 . 分隔的属性路径字符串，例如 "user.profile.name"。
export function createPathGetter(ctx: any, path: string) {
  // 把路径字符串拆分为数组，例如 "a.b.c" → ["a", "b", "c"]。
  const segments = path.split('.')
  // 返回一个函数（闭包），调用这个函数时会遍历 ctx，按路径访问嵌套属性，返回最终的值。
  return (): any => {
    // 从 ctx 开始一层一层读取嵌套字段；
    // 如果中间某一层为 null 或 undefined，就提前停止遍历，最终返回 undefined。
    let cur = ctx
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]]
    }
    return cur
  }
}
