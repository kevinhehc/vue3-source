import { extend, hasChanged } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { type Link, globalVersion } from './dep'
import { activeEffectScope } from './effectScope'
import { warn } from './warning'

export type EffectScheduler = (...args: any[]) => any

// 定义一个调试事件类型 DebuggerEvent，包含一个 effect（副作用函数）和额外的调试信息
export type DebuggerEvent = {
  effect: Subscriber // 当前触发的副作用函数
} & DebuggerEventExtraInfo // 与事件相关的详细调试信息

export type DebuggerEventExtraInfo = {
  target: object // 触发副作用的目标对象（响应式对象）
  type: TrackOpTypes | TriggerOpTypes // 操作类型：追踪（track）或触发（trigger）
  key: any // 被访问或修改的属性键
  newValue?: any // 新值（如果是设置操作）
  oldValue?: any // 旧值（如果是设置或删除操作）
  oldTarget?: Map<any, any> | Set<any> // 删除或清空集合操作时的旧集合副本
}

// 响应式系统调试选项接口
export interface DebuggerOptions {
  // 当依赖被收集（track）时的回调
  onTrack?: (event: DebuggerEvent) => void
  // 当依赖被触发（trigger）时的回调
  onTrigger?: (event: DebuggerEvent) => void
}

// 定义响应式副作用函数（ReactiveEffect）的选项接口
export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler // 调度器函数：用于控制副作用函数的执行时机
  allowRecurse?: boolean // 是否允许在副作用函数中递归调用自身
  onStop?: () => void // 当副作用停止（stop）时的回调
}

// 定义副作用函数的运行器接口，实际是一个可执行函数
export interface ReactiveEffectRunner<T = any> {
  (): T // 可执行函数，运行副作用逻辑
  effect: ReactiveEffect // 与这个运行器关联的 ReactiveEffect 实例
}

// 当前活跃的副作用函数（用于依赖收集时标识）
export let activeSub: Subscriber | undefined

export enum EffectFlags {
  /**
   * ReactiveEffect only
   */

  // 表示这个 effect 是激活状态的，可以被运行。如果不活跃，就不会响应依赖变化或运行。
  ACTIVE = 1 << 0,

  // 用于防止递归调用同一个 effect（避免死循环），或者执行中嵌套不当触发。
  RUNNING = 1 << 1,

  // 表示当前这个 effect 会追踪依赖（即允许 track() 收集依赖）。
  // 有些特殊场景下，例如手动设置后，不希望再收集依赖，可以禁用这个标志。
  TRACKING = 1 << 2,

  // 表示这个 effect 已经被某个 dep 通知要重新运行。
  // 通常在批量调度器（scheduler）中使用，避免同一个 effect 被重复添加。
  NOTIFIED = 1 << 3,

  // 通常用于 computed，表示当前的缓存值已失效，需要重新执行 getter。
  // 每次依赖变更时设置 dirty 为 true，下一次访问就会重新计算。
  DIRTY = 1 << 4,

  // 允许这个 effect 在运行中递归触发自己（例如组件更新时的递归更新）。
  // 默认禁止递归，只有加了这个标志才允许。
  ALLOW_RECURSE = 1 << 5,

  // 表示该 effect 被暂停（临时不运行），例如在某些特殊流程或异步调度中暂时挂起。
  PAUSED = 1 << 6,
}

/**
 * Subscriber is a type that tracks (or subscribes to) a list of deps.
 */
/**
 * Subscriber 接口表示一个订阅者（副作用函数），会被依赖项追踪。
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * Head of the doubly linked list representing the deps
   * @internal
   * deps 是一个双向链表的头部，表示当前副作用依赖的所有 dep。
   */
  deps?: Link
  /**
   * Tail of the same list
   * @internal
   * depsTail 是双向链表的尾部。
   */
  depsTail?: Link
  /**
   * @internal
   * flags 用于标记副作用的状态（如是否活跃、是否运行中等）。
   */
  flags: EffectFlags
  /**
   * @internal
   * 链表中的下一个订阅者。
   */
  next?: Subscriber
  /**
   * returning `true` indicates it's a computed that needs to call notify
   * on its dep too
   * @internal
   * notify 方法用于通知该副作用应被重新执行。
   */
  notify(): true | void
}

// 存储被暂停但等待执行的副作用函数集合
const pausedQueueEffects = new WeakSet<ReactiveEffect>()

/**
 * ReactiveEffect 类实现了副作用函数的完整生命周期。
 */
