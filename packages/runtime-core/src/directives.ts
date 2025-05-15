/**
Runtime helper for applying directives to a vnode. Example usage:

const comp = resolveComponent('comp')
const foo = resolveDirective('foo')
const bar = resolveDirective('bar')

return withDirectives(h(comp), [
  [foo, this.x],
  [bar, this.y]
])
*/

import type { VNode } from './vnode'
import { EMPTY_OBJ, isBuiltInDirective, isFunction } from '@vue/shared'
import { warn } from './warning'
import {
  type ComponentInternalInstance,
  type Data,
  getComponentPublicInstance,
} from './component'
import { currentRenderingInstance } from './componentRenderContext'
import { ErrorCodes, callWithAsyncErrorHandling } from './errorHandling'
import type { ComponentPublicInstance } from './componentPublicInstance'
import { mapCompatDirectiveHook } from './compat/customDirective'
import { pauseTracking, resetTracking, traverse } from '@vue/reactivity'

export interface DirectiveBinding<
  Value = any,
  Modifiers extends string = string,
  Arg extends string = string,
> {
  instance: ComponentPublicInstance | Record<string, any> | null
  value: Value
  oldValue: Value | null
  arg?: Arg
  modifiers: DirectiveModifiers<Modifiers>
  dir: ObjectDirective<any, Value>
}

export type DirectiveHook<
  HostElement = any,
  Prev = VNode<any, HostElement> | null,
  Value = any,
  Modifiers extends string = string,
  Arg extends string = string,
> = (
  el: HostElement,
  binding: DirectiveBinding<Value, Modifiers, Arg>,
  vnode: VNode<any, HostElement>,
  prevVNode: Prev,
) => void

export type SSRDirectiveHook<
  Value = any,
  Modifiers extends string = string,
  Arg extends string = string,
> = (
  binding: DirectiveBinding<Value, Modifiers, Arg>,
  vnode: VNode,
) => Data | undefined

export interface ObjectDirective<
  HostElement = any,
  Value = any,
  Modifiers extends string = string,
  Arg extends string = string,
> {
  // 指令声明时可用hooks
  /**
   * @internal without this, ts-expect-error in directives.test-d.ts somehow
   * fails when running tsc, but passes in IDE and when testing against built
   * dts. Could be a TS bug.
   */
  __mod?: Modifiers
  created?: DirectiveHook<HostElement, null, Value, Modifiers, Arg>
  beforeMount?: DirectiveHook<HostElement, null, Value, Modifiers, Arg>
  mounted?: DirectiveHook<HostElement, null, Value, Modifiers, Arg>
  beforeUpdate?: DirectiveHook<
    HostElement,
    VNode<any, HostElement>,
    Value,
    Modifiers,
    Arg
  >
  updated?: DirectiveHook<
    HostElement,
    VNode<any, HostElement>,
    Value,
    Modifiers,
    Arg
  >
  beforeUnmount?: DirectiveHook<HostElement, null, Value, Modifiers, Arg>
  unmounted?: DirectiveHook<HostElement, null, Value, Modifiers, Arg>
  getSSRProps?: SSRDirectiveHook<Value, Modifiers, Arg>
  deep?: boolean
}

export type FunctionDirective<
  HostElement = any,
  V = any,
  Modifiers extends string = string,
  Arg extends string = string,
> = DirectiveHook<HostElement, any, V, Modifiers, Arg>

// 指令注册时可接受的方式
export type Directive<
  HostElement = any,
  Value = any,
  Modifiers extends string = string,
  Arg extends string = string,
> =
  | ObjectDirective<HostElement, Value, Modifiers, Arg>
  | FunctionDirective<HostElement, Value, Modifiers, Arg>

export type DirectiveModifiers<K extends string = string> = Partial<
  Record<K, boolean>
>

export function validateDirectiveName(name: string): void {
  if (isBuiltInDirective(name)) {
    warn('Do not use built-in directive ids as custom directive id: ' + name)
  }
}

// Directive, value, argument, modifiers
export type DirectiveArguments = Array<
  | [Directive | undefined]
  | [Directive | undefined, any]
  | [Directive | undefined, any, string]
  | [Directive | undefined, any, string | undefined, DirectiveModifiers]
>

