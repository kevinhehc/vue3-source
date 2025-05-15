import {
  type Component,
  type ComponentInternalInstance,
  type ComponentOptions,
  type ConcreteComponent,
  currentInstance,
  isInSSRComponentSetup,
} from './component'
import { isFunction, isObject } from '@vue/shared'
import type { ComponentPublicInstance } from './componentPublicInstance'
import { type VNode, createVNode } from './vnode'
import { defineComponent } from './apiDefineComponent'
import { warn } from './warning'
import { ref } from '@vue/reactivity'
import { ErrorCodes, handleError } from './errorHandling'
import { isKeepAlive } from './components/KeepAlive'
import { markAsyncBoundary } from './helpers/useId'
import { type HydrationStrategy, forEachElement } from './hydrationStrategies'

// 异步组件加载完成后可能返回的类型。它支持两种形式：
// 1、直接返回组件（T）：这是常见的情况。
// 2、ES 模块格式：即 { default: T }，因为通过 import() 动态导入的模块是一个包含 default 属性的对象。
export type AsyncComponentResolveResult<T = Component> = T | { default: T } // es modules

// 这是定义一个异步组件加载器的类型，它是一个返回 Promise 的函数，最终解析结果是上面提到的 AsyncComponentResolveResult<T> 类型。
export type AsyncComponentLoader<T = any> = () => Promise<
  AsyncComponentResolveResult<T>
>

export interface AsyncComponentOptions<T = any> {
  // 异步的组件
  loader: AsyncComponentLoader<T>
  // 加载中的组件
  loadingComponent?: Component
  // 错误时的组件
  errorComponent?: Component
  // 延迟加载时长
  delay?: number
  // 超时 时长
  timeout?: number
  // 是否使用suspense
  suspensible?: boolean
  hydrate?: HydrationStrategy
  // 出错时的回调
  onError?: (
    error: Error,
    // 重试
    retry: () => void,
    // 失败
    fail: () => void,
    // 尝试加载的次数
    attempts: number,
  ) => any
}

export const isAsyncWrapper = (i: ComponentInternalInstance | VNode): boolean =>
  !!(i.type as ComponentOptions).__asyncLoader

// /*! #__NO_SIDE_EFFECTS__ */ 是用于工具链优化的注释，表示这个函数调用没有副作用，可以进行 tree-shaking。
/*! #__NO_SIDE_EFFECTS__ */

// Vue 提供的一个 定义异步组件 的方法。
// 参数 source 可以是一个加载函数 AsyncComponentLoader<T>，也可以是一个包含更多配置的对象 AsyncComponentOptions<T>。
// 函数返回一个泛型组件 T。
export function defineAsyncComponent<
  T extends Component = { new (): ComponentPublicInstance },
