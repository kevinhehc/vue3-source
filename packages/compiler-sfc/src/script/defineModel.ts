import type { LVal, Node, TSType } from '@babel/types'
import type { ScriptCompileContext } from './context'
import { inferRuntimeType } from './resolveType'
import { UNKNOWN_TYPE, isCallOf, toRuntimeTypeString } from './utils'
import { BindingTypes, unwrapTSNode } from '@vue/compiler-dom'

export const DEFINE_MODEL = 'defineModel'

export interface ModelDecl {
  type: TSType | undefined // 类型参数，如 string、number 等
  options: string | undefined // 字符串形式的运行时配置（如 default、required 等）
  identifier: string | undefined // 绑定变量名（如 const foo = defineModel() 中的 foo）
  runtimeOptionNodes: Node[] // 原始 AST 节点（可能用于后续合并处理）
}

// 判断某个节点是否为 defineModel() 调用
// 提取绑定的 model 名、类型参数、运行时选项等
// 记录在编译上下文中（ctx.modelDecls）
// 检查是否有重复定义
// 返回是否成功处理该节点
export function processDefineModel(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  // 不是 defineModel()，直接返回
  if (!isCallOf(node, DEFINE_MODEL)) {
    return false
  }

  // 设置已调用标志
  ctx.hasDefineModelCall = true

  // 读取类型参数
  // 例如：
  // defineModel<string>('foo')
  // 会提取出 string 的类型节点，供后续生成 props 的 type 字段
  const type =
    (node.typeParameters && node.typeParameters.params[0]) || undefined
  let modelName: string
  let options: Node | undefined
  // 如果第一个参数是字符串字面量，如 'title'，则为 model 名
  // 否则默认名为 'modelValue'
  const arg0 = node.arguments[0] && unwrapTSNode(node.arguments[0])
  const hasName = arg0 && arg0.type === 'StringLiteral'
  if (hasName) {
    modelName = arg0.value // e.g., 'title'
    options = node.arguments[1] // 第二个参数是配置项
  } else {
    modelName = 'modelValue'
    options = arg0 // // 没有 model 名时，第一个参数是配置项
  }
  // 支持语法形式：
  // defineModel('title', { required: true })
  // defineModel({ required: true }) // name = 'modelValue'

  // 一个组件内每个 model 名只能出现一次，否则报错
  if (ctx.modelDecls[modelName]) {
    ctx.error(`duplicate model name ${JSON.stringify(modelName)}`, node)
  }

  // 获取传入的选项对象的原始代码文本
  // 初始化是否移除 options 的标记
  // 初始化用于记录属性节点的数组（后续做作用域检查）
  let optionsString = options && ctx.getString(options)
  let optionsRemoved = !options
  const runtimeOptionNodes: Node[] = []

  // 处理 options 中的 get / set 访问器 —— 它们是运行时专用
  // 仅处理简单对象表达式，不包含扩展或计算属性
  // 倒序遍历所有属性，尝试剔除 get / set 相关项
  if (
    options &&
    options.type === 'ObjectExpression' &&
    !options.properties.some(p => p.type === 'SpreadElement' || p.computed)
  ) {
    let removed = 0
    for (let i = options.properties.length - 1; i >= 0; i--) {
      const p = options.properties[i]
      const next = options.properties[i + 1]
      const start = p.start!
      const end = next ? next.start! : options.end! - 1

      if (
        (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') &&
        ((p.key.type === 'Identifier' &&
          (p.key.name === 'get' || p.key.name === 'set')) ||
          (p.key.type === 'StringLiteral' &&
            (p.key.value === 'get' || p.key.value === 'set')))
      ) {
        // remove runtime-only options from prop options to avoid duplicates
        // 移除 runtime-only 的 get / set
        // 对于 get / set 修饰符属性，直接从 optionsString 中移除（防止注入到组件 props）
        optionsString =
          optionsString.slice(0, start - options.start!) +
          optionsString.slice(end - options.start!)
      } else {
        // remove prop options from runtime options
        // 否则：将其他 prop 选项移出运行时代码
        // 删除源码中这段属性（如 required: true）
        // 同时将节点加入 runtimeOptionNodes，后续用于作用域检查
        removed++
        ctx.s.remove(ctx.startOffset! + start, ctx.startOffset! + end)
        // record prop options for invalid scope var reference check
        runtimeOptionNodes.push(p)
      }
    }
    if (removed === options.properties.length) {
      optionsRemoved = true
      ctx.s.remove(
        ctx.startOffset! + (hasName ? arg0.end! : options.start!),
        ctx.startOffset! + options.end!,
      )
    }
  }

  // 注册模型声明
  // 这是 defineModel 的核心输出结构，保存：
  // 类型注解
  // 最终用于生成 props 的 options 字符串
  // 被移除的 prop 属性节点（供检查）
  // 左值变量名，如 const x = defineModel() 中的 x
  ctx.modelDecls[modelName] = {
    type,
    options: optionsString,
    runtimeOptionNodes,
    identifier:
      declId && declId.type === 'Identifier' ? declId.name : undefined,
  }
  // register binding type
  // 用于后续 <template> 编译时识别绑定来源：这是个 prop
  ctx.bindingMetadata[modelName] = BindingTypes.PROPS

  // defineModel -> useModel
  // 替换宏调用为运行时代码中的 useModel 函数
  // 会自动注入 import { useModel as _useModel } from 'vue'
  ctx.s.overwrite(
    ctx.startOffset! + node.callee.start!,
    ctx.startOffset! + node.callee.end!,
    ctx.helper('useModel'),
  )
  // inject arguments
  // 编译后注入 __props 作为第一个参数
  ctx.s.appendLeft(
    ctx.startOffset! +
      (node.arguments.length ? node.arguments[0].start! : node.end! - 1),
    `__props, ` +
      (hasName
        ? ``
        : `${JSON.stringify(modelName)}${optionsRemoved ? `` : `, `}`),
  )

  return true
}

// 生成组件中使用 defineModel(...) 时对应的 props 定义字符串，包括：
// prop 的 type
// skipCheck 标志（用于跳过类型检查）
// 运行时传入的额外选项（如 default）
// 自动添加 xxxModifiers 对应的 prop（例如 modelModifiers）
// 这些内容将作为组件导出的 props 字段被注入。
export function genModelProps(ctx: ScriptCompileContext) {
  // 若没有使用 defineModel()，直接返回
  if (!ctx.hasDefineModelCall) return

  const isProd = !!ctx.options.isProd
  let modelPropsDecl = ''
  // 遍历所有的 model 声明
  // 每个 defineModel('xxx', ...) 的信息都已在 ctx.modelDecls 中收集好
  for (const [name, { type, options: runtimeOptions }] of Object.entries(
    ctx.modelDecls,
  )) {
    let skipCheck = false
    let codegenOptions = ``
    // 根据类型 AST，推导出运行时类型数组，如 ['String']、['Boolean']
    // 若包含 UNKNOWN_TYPE，会做特殊处理（比如保留其他类型，跳过类型检查）
    let runtimeTypes = type && inferRuntimeType(ctx, type)
    if (runtimeTypes) {
      const hasBoolean = runtimeTypes.includes('Boolean')
      const hasFunction = runtimeTypes.includes('Function')
      const hasUnknownType = runtimeTypes.includes(UNKNOWN_TYPE)

      if (hasUnknownType) {
        if (hasBoolean || hasFunction) {
          runtimeTypes = runtimeTypes.filter(t => t !== UNKNOWN_TYPE)
          skipCheck = true
        } else {
          runtimeTypes = ['null']
        }
      }

      if (!isProd) {
        // 开发环境下保留类型并加上 skipCheck（用于优化 IDE 支持）
        // 生产环境下尽可能省略 type 字段以减小体积（除非有 boolean 或默认值）
        codegenOptions =
          `type: ${toRuntimeTypeString(runtimeTypes)}` +
          (skipCheck ? ', skipCheck: true' : '')
      } else if (hasBoolean || (runtimeOptions && hasFunction)) {
        // preserve types if contains boolean, or
        // function w/ runtime options that may contain default
        codegenOptions = `type: ${toRuntimeTypeString(runtimeTypes)}`
      } else {
        // able to drop types in production
      }
    }

    let decl: string
    // 合并用户传入的 defineModel 第二个参数（runtime options）
    // 如果存在编译器推导的类型信息（codegenOptions）和用户配置（runtimeOptions），需要合并为一个对象
    // 如果只存在其一，直接使用
    // 否则使用空对象 {} 作为默认 prop 配置
    if (codegenOptions && runtimeOptions) {
      decl = ctx.isTS
        ? `{ ${codegenOptions}, ...${runtimeOptions} }`
        : `Object.assign({ ${codegenOptions} }, ${runtimeOptions})`
    } else if (codegenOptions) {
      decl = `{ ${codegenOptions} }`
    } else if (runtimeOptions) {
      decl = runtimeOptions
    } else {
      decl = `{}`
    }
    modelPropsDecl += `\n    ${JSON.stringify(name)}: ${decl},`

    // also generate modifiers prop
    // 为每个 defineModel 的 prop 自动添加一个空对象修饰符 prop
    // Vue 会使用它来接收 <input v-model:foo.modifier /> 中的 .modifier
    const modifierPropName = JSON.stringify(
      name === 'modelValue' ? `modelModifiers` : `${name}Modifiers`,
    )
    modelPropsDecl += `\n    ${modifierPropName}: {},`
  }
  // 拼接为对象字面量字符串
  // return `{${modelPropsDecl}\n  }`
  // 例如输出如下字符串：
  // {
  //   "title": { type: String },
  //   "titleModifiers": {},
  //   "modelValue": { type: [String, Number] },
  //   "modelModifiers": {}
  // }
  return `{${modelPropsDecl}\n  }`

  // 示例输入：
  // const title = defineModel<string>('title')
  // const modelValue = defineModel<number>()
  // 生成代码：
  // {
  //   "title": { type: String },
  //   "titleModifiers": {},
  //   "modelValue": { type: Number },
  //   "modelModifiers": {}
  // }
}