/**
 * Adds directives to a VNode.
 *
 *
 * `withDirectives`所做的就是将`DirectiveArguments`转化成`DirectiveBinding`，
 * 我们再回看`withDirectives`的逻辑处理，先会对`app.directive()`的指令参数进行标准化处理，
 * 然后将指令信息全部转化成`bindings`并存储在`VNode.dirs`。
 */
export function withDirectives<T extends VNode>(
  vnode: T,
  directives: DirectiveArguments,
): T {
  // 渲染实例  // 只能在render函数中使用
  if (currentRenderingInstance === null) {
    __DEV__ && warn(`withDirectives can only be used inside render functions.`)
    return vnode
  }

  // 实例公共代理
  const instance = getComponentPublicInstance(currentRenderingInstance)
  // 拿到已处理的所有指令信息
  const bindings: DirectiveBinding[] = vnode.dirs || (vnode.dirs = [])
  // 遍历标准化指令绑定信息
  for (let i = 0; i < directives.length; i++) {
    let [dir, value, arg, modifiers = EMPTY_OBJ] = directives[i]
    if (dir) {
      if (isFunction(dir)) {
        // 指令注册时直接传递钩子函数处理为mounted和updated
        dir = {
          mounted: dir,
          updated: dir,
        } as ObjectDirective
      }
      if (dir.deep) {
        traverse(value)
      }
      // 创建binding参数
      bindings.push({
        dir,
        instance,
        value,
        oldValue: void 0,
        arg,
        modifiers,
      })
    }
  }
  return vnode
}

// Vue 3 渲染过程中对自定义指令钩子的统一调度函数 invokeDirectiveHook，
// 用于在合适的时机调用指令的各个生命周期钩子（created、beforeMount、mounted、beforeUpdate、updated、beforeUnmount、unmounted 等）。
export function invokeDirectiveHook(
  // vnode：当前 VNode，可能携带多个指令信息 (vnode.dirs)。
  // prevVNode：前一次渲染对应的 VNode，用于更新阶段对比旧值；首次挂载时为 null。
  // instance：所属组件实例，用于作为执行钩子的上下文。
  // name：要调用的钩子名称，来自 ObjectDirective 接口的键（如 mounted、beforeUpdate 等）。
  vnode: VNode,
  prevVNode: VNode | null,
  instance: ComponentInternalInstance | null,
  name: keyof ObjectDirective,
): void {
  // vnode.dirs 是当前节点上所有指令的绑定信息数组（DirectiveBinding[]）；
  // 如果存在 prevVNode，则也取出旧的绑定数组 oldBindings，用于在更新时对比旧值。
  const bindings = vnode.dirs!
  const oldBindings = prevVNode && prevVNode.dirs!

  // 2. 遍历每个指令绑定
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i]
    if (oldBindings) {
      // 设置 oldValue（仅更新阶段）
      // 如果在更新阶段（oldBindings 不为 null），将对应旧绑定的 value 赋给当前绑定的 oldValue，以便钩子函数内部能够对比新旧值。
      binding.oldValue = oldBindings[i].value
    }
    // 4. 取出钩子函数
    // binding.dir 是指令定义对象，可能直接包含钩子函数；
    // 如果开启了兼容模式 (__COMPAT__) 且当前指令对象没有对应钩子，则通过 mapCompatDirectiveHook 映射到 Vue 2 风格的兼容钩子。
    let hook = binding.dir[name] as DirectiveHook | DirectiveHook[] | undefined
    if (__COMPAT__ && !hook) {
      hook = mapCompatDirectiveHook(name, binding.dir, instance)
    }
    if (hook) {
      // disable tracking inside all lifecycle hooks
      // since they can potentially be called inside effects.
      // 5. 调用钩子前暂停依赖跟踪
      // 指令钩子可能在渲染过程中调用响应式读写操作，暂停 Vue 的响应式副作用跟踪，避免影响渲染过程中的依赖收集。
      pauseTracking()
      // 6. 安全地执行钩子
      // 使用 callWithAsyncErrorHandling 包装，确保如果钩子抛出错误能够被 Vue 的错误处理逻辑捕获；
      // 传入参数依次是：指令对应的 DOM 元素 vnode.el、当前绑定对象 binding、新旧 VNode。
      callWithAsyncErrorHandling(hook, instance, ErrorCodes.DIRECTIVE_HOOK, [
        vnode.el,
        binding,
        vnode,
        prevVNode,
      ])
      // 7. 恢复依赖跟踪
      resetTracking()
    }
  }
}
