import { registerRuntimeHelpers } from '@vue/compiler-core'

// 定义编译时使用的唯一 symbol，每个都是一个 v-model 或指令变体的标识符
// 在开发模式 (__DEV__) 下，Symbol 会有可读的描述，便于调试
// 在生产模式下，Symbol 是匿名的，以减小体积

// v-model 用于 radio 类型的 input
export const V_MODEL_RADIO: unique symbol = Symbol(__DEV__ ? `vModelRadio` : ``)

// v-model 用于 checkbox 类型的 input
export const V_MODEL_CHECKBOX: unique symbol = Symbol(
  __DEV__ ? `vModelCheckbox` : ``,
)

// v-model 用于 text 类型的 input（包括 textarea）
export const V_MODEL_TEXT: unique symbol = Symbol(__DEV__ ? `vModelText` : ``)

// v-model 用于 select 元素
export const V_MODEL_SELECT: unique symbol = Symbol(
  __DEV__ ? `vModelSelect` : ``,
)

// v-model 的动态变体（动态选择 v-model 的实现）
export const V_MODEL_DYNAMIC: unique symbol = Symbol(
  __DEV__ ? `vModelDynamic` : ``,
)

// 带修饰符的 v-on，比如 `.stop`、`.prevent` 等
export const V_ON_WITH_MODIFIERS: unique symbol = Symbol(
  __DEV__ ? `vOnModifiersGuard` : ``,
)

// 带按键修饰符的 v-on，比如 `.enter`、`.esc` 等
export const V_ON_WITH_KEYS: unique symbol = Symbol(
  __DEV__ ? `vOnKeysGuard` : ``,
)

// v-show 指令的运行时处理
export const V_SHOW: unique symbol = Symbol(__DEV__ ? `vShow` : ``)

// Transition 组件的运行时辅助
export const TRANSITION: unique symbol = Symbol(__DEV__ ? `Transition` : ``)

// TransitionGroup 组件的运行时辅助
export const TRANSITION_GROUP: unique symbol = Symbol(
  __DEV__ ? `TransitionGroup` : ``,
)

// 将以上定义的 symbol 注册为编译时辅助函数，映射到实际运行时的函数名或模块名
registerRuntimeHelpers({
  [V_MODEL_RADIO]: `vModelRadio`,
  [V_MODEL_CHECKBOX]: `vModelCheckbox`,
  [V_MODEL_TEXT]: `vModelText`,
  [V_MODEL_SELECT]: `vModelSelect`,
  [V_MODEL_DYNAMIC]: `vModelDynamic`,
  [V_ON_WITH_MODIFIERS]: `withModifiers`,
  [V_ON_WITH_KEYS]: `withKeys`,
  [V_SHOW]: `vShow`,
  [TRANSITION]: `Transition`,
  [TRANSITION_GROUP]: `TransitionGroup`,
})
