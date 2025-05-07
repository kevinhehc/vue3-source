import type { SFCDescriptor } from '../parse'
import {
  type ExpressionNode,
  NodeTypes,
  type SimpleExpressionNode,
  type TemplateChildNode,
  parserOptions,
  walkIdentifiers,
} from '@vue/compiler-dom'
import { createCache } from '../cache'
import { camelize, capitalize, isBuiltInDirective } from '@vue/shared'

/**
 * Check if an import is used in the SFC's template. This is used to determine
 * the properties that should be included in the object returned from setup()
 * when not using inline mode.
 */
// 是一个用于检测某个导入（如组件、函数、常量等）是否在单文件组件（SFC）的模板中被使用的函数。
// 如果某个导入的名称在模板中有使用，那么我们在 setup() 返回对象时（当不是使用 inline 模式时）就需要把它返回出去。这样模板才能访问它。
export function isImportUsed(local: string, sfc: SFCDescriptor): boolean {
  // local: 是导入的本地名称，例如 ref、MyComponent 等。
  // sfc: 是整个 .vue 文件的描述对象（SFCDescriptor），包含 <template>、<script>、<style> 等块的信息。
  return resolveTemplateUsedIdentifiers(sfc).has(local)
}

// 一个缓存对象，由 createCache() 创建，用于缓存模板中用到的标识符集合，避免重复解析 AST，提高编译效率。
const templateUsageCheckCache = createCache<Set<string>>()

// 分析 .vue 文件中的 <template> 区块，提取出所有在模板中使用到的变量名（标识符），用于判断哪些 script 中声明的变量需要暴露给模板使用。
function resolveTemplateUsedIdentifiers(sfc: SFCDescriptor): Set<string> {
  // 获取模板内容和 AST，如果模板中之前已经处理过该内容（通过缓存 templateUsageCheckCache），就直接返回缓存结
  const { content, ast } = sfc.template!
  const cached = templateUsageCheckCache.get(content)
  if (cached) {
    return cached
  }

  // 创建一个 Set<string> 类型的集合 ids，用于存放识别出的变量名。
  const ids = new Set<string>()

  // 遍历模板 AST 的所有顶层子节点，递归调用 walk() 进行处理。
  ast!.children.forEach(walk)

  function walk(node: TemplateChildNode) {
    switch (node.type) {
      case NodeTypes.ELEMENT:
        // 如果是元素节点（ELEMENT）：
        let tag = node.tag
        // 提取组件标签名，如果标签不是原生标签或内置组件（比如 <div> 或 <Transition>），则将它作为变量名加入 ids（包括 camelCase 和 PascalCase 两种形式）。
        if (tag.includes('.')) tag = tag.split('.')[0].trim()
        if (
          !parserOptions.isNativeTag!(tag) &&
          !parserOptions.isBuiltInComponent!(tag)
        ) {
          ids.add(camelize(tag))
          ids.add(capitalize(camelize(tag)))
        }
        // 历该元素的所有属性：
        for (let i = 0; i < node.props.length; i++) {
          const prop = node.props[i]
          // 如果属性是指令（DIRECTIVE）：
          if (prop.type === NodeTypes.DIRECTIVE) {
            if (!isBuiltInDirective(prop.name)) {
              // 如果是自定义指令，则加入形如 vMyDirective 的变量名。
              ids.add(`v${capitalize(camelize(prop.name))}`)
            }

            // process dynamic directive arguments
            if (prop.arg && !(prop.arg as SimpleExpressionNode).isStatic) {
              // 如果指令有动态参数（如 :[foo]），提取表达式里的变量。
              extractIdentifiers(ids, prop.arg)
            }

            if (prop.name === 'for') {
              // 特别处理 v-for，提取源表达式（如 item in items）。
              extractIdentifiers(ids, prop.forParseResult!.source)
            } else if (prop.exp) {
              // 如果是一般指令（如 v-model="msg"），提取表达式里的变量。
              extractIdentifiers(ids, prop.exp)
            } else if (prop.name === 'bind' && !prop.exp) {
              // v-bind shorthand name as identifier
              // 对于 v-bind 没有绑定值的情况，如 v-bind:foo，也提取属性名作为变量。
              ids.add(camelize((prop.arg as SimpleExpressionNode).content))
            }
          }
          if (
            prop.type === NodeTypes.ATTRIBUTE &&
            prop.name === 'ref' &&
            prop.value?.content
          ) {
            // 如果属性是 ref 并且是静态字符串值，也把这个字符串加入变量名（ref="myEl" → "myEl"）。
            ids.add(prop.value.content)
          }
        }
        // 递归处理子元素节点。
        node.children.forEach(walk)
        break
      case NodeTypes.INTERPOLATION:
        // 如果是插值表达式（{{ msg }}），提取表达式中出现的变量名。
        extractIdentifiers(ids, node.content)
        break
    }
  }

  // 遍历完成后，把结果缓存到 templateUsageCheckCache 中，避免重复解析。
  templateUsageCheckCache.set(content, ids)
  return ids
}

// 从模板表达式中提取出所有使用到的变量名（标识符），并添加到传入的 Set<string> 集合中。
function extractIdentifiers(ids: Set<string>, node: ExpressionNode) {
  // ids: 一个 Set<string> 集合，用于存放提取出的标识符名称。
  // node: 模板中的表达式节点，类型是 ExpressionNode，通常来自插值、指令表达式等。

  if (node.ast) {
    // 判断这个表达式节点是否已经被编译器附加了 ast 属性（通常是 @vue/compiler-dom 提前解析生成的 JavaScript AST）：
    // 如果存在 node.ast，说明表达式已经被解析为 JS AST，那么通过 walkIdentifiers 遍历所有标识符节点，并将它们的名字加到 ids 中。
    walkIdentifiers(node.ast, n => ids.add(n.name))
  } else if (node.ast === null) {
    // 如果 node.ast === null，说明这是一个简单表达式（未被解析），比如静态字符串 foo，那就直接将它的 content 作为标识符加入集合。
    ids.add((node as SimpleExpressionNode).content)
  }
}