export class ReactiveEffect<T = any>
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * @internal
   * 当前 effect 依赖的所有 dep 的链表头
   */
  deps?: Link = undefined
  /**
   * @internal
   * 链表尾
   */
  depsTail?: Link = undefined
  /**
   * @internal
   * 初始为活跃并可追踪
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * @internal
   * 用于链表中的下一个副作用
   */
  next?: Subscriber = undefined
  /**
   * @internal
   * 停止副作用时执行的清理函数
   */
  cleanup?: () => void = undefined

  // 自定义调度器
  scheduler?: EffectScheduler = undefined
  // 停止时的回调
  onStop?: () => void
  // track 回调
  onTrack?: (event: DebuggerEvent) => void
  // trigger 回调
  onTrigger?: (event: DebuggerEvent) => void

  // 构造函数接收副作用函数本体
  constructor(public fn: () => T) {
    if (activeEffectScope && activeEffectScope.active) {
      // 注册到当前活跃的 effect 作用域中
      activeEffectScope.effects.push(this)
    }
  }

  // 设置暂停标志
  pause(): void {
    this.flags |= EffectFlags.PAUSED
  }

  resume(): void {
    if (this.flags & EffectFlags.PAUSED) {
      // 取消暂停
      this.flags &= ~EffectFlags.PAUSED
      if (pausedQueueEffects.has(this)) {
        // 移出等待队列
        pausedQueueEffects.delete(this)
        // 触发执行
        this.trigger()
      }
    }
  }

  /**
   * @internal
   */
  notify(): void {
    if (
      // 如果正在运行且不允许递归调用则忽略通知
      this.flags & EffectFlags.RUNNING &&
      !(this.flags & EffectFlags.ALLOW_RECURSE)
    ) {
      return
    }
    // 如果还未被标记为已通知，则添加到批处理队列
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      batch(this)
    }
  }

  run(): T {
    // TODO cleanupEffect

    // 如果不活跃则直接执行原函数
    if (!(this.flags & EffectFlags.ACTIVE)) {
      // stopped during cleanup
      return this.fn()
    }

    // 设置运行中标志
    this.flags |= EffectFlags.RUNNING
    // 清理旧依赖
    cleanupEffect(this)
    // 初始化依赖链表结构
    prepareDeps(this)
    const prevEffect = activeSub
    const prevShouldTrack = shouldTrack
    // 设置当前活跃副作用
    activeSub = this
    // 启用依赖追踪
    shouldTrack = true

    try {
      // 执行副作用逻辑
      return this.fn()
    } finally {
      if (__DEV__ && activeSub !== this) {
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      // 清除无效依赖
      cleanupDeps(this)
      // 恢复前一个 effect
      activeSub = prevEffect
      // 恢复追踪状态
      shouldTrack = prevShouldTrack
      // 清除运行标志
      this.flags &= ~EffectFlags.RUNNING
    }
  }

  stop(): void {
    if (this.flags & EffectFlags.ACTIVE) {
      // 遍历依赖链表，移除自身
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }
      this.deps = this.depsTail = undefined
      // 清理额外资源
      cleanupEffect(this)
      // 调用停止回调
      this.onStop && this.onStop()
      // 设置为非活跃
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  trigger(): void {
    if (this.flags & EffectFlags.PAUSED) {
      // 加入等待队列
      pausedQueueEffects.add(this)
    } else if (this.scheduler) {
      // 使用自定义调度器执行
      this.scheduler()
    } else {
      // 默认按需执行
      this.runIfDirty()
    }
  }

  /**
   * @internal
   */
  runIfDirty(): void {
    // 脏时重新执行副作用
    if (isDirty(this)) {
      this.run()
    }
  }

  get dirty(): boolean {
    // 返回当前是否为脏状态
    return isDirty(this)
  }
}

/**
 * For debugging
 */
// function printDeps(sub: Subscriber) {
//   let d = sub.deps
//   let ds = []
//   while (d) {
//     ds.push(d)
//     d = d.nextDep
//   }
//   return ds.map(d => ({
//     id: d.id,
//     prev: d.prevDep?.id,
//     next: d.nextDep?.id,
//   }))
// }

// 当前的批处理嵌套深度（例如嵌套的 trigger 过程中可能发生嵌套 batch）
let batchDepth = 0
// 普通副作用（非 computed）的批处理队列的头部
let batchedSub: Subscriber | undefined
// 计算属性（computed effect）的批处理队列的头部
let batchedComputed: Subscriber | undefined

/**
 * 将副作用（sub）加入批处理队列，等待统一处理（去重+排序+运行）
 * @param sub - 要加入批处理的副作用对象
 * @param isComputed - 是否为计算属性（computed effect）
 */
export function batch(sub: Subscriber, isComputed = false): void {
  // 将副作用标记为已通知，防止重复加入队列
  sub.flags |= EffectFlags.NOTIFIED
  if (isComputed) {
    // 如果是计算属性，将其插入到 batchedComputed 链表头部
    sub.next = batchedComputed
    batchedComputed = sub
    return
  }
  // 否则将其插入到普通副作用链表 batchedSub 的头部
  sub.next = batchedSub
  batchedSub = sub
}

/**
 * @internal
 * 开始批量
 */
export function startBatch(): void {
  // 深度++
  batchDepth++
}

/**
 * Run batched effects when all batches have ended
 * @internal
 *
 * 是一个内部函数，用于“结束响应式更新的批量阶段”，
 * 统一触发 effect() 或 computed 的更新回调，而不是每改一个值就立即更新。
 */
export function endBatch(): void {
  // batchDepth 是嵌套计数器（startBatch() 会 ++，endBatch() 会 --）
  // 只有当 batchDepth 归零时，才真正触发 effect
  if (--batchDepth > 0) {
    return
  }

  // 如果有缓存的计算属性（computed），把它们拿出来执行：
  // batchedComputed 是一个链表头节点
  if (batchedComputed) {
    let e: Subscriber | undefined = batchedComputed
    // 把链表清空，准备处理里面的计算属性
    batchedComputed = undefined
    // 这里是清理每个 computed 依赖的链表
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      // 表示取消“待执行”标记
      e.flags &= ~EffectFlags.NOTIFIED
      // 清空链表，避免重复执行
      e = next
    }
  }

  let error: unknown
  // 如果有注册的副作用函数（effect），也一样准备清理并执行。
  while (batchedSub) {
    let e: Subscriber | undefined = batchedSub
    batchedSub = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      // 一样地，对每个副作用函数进行清理标记。
      e.flags &= ~EffectFlags.NOTIFIED
      // 如果这是一个有效的副作用函数（有 ACTIVE 标记）
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          // ACTIVE flag is effect-only
          // 就执行它的 trigger() 方法（实际执行副作用函数）
          ;(e as ReactiveEffect).trigger()
        } catch (err) {
          // 捕捉可能的异常，最后统一抛出
          // 如果在执行某个 effect 时抛出了错误，这里统一抛出第一个遇到的错误。
          if (!error) error = err
        }
      }
      e = next
    }
  }

  if (error) throw error
}

