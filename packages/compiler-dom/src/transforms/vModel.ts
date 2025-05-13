import {
  type DirectiveTransform,
  ElementTypes,
  NodeTypes,
  transformModel as baseTransform,
  findDir,
  findProp,
  hasDynamicKeyVBind,
  isStaticArgOf,
} from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'
import {
  V_MODEL_CHECKBOX,
  V_MODEL_DYNAMIC,
  V_MODEL_RADIO,
  V_MODEL_SELECT,
  V_MODEL_TEXT,
} from '../runtimeHelpers'

// 用于处理 v-model 指令的核心转换函数 transformModel。
// 它根据指令作用的 HTML 元素（如 input, select, textarea）或组件，生成对应的运行时代码，并在必要时发出错误提示或警告。
export const transformModel: DirectiveTransform = (dir, node, context) => {
  // 使用通用的 baseTransform 获取初步处理结果；
  // 如果是组件或未生成属性，直接返回（组件的 v-model 会走组件路径，不在这里处理）。
  const baseResult = baseTransform(dir, node, context)
  // base transform has errors OR component v-model (only need props)
  if (!baseResult.props.length || node.tagType === ElementTypes.COMPONENT) {
    return baseResult
  }

  // 错误检查：不允许在 DOM 元素上使用 v-model:arg
  if (dir.arg) {
    // v-model="foo" 是合法的；
    // v-model:someProp="foo" 只允许用于组件，不允许用于原生元素。
    context.onError(
      createDOMCompilerError(
        DOMErrorCodes.X_V_MODEL_ARG_ON_ELEMENT,
        dir.arg.loc,
      ),
    )
  }

  // 如果使用了 v-model 还手动绑定了 :value，就多此一举，应该提示开发者。
  function checkDuplicatedValue() {
    const value = findDir(node, 'bind')
    if (value && isStaticArgOf(value.arg, 'value')) {
      context.onError(
        createDOMCompilerError(
          DOMErrorCodes.X_V_MODEL_UNNECESSARY_VALUE,
          value.loc,
        ),
      )
    }
  }

  const { tag } = node
  const isCustomElement = context.isCustomElement(tag)
  // Vue 针对这几种元素有不同的 vModel 运行时实现。
  if (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    isCustomElement
  ) {
    let directiveToUse = V_MODEL_TEXT
    let isInvalidType = false
    if (tag === 'input' || isCustomElement) {
      // 如果 type 是动态绑定的（:type="foo"），使用 V_MODEL_DYNAMIC；
      // 如果是静态类型：
      // 'radio' → V_MODEL_RADIO
      // 'checkbox' → V_MODEL_CHECKBOX
      // 'file' → 报错：不支持 v-model（文件输入不能用 v-model）；
      // 其他类型 → 默认为 V_MODEL_TEXT，并在开发环境检查冗余 value 绑定。
      const type = findProp(node, `type`)
      if (type) {
        if (type.type === NodeTypes.DIRECTIVE) {
          // :type="foo"
          directiveToUse = V_MODEL_DYNAMIC
        } else if (type.value) {
          switch (type.value.content) {
            case 'radio':
              directiveToUse = V_MODEL_RADIO
              break
            case 'checkbox':
              directiveToUse = V_MODEL_CHECKBOX
              break
            case 'file':
              isInvalidType = true
              context.onError(
                createDOMCompilerError(
                  DOMErrorCodes.X_V_MODEL_ON_FILE_INPUT_ELEMENT,
                  dir.loc,
                ),
              )
              break
            default:
              // text type
              __DEV__ && checkDuplicatedValue()
              break
          }
        }
      } else if (hasDynamicKeyVBind(node)) {
        // element has bindings with dynamic keys, which can possibly contain
        // "type".
        directiveToUse = V_MODEL_DYNAMIC
      } else {
        // text type
        __DEV__ && checkDuplicatedValue()
      }
    } else if (tag === 'select') {
      directiveToUse = V_MODEL_SELECT
    } else {
      // textarea
      __DEV__ && checkDuplicatedValue()
    }
    // inject runtime directive
    // by returning the helper symbol via needRuntime
    // the import will replaced a resolveDirective call.
    if (!isInvalidType) {
      // 通过 needRuntime 返回特定指令类型，Vue 编译器会将它注入渲染函数中：
      baseResult.needRuntime = context.helper(directiveToUse)
    }
  } else {
    context.onError(
      createDOMCompilerError(
        DOMErrorCodes.X_V_MODEL_ON_INVALID_ELEMENT,
        dir.loc,
      ),
    )
  }

  // native vmodel doesn't need the `modelValue` props since they are also
  // passed to the runtime as `binding.value`. removing it reduces code size.
  // 对于原生元素，modelValue 是多余的，因为它会通过绑定值传给 runtime 指令，这里移除以优化体积。
  baseResult.props = baseResult.props.filter(
    p =>
      !(
        p.key.type === NodeTypes.SIMPLE_EXPRESSION &&
        p.key.content === 'modelValue'
      ),
  )

  return baseResult
}
