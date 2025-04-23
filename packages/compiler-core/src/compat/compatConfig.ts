// 类型导入：源代码位置类型
import type { SourceLocation } from '../ast'
// 类型导入：编译器错误对象
import type { CompilerError } from '../errors'
// 类型导入：解析器选项（合并后的配置）
import type { MergedParserOptions } from '../parser'
// 类型导入：转换上下文
import type { TransformContext } from '../transform'

// 定义兼容性配置的类型，键是枚举，值是布尔值或 'suppress-warning'
// 还可包含 MODE 字段指定是 Vue 2 还是 Vue 3
export type CompilerCompatConfig = Partial<
  Record<CompilerDeprecationTypes, boolean | 'suppress-warning'>
> & {
  MODE?: 2 | 3
}

// 编译器兼容选项接口（通常由用户传入）
export interface CompilerCompatOptions {
  compatConfig?: CompilerCompatConfig
}

// 枚举：列出所有 Vue 2 特性中已被废弃的类型，供兼容处理
export enum CompilerDeprecationTypes {
  COMPILER_IS_ON_ELEMENT = 'COMPILER_IS_ON_ELEMENT',
  COMPILER_V_BIND_SYNC = 'COMPILER_V_BIND_SYNC',
  COMPILER_V_BIND_OBJECT_ORDER = 'COMPILER_V_BIND_OBJECT_ORDER',
  COMPILER_V_ON_NATIVE = 'COMPILER_V_ON_NATIVE',
  COMPILER_V_IF_V_FOR_PRECEDENCE = 'COMPILER_V_IF_V_FOR_PRECEDENCE',
  COMPILER_NATIVE_TEMPLATE = 'COMPILER_NATIVE_TEMPLATE',
  COMPILER_INLINE_TEMPLATE = 'COMPILER_INLINE_TEMPLATE',
  COMPILER_FILTERS = 'COMPILER_FILTERS',
}

// 废弃特性的说明数据结构
type DeprecationData = {
  // 支持静态字符串或函数
  message: string | ((...args: any[]) => string)
  // 可选的文档链接
  link?: string
}

// 每个废弃特性的具体说明信息及文档链接
const deprecationData: Record<CompilerDeprecationTypes, DeprecationData> = {
  [CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT]: {
    message:
      `Platform-native elements with "is" prop will no longer be ` +
      `treated as components in Vue 3 unless the "is" value is explicitly ` +
      `prefixed with "vue:".`,
    link: `https://v3-migration.vuejs.org/breaking-changes/custom-elements-interop.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_BIND_SYNC]: {
    message: key =>
      `.sync modifier for v-bind has been removed. Use v-model with ` +
      `argument instead. \`v-bind:${key}.sync\` should be changed to ` +
      `\`v-model:${key}\`.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-model.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER]: {
    message:
      `v-bind="obj" usage is now order sensitive and behaves like JavaScript ` +
      `object spread: it will now overwrite an existing non-mergeable attribute ` +
      `that appears before v-bind in the case of conflict. ` +
      `To retain 2.x behavior, move v-bind to make it the first attribute. ` +
      `You can also suppress this warning if the usage is intended.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-bind.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_ON_NATIVE]: {
    message: `.native modifier for v-on has been removed as is no longer necessary.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-on-native-modifier-removed.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE]: {
    message:
      `v-if / v-for precedence when used on the same element has changed ` +
      `in Vue 3: v-if now takes higher precedence and will no longer have ` +
      `access to v-for scope variables. It is best to avoid the ambiguity ` +
      `with <template> tags or use a computed property that filters v-for ` +
      `data source.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-if-v-for.html`,
  },

  [CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE]: {
    message:
      `<template> with no special directives will render as a native template ` +
      `element instead of its inner content in Vue 3.`,
  },

  [CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE]: {
    message: `"inline-template" has been removed in Vue 3.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/inline-template-attribute.html`,
  },

  [CompilerDeprecationTypes.COMPILER_FILTERS]: {
    message:
      `filters have been removed in Vue 3. ` +
      `The "|" symbol will be treated as native JavaScript bitwise OR operator. ` +
      `Use method calls or computed properties instead.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/filters.html`,
  },
}

// 获取指定兼容项或 MODE 的值
function getCompatValue(
  key: CompilerDeprecationTypes | 'MODE',
  { compatConfig }: MergedParserOptions | TransformContext,
) {
  // 获取配置项的值
  const value = compatConfig && compatConfig[key]
  if (key === 'MODE') {
    // 如果未设置 MODE，默认是 Vue 3 模式
    return value || 3 // compiler defaults to v3 behavior
  } else {
    return value
  }
}

// 判断某项兼容性特性是否启用
export function isCompatEnabled(
  key: CompilerDeprecationTypes,
  context: MergedParserOptions | TransformContext,
): boolean {
  // 获取当前模式
  const mode = getCompatValue('MODE', context)
  // 获取兼容项配置
  const value = getCompatValue(key, context)
  // in v3 mode, only enable if explicitly set to true
  // otherwise enable for any non-false value
  // Vue 3 模式下，仅当值为 true 时才启用
  // Vue 2 模式下，非 false 都认为启用
  return mode === 3 ? value === true : value !== false
}

// 检查兼容项是否启用，并在开发模式下发出警告
export function checkCompatEnabled(
  key: CompilerDeprecationTypes,
  context: MergedParserOptions | TransformContext,
  loc: SourceLocation | null,
  ...args: any[]
): boolean {
  // 检查是否启用
  const enabled = isCompatEnabled(key, context)
  if (__DEV__ && enabled) {
    // 仅在开发环境中警告
    warnDeprecation(key, context, loc, ...args)
  }
  return enabled
}

// 发出废弃特性的警告信息
export function warnDeprecation(
  key: CompilerDeprecationTypes,
  context: MergedParserOptions | TransformContext,
  loc: SourceLocation | null,
  ...args: any[]
): void {
  const val = getCompatValue(key, context)
  if (val === 'suppress-warning') {
    // 若设置为 suppress-warning，则不发出警告
    return
  }
  // 获取该项的警告内容
  const { message, link } = deprecationData[key]
  const msg = `(deprecation ${key}) ${
    typeof message === 'function' ? message(...args) : message
  }${link ? `\n  Details: ${link}` : ``}`

  // 构造语法错误对象用于发出警告
  const err = new SyntaxError(msg) as CompilerError
  err.code = key
  if (loc) err.loc = loc
  // 调用上下文中的警告函数
  context.onWarn(err)
}
