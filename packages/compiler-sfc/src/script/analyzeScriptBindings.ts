import type {
  ArrayExpression,
  Node,
  ObjectExpression,
  Statement,
} from '@babel/types'
import { type BindingMetadata, BindingTypes } from '@vue/compiler-dom'
import { resolveObjectKey } from './utils'

/**
 * Analyze bindings in normal `<script>`
 * Note that `compileScriptSetup` already analyzes bindings as part of its
 * compilation process so this should only be used on single `<script>` SFCs.
 */
// 分析 SFC（单文件组件）中 <script> 标签内的变量绑定情况，用于支持自动注入、宏语法、类型提示等功能。
// 传入 AST（JavaScript 顶层语法树节点数组），返回一个 BindingMetadata 对象，表示脚本中定义了哪些变量（props、methods、data、computed 等）。
// 仅适用于 普通 <script> 标签（非 <script setup>）。因为 <script setup> 会在 compileScriptSetup 中独立处理。
export function analyzeScriptBindings(ast: Statement[]): BindingMetadata {
  // 遍历所有顶层语句（AST 节点）
  for (const node of ast) {
    // 查找 export default { ... } 语句，即组件的默认导出对象
    if (
      node.type === 'ExportDefaultDeclaration' &&
      node.declaration.type === 'ObjectExpression'
    ) {
      // 果找到了这样的对象结构，调用 analyzeBindingsFromOptions(...) 进一步分析这个对象的属性（如 data(), methods, props 等），提取其中定义的变量名和绑定类型
      // 如果没有找到符合条件的 export default 对象，返回空对象（即未发现绑定）
      // 这个函数会进一步分析 Vue 选项式 API 中的内容，如：
      // props: ['title', 'count'] → 标记为 prop
      // data() { return { foo, bar } } → 标记为 data
      // methods: { doSomething() {} } → 标记为 method
      // computed: { msg() {} } → 标记为 computed
      return analyzeBindingsFromOptions(node.declaration)
    }
  }
  return {}
}

// 用于收集组件中通过 props、data、methods、setup 等方式定义的变量，标记其绑定类型（如 props、data、computed 等），为 IDE 类型提示、宏注入、AST 编译等提供基础信息。
// node: AST 中 export default { ... } 的对象表达式部分
// 返回值：一个 BindingMetadata 对象，结构是 { [key: string]: BindingTypes }
function analyzeBindingsFromOptions(node: ObjectExpression): BindingMetadata {
  // 创建一个空对象用于存储变量绑定类型
  const bindings: BindingMetadata = {}
  // #3270, #3275
  // mark non-script-setup so we don't resolve components/directives from these
  // 添加一个非枚举属性 __isScriptSetup = false，标记这是 普通 <script> 的绑定（非 <script setup>）
  Object.defineProperty(bindings, '__isScriptSetup', {
    enumerable: false,
    value: false,
  })
  for (const property of node.properties) {
    if (
      property.type === 'ObjectProperty' &&
      !property.computed &&
      property.key.type === 'Identifier'
    ) {
      // props
      // 处理 props
      if (property.key.name === 'props') {
        // props: ['foo']
        // props: { foo: ... }
        // 支持 props: ['a'] 和 props: { a: ... }
        // 将 key 标记为 BindingTypes.PROPS
        for (const key of getObjectOrArrayExpressionKeys(property.value)) {
          bindings[key] = BindingTypes.PROPS
        }
      }

      // inject
      //  处理 inject
      else if (property.key.name === 'inject') {
        // inject: ['foo']
        // inject: { foo: {} }
        for (const key of getObjectOrArrayExpressionKeys(property.value)) {
          // inject: ['x'] 或 inject: { x: ... }
          // 将注入项标记为 BindingTypes.OPTIONS
          bindings[key] = BindingTypes.OPTIONS
        }
      }

      // computed & methods
      // 处理 methods 和 computed
      else if (
        property.value.type === 'ObjectExpression' &&
        (property.key.name === 'computed' || property.key.name === 'methods')
      ) {
        // methods: { foo() {} }
        // computed: { foo() {} }
        // 标记方法名和计算属性名为 OPTIONS
        // 支持写法：methods: { doSomething() {} }
        for (const key of getObjectExpressionKeys(property.value)) {
          bindings[key] = BindingTypes.OPTIONS
        }
      }
    }

    // setup & data
    // 处理 setup() 和 data() 返回的对象
    else if (
      property.type === 'ObjectMethod' &&
      property.key.type === 'Identifier' &&
      (property.key.name === 'setup' || property.key.name === 'data')
    ) {
      // 识别 setup() 和 data() 函数体中的 return { a, b }
      // 对其中的变量做绑定标记
      // setup 返回的变量 → SETUP_MAYBE_REF（可能是 ref）
      // data 返回的变量 → DATA
      for (const bodyItem of property.body.body) {
        // setup() {
        //   return {
        //     foo: null
        //   }
        // }
        if (
          bodyItem.type === 'ReturnStatement' &&
          bodyItem.argument &&
          bodyItem.argument.type === 'ObjectExpression'
        ) {
          for (const key of getObjectExpressionKeys(bodyItem.argument)) {
            bindings[key] =
              property.key.name === 'setup'
                ? BindingTypes.SETUP_MAYBE_REF
                : BindingTypes.DATA
          }
        }
      }
    }
  }

  return bindings
}