>(source: AsyncComponentLoader<T> | AsyncComponentOptions<T>): T {
  // 判断 source 类型：
  // 如果传入的是一个函数（即简化写法的加载器），则将其转换为对象形式 { loader: source }。
  // 这样后续处理就统一按对象来操作了。
  if (isFunction(source)) {
    source = { loader: source }
  }

  // 解构配置参数：
  const {
    // loader: 加载组件的函数（必须）。
    // loadingComponent: 正在加载时显示的组件（可选）。
    // errorComponent: 加载失败时显示的组件（可选）。
    // delay: 显示 loadingComponent 前的延迟时间，默认是 200ms。
    // hydrate: 用于服务端渲染时自定义 hydrate 策略。
    // timeout: 超时时间（毫秒）。为 undefined 时表示永不超时。
    // suspensible: 是否支持 <Suspense>，默认是 true。
    // onError: 加载出错时的用户自定义错误处理回调。
    loader,
    loadingComponent,
    errorComponent,
    delay = 200,
    hydrate: hydrateStrategy,
    // 超时为undefined时永不超时
    timeout, // undefined = never times out
    suspensible = true,
    onError: userOnError,
  } = source

  // pendingRequest: 当前是否有正在进行的异步请求。
  // resolvedComp: 缓存成功加载的组件。
  let pendingRequest: Promise<ConcreteComponent> | null = null
  let resolvedComp: ConcreteComponent | undefined

  let retries = 0
  const retry = () => {
    retries++
    pendingRequest = null
    // 清空重新加载
    return load()
  }

  const load = (): Promise<ConcreteComponent> => {
    // 本次load调用的异步组件请求promise函数
    let thisRequest: Promise<ConcreteComponent>
    return (
      // 存在正在进行的异步组件请求promise函数则直接返回
      pendingRequest ||
      (thisRequest = pendingRequest =
        loader()
          .catch(err => {
            // 异常处理
            // 创建错误信息
            err = err instanceof Error ? err : new Error(String(err))
            if (userOnError) {
              // 存在用户的错误处理函数
              return new Promise((resolve, reject) => {
                const userRetry = () => resolve(retry())
                const userFail = () => reject(err)
                // 调用用户错误处理函数
                userOnError(err, userRetry, userFail, retries + 1)
              })
            } else {
              throw err
            }
          })
          .then((comp: any) => {
            // 异步组件返回处理
            if (thisRequest !== pendingRequest && pendingRequest) {
              // 本次异步组件请求和正在进行的异步组件请求不一致，且存在正在进行的异步组件请求，返回正在进行的异步组件请求
              return pendingRequest
            }
            if (__DEV__ && !comp) {
              warn(
                `Async component loader resolved to undefined. ` +
                  `If you are using retry(), make sure to return its return value.`,
              )
            }
            // interop module default
            // 解析 esm 格式
            if (
              comp &&
              (comp.__esModule || comp[Symbol.toStringTag] === 'Module')
            ) {
              comp = comp.default
            }
            if (__DEV__ && comp && !isObject(comp) && !isFunction(comp)) {
              throw new Error(`Invalid async component load result: ${comp}`)
            }
            resolvedComp = comp
            return comp
          }))
    )
  }

  // 1. 标准化source，创建相关方法变量
  // 2. 创建load组件promise
  // 3. 调用defineComponent

  // 构造并返回了一个 Vue 组件，也就是异步组件的「包装器」（Wrapper）。这个包装器负责：
  // 加载异步组件；
  // 管理加载状态、错误状态、超时；
  // 与 <Suspense> 和 SSR 兼容；
  // 渲染合适的 loading、error 或最终组件。
  return defineComponent({
    // 返回一个名为 AsyncComponentWrapper 的 Vue 组件。
    // 实际渲染的会是这个包装器，它是用户看到的异步组件的外壳。
    name: 'AsyncComponentWrapper',

    // 暴露 load 方法（异步加载组件），用于 Suspense 或工具链识别。
    __asyncLoader: load,

    // 用于 SSR hydrate 阶段：
    // 若提供了自定义 hydrate 策略 hydrateStrategy，就优先使用；
    // 否则直接执行传入的 hydrate 函数；
    // 如果组件还未加载，就先 load()，等加载完成后再 hydrate；
    // 如果 hydrateStrategy() 返回 teardown 方法，会在组件卸载时调用（通过 instance.bum 注册）。
    __asyncHydrate(el, instance, hydrate) {
      const doHydrate = hydrateStrategy
        ? () => {
            const teardown = hydrateStrategy(hydrate, cb =>
              forEachElement(el, cb),
            )
            if (teardown) {
              ;(instance.bum || (instance.bum = [])).push(teardown)
            }
          }
        : hydrate
      if (resolvedComp) {
        doHydrate()
      } else {
        load().then(() => !instance.isUnmounted && doHydrate())
      }
    },

    // 暴露当前已解析的组件，供外部（比如 Suspense 或调试工具）访问。
    get __asyncResolved() {
      return resolvedComp
    },

    // setup 函数：异步加载核心逻辑
    setup() {
      // 获取当前组件实例；
      // markAsyncBoundary() 是 Vue 的一个标记函数，标记这是一个异步组件，供 Suspense 用于追踪。
      const instance = currentInstance!
      markAsyncBoundary(instance)

      // already resolved
      //  如果组件已经解析好，直接渲染：
      if (resolvedComp) {
        return () => createInnerComp(resolvedComp!, instance)
      }

      // 错误处理逻辑：
      const onError = (err: Error) => {
        // 清空 pendingRequest；
        // 抛出错误，交给 Vue 全局错误处理逻辑；
        // 如果用户定义了 errorComponent，则阻止开发模式下抛出异常。
        pendingRequest = null
        handleError(
          err,
          instance,
          ErrorCodes.ASYNC_COMPONENT_LOADER,
          !errorComponent /* do not throw in dev if user provided error component */,
        )
      }

      // suspense-controlled or SSR.
      // Suspense / SSR 情况：
      if (
        (__FEATURE_SUSPENSE__ && suspensible && instance.suspense) ||
        (__SSR__ && isInSSRComponentSetup)
      ) {
        // 若启用了 <Suspense> 或正在 SSR 中，会优先使用 Promise 方式，让 Suspense 追踪其状态；
        // 异步加载成功后返回实际组件；
        // 出错时尝试渲染 errorComponent。
        return load()
          .then(comp => {
            return () => createInnerComp(comp, instance)
          })
          .catch(err => {
            onError(err)
            return () =>
              errorComponent
                ? createVNode(errorComponent as ConcreteComponent, {
                    error: err,
                  })
                : null
          })
      }

      // 普通异步加载处理逻辑（非 Suspense）
      // 使用 Vue 的响应式 ref() 来跟踪三种状态：
      // loaded: 是否加载成功；
      // error: 是否加载失败；
      // delayed: 是否处于延迟期间（在 delay 过后才显示 loadingComponent）。
      const loaded = ref(false)
      const error = ref()
      const delayed = ref(!!delay)

      // 处理 delay
      // 延迟时间后，允许显示 loadingComponent。
      if (delay) {
        setTimeout(() => {
          delayed.value = false
        }, delay)
      }

      // 处理 timeout
      // 若超时还未加载成功，就认为失败，并设置 error。
      if (timeout != null) {
        setTimeout(() => {
          if (!loaded.value && !error.value) {
            const err = new Error(
              `Async component timed out after ${timeout}ms.`,
            )
            onError(err)
            error.value = err
          }
        }, timeout)
      }

      // 加载组件并监听完成
      load()
        .then(() => {
          loaded.value = true
          // 加载成功时标记 loaded；
          // 如果父组件是 keep-alive，强制更新，确保缓存命中。
          if (instance.parent && isKeepAlive(instance.parent.vnode)) {
            // parent is keep-alive, force update so the loaded component's
            // name is taken into account
            instance.parent.update()
          }
        })
        .catch(err => {
          onError(err)
          error.value = err
        })

      //  渲染函数（最终返回）
      // 根据当前状态渲染不同内容：
      // 加载完成：渲染真实组件；
      // 加载失败：渲染错误组件（若提供）；
      // 加载中并且延迟已过：渲染加载中组件；
      // 其他情况返回 undefined，Vue 会渲染空节点。
      return () => {
        // 加载完成
        if (loaded.value && resolvedComp) {
          return createInnerComp(resolvedComp, instance)
        } else if (error.value && errorComponent) {
          // 渲染错误
          return createVNode(errorComponent, {
            error: error.value,
          })
        } else if (loadingComponent && !delayed.value) {
          // 渲染加载中
          return createVNode(loadingComponent)
        }
      }
    },
  }) as T
}

