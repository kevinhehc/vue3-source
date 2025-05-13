import { ShapeFlags, extend } from '@vue/shared'
import type { ComponentInternalInstance, ComponentOptions } from '../component'
import { ErrorCodes, callWithErrorHandling } from '../errorHandling'
import type { VNode } from '../vnode'
import { popWarningContext, pushWarningContext } from '../warning'
import {
  DeprecationTypes,
  isCompatEnabled,
  warnDeprecation,
} from './compatConfig'

export const compatModelEventPrefix = `onModelCompat:`

const warnedTypes = new WeakSet()

// Vue 2 vs Vue 3 的 v-model 区别

//                   Vue 2	                              Vue 3
// 绑定的 prop 名	value（默认）或组件自定义的 model.prop	  modelValue（固定）
// 更新事件名	        input（默认）或 model.event	          update:modelValue
// 多个 v-model	    不支持	                              支持多个 v-model（通过参数）
//
// Vue 3 强化了 v-model 的一致性和多样性，但 Vue 2 写法就不兼容了，因此 compat build 提供转换机制。
// 在运行时将 Vue 3 的 v-model props 转换成 Vue 2 的形式，以便 Vue 2 风格组件能正确接收和响应 v-model。
export function convertLegacyVModelProps(vnode: VNode): void {
  const { type, shapeFlag, props, dynamicProps } = vnode
  const comp = type as ComponentOptions
  // 当前 vnode 是组件；
  // 绑定了 v-model（即 props 中有 modelValue）；
  if (shapeFlag & ShapeFlags.COMPONENT && props && 'modelValue' in props) {
    if (
      // 判断是否启用了 v-model 的 compat 行为（来自 compatConfig）。
      // 注意这里是特别地用 当前 vnode 所代表的组件本身的 compat config，而非当前父组件。
      !isCompatEnabled(
        DeprecationTypes.COMPONENT_V_MODEL,
        // this is a special case where we want to use the vnode component's
        // compat config instead of the current rendering instance (which is the
        // parent of the component that exposes v-model)
        { type } as any,
      )
    ) {
      return
    }

    if (__DEV__ && !warnedTypes.has(comp)) {
      pushWarningContext(vnode)
      // 只打印一次警告（使用 WeakSet 缓存组件）。
      warnDeprecation(DeprecationTypes.COMPONENT_V_MODEL, { type } as any, comp)
      popWarningContext()
      warnedTypes.add(comp)
    }

    // v3 compiled model code -> v2 compat props
    // modelValue -> value
    // onUpdate:modelValue -> onModelCompat:input
    // 执行兼容字段转换：
    const model = comp.model || {}
    applyModelFromMixins(model, comp.mixins)
    const { prop = 'value', event = 'input' } = model
    if (prop !== 'modelValue') {
      props[prop] = props.modelValue
      delete props.modelValue
    }
    // important: update dynamic props
    if (dynamicProps) {
      dynamicProps[dynamicProps.indexOf('modelValue')] = prop
    }
    props[compatModelEventPrefix + event] = props['onUpdate:modelValue']
    delete props['onUpdate:modelValue']
  }
}

function applyModelFromMixins(model: any, mixins?: ComponentOptions[]) {
  if (mixins) {
    mixins.forEach(m => {
      if (m.model) extend(model, m.model)
      if (m.mixins) applyModelFromMixins(model, m.mixins)
    })
  }
}

// 在组件内部手动触发 Vue 2 的 v-model 更新事件（如 'input'）
export function compatModelEmit(
  instance: ComponentInternalInstance,
  event: string,
  args: any[],
): void {
  if (!isCompatEnabled(DeprecationTypes.COMPONENT_V_MODEL, instance)) {
    return
  }
  const props = instance.vnode.props
  const modelHandler = props && props[compatModelEventPrefix + event]
  if (modelHandler) {
    callWithErrorHandling(
      modelHandler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args,
    )
  }
}
