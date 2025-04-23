// 引入运行时辅助函数，用于注册过滤器解析器
import { RESOLVE_FILTER } from '../runtimeHelpers'
// 导入 AST 节点类型定义
import {
  type AttributeNode,
  type DirectiveNode,
  type ExpressionNode,
  NodeTypes,
  type SimpleExpressionNode,
} from '../ast'
// 导入兼容性检测与警告工具
import {
  CompilerDeprecationTypes,
  isCompatEnabled,
  warnDeprecation,
} from './compatConfig'
// 导入编译阶段的转换上下文类型定义
import type { NodeTransform, TransformContext } from '../transform'
// 工具函数：将资产名称转换为合法的标识符（如过滤器名）
import { toValidAssetId } from '../utils'

// 正则：判断一个字符是否可能出现在除号前（避免将正则误判为除法）
const validDivisionCharRE = /[\w).+\-_$\]]/

// 过滤器的转换插件（NodeTransform 类型）
export const transformFilter: NodeTransform = (node, context) => {
  // 如果该兼容项未启用，直接返回
  if (!isCompatEnabled(CompilerDeprecationTypes.COMPILER_FILTERS, context)) {
    return
  }

  // 针对插值表达式，例如 {{ msg | capitalize }}
  if (node.type === NodeTypes.INTERPOLATION) {
    // filter rewrite is applied before expression transform so only
    // simple expressions are possible at this stage
    // 表达式转换前处理过滤器
    rewriteFilter(node.content, context)
  } else if (node.type === NodeTypes.ELEMENT) {
    // 对于元素节点，遍历其所有属性（包含指令）
    node.props.forEach((prop: AttributeNode | DirectiveNode) => {
      // 忽略 v-for 指令，但处理其余有表达式的指令
      if (
        prop.type === NodeTypes.DIRECTIVE &&
        prop.name !== 'for' &&
        prop.exp
      ) {
        rewriteFilter(prop.exp, context)
      }
    })
  }
}

// 递归解析表达式节点中的过滤器
function rewriteFilter(node: ExpressionNode, context: TransformContext) {
  if (node.type === NodeTypes.SIMPLE_EXPRESSION) {
    // 简单表达式直接处理
    parseFilter(node, context)
  } else {
    // 否则递归遍历其子节点
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (typeof child !== 'object') continue
      if (child.type === NodeTypes.SIMPLE_EXPRESSION) {
        parseFilter(child, context)
      } else if (child.type === NodeTypes.COMPOUND_EXPRESSION) {
        rewriteFilter(node, context)
      } else if (child.type === NodeTypes.INTERPOLATION) {
        rewriteFilter(child.content, context)
      }
    }
  }
}

// 解析并转换过滤器表达式
function parseFilter(node: SimpleExpressionNode, context: TransformContext) {
  const exp = node.content
  let inSingle = false
  let inDouble = false
  let inTemplateString = false
  let inRegex = false
  let curly = 0
  let square = 0
  let paren = 0
  let lastFilterIndex = 0
  let c,
    prev,
    i: number,
    expression,
    filters: string[] = []

  // 遍历表达式的字符，查找管道符号 `|` 作为过滤器分隔
  for (i = 0; i < exp.length; i++) {
    prev = c
    c = exp.charCodeAt(i)
    // 检测字符串、模板字符串、正则等包围范围
    if (inSingle) {
      // 结束单引号字符串
      if (c === 0x27 && prev !== 0x5c) inSingle = false
    } else if (inDouble) {
      // 结束双引号字符串
      if (c === 0x22 && prev !== 0x5c) inDouble = false
    } else if (inTemplateString) {
      if (c === 0x60 && prev !== 0x5c) inTemplateString = false
    } else if (inRegex) {
      if (c === 0x2f && prev !== 0x5c) inRegex = false
    } else if (
      c === 0x7c && // pipe // 管道符
      exp.charCodeAt(i + 1) !== 0x7c && // 排除 ||
      exp.charCodeAt(i - 1) !== 0x7c &&
      // 确保不是在复杂结构中
      !curly &&
      !square &&
      !paren
    ) {
      // 第一个过滤器前的表达式
      if (expression === undefined) {
        // first filter, end of expression
        lastFilterIndex = i + 1
        expression = exp.slice(0, i).trim()
      } else {
        // 推入一个过滤器
        pushFilter()
      }
    } else {
      // 括号与结构计数维护
      switch (c) {
        case 0x22:
          inDouble = true
          break // "
        case 0x27:
          inSingle = true
          break // '
        case 0x60:
          inTemplateString = true
          break // `
        case 0x28:
          paren++
          break // (
        case 0x29:
          paren--
          break // )
        case 0x5b:
          square++
          break // [
        case 0x5d:
          square--
          break // ]
        case 0x7b:
          curly++
          break // {
        case 0x7d:
          curly--
          break // }
      }
      // 判断是否为正则表达式的开头
      if (c === 0x2f) {
        // /
        let j = i - 1
        let p
        // find first non-whitespace prev char
        for (; j >= 0; j--) {
          p = exp.charAt(j)
          if (p !== ' ') break
        }
        if (!p || !validDivisionCharRE.test(p)) {
          inRegex = true
        }
      }
    }
  }

  // 最后一个表达式或过滤器
  if (expression === undefined) {
    expression = exp.slice(0, i).trim()
  } else if (lastFilterIndex !== 0) {
    pushFilter()
  }

  // 过滤器截取工具函数
  function pushFilter() {
    filters.push(exp.slice(lastFilterIndex, i).trim())
    lastFilterIndex = i + 1
  }

  // 如果包含过滤器，转换为函数调用形式
  if (filters.length) {
    __DEV__ &&
      warnDeprecation(
        CompilerDeprecationTypes.COMPILER_FILTERS,
        context,
        node.loc,
      )
    for (i = 0; i < filters.length; i++) {
      expression = wrapFilter(expression, filters[i], context)
    }
    node.content = expression
    // reset ast since the content is replaced
    // 清除旧 AST，表达式已被修改
    node.ast = undefined
  }
}

// 将过滤器表达式包装成函数调用形式
function wrapFilter(
  exp: string,
  filter: string,
  context: TransformContext,
): string {
  // 注册运行时过滤器解析器
  context.helper(RESOLVE_FILTER)
  const i = filter.indexOf('(')
  if (i < 0) {
    // 没有参数的过滤器
    context.filters!.add(filter)
    return `${toValidAssetId(filter, 'filter')}(${exp})`
  } else {
    // 带参数的过滤器
    const name = filter.slice(0, i)
    const args = filter.slice(i + 1)
    context.filters!.add(name)
    return `${toValidAssetId(name, 'filter')}(${exp}${
      args !== ')' ? ',' + args : args
    }`
  }
}
