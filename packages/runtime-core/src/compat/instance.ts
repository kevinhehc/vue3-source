import {
  NOOP,
  extend,
  looseEqual,
  looseIndexOf,
  looseToNumber,
  toDisplayString,
} from '@vue/shared'
import type {
  ComponentPublicInstance,
  PublicPropertiesMap,
} from '../componentPublicInstance'
import { getCompatChildren } from './instanceChildren'
import {
  DeprecationTypes,
  assertCompatEnabled,
  isCompatEnabled,
  warnDeprecation,
} from './compatConfig'
import { off, on, once } from './instanceEventEmitter'
import { getCompatListeners } from './instanceListeners'
import { shallowReadonly } from '@vue/reactivity'
import { legacySlotProxyHandlers } from './componentFunctional'
import { compatH } from './renderFn'
import { createCommentVNode, createTextVNode } from '../vnode'
import { renderList } from '../helpers/renderList'
import {
  legacyBindDynamicKeys,
  legacyBindObjectListeners,
  legacyBindObjectProps,
  legacyCheckKeyCodes,
  legacyMarkOnce,
  legacyPrependModifier,
  legacyRenderSlot,
  legacyRenderStatic,
  legacyresolveScopedSlots,
} from './renderHelpers'
import { resolveFilter } from '../helpers/resolveAssets'
import type { Slots } from '../componentSlots'
import { resolveMergedOptions } from '../componentOptions'

export type LegacyPublicInstance = ComponentPublicInstance &
  LegacyPublicProperties

export interface LegacyPublicProperties {
  $set<T extends Record<keyof any, any>, K extends keyof T>(
    target: T,
    key: K,
    value: T[K],
  ): void
  $delete<T extends Record<keyof any, any>, K extends keyof T>(
    target: T,
    key: K,
  ): void
  $mount(el?: string | Element): this
  $destroy(): void
  $scopedSlots: Slots
  $on(event: string | string[], fn: Function): this
  $once(event: string, fn: Function): this
  $off(event?: string | string[], fn?: Function): this
  $children: LegacyPublicProperties[]
  $listeners: Record<string, Function | Function[]>
}

