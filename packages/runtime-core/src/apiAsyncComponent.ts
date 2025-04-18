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

export type AsyncComponentResolveResult<T = Component> = T | { default: T } // es modules

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

/*! #__NO_SIDE_EFFECTS__ */
export function defineAsyncComponent<
  T extends Component = { new (): ComponentPublicInstance },
>(source: AsyncComponentLoader<T> | AsyncComponentOptions<T>): T {
  if (isFunction(source)) {
    source = { loader: source }
  }

  const {
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
  return defineComponent({
    name: 'AsyncComponentWrapper',

    __asyncLoader: load,

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

    get __asyncResolved() {
      return resolvedComp
    },

    setup() {
      const instance = currentInstance!
      markAsyncBoundary(instance)

      // already resolved
      if (resolvedComp) {
        return () => createInnerComp(resolvedComp!, instance)
      }

      const onError = (err: Error) => {
        pendingRequest = null
        handleError(
          err,
          instance,
          ErrorCodes.ASYNC_COMPONENT_LOADER,
          !errorComponent /* do not throw in dev if user provided error component */,
        )
      }

      // suspense-controlled or SSR.
      if (
        (__FEATURE_SUSPENSE__ && suspensible && instance.suspense) ||
        (__SSR__ && isInSSRComponentSetup)
      ) {
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

      const loaded = ref(false)
      const error = ref()
      const delayed = ref(!!delay)

      if (delay) {
        setTimeout(() => {
          delayed.value = false
        }, delay)
      }

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

      load()
        .then(() => {
          loaded.value = true
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

function createInnerComp(
  comp: ConcreteComponent,
  parent: ComponentInternalInstance,
) {
  const { ref, props, children, ce } = parent.vnode
  const vnode = createVNode(comp, props, children)
  // ensure inner component inherits the async wrapper's ref owner
  vnode.ref = ref
  // pass the custom element callback on to the inner comp
  // and remove it from the async wrapper
  vnode.ce = ce
  delete parent.vnode.ce

  return vnode
}
