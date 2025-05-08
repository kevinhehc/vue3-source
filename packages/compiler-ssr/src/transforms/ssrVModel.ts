import {
  DOMErrorCodes,
  type DirectiveTransform,
  ElementTypes,
  type ExpressionNode,
  NodeTypes,
  type PlainElementNode,
  type TemplateChildNode,
  createCallExpression,
  createConditionalExpression,
  createDOMCompilerError,
  createInterpolation,
  createObjectProperty,
  createSimpleExpression,
  findProp,
  hasDynamicKeyVBind,
  transformModel,
} from '@vue/compiler-dom'
import {
  SSR_INCLUDE_BOOLEAN_ATTR,
  SSR_LOOSE_CONTAIN,
  SSR_LOOSE_EQUAL,
  SSR_RENDER_DYNAMIC_MODEL,
} from '../runtimeHelpers'
import type { DirectiveTransformResult } from 'packages/compiler-core/src/transform'

// Vue 3 SSR 编译器中处理 v-model 指令的核心逻辑，属于 ssrTransformModel 插件。
// 它负责将 v-model 应用于各种 HTML 表单元素，并将其转化为适合 SSR 渲染的代码。

// 将 <input v-model="foo"> 等转换为服务端可渲染的 DOM 属性（如 checked、value、selected）表达式，
// 确保 服务端渲染出的 HTML 与客户端绑定的状态一致。

export const ssrTransformModel: DirectiveTransform = (dir, node, context) => {
  const model = dir.exp!

  // 避免以下冲突写法：
  // <input v-model="foo" value="bar" /> <!-- 错误！ -->
  // 此时会报错：
  // X_V_MODEL_UNNECESSARY_VALUE
  function checkDuplicatedValue() {
    const value = findProp(node, 'value')
    if (value) {
      context.onError(
        createDOMCompilerError(
          DOMErrorCodes.X_V_MODEL_UNNECESSARY_VALUE,
          value.loc,
        ),
      )
    }
  }

  function processOption(plainNode: PlainElementNode) {
    if (plainNode.tag === 'option') {
      if (plainNode.props.findIndex(p => p.name === 'selected') === -1) {
        const value = findValueBinding(plainNode)
        plainNode.ssrCodegenNode!.elements.push(
          createConditionalExpression(
            createCallExpression(context.helper(SSR_INCLUDE_BOOLEAN_ATTR), [
              createConditionalExpression(
                createCallExpression(`Array.isArray`, [model]),
                createCallExpression(context.helper(SSR_LOOSE_CONTAIN), [
                  model,
                  value,
                ]),
                createCallExpression(context.helper(SSR_LOOSE_EQUAL), [
                  model,
                  value,
                ]),
              ),
            ]),
            createSimpleExpression(' selected', true),
            createSimpleExpression('', true),
            false /* no newline */,
          ),
        )
      }
    } else if (plainNode.tag === 'optgroup') {
      plainNode.children.forEach(option =>
        processOption(option as PlainElementNode),
      )
    }
  }

  if (node.tagType === ElementTypes.ELEMENT) {
    const res: DirectiveTransformResult = { props: [] }
    const defaultProps = [
      // default value binding for text type inputs
      createObjectProperty(`value`, model),
    ]
    // 根据 node.tag 的不同，分别处理：
    // 元素类型	行为
    // <input>	根据 type 生成 checked 或 value 属性
    // <textarea>	插入内容文本（由 model 表达式渲染）
    // <select> 和 <option>	标记 <option selected>
    // 组件	转发给 transformModel(...)
    // 其他标签	报错（非法用法）
    if (node.tag === 'input') {
      const type = findProp(node, 'type')
      if (type) {
        const value = findValueBinding(node)
        if (type.type === NodeTypes.DIRECTIVE) {
          // dynamic type
          res.ssrTagParts = [
            createCallExpression(context.helper(SSR_RENDER_DYNAMIC_MODEL), [
              type.exp!,
              model,
              value,
            ]),
          ]
        } else if (type.value) {
          // static type
          switch (type.value.content) {
            case 'radio':
              res.props = [
                createObjectProperty(
                  `checked`,
                  createCallExpression(context.helper(SSR_LOOSE_EQUAL), [
                    model,
                    value,
                  ]),
                ),
              ]
              break
            case 'checkbox':
              const trueValueBinding = findProp(node, 'true-value')
              if (trueValueBinding) {
                const trueValue =
                  trueValueBinding.type === NodeTypes.ATTRIBUTE
                    ? JSON.stringify(trueValueBinding.value!.content)
                    : trueValueBinding.exp!
                res.props = [
                  createObjectProperty(
                    `checked`,
                    createCallExpression(context.helper(SSR_LOOSE_EQUAL), [
                      model,
                      trueValue,
                    ]),
                  ),
                ]
              } else {
                res.props = [
                  createObjectProperty(
                    `checked`,
                    createConditionalExpression(
                      createCallExpression(`Array.isArray`, [model]),
                      createCallExpression(context.helper(SSR_LOOSE_CONTAIN), [
                        model,
                        value,
                      ]),
                      model,
                    ),
                  ),
                ]
              }
              break
            case 'file':
              context.onError(
                createDOMCompilerError(
                  DOMErrorCodes.X_V_MODEL_ON_FILE_INPUT_ELEMENT,
                  dir.loc,
                ),
              )
              break
            default:
              checkDuplicatedValue()
              res.props = defaultProps
              break
          }
        }
      } else if (hasDynamicKeyVBind(node)) {
        // dynamic type due to dynamic v-bind
        // NOOP, handled in ssrTransformElement due to need to rewrite
        // the entire props expression
      } else {
        // text type
        checkDuplicatedValue()
        res.props = defaultProps
      }
    } else if (node.tag === 'textarea') {
      checkDuplicatedValue()
      node.children = [createInterpolation(model, model.loc)]
    } else if (node.tag === 'select') {
      const processChildren = (children: TemplateChildNode[]) => {
        children.forEach(child => {
          if (child.type === NodeTypes.ELEMENT) {
            processOption(child as PlainElementNode)
          } else if (child.type === NodeTypes.FOR) {
            processChildren(child.children)
          } else if (child.type === NodeTypes.IF) {
            child.branches.forEach(b => processChildren(b.children))
          }
        })
      }
      processChildren(node.children)
    } else {
      context.onError(
        createDOMCompilerError(
          DOMErrorCodes.X_V_MODEL_ON_INVALID_ELEMENT,
          dir.loc,
        ),
      )
    }

    return res
  } else {
    // component v-model
    return transformModel(dir, node, context)
  }
  // 表单类型	SSR 编译行为
  // input[type=text]	输出 value="{{ model }}"
  // input[type=checkbox]	输出 checked 取决于数组包含或布尔值
  // input[type=radio]	输出 checked 判断值相等
  // textarea	直接用 {{ model }} 插入为 children
  // select + option	根据是否匹配设定 selected 属性
  // 组件	使用 transformModel()
}

function findValueBinding(node: PlainElementNode): ExpressionNode {
  const valueBinding = findProp(node, 'value')
  return valueBinding
    ? valueBinding.type === NodeTypes.DIRECTIVE
      ? valueBinding.exp!
      : createSimpleExpression(valueBinding.value!.content, true)
    : createSimpleExpression(`null`, false)
}
