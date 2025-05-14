import { type ShallowRef, readonly, shallowRef } from '@vue/reactivity'
import { getCurrentInstance } from '../component'
import { warn } from '../warning'
import { EMPTY_OBJ } from '@vue/shared'

export const knownTemplateRefs: WeakSet<ShallowRef> = new WeakSet()

// 返回的是 readonly 包裹的 shallowRef；
// 只读是为了防止用户直接写入 .value = ...，因为它是由模板驱动的；
// 类型默认为 T | null，你也可以手动指定为 <HTMLInputElement> 等。
export type TemplateRef<T = unknown> = Readonly<ShallowRef<T | null>>

// 允许你在 <script setup> 中以组合式方式声明并接收模板中的 ref="myRef" DOM 或组件引用。
export function useTemplateRef<T = unknown, Keys extends string = string>(
  key: Keys,
): TemplateRef<T> {
  const i = getCurrentInstance()
  // 1. 创建 shallowRef 容器
  // 它会存储模板中 ref="key" 绑定的值（DOM/组件实例）；
  // 不是 ref() 而是 shallowRef()，因为模板 ref 对象通常不需要深层响应。
  const r = shallowRef(null)
  if (i) {
    // 2. 关联当前组件的 refs 表
    // refs 就是组件实例上的 this.$refs；
    // 若还未初始化（为 EMPTY_OBJ），则创建新的对象。
    const refs = i.refs === EMPTY_OBJ ? (i.refs = {}) : i.refs
    let desc: PropertyDescriptor | undefined
    if (
      __DEV__ &&
      (desc = Object.getOwnPropertyDescriptor(refs, key)) &&
      !desc.configurable
    ) {
      warn(`useTemplateRef('${key}') already exists.`)
    } else {
      // 3. 定义 getter/setter 属性
      // 把 refs[key] 变成一个 getter/setter 代理，与 r.value 双向绑定；
      // 所以模板中 <div ref="foo" /> 会自动将 DOM 赋值到 r.value。
      Object.defineProperty(refs, key, {
        enumerable: true,
        get: () => r.value,
        set: val => (r.value = val),
      })
    }
  } else if (__DEV__) {
    // 4. DEV 检查
    // 防止重复定义 ref="key" 的同名引用。
    warn(
      `useTemplateRef() is called when there is no active component ` +
        `instance to be associated with.`,
    )
  }
  // 5. 返回只读版本
  // 返回一个 readonly() 包裹的 ref，防止误写入；
  // 内部仍然可响应更新。
  const ret = __DEV__ ? readonly(r) : r
  if (__DEV__) {
    // 6. DEV 专用调试标记
    // 用于工具链识别哪些 ref 是通过 useTemplateRef 创建的
    // 比如用于警告或 devtools 展示。
    knownTemplateRefs.add(ret)
  }
  return ret
}
