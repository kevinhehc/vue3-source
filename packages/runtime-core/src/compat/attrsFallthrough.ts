import { isOn } from '@vue/shared'
import type { ComponentInternalInstance } from '../component'
import { DeprecationTypes, isCompatEnabled } from './compatConfig'

// 用于判断某个 prop 或 attribute 是否应当 被跳过（不传递到 DOM 或组件实例）。
// 它主要用于组件属性处理阶段，比如透传 attrs、生成 props 时，决定 哪些 key 不应该继续往下传递。
export function shouldSkipAttr(
  // key：要判断的 prop/attr 的名称；
  // instance：当前组件实例；
  // 返回值：是否应该跳过该属性。
  key: string,
  instance: ComponentInternalInstance,
): boolean {
  if (key === 'is') {
    // 跳过 is 属性（内建行为）
    // is 是 Vue 支持的 动态组件标签 用法：
    // <component is="SomeComponent" />
    // 编译器和运行时已消化 is 的用途，不需要向下传递。
    return true
  }
  if (
    (key === 'class' || key === 'style') &&
    isCompatEnabled(DeprecationTypes.INSTANCE_ATTRS_CLASS_STYLE, instance)
  ) {
    // 兼容模式下跳过 class 和 style
    // Vue 2 中 class 和 style 会被透传到根元素；
    // Vue 3 默认不这样做；
    // 如果启用了兼容性选项（via @vue/compat），会跳过它们的透传。
    return true
  }
  if (
    isOn(key) &&
    isCompatEnabled(DeprecationTypes.INSTANCE_LISTENERS, instance)
  ) {
    // 跳过 on*（事件监听器），用于兼容模式
    // Vue 2 会把所有 onX 事件监听器通过 $listeners 透传；
    // Vue 3 改为显式 emits 机制；
    // 兼容模式中启用了旧行为，需要跳过这些事件绑定。
    return true
  }
  // vue-router
  if (key.startsWith('routerView') || key === 'registerRouteInstance') {
    // vue-router 内部用于 <router-view> 或 <router-link> 的私有标记属性；
    // 不应透传给 DOM 或其他子组件。
    return true
  }
  return false
}