// 该函数用于给 Vue 3 的组件实例注入 Vue 2 风格的实例属性（如 $set、$on、$slots、$options 等），
// 从而在不修改旧代码的情况下，让它们在 Vue 3 中继续工作。
// 它作用于 Vue 3 内部的 PublicPropertiesMap，这是 Vue 3 代理组件实例时用于控制哪些属性可以通过 this.xxx 访问的映射表。
export function installCompatInstanceProperties(
  map: PublicPropertiesMap,
): void {
  // 兼容公共实例方法（Vue 2 的 $xxx API）
  // {
  //   $set, $delete, $mount, $destroy,
  //   $slots, $scopedSlots,
  //   $on, $once, $off,
  //   $children, $listeners,
  //   $options
  // }
  // 🔹 $set / $delete
  // 模拟 Vue 2 的响应式属性添加和删除；
  // 实际内部是直接赋值/删除，并触发 compat 警告。
  // 🔹 $mount / $destroy
  // 兼容 new Vue().$mount(el) 和 $destroy()；
  // 在 compat build 中由 installCompatMount() 注入 _compat_mount 等方法。
  // 🔹 $slots / $scopedSlots
  // 默认使用 i.slots；
  // 在 compat 渲染函数场景下（i.render._compatWrapped），使用 Proxy 包装的旧插槽访问方式。
  // 🔹 $on / $once / $off
  // 将实例事件监听映射到 Vue 3 的 emits 系统；
  // 通常用于旧插件或组件间通信。
  // 🔹 $children / $listeners
  // $children：通过 vnode 的子节点和实例关系获取；
  // $listeners：将 v-on 绑定事件提取到 $attrs 中兼容访问。
  // 🔹 $options
  // 提供对组件选项的访问（如 data、methods）；
  // 增加 parent、propsData 的 getter，触发废弃警告；
  // 默认返回 resolveMergedOptions() 合并后的完整选项。
  // ✅ 2. 注入 Vue 2 的私有属性（_xxx）和渲染辅助方法（_c, _o, _s 等）
  // {
  //   _self, _uid, _data, _isMounted, _isDestroyed,
  //   $createElement, _c, _o, _n, _s, ...
  // }
  // 这些属性和方法在 Vue 2 中是渲染函数编译生成时使用的，如 _c() 创建元素，_s() 转字符串，_t() 渲染插槽。
  // 例子：
  // _c: 旧版 createElement() 的简写；
  // _s: 等价于 toDisplayString()；
  // _l: 兼容 v-for 渲染；
  // _m: 渲染静态树；
  // _t: 渲染具名插槽；
  // _f: 兼容 filter；
  // _b: 兼容 v-bind="obj"；
  // _k: 旧的 keyCode 兼容；
  // _g, _d, _p: 分别对应 v-on, v-bind 修饰符、动态 key 等特性兼容。
  // 这些会被 Vue 2 编译出来的 render 函数所使用，因此 compat build 需要提供对应实现以保持运行能力。
  // ✅ 3. 权限控制：是否启用某个 compat 属性
  // 所有注入的属性和方法都通过如下检查：
  // assertCompatEnabled(DeprecationTypes.INSTANCE_SET, i)
  // 或：
  // isCompatEnabled(DeprecationTypes.PRIVATE_APIS, i)
  // 用来判断当前组件是否启用了特定兼容特性，防止兼容项无意义地干扰 Vue 3 项目。
  const set = (target: any, key: any, val: any) => {
    target[key] = val
    return target[key]
  }

  const del = (target: any, key: any) => {
    delete target[key]
  }

  extend(map, {
    $set: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_SET, i)
      return set
    },

    $delete: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_DELETE, i)
      return del
    },

    $mount: i => {
      assertCompatEnabled(
        DeprecationTypes.GLOBAL_MOUNT,
        null /* this warning is global */,
      )
      // root mount override from ./global.ts in installCompatMount
      return i.ctx._compat_mount || NOOP
    },

    $destroy: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_DESTROY, i)
      // root destroy override from ./global.ts in installCompatMount
      return i.ctx._compat_destroy || NOOP
    },

    // overrides existing accessor
    $slots: i => {
      if (
        isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, i) &&
        i.render &&
        i.render._compatWrapped
      ) {
        return new Proxy(i.slots, legacySlotProxyHandlers)
      }
      return __DEV__ ? shallowReadonly(i.slots) : i.slots
    },

    $scopedSlots: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_SCOPED_SLOTS, i)
      return __DEV__ ? shallowReadonly(i.slots) : i.slots
    },

    $on: i => on.bind(null, i),
    $once: i => once.bind(null, i),
    $off: i => off.bind(null, i),

    $children: getCompatChildren,
    $listeners: getCompatListeners,

    // inject additional properties into $options for compat
    // e.g. vuex needs this.$options.parent
    $options: i => {
      if (!isCompatEnabled(DeprecationTypes.PRIVATE_APIS, i)) {
        return resolveMergedOptions(i)
      }
      if (i.resolvedOptions) {
        return i.resolvedOptions
      }
      const res = (i.resolvedOptions = extend({}, resolveMergedOptions(i)))
      Object.defineProperties(res, {
        parent: {
          get() {
            warnDeprecation(DeprecationTypes.PRIVATE_APIS, i, '$options.parent')
            return i.proxy!.$parent
          },
        },
        propsData: {
          get() {
            warnDeprecation(
              DeprecationTypes.PRIVATE_APIS,
              i,
              '$options.propsData',
            )
            return i.vnode.props
          },
        },
      })
      return res
    },
  } as PublicPropertiesMap)

  const privateAPIs = {
    // needed by many libs / render fns
    $vnode: i => i.vnode,

    // some private properties that are likely accessed...
    _self: i => i.proxy,
    _uid: i => i.uid,
    _data: i => i.data,
    _isMounted: i => i.isMounted,
    _isDestroyed: i => i.isUnmounted,

    // v2 render helpers
    $createElement: () => compatH,
    _c: () => compatH,
    _o: () => legacyMarkOnce,
    _n: () => looseToNumber,
    _s: () => toDisplayString,
    _l: () => renderList,
    _t: i => legacyRenderSlot.bind(null, i),
    _q: () => looseEqual,
    _i: () => looseIndexOf,
    _m: i => legacyRenderStatic.bind(null, i),
    _f: () => resolveFilter,
    _k: i => legacyCheckKeyCodes.bind(null, i),
    _b: () => legacyBindObjectProps,
    _v: () => createTextVNode,
    _e: () => createCommentVNode,
    _u: () => legacyresolveScopedSlots,
    _g: () => legacyBindObjectListeners,
    _d: () => legacyBindDynamicKeys,
    _p: () => legacyPrependModifier,
  } as PublicPropertiesMap

  for (const key in privateAPIs) {
    map[key] = i => {
      if (isCompatEnabled(DeprecationTypes.PRIVATE_APIS, i)) {
        return privateAPIs[key](i)
      }
    }
  }
}