// 用于创建一个实际内部组件的 VNode（虚拟节点）。它的作用是：当异步组件加载完成后，用真正的组件替换占位的异步 wrapper。
function createInnerComp(
  // comp：加载成功的实际组件（已解析出来的异步组件）。
  // parent：异步组件包裹器（wrapper）的实例。注意，这不是父组件，而是 defineAsyncComponent 创建的“外壳”组件的实例。
  comp: ConcreteComponent,
  parent: ComponentInternalInstance,
) {
  // 从异步组件 wrapper 的 vnode 上拿出：
  // ref：用户设置的 ref（需要传递到内部组件）。
  // props：传给组件的 props。
  // children：传给组件的子节点（slots）。
  // ce：custom element 相关的回调（用于 Vue 自定义元素功能）。
  const { ref, props, children, ce } = parent.vnode
  // 使用真正的组件 comp 创建 VNode，保留 props 和子节点。
  const vnode = createVNode(comp, props, children)
  // ensure inner component inherits the async wrapper's ref owner
  // **ref 很关键！**用户在模板中可能写了 ref="myComp"，原本是在异步 wrapper 上，现在需要把它转移到实际的内部组件上。这样用户才能访问正确的组件实例。
  vnode.ref = ref
  // pass the custom element callback on to the inner comp
  // and remove it from the async wrapper
  // 传递自定义元素注册回调（ce）：
  // 将 wrapper 上的 ce（CustomElement 回调）转交给真正的组件。
  // 删除 wrapper 上的 ce，避免重复调用。
  vnode.ce = ce
  delete parent.vnode.ce

  return vnode
}
