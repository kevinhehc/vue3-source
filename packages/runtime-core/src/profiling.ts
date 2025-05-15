/* eslint-disable no-restricted-globals */
import {
  type ComponentInternalInstance,
  formatComponentName,
} from './component'
import { devtoolsPerfEnd, devtoolsPerfStart } from './devtools'

// 性能分析工具（performance instrumentation）的一部分，用于测量组件渲染等生命周期操作的耗时，
// 并在开发工具或浏览器性能面板中提供可视化指标。

// 在开发或开启性能模式（app.config.performance = true）时
// 利用 浏览器原生 Performance API 或 devtools 钩子
// 记录 Vue 组件的渲染、更新等阶段的 起始与结束时间
// 帮助开发者定位性能瓶颈

let supported: boolean
let perf: Performance

export function startMeasure(
  instance: ComponentInternalInstance,
  type: string,
): void {
  // 标记某个组件操作的开始点（如 vue-mount-3）
  // type 可以是 "mount"、"update" 等
  if (instance.appContext.config.performance && isSupported()) {
    perf.mark(`vue-${type}-${instance.uid}`)
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsPerfStart(instance, type, isSupported() ? perf.now() : Date.now())
  }
}

export function endMeasure(
  instance: ComponentInternalInstance,
  type: string,
): void {
  // 标记结束点后，使用 performance.measure() 记录耗时
  // 生成项会出现在浏览器 性能面板（Performance Tab） 中
  // 然后调用 clearMarks() 清理缓存，避免污染或泄露
  if (instance.appContext.config.performance && isSupported()) {
    const startTag = `vue-${type}-${instance.uid}`
    const endTag = startTag + `:end`
    perf.mark(endTag)
    perf.measure(
      `<${formatComponentName(instance, instance.type)}> ${type}`,
      startTag,
      endTag,
    )
    perf.clearMarks(startTag)
    perf.clearMarks(endTag)
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsPerfEnd(instance, type, isSupported() ? perf.now() : Date.now())
  }
}

// 判断当前环境是否支持 window.performance（用于非 Node SSR 场景）
// 使用 懒初始化 + 缓存机制（supported）避免重复判断
function isSupported() {
  if (supported !== undefined) {
    return supported
  }
  if (typeof window !== 'undefined' && window.performance) {
    supported = true
    perf = window.performance
  } else {
    supported = false
  }
  return supported
}
