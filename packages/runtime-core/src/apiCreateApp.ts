import {
  type Component,
  type ComponentInternalInstance,
  type ConcreteComponent,
  type Data,
  getComponentPublicInstance,
  validateComponentName,
} from './component'
import type {
  ComponentOptions,
  MergedComponentOptions,
  RuntimeCompilerOptions,
} from './componentOptions'
import type {
  ComponentCustomProperties,
  ComponentPublicInstance,
} from './componentPublicInstance'
import { type Directive, validateDirectiveName } from './directives'
import type { ElementNamespace, RootRenderFunction } from './renderer'
import type { InjectionKey } from './apiInject'
import { warn } from './warning'
import { type VNode, cloneVNode, createVNode } from './vnode'
import type { RootHydrateFunction } from './hydration'
import { devtoolsInitApp, devtoolsUnmountApp } from './devtools'
import { NO, extend, isFunction, isObject } from '@vue/shared'
import { version } from '.'
import { installAppCompatProperties } from './compat/global'
import type { NormalizedPropsOptions } from './componentProps'
import type { ObjectEmitsOptions } from './componentEmits'
import { ErrorCodes, callWithAsyncErrorHandling } from './errorHandling'
import type { DefineComponent } from './apiDefineComponent'

export interface App<HostElement = any> {
  // 版本信息
  version: string
  // 全局的app配置
  config: AppConfig
  // 插件use方法
  use<Options extends unknown[]>(
    plugin: Plugin<Options>,
    ...options: NoInfer<Options>
  ): this
  use<Options>(plugin: Plugin<Options>, options: NoInfer<Options>): this
  // 混入方法
  mixin(mixin: ComponentOptions): this
  // 组件相关函数重载
  // 获取
  component(name: string): Component | undefined
  // 注册
  component<T extends Component | DefineComponent>(
    name: string,
    component: T,
  ): this
  // 指令相关函数重载
  // 获取
  directive<
    HostElement = any,
    Value = any,
    Modifiers extends string = string,
    Arg extends string = string,
  >(
    name: string,
  ): Directive<HostElement, Value, Modifiers, Arg> | undefined
  // 注册
  directive<
    HostElement = any,
    Value = any,
    Modifiers extends string = string,
    Arg extends string = string,
  >(
    name: string,
    directive: Directive<HostElement, Value, Modifiers, Arg>,
  ): this
  // 挂载方法
  mount(
    rootContainer: HostElement | string,
    /**
     * @internal
     */
    isHydrate?: boolean,
    /**
     * @internal
     */
    namespace?: boolean | ElementNamespace,
    /**
     * @internal
     */
    vnode?: VNode,
  ): ComponentPublicInstance
  // 卸载方法
  unmount(): void
  onUnmount(cb: () => void): void
  // 注入方法
  provide<T, K = InjectionKey<T> | string | number>(
    key: K,
    value: K extends InjectionKey<infer V> ? V : T,
  ): this

  /**
   * Runs a function with the app as active instance. This allows using of `inject()` within the function to get access
   * to variables provided via `app.provide()`.
   *
   * @param fn - function to run with the app as active instance
   */
  runWithContext<T>(fn: () => T): T

  // internal, but we need to expose these for the server-renderer and devtools
  _uid: number
  // 根组件
  _component: ConcreteComponent
  // 根组件props
  _props: Data | null
  // 挂载容器
  _container: HostElement | null
  // app上下文
  _context: AppContext
  _instance: ComponentInternalInstance | null

  /**
   * @internal custom element vnode
   */
  _ceVNode?: VNode

  /**
   * v2 compat only
   */
  filter?(name: string): Function | undefined
  filter?(name: string, filter: Function): this

  /**
   * @internal v3 compat only
   */
  _createRoot?(options: ComponentOptions): ComponentPublicInstance
}

export type OptionMergeFunction = (to: unknown, from: unknown) => any

