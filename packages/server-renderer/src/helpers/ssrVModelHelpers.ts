import { isArray, looseEqual, looseIndexOf } from '@vue/shared'
import { ssrRenderAttr } from './ssrRenderAttrs'

// SSR 下的宽松比较，用于判断是否“值相等”（深度比较，类似 ==，但更智能）。
// 用于 v-model 比较当前模型值与 input 的 value。
export const ssrLooseEqual = looseEqual as (a: unknown, b: unknown) => boolean

// 判断某个值是否在数组中（使用宽松比较）。
// 用于 <input type="checkbox" v-model="array"> 场景。
export function ssrLooseContain(arr: unknown[], value: unknown): boolean {
  return looseIndexOf(arr, value) > -1
}

// for <input :type="type" v-model="model" value="value">
// 用于生成 input 元素的字符串属性（如 checked 或 value="..."）：
export function ssrRenderDynamicModel(
  type: unknown,
  model: unknown,
  value: unknown,
): string {
  switch (type) {
    case 'radio':
      return looseEqual(model, value) ? ' checked' : ''
    case 'checkbox':
      return (isArray(model) ? ssrLooseContain(model, value) : model)
        ? ' checked'
        : ''
    default:
      // text types
      return ssrRenderAttr('value', model)
  }
}

// for <input v-bind="obj" v-model="model">
// 用于静态属性合并的函数，不返回字符串，而是返回 props 对象，给 SSR 内部的 mergeProps() 使用。
// 用于 <input v-bind="someObj" v-model="model"> 场景下，自动补充 checked 或 value。
export function ssrGetDynamicModelProps(
  existingProps: any = {},
  model: unknown,
): { checked: true } | { value: any } | null {
  const { type, value } = existingProps
  switch (type) {
    case 'radio':
      return looseEqual(model, value) ? { checked: true } : null
    case 'checkbox':
      return (isArray(model) ? ssrLooseContain(model, value) : model)
        ? { checked: true }
        : null
    default:
      // text types
      return { value: model }
  }
  // 示例：
  // const props = { type: 'checkbox', value: 'foo' }
  // const model = ['foo']
  // ssrGetDynamicModelProps(props, model)  // → { checked: true }
}