function prepareDeps(sub: Subscriber) {
  // Prepare deps for tracking, starting from the head
  // 遍历 sub 当前记录的所有依赖链接（双向链表形式），这些是上一次依赖收集过程中记录下的 deps。
  for (let link = sub.deps; link; link = link.nextDep) {
    // set all previous deps' (if any) version to -1 so that we can track
    // which ones are unused after the run

    // 将依赖项的 version 标记为 -1，
    // 表示“默认假设这个依赖在本轮中不会被再次使用”，
    // 如果等下被使用了，会把 version 设置为最新值。
    link.version = -1
    // store previous active sub if link was being used in another context
    // 当前这个依赖 dep 可能被多个 effect 使用过。这里暂存之前的 activeLink，以便之后恢复。
    link.prevActiveLink = link.dep.activeLink
    //设置当前 dep 的活跃链接为当前这个 link。这用于在依赖收集（track()）时，把新依赖挂在当前 activeLink 后面，形成链表。
    link.dep.activeLink = link
  }
}

function cleanupDeps(sub: Subscriber) {
  // Cleanup unsued deps
  // 将要重新计算这个 sub 的 deps 链表头尾指针。
  let head
  let tail = sub.depsTail
  let link = tail
  // 从 tail 开始向前遍历整个双向链表（prevDep 指针）。
  while (link) {
    const prev = link.prevDep
    if (link.version === -1) {
      if (link === tail) tail = prev
      // 这个 link 没有在本轮被重新访问（即本轮没有调用 track() 收集到它），说明它“已经不再需要”，要清理。
      // unused - remove it from the dep's subscribing effect list
      // 从这个 dep 的订阅列表中移除这个 sub（即不再通知这个 effect）。
      removeSub(link)
      // also remove it from this effect's dep list
      // 从这个 sub 的 deps 链表中移除这个 link。
      removeDep(link)
    } else {
      // The new head is the last node seen which wasn't removed
      // from the doubly-linked list
      // 如果是活跃依赖，更新链表的头部引用。
      head = link
    }

    // restore previous active link if any
    // 恢复之前保留的 activeLink，即清理掉当前的活跃上下文。
    link.dep.activeLink = link.prevActiveLink
    // 避免内存泄漏，清除临时缓存。
    link.prevActiveLink = undefined
    link = prev
  }
  // set the new head & tail
  // 最终更新这个 effect 的 deps 链表头尾指针。
  sub.deps = head
  sub.depsTail = tail
}