// 描述应用实例的全局配置项
export interface AppConfig {
  // @private
  // 判断标签是否是平台内建标签（如 div、span）。
  // 多用于编译器阶段（如判断自定义元素）。
  readonly isNativeTag: (tag: string) => boolean

  // 是否启用性能统计标志。
  // 在 DevTools 中用于显示组件性能（仅开发模式启用）
  performance: boolean
  // 组件选项合并策略，如生命周期钩子的合并方式。
  optionMergeStrategies: Record<string, OptionMergeFunction>
  // 注册到 app.config.globalProperties 的内容会变成所有组件实例的公共属性（即 this.xxx）。
  globalProperties: ComponentCustomProperties & Record<string, any>
  // 用于捕获全局未处理的错误和警告，防止程序崩溃。
  errorHandler?: (
    err: unknown,
    instance: ComponentPublicInstance | null,
    info: string,
  ) => void
  warnHandler?: (
    msg: string,
    instance: ComponentPublicInstance | null,
    trace: string,
  ) => void

  /**
   * Options to pass to `@vue/compiler-dom`.
   * Only supported in runtime compiler build.
   */
  // 编译器配置（仅在 runtime compiler 版本中有效）。
  compilerOptions: RuntimeCompilerOptions

  /**
   * @deprecated use config.compilerOptions.isCustomElement
   */
  // 已废弃，用 compilerOptions.isCustomElement 代替。
  isCustomElement?: (tag: string) => boolean

  /**
   * TODO document for 3.5
   * Enable warnings for computed getters that recursively trigger itself.
   */
  // Vue 3.5 新增，用于检测递归触发的 computed 并发出警告。
  warnRecursiveComputed?: boolean

  /**
   * Whether to throw unhandled errors in production.
   * Default is `false` to avoid crashing on any error (and only logs it)
   * But in some cases, e.g. SSR, throwing might be more desirable.
   */
  // 是否在生产环境中抛出未捕获错误（默认只是记录）。
  // 在 SSR 中可能更希望强制抛出。
  throwUnhandledErrorInProduction?: boolean

  /**
   * Prefix for all useId() calls within this app
   */
  // 设置 useId() 返回值的前缀，防止 SSR 重复 ID。
  idPrefix?: string
}

// 描述 Vue 应用实例的上下文信息，被每个组件实例共享引用。
export interface AppContext {
  // 当前上下文关联的 Vue 应用实例。
  app: App // for devtools
  // 上文提到的应用配置。
  config: AppConfig
  // 全局注册的 mixins，会影响所有组件。
  mixins: ComponentOptions[]

  components: Record<string, Component>
  // 应用级别注册的组件和指令。
  directives: Record<string, Directive>
  // 应用级别的 provide/inject 数据。
  provides: Record<string | symbol, any>

  /**
   * Cache for merged/normalized component options
   * Each app instance has its own cache because app-level global mixins and
   * optionMergeStrategies can affect merge behavior.
   * @internal
   */
  // 缓存合并后的组件选项，用于性能优化。
  optionsCache: WeakMap<ComponentOptions, MergedComponentOptions>
  /**
   * Cache for normalized props options
   * @internal
   */
  // 缓存组件的 props 规范化结果。
  propsCache: WeakMap<ConcreteComponent, NormalizedPropsOptions>
  /**
   * Cache for normalized emits options
   * @internal
   */
  // 缓存组件的 emits 规范化结果。
  emitsCache: WeakMap<ConcreteComponent, ObjectEmitsOptions | null>
  /**
   * HMR only
   * @internal
   */
  // 热更新（HMR）时调用，开发专用。
  reload?: () => void
  /**
   * v2 compat only
   * @internal
   */
  // Vue 2 兼容用（v2 filters 支持）。
  filters?: Record<string, Function>
}

type PluginInstallFunction<Options = any[]> = Options extends unknown[]
  ? (app: App, ...options: Options) => any
  : (app: App, options: Options) => any

export type ObjectPlugin<Options = any[]> = {
  install: PluginInstallFunction<Options>
}
export type FunctionPlugin<Options = any[]> = PluginInstallFunction<Options> &
  Partial<ObjectPlugin<Options>>

