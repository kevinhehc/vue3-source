import { type Ref, customRef, ref } from '@vue/reactivity'
import { EMPTY_OBJ, camelize, hasChanged, hyphenate } from '@vue/shared'
import type { DefineModelOptions, ModelRef } from '../apiSetupHelpers'
import { getCurrentInstance } from '../component'
import { warn } from '../warning'
import type { NormalizedProps } from '../componentProps'
import { watchSyncEffect } from '../apiWatch'

// 使用场景示例
// <!-- 父组件 -->
// <MyInput v-model:msg="text" :msg-modifiers="{ trim: true }" />
//
// <!-- 子组件 -->
// <script setup>
// const model = useModel(defineProps(), 'msg')
// </script>

// 现在你可以在 setup() 中直接操作 model.value，等价于传统的：
// defineProps({ msg: String })
// defineEmits(['update:msg'])
// 再手动 watch 和 emit。
export function useModel<
  M extends PropertyKey,
  T extends Record<string, any>,
  K extends keyof T,
  G = T[K],
  S = T[K],
>(
  props: T,
  name: K,
  options?: DefineModelOptions<T[K], G, S>,
): ModelRef<T[K], M, G, S>

// 让你在 setup() 中用 ref 的方式 双向绑定某个 v-model 传入的 prop，并自动处理 update:xxx 的事件触发、修饰符等逻辑。
export function useModel(
  props: Record<string, any>,
  name: string,
  options: DefineModelOptions = EMPTY_OBJ,
): Ref {
  // 1. 获取组件实例
  // 必须在组件上下文中调用，否则报错。
  const i = getCurrentInstance()!
  if (__DEV__ && !i) {
    warn(`useModel() called without active instance.`)
    return ref() as any
  }

  // 2. 名称处理
  // 支持 kebab-case / camelCase 混用；
  // v-model:msg-foo → msgFoo 和 msg-foo 都能识别。
  const camelizedName = camelize(name)
  if (__DEV__ && !(i.propsOptions[0] as NormalizedProps)[camelizedName]) {
    warn(`useModel() called with prop "${name}" which is not declared.`)
    return ref() as any
  }

  const hyphenatedName = hyphenate(name)

  // 3. 修饰符提取
  // v-model:foo.modifier 会通过 :foo-modifiers 传入；
  // Vue 编译器在父组件中自动生成 :foo-modifiers="..."；
  // 内部支持常规 fooModifiers、foo-modifiers、modelModifiers（专用于默认 modelValue）命名格式。
  const modifiers = getModelModifiers(props, camelizedName)

  // 4. customRef() 包装响应式引用
  // 这是实现 v-model 的响应式 双向绑定封装核心。
  const res = customRef((track, trigger) => {
    let localValue: any
    let prevSetValue: any = EMPTY_OBJ
    let prevEmittedValue: any

    // 5. watchSyncEffect → 响应 props 变化
    watchSyncEffect(() => {
      const propValue = props[camelizedName]
      if (hasChanged(localValue, propValue)) {
        localValue = propValue
        trigger()
      }
    })

    return {
      // 如果传入 get() 转换函数，先处理；
      // 否则直接返回本地缓存值。
      get() {
        track()
        return options.get ? options.get(localValue) : localValue
      },

      // 完整流程：
      // 判断 value 是否变更，防抖；
      // 若父组件未传入 v-model 对应事件，则仅更新本地；
      // 否则触发 update:xxx 事件；
      // 若 value 和 emittedValue 不一致但前者是用户输入（见 #10279），则强制 trigger()；
      // 记录上次设置值、上次 emit 值，避免重复触发。

      // 保证 props.xxx 改变时 useModel() 的 ref 会响应更新；
      // 实现 props → ref 的响应同步。
      set(value) {
        const emittedValue = options.set ? options.set(value) : value
        if (
          !hasChanged(emittedValue, localValue) &&
          !(prevSetValue !== EMPTY_OBJ && hasChanged(value, prevSetValue))
        ) {
          return
        }
        const rawProps = i.vnode!.props
        if (
          !(
            rawProps &&
            // check if parent has passed v-model
            (name in rawProps ||
              camelizedName in rawProps ||
              hyphenatedName in rawProps) &&
            (`onUpdate:${name}` in rawProps ||
              `onUpdate:${camelizedName}` in rawProps ||
              `onUpdate:${hyphenatedName}` in rawProps)
          )
        ) {
          // no v-model, local update
          localValue = value
          trigger()
        }

        i.emit(`update:${name}`, emittedValue)
        // #10279: if the local value is converted via a setter but the value
        // emitted to parent was the same, the parent will not trigger any
        // updates and there will be no prop sync. However the local input state
        // may be out of sync, so we need to force an update here.
        if (
          hasChanged(value, emittedValue) &&
          hasChanged(value, prevSetValue) &&
          !hasChanged(emittedValue, prevEmittedValue)
        ) {
          trigger()
        }
        prevSetValue = value
        prevEmittedValue = emittedValue
      },
    }
  })

  // @ts-expect-error
  res[Symbol.iterator] = () => {
    let i = 0
    return {
      next() {
        if (i < 2) {
          return { value: i++ ? modifiers || EMPTY_OBJ : res, done: false }
        } else {
          return { done: true }
        }
      },
    }
  }

  return res
}

// 兼容所有可能格式（由编译器生成）；
// 用于 .trim、.number 等修饰符功能；
// 默认 v-model 会使用 modelModifiers；
// 具名的则为 xxxModifiers。
export const getModelModifiers = (
  props: Record<string, any>,
  modelName: string,
): Record<string, boolean> | undefined => {
  return modelName === 'modelValue' || modelName === 'model-value'
    ? props.modelModifiers
    : props[`${modelName}Modifiers`] ||
        props[`${camelize(modelName)}Modifiers`] ||
        props[`${hyphenate(modelName)}Modifiers`]
}