function isDirty(sub: Subscriber): boolean {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (
      link.dep.version !== link.version ||
      (link.dep.computed &&
        (refreshComputed(link.dep.computed) ||
          link.dep.version !== link.version))
    ) {
      return true
    }
  }
  // @ts-expect-error only for backwards compatibility where libs manually set
  // this flag - e.g. Pinia's testing module
  if (sub._dirty) {
    return true
  }
  return false
}

/**
 * Returning false indicates the refresh failed
 * @internal
 * 如何失败就返回false
 * 刷新一个计算属性的值，如果依赖发生了变化则重新计算
 */
export function refreshComputed(computed: ComputedRefImpl): undefined {
  // 跳过不需要更新的情况
  if (
    // 如果当前正在「追踪依赖」（TRACKING），但标志中没有被标记为「脏」（DIRTY），
    // 说明计算属性是“干净的”，不需要重新计算，直接返回。
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    return
  }

  // 将 DIRTY 标志位移除，表示现在我们要更新值了，它已经不是脏的。
  computed.flags &= ~EffectFlags.DIRTY

  // Global version fast path when no reactive changes has happened since
  // last refresh.
  // 如果计算属性上一次刷新的时候用的全局版本号和现在的一样，说明其依赖没有发生任何变化，直接跳过。
  if (computed.globalVersion === globalVersion) {
    return
  }
  // 更新版本号
  computed.globalVersion = globalVersion

  // dep 是依赖集合（依赖哪些 reactive 数据）。
  const dep = computed.dep
  // 设置 RUNNING 标志表示正在执行这个 computed
  computed.flags |= EffectFlags.RUNNING
  // In SSR there will be no render effect, so the computed has no subscriber
  // and therefore tracks no deps, thus we cannot rely on the dirty check.
  // Instead, computed always re-evaluate and relies on the globalVersion
  // fast path above for caching.
  if (
    // 有依赖（dep.version > 0）
    dep.version > 0 &&
    // 不是 SSR 环境
    !computed.isSSR &&
    // 存在已记录的依赖
    computed.deps &&
    // 并且依赖没有变脏
    !isDirty(computed)
  ) {
    // 则不需要重新计算，直接退出
    computed.flags &= ~EffectFlags.RUNNING
    return
  }

  // 保存之前的订阅者和依赖收集状态【A】。
  const prevSub = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = computed
  shouldTrack = true

  try {
    // 用于清空旧的依赖。
    prepareDeps(computed)
    // 执行 computed.fn，传入当前值（部分支持懒更新的写法）
    const value = computed.fn(computed._value)
    // 如果是第一次计算，或值有变更，更新 _value 并递增依赖版本号。
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed._value = value
      dep.version++
    }
  } catch (err) {
    // 依然要更新版本号
    dep.version++
    throw err
  } finally {
    // 还原之前的订阅者和依赖收集状态【A】。
    activeSub = prevSub
    shouldTrack = prevShouldTrack
    cleanupDeps(computed)
    // 清除 RUNNING 状态
    computed.flags &= ~EffectFlags.RUNNING
  }
}

function removeSub(link: Link, soft = false) {
  const { dep, prevSub, nextSub } = link
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined
  }
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined
  }
  if (__DEV__ && dep.subsHead === link) {
    // was previous head, point new head to next
    dep.subsHead = nextSub
  }

  if (dep.subs === link) {
    // was previous tail, point new tail to prev
    dep.subs = prevSub

    if (!prevSub && dep.computed) {
      // if computed, unsubscribe it from all its deps so this computed and its
      // value can be GCed
      dep.computed.flags &= ~EffectFlags.TRACKING
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        // here we are only "soft" unsubscribing because the computed still keeps
        // referencing the deps and the dep should not decrease its sub count
        removeSub(l, true)
      }
    }
  }

  if (!soft && !--dep.sc && dep.map) {
    // #11979
    // property dep no longer has effect subscribers, delete it
    // this mostly is for the case where an object is kept in memory but only a
    // subset of its properties is tracked at one time
    dep.map.delete(dep.key)
  }
}

// 双向链表的处理
function removeDep(link: Link) {
  const { prevDep, nextDep } = link
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined
  }
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  fn = (fn as ReactiveEffectRunner).effect.fn

  const e = new ReactiveEffect(fn)
  if (options) {
    extend(e, options)
  }
  try {
    e.run()
  } catch (err) {
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

/**
 * @internal
 */
export let shouldTrack = true
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking(): void {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanup = fn
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(e: ReactiveEffect) {
  const { cleanup } = e
  e.cleanup = undefined
  if (cleanup) {
    // run cleanup without active effect
    const prevSub = activeSub
    activeSub = undefined
    try {
      cleanup()
    } finally {
      activeSub = prevSub
    }
  }
}