export type Plugin<
  Options = any[],
  // TODO: in next major Options extends unknown[] and remove P
  P extends unknown[] = Options extends unknown[] ? Options : [Options],
> = FunctionPlugin<P> | ObjectPlugin<P>

export function createAppContext(): AppContext {
  return {
    // app实例
    app: null as any,
    // 全局配置
    config: {
      // 是否为原生标签
      isNativeTag: NO,
      performance: false,
      // 全局属性
      globalProperties: {},
      // 配置合并策略
      optionMergeStrategies: {},
      // 错误处理函数
      errorHandler: undefined,
      // 警告处理函数
      warnHandler: undefined,
      compilerOptions: {},
    },
    // 全局混入
    mixins: [],
    // 全局组件
    components: {},
    // 全局指令
    directives: {},
    // 全局注入
    provides: Object.create(null),
    optionsCache: new WeakMap(),
    propsCache: new WeakMap(),
    emitsCache: new WeakMap(),
  }
}

export type CreateAppFunction<HostElement> = (
  rootComponent: Component,
  rootProps?: Data | null,
) => App<HostElement>

let uid = 0

export function createAppAPI<HostElement>(
  render: RootRenderFunction<HostElement>,
  hydrate?: RootHydrateFunction,
): CreateAppFunction<HostElement> {
  // 再次返回一个函数，是为了通过柯里化的技巧将render函数以及hydrate参数持有，避免了用户在应用需要传入render函数给createApp
  return function createApp(rootComponent, rootProps = null) {
    if (!isFunction(rootComponent)) {
      rootComponent = extend({}, rootComponent)
    }

    if (rootProps != null && !isObject(rootProps)) {
      __DEV__ && warn(`root props passed to app.mount() must be an object.`)
      rootProps = null
    }

    // 创建app上下文
    const context = createAppContext()
    // 创建插件安装set
    const installedPlugins = new WeakSet()
    const pluginCleanupFns: Array<() => any> = []

    // 是否挂载
    let isMounted = false

    // 通过对象字面量俩创建app实例
    // 实现了上文app实例的接口
    const app: App = (context.app = {
      _uid: uid++,
      _component: rootComponent as ConcreteComponent,
      _props: rootProps,
      _container: null,
      _context: context,
      _instance: null,

      version,

      get config() {
        return context.config
      },

      set config(v) {
        if (__DEV__) {
          warn(
            `app.config cannot be replaced. Modify individual options instead.`,
          )
        }
      },

      use(plugin: Plugin, ...options: any[]) {
        if (installedPlugins.has(plugin)) {
          __DEV__ && warn(`Plugin has already been applied to target app.`)
        } else if (plugin && isFunction(plugin.install)) {
          installedPlugins.add(plugin)
          plugin.install(app, ...options)
        } else if (isFunction(plugin)) {
          installedPlugins.add(plugin)
          plugin(app, ...options)
        } else if (__DEV__) {
          warn(
            `A plugin must either be a function or an object with an "install" ` +
              `function.`,
          )
        }
        return app
      },

      mixin(mixin: ComponentOptions) {
        if (__FEATURE_OPTIONS_API__) {
          if (!context.mixins.includes(mixin)) {
            context.mixins.push(mixin)
          } else if (__DEV__) {
            warn(
              'Mixin has already been applied to target app' +
                (mixin.name ? `: ${mixin.name}` : ''),
            )
          }
        } else if (__DEV__) {
          warn('Mixins are only available in builds supporting Options API')
        }
        return app
      },

      component(name: string, component?: Component): any {
        if (__DEV__) {
          // 开发环境 校验指令名称合法性
          validateComponentName(name, context.config)
        }
        // 不传组件，视为获取组件
        if (!component) {
          return context.components[name]
        }
        // 判断是否重复注册
        if (__DEV__ && context.components[name]) {
          warn(`Component "${name}" has already been registered in target app.`)
        }
        // 注册组件
        context.components[name] = component
        return app
      },

      directive(name: string, directive?: Directive) {
        if (__DEV__) {
          // 开发环境 校验指令名称合法性
          validateDirectiveName(name)
        }
        // 不传指令，视为获取指令
        if (!directive) {
          return context.directives[name] as any
        }
        // 判断是否重复注册
        if (__DEV__ && context.directives[name]) {
          warn(`Directive "${name}" has already been registered in target app.`)
        }
        // 注册指令
        context.directives[name] = directive
        return app
      },

      mount(
        rootContainer: HostElement,
        isHydrate?: boolean,
        namespace?: boolean | ElementNamespace,
      ): any {
        if (!isMounted) {
          // #5571
          if (__DEV__ && (rootContainer as any).__vue_app__) {
            warn(
              `There is already an app instance mounted on the host container.\n` +
                ` If you want to mount another app on the same host container,` +
                ` you need to unmount the previous app by calling \`app.unmount()\` first.`,
            )
          }
          // 创建根组件Vnode
          const vnode = app._ceVNode || createVNode(rootComponent, rootProps)
          // store app context on the root VNode.
          // this will be set on the root instance on initial mount.
          // 根组件Vnode 拥有 根app上下文
          vnode.appContext = context

          if (namespace === true) {
            namespace = 'svg'
          } else if (namespace === false) {
            namespace = undefined
          }

          // HMR root reload
          if (__DEV__) {
            context.reload = () => {
              // casting to ElementNamespace because TS doesn't guarantee type narrowing
              // over function boundaries
              // 从根组件Vnode开始渲染
              render(
                cloneVNode(vnode),
                rootContainer,
                namespace as ElementNamespace,
              )
            }
          }

          if (isHydrate && hydrate) {
            hydrate(vnode as VNode<Node, Element>, rootContainer as any)
          } else {
            render(vnode, rootContainer, namespace)
          }
          // 标识已挂载
          isMounted = true
          // 绑定根实例和根容器
          app._container = rootContainer
          // for devtools and telemetry
          ;(rootContainer as any).__vue_app__ = app

          if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
            app._instance = vnode.component
            devtoolsInitApp(app, version)
          }

          // 返回根组件的代理
          return getComponentPublicInstance(vnode.component!)
        } else if (__DEV__) {
          warn(
            `App has already been mounted.\n` +
              `If you want to remount the same app, move your app creation logic ` +
              `into a factory function and create fresh app instances for each ` +
              `mount - e.g. \`const createMyApp = () => createApp(App)\``,
          )
        }
      },

      onUnmount(cleanupFn: () => void) {
        if (__DEV__ && typeof cleanupFn !== 'function') {
          warn(
            `Expected function as first argument to app.onUnmount(), ` +
              `but got ${typeof cleanupFn}`,
          )
        }
        pluginCleanupFns.push(cleanupFn)
      },

      unmount() {
        if (isMounted) {
          callWithAsyncErrorHandling(
            pluginCleanupFns,
            app._instance,
            ErrorCodes.APP_UNMOUNT_CLEANUP,
          )
          render(null, app._container)
          if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
            app._instance = null
            devtoolsUnmountApp(app)
          }
          delete app._container.__vue_app__
        } else if (__DEV__) {
          warn(`Cannot unmount an app that is not mounted.`)
        }
      },

      provide(key, value) {
        if (__DEV__ && (key as string | symbol) in context.provides) {
          warn(
            `App already provides property with key "${String(key)}". ` +
              `It will be overwritten with the new value.`,
          )
        }

        context.provides[key as string | symbol] = value

        return app
      },

      runWithContext(fn) {
        const lastApp = currentApp
        currentApp = app
        try {
          return fn()
        } finally {
          currentApp = lastApp
        }
      },
    })

    if (__COMPAT__) {
      installAppCompatProperties(app, context, render)
    }

    return app
  }
}

/**
 * @internal Used to identify the current app when using `inject()` within
 * `app.runWithContext()`.
 */
export let currentApp: App<unknown> | null = null
