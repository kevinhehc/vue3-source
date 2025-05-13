import { isFunction, isObject } from '@vue/shared'
import type { Component, ComponentInternalInstance } from '../component'
import {
  DeprecationTypes,
  checkCompatEnabled,
  softAssertCompatEnabled,
} from './compatConfig'
import { convertLegacyAsyncComponent } from './componentAsync'
import { convertLegacyFunctionalComponent } from './componentFunctional'

// 将 Vue 2 的组件对象（包括构造器、函数式组件、异步组件等）转换为 Vue 3 兼容的标准组件格式，以便 Vue 3 运行时能够正常处理它们。
export function convertLegacyComponent(
  comp: any,
  instance: ComponentInternalInstance | null,
): Component {
  // 保留内置组件
  // 对于像 <Transition> 等内置组件，直接返回；
  // 不需要转换。
  if (comp.__isBuiltIn) {
    return comp
  }

  // 2.x constructor
  // 构造器组件（Vue.extend）
  // Vue 2 的 Vue.extend({...}) 返回的是一个 构造函数，且有 .cid 属性；
  // 实际组件定义在 .options 中；
  // 如果 .render 是 SFC 编译产物，需要补进 .options；
  // 转换后得到一个 Vue 3 可识别的标准组件选项对象。
  if (isFunction(comp) && comp.cid) {
    // #7766
    if (comp.render) {
      // only necessary when compiled from SFC
      comp.options.render = comp.render
    }
    // copy over internal properties set by the SFC compiler
    comp.options.__file = comp.__file
    comp.options.__hmrId = comp.__hmrId
    comp.options.__scopeId = comp.__scopeId
    comp = comp.options
  }

  // 2.x async component
  // 2.x 异步组件
  // Vue 2 支持异步组件：const MyAsync = () => import('./My.vue')
  // Vue 3 需要明确使用 defineAsyncComponent()；
  // 若检测到是 Vue 2 风格的异步组件，就调用兼容转换函数 convertLegacyAsyncComponent。
  if (
    isFunction(comp) &&
    checkCompatEnabled(DeprecationTypes.COMPONENT_ASYNC, instance, comp)
  ) {
    // since after disabling this, plain functions are still valid usage, do not
    // use softAssert here.
    return convertLegacyAsyncComponent(comp)
  }

  // 2.x functional component
  // 2.x 函数式组件
  // Vue 2 中 functional: true 是定义无状态函数式组件的方式；
  // Vue 3 已弃用该语法，使用纯函数组件替代；
  // 检测到后通过 convertLegacyFunctionalComponent() 转换。
  if (
    isObject(comp) &&
    comp.functional &&
    softAssertCompatEnabled(
      DeprecationTypes.COMPONENT_FUNCTIONAL,
      instance,
      comp,
    )
  ) {
    return convertLegacyFunctionalComponent(comp)
  }

  return comp
}
