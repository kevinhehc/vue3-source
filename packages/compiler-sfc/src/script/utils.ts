import type {
  CallExpression,
  Expression,
  Identifier,
  ImportDefaultSpecifier,
  ImportNamespaceSpecifier,
  ImportSpecifier,
  Node,
  StringLiteral,
} from '@babel/types'
import path from 'path'

// 用于表示无法推断的类型。
export const UNKNOWN_TYPE = 'Unknown'

// 解析对象属性的键名。支持字符串字面量、数字字面量和非计算属性的标识符。如果是 [foo] 这种计算属性，则返回 undefined。
export function resolveObjectKey(
  node: Node,
  computed: boolean,
): string | undefined {
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
      return String(node.value)
    case 'Identifier':
      if (!computed) return node.name
  }
  return undefined
}

// 用于将一组可能为 null/undefined/false 的字符串拼接为一个逗号分隔的字符串，过滤掉无效项。
export function concatStrings(
  strs: Array<string | null | undefined | false>,
): string {
  return strs.filter((s): s is string => !!s).join(', ')
}

// 判断一个 AST 节点是否为字面量节点（即类型名以 "Literal" 结尾）。
export function isLiteralNode(node: Node): boolean {
  return node.type.endsWith('Literal')
}

// 判断一个节点是否是某个函数（如 defineProps、watch 等）的调用。test 参数可以是字符串或函数。
export function isCallOf(
  node: Node | null | undefined,
  test: string | ((id: string) => boolean) | null | undefined,
): node is CallExpression {
  return !!(
    node &&
    test &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    (typeof test === 'string'
      ? node.callee.name === test
      : test(node.callee.name))
  )
}

// 将多个类型组成运行时类型字符串，如果有多个类型则加方括号包裹（如 [String, Number]），否则直接返回单个类型。
export function toRuntimeTypeString(types: string[]): string {
  return types.length > 1 ? `[${types.join(', ')}]` : types[0]
}

// 从 import 语法中提取被导入的名称。适用于 import {}、import * as、import default 三种情况。
export function getImportedName(
  specifier:
    | ImportSpecifier
    | ImportDefaultSpecifier
    | ImportNamespaceSpecifier,
): string {
  if (specifier.type === 'ImportSpecifier')
    return specifier.imported.type === 'Identifier'
      ? specifier.imported.name
      : specifier.imported.value
  else if (specifier.type === 'ImportNamespaceSpecifier') return '*'
  return 'default'
}

export function getId(node: Identifier | StringLiteral): string
export function getId(node: Expression): string | null
// 从一个表达式中获取标识符名或字符串值（例如 node 是 Identifier 或 StringLiteral），否则返回 null。
export function getId(node: Expression) {
  return node.type === 'Identifier'
    ? node.name
    : node.type === 'StringLiteral'
      ? node.value
      : null
}

// 恒等函数，直接返回输入值。
const identity = (str: string) => str
// 匹配所有不属于某些特殊字符范围的字符，用于统一大小写处理。
const fileNameLowerCaseRegExp = /[^\u0130\u0131\u00DFa-z0-9\\/:\-_\. ]+/g
// 将字符串转为小写。
const toLowerCase = (str: string) => str.toLowerCase()

// 把路径名中非法字符部分变为小写，支持用于不区分大小写的文件系统。
function toFileNameLowerCase(x: string) {
  return fileNameLowerCaseRegExp.test(x)
    ? x.replace(fileNameLowerCaseRegExp, toLowerCase)
    : x
}

/**
 * We need `getCanonicalFileName` when creating ts module resolution cache,
 * but TS does not expose it directly. This implementation is repllicated from
 * the TS source code.
 */
// 用于创建统一格式的文件名（大小写处理），适配 TS 模块缓存机制。
export function createGetCanonicalFileName(
  useCaseSensitiveFileNames: boolean,
): (str: string) => string {
  return useCaseSensitiveFileNames ? identity : toFileNameLowerCase
}

// in the browser build, the polyfill doesn't expose posix, but defaults to
// posix behavior.
const normalize = (path.posix || path).normalize
const windowsSlashRE = /\\/g
// // 把路径标准化并将反斜杠（Windows）替换为正斜杠。
export function normalizePath(p: string): string {
  return normalize(p.replace(windowsSlashRE, '/'))
}

// 使用 path.posix.join 或默认的 path.join 拼接路径。
export const joinPaths: (...paths: string[]) => string = (path.posix || path)
  .join

/**
 * key may contain symbols
 * e.g. onUpdate:modelValue -> "onUpdate:modelValue"
 */
// 用于检测 prop 名称中是否包含特殊字符（如冒号、破折号、空格等），决定是否要进行字符串转义。
export const propNameEscapeSymbolsRE: RegExp =
  /[ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~\-]/

// 如果 prop 名称中包含特殊字符，就对其进行 JSON 字符串化（加引号），否则直接返回原样。
export function getEscapedPropName(key: string): string {
  return propNameEscapeSymbolsRE.test(key) ? JSON.stringify(key) : key
}
