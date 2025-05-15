/* eslint-disable no-restricted-globals */
import type { App } from './apiCreateApp'
import { Comment, Fragment, Static, Text } from './vnode'
import type { ComponentInternalInstance } from './component'

interface AppRecord {
  id: number
  app: App
  version: string
  types: Record<string, string | Symbol>
}

enum DevtoolsHooks {
  APP_INIT = 'app:init',
  APP_UNMOUNT = 'app:unmount',
  COMPONENT_UPDATED = 'component:updated',
  COMPONENT_ADDED = 'component:added',
  COMPONENT_REMOVED = 'component:removed',
  COMPONENT_EMIT = 'component:emit',
  PERFORMANCE_START = 'perf:start',
  PERFORMANCE_END = 'perf:end',
}

export interface DevtoolsHook {
  enabled?: boolean
  emit: (event: string, ...payload: any[]) => void
  on: (event: string, handler: Function) => void
  once: (event: string, handler: Function) => void
  off: (event: string, handler: Function) => void
  appRecords: AppRecord[]
  /**
   * Added at https://github.com/vuejs/devtools/commit/f2ad51eea789006ab66942e5a27c0f0986a257f9
   * Returns whether the arg was buffered or not
   */
  cleanupBuffer?: (matchArg: unknown) => boolean
}

export let devtools: DevtoolsHook

let buffer: { event: string; args: any[] }[] = []

let devtoolsNotInstalled = false

function emit(event: string, ...args: any[]) {
  if (devtools) {
    devtools.emit(event, ...args)
  } else if (!devtoolsNotInstalled) {
    buffer.push({ event, args })
  }
}

// 设置 devtools 的钩子函数对象（hook），这是浏览器中 Vue Devtools 插件注入到页面的通信接口。
// 赋值 devtools = hook
//
// 如果 devtools 插件已注入：
// 设置 enabled = true
// 执行之前缓存的事件（buffer 中的 emit 调用）
//
// 否则（插件未注入）：
// 在浏览器环境中创建 target.__VUE_DEVTOOLS_HOOK_REPLAY__，用于 后续注入时 replay
// 设置超时清理，3 秒后还没注入，则认为 devtools 未安装，避免内存泄漏
export function setDevtoolsHook(hook: DevtoolsHook, target: any): void {
  devtools = hook
  if (devtools) {
    devtools.enabled = true
    buffer.forEach(({ event, args }) => devtools.emit(event, ...args))
    buffer = []
  } else if (
    // handle late devtools injection - only do this if we are in an actual
    // browser environment to avoid the timer handle stalling test runner exit
    // (#4815)
    typeof window !== 'undefined' &&
    // some envs mock window but not fully
    window.HTMLElement &&
    // also exclude jsdom
    // eslint-disable-next-line no-restricted-syntax
    !window.navigator?.userAgent?.includes('jsdom')
  ) {
    const replay = (target.__VUE_DEVTOOLS_HOOK_REPLAY__ =
      target.__VUE_DEVTOOLS_HOOK_REPLAY__ || [])
    replay.push((newHook: DevtoolsHook) => {
      setDevtoolsHook(newHook, target)
    })
    // clear buffer after 3s - the user probably doesn't have devtools installed
    // at all, and keeping the buffer will cause memory leaks (#4738)
    setTimeout(() => {
      if (!devtools) {
        target.__VUE_DEVTOOLS_HOOK_REPLAY__ = null
        devtoolsNotInstalled = true
        buffer = []
      }
    }, 3000)
  } else {
    // non-browser env, assume not installed
    devtoolsNotInstalled = true
    buffer = []
  }
}

// 二、初始化和销毁应用事件
// 向 devtools 发送 APP_INIT 事件，通知插件 Vue 应用已初始化
// 附带 Fragment, Text, Comment, Static 等 vnode 类型，供 devtools 渲染
export function devtoolsInitApp(app: App, version: string): void {
  emit(DevtoolsHooks.APP_INIT, app, version, {
    Fragment,
    Text,
    Comment,
    Static,
  })
}

// 向 devtools 发送 APP_UNMOUNT，通知应用被卸载
export function devtoolsUnmountApp(app: App): void {
  emit(DevtoolsHooks.APP_UNMOUNT, app)
}

// 三、组件事件钩子（添加、更新、移除）
// 这些钩子用于通知 devtools 组件树的变化。
// 添加/更新：
export const devtoolsComponentAdded: DevtoolsComponentHook =
  /*@__PURE__*/ createDevtoolsComponentHook(DevtoolsHooks.COMPONENT_ADDED)

export const devtoolsComponentUpdated: DevtoolsComponentHook =
  /*@__PURE__*/ createDevtoolsComponentHook(DevtoolsHooks.COMPONENT_UPDATED)

// 移除（带缓存清理）：
// 如果组件未出现在 devtools 缓冲区中（即未被追踪），才发送 COMPONENT_REMOVED。
const _devtoolsComponentRemoved = /*@__PURE__*/ createDevtoolsComponentHook(
  DevtoolsHooks.COMPONENT_REMOVED,
)

// 每次组件挂载、更新、移除，都会向 devtools 发送一个包含组件信息的事件。
export const devtoolsComponentRemoved = (
  component: ComponentInternalInstance,
): void => {
  if (
    devtools &&
    typeof devtools.cleanupBuffer === 'function' &&
    // remove the component if it wasn't buffered
    !devtools.cleanupBuffer(component)
  ) {
    _devtoolsComponentRemoved(component)
  }
}

type DevtoolsComponentHook = (component: ComponentInternalInstance) => void

/*! #__NO_SIDE_EFFECTS__ */
function createDevtoolsComponentHook(
  hook: DevtoolsHooks,
): DevtoolsComponentHook {
  return (component: ComponentInternalInstance) => {
    emit(
      hook,
      component.appContext.app,
      component.uid,
      component.parent ? component.parent.uid : undefined,
      component,
    )
  }
}

// 用于组件生命周期中的性能分析（如渲染耗时）：
export const devtoolsPerfStart: DevtoolsPerformanceHook =
  /*@__PURE__*/ createDevtoolsPerformanceHook(DevtoolsHooks.PERFORMANCE_START)

export const devtoolsPerfEnd: DevtoolsPerformanceHook =
  /*@__PURE__*/ createDevtoolsPerformanceHook(DevtoolsHooks.PERFORMANCE_END)

type DevtoolsPerformanceHook = (
  component: ComponentInternalInstance,
  type: string,
  time: number,
) => void
// 用于标记组件执行某类操作（如 render、setup）的开始和结束时间。
function createDevtoolsPerformanceHook(
  hook: DevtoolsHooks,
): DevtoolsPerformanceHook {
  return (component: ComponentInternalInstance, type: string, time: number) => {
    emit(hook, component.appContext.app, component.uid, component, type, time)
  }
}

// 五、组件事件触发钩子
// 当组件使用 emit 触发自定义事件时，通知 devtools 进行记录或显示。
export function devtoolsComponentEmit(
  component: ComponentInternalInstance,
  event: string,
  params: any[],
): void {
  emit(
    DevtoolsHooks.COMPONENT_EMIT,
    component.appContext.app,
    component,
    event,
    params,
  )
}
