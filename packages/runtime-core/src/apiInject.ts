import { isFunction } from '@vue/shared'
import { currentInstance } from './component'
import { currentRenderingInstance } from './componentRenderContext'
import { currentApp } from './apiCreateApp'
import { warn } from './warning'

interface InjectionConstraint<T> {}

export type InjectionKey<T> = symbol & InjectionConstraint<T>

export function provide<T, K = InjectionKey<T> | string | number>(
  key: K,
  value: K extends InjectionKey<infer V> ? V : T,
): void {
  if (!currentInstance) {
    if (__DEV__) {
      warn(`provide() can only be used inside setup().`)
    }
  } else {
    let provides = currentInstance.provides
    // by default an instance inherits its parent's provides object
    // but when it needs to provide values of its own, it creates its
    // own provides object using parent provides object as prototype.
    // this way in `inject` we can simply look up injections from direct
    // parent and let the prototype chain do the work.
    const parentProvides =
      currentInstance.parent && currentInstance.parent.provides
    if (parentProvides === provides) {
      provides = currentInstance.provides = Object.create(parentProvides)
    }
    // TS doesn't allow symbol as index type
    provides[key as string] = value
  }
}

export function inject<T>(key: InjectionKey<T> | string): T | undefined
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T,
  treatDefaultAsFactory?: false,
): T
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T | (() => T),
  treatDefaultAsFactory: true,
): T
// 核心逻辑是实现 依赖注入的消费端，配合 provide() 使用。
export function inject(
  // key：注入的依赖标识（字符串或 Symbol）。
  // defaultValue：找不到对应依赖时返回的默认值。
  // treatDefaultAsFactory：是否将 defaultValue 当作函数工厂来调用。
  key: InjectionKey<any> | string,
  defaultValue?: unknown,
  treatDefaultAsFactory = false,
) {
  // fallback to `currentRenderingInstance` so that this can be called in
  // a functional component
  // 获取当前组件实例（可能在 setup() 或函数式组件中）。
  // 若两者都没有，表示调用时机不合法。
  const instance = currentInstance || currentRenderingInstance

  // also support looking up from app-level provides w/ `app.runWithContext()`
  // 情况一：在组件或 app 上下文中
  if (instance || currentApp) {
    // #2400
    // to support `app.use` plugins,
    // fallback to appContext's `provides` if the instance is at root
    // #11488, in a nested createApp, prioritize using the provides from currentApp
    // 开始获取 provides 数据源。
    // 处理优先级如下：
    // 如果 currentApp 存在：优先使用 app-level 的 provides（支持 app.runWithContext()、全局插件注入等）。
    // 如果在组件内：
    // 是根组件：使用 vnode.appContext.provides
    // 否则：从 parent.provides 继承查找（标准组件提供注入方式）
    const provides = currentApp
      ? currentApp._context.provides
      : instance
        ? instance.parent == null
          ? instance.vnode.appContext && instance.vnode.appContext.provides
          : instance.parent.provides
        : undefined

    // 找到依赖时返回 注意：TS 不允许使用 symbol 作为索引类型，这里用了类型断言。
    if (provides && (key as string | symbol) in provides) {
      // TS doesn't allow symbol as index type
      return provides[key as string]
    } else if (arguments.length > 1) {
      // 找不到依赖时：使用默认值（如提供）
      // 如果显式传入了 defaultValue，则使用它；
      // 若 treatDefaultAsFactory 为 true 且 defaultValue 是函数，则调用它并返回其结果。
      return treatDefaultAsFactory && isFunction(defaultValue)
        ? defaultValue.call(instance && instance.proxy)
        : defaultValue
    } else if (__DEV__) {
      // 找不到且没默认值：开发模式下发出警告
      warn(`injection "${String(key)}" not found.`)
    }
  } else if (__DEV__) {
    // 情况二：非法调用（setup 外调用）
    // 提示错误调用时机，如在模块作用域等 setup 外部调用。
    warn(`inject() can only be used inside setup() or functional components.`)
  }
}

/**
 * Returns true if `inject()` can be used without warning about being called in the wrong place (e.g. outside of
 * setup()). This is used by libraries that want to use `inject()` internally without triggering a warning to the end
 * user. One example is `useRoute()` in `vue-router`.
 */
// 主要用于判断当前是否处于允许使用 inject() 的上下文中。
export function hasInjectionContext(): boolean {
  // 返回值：
  // 如果当前处于组件的 setup()、渲染函数或某些框架封装环境中，返回 true。
  // 否则（比如在模块顶层调用 inject()），返回 false。
  return !!(currentInstance || currentRenderingInstance || currentApp)
}