// 用于提取 JavaScript 对象字面量（ObjectExpression）中的键名数组，忽略不能静态分析的部分。
// 它被用于 Vue 编译器中分析如 data(), computed, methods 返回对象的属性名。
// 参数：
// node: 一个对象表达式（AST 节点），比如 { foo: 1, ['bar']: 2 }
// 返回：
// 对象中可以静态确定的键名数组（字符串列表）
function getObjectExpressionKeys(node: ObjectExpression): string[] {
  const keys = []
  for (const prop of node.properties) {
    // 遍历对象的每个属性（ObjectProperty, ObjectMethod, 也可能是 SpreadElement）
    // 跳过扩展操作符（...），因为无法静态确定具体属性
    if (prop.type === 'SpreadElement') continue
    // 调用 resolveObjectKey（Vue 内部工具函数），尝试静态解析属性名：
    // foo → 'foo'
    // 'bar' → 'bar'
    // [foo]（动态）→ 解析失败 → null
    const key = resolveObjectKey(prop.key, prop.computed)
    if (key) keys.push(String(key))
  }
  return keys
}

// 用于从一个数组字面量（AST 中的 ArrayExpression）中提取所有静态字符串项，常用于处理像 props: ['a', 'b'] 这样的语法。
// 参数说明：
// node: 一个 JavaScript AST 节点，类型为 ArrayExpression，对应于数组字面量表达式，如 ['foo', 'bar']
// 返回值：
// 返回一个字符串数组，包含该数组中所有静态字符串项的值
function getArrayExpressionKeys(node: ArrayExpression): string[] {
  const keys = []
  // 遍历数组中的每一个元素，例如 ['foo', 'bar', someVar] 会有 3 个元素
  for (const element of node.elements) {
    // 忽略空位（element == null）
    // 忽略非字符串项（例如 42, true, 变量引用等）
    // 如果元素是字符串字面量（如 'foo'），就提取其值并加入结果列表
    if (element && element.type === 'StringLiteral') {
      keys.push(element.value)
    }
  }
  return keys
}

// 用于从 AST 中提取静态键名，无论传入的是数组字面量还是对象字面量。
// 参数说明：
// value: 一个 AST 节点（类型为 Node），可能是 ArrayExpression 或 ObjectExpression，也可能是其他类型。
// 返回值：
// 静态字符串键名数组。
export function getObjectOrArrayExpressionKeys(value: Node): string[] {
  // 如果传入的是数组表达式，例如：
  // ['a', 'b']
  if (value.type === 'ArrayExpression') {
    // 调用 getArrayExpressionKeys() 提取其中的静态字符串项。
    return getArrayExpressionKeys(value)
  }
  if (value.type === 'ObjectExpression') {
    // 如果传入的是对象表达式，例如：
    // { a: ..., ['b']: ... }
    // 调用 getObjectExpressionKeys() 提取静态属性名。
    return getObjectExpressionKeys(value)
  }
  return []
}
