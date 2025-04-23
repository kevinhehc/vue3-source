// 导入节点转换函数类型和编译时的上下文对象类型。
import type { NodeTransform, TransformContext } from '../transform'

// 导入了编译器的 AST 节点类型和相关工厂函数（如 createVNodeCall 用于生成 h(...) 调用结构）。
// ConstantTypes 用于判断节点是否静态可缓存。
// NodeTypes, ElementTypes 用于分类节点。
import {
  type ArrayExpression,
  type CallExpression,
  type ComponentNode,
  ConstantTypes,
  type DirectiveArguments,
  type DirectiveNode,
  type ElementNode,
  ElementTypes,
  type ExpressionNode,
  type JSChildNode,
  NodeTypes,
  type ObjectExpression,
  type Property,
  type TemplateTextChildNode,
  type VNodeCall,
  createArrayExpression,
  createCallExpression,
  createObjectExpression,
  createObjectProperty,
  createSimpleExpression,
  createVNodeCall,
} from '../ast'

// PatchFlags 是渲染优化的标志位。
// camelize / capitalize 是常用字符串格式化工具。
// isOn 用于判断是否为事件监听器（如 onClick）。
// isBuiltInDirective 判断指令是否是内置指令（如 v-model）。
import {
  PatchFlags,
  camelize,
  capitalize,
  isBuiltInDirective,
  isObject,
  isOn,
  isReservedProp,
  isSymbol,
} from '@vue/shared'

// 导入错误码和用于报告编译错误的工厂函数。
import { ErrorCodes, createCompilerError } from '../errors'

// 运行时指令与组件的 helper 函数标记
// RESOLVE_COMPONENT：解析组件名
// MERGE_PROPS：合并多个 props
// NORMALIZE_CLASS / STYLE：规范化 class/style
// UNREF：处理响应式解包
import {
  GUARD_REACTIVE_PROPS,
  KEEP_ALIVE,
  MERGE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_PROPS,
  NORMALIZE_STYLE,
  RESOLVE_COMPONENT,
  RESOLVE_DIRECTIVE,
  RESOLVE_DYNAMIC_COMPONENT,
  SUSPENSE,
  TELEPORT,
  TO_HANDLERS,
  UNREF,
} from '../runtimeHelpers'

// 实用工具函数
// findProp()：查找元素上的某个 prop 或指令
// isStaticExp()：判断表达式是否为静态字面量
// toValidAssetId()：将组件/指令名称规范化成变量名
import {
  findProp,
  isCoreComponent,
  isStaticArgOf,
  isStaticExp,
  toValidAssetId,
} from '../utils'

// 处理 v-slot 和默认插槽内容。
import { buildSlots } from './vSlot'
// 判断节点是否静态（用于缓存优化）。
import { getConstantType } from './cacheStatic'
// 标记作用域中变量的绑定类型（如 setup 中的变量）。
import { BindingTypes } from '../options'

// 处理废弃特性的兼容提示，例如 v-bind.sync、v-on.native。
import {
  CompilerDeprecationTypes,
  checkCompatEnabled,
  isCompatEnabled,
} from '../compat/compatConfig'

// 用于分析和预处理模板表达式，例如 {{ count + 1 }} 中的 count 是否来自 setup() 或 data。
import { processExpression } from './transformExpression'

// some directive transforms (e.g. v-model) may return a symbol for runtime
// import, which should be used instead of a resolveDirective call.
// 指令 runtime helper 的注册表
// 某些指令转换函数（如 v-model）会注册它们依赖的 runtime helper（如 vModelText）
// 用于缓存某些指令转换过程中的 helper 引用，避免重复调用 resolveDirective()
const directiveImportMap = new WeakMap<DirectiveNode, symbol>()

// generate a JavaScript AST for this element's codegen
// 为元素生成 JavaScript AST 的转换器
export const transformElement: NodeTransform = (node, context) => {
  // perform the work on exit, after all child expressions have been
  // processed and merged.
  // 使用退出阶段（post-transform），在处理完所有子节点后执行
  // Vue 的编译器会先处理子节点，最后才处理父节点，所以这里在“退出阶段”处理整个元素。
  return function postTransformElement() {
    node = context.currentNode!

    // 过滤掉非元素类型
    // 仅处理真正的 DOM 元素或组件节点，跳过其他节点（如文本、注释、插值等）。
    if (
      !(
        node.type === NodeTypes.ELEMENT &&
        (node.tagType === ElementTypes.ELEMENT ||
          node.tagType === ElementTypes.COMPONENT)
      )
    ) {
      return
    }

    const { tag, props } = node
    // 判断当前是否是组件节点。
    const isComponent = node.tagType === ElementTypes.COMPONENT

    // The goal of the transform is to create a codegenNode implementing the
    // VNodeCall interface.
    // 如果是组件，尝试调用 resolveComponentType（比如 _resolveComponent("MyComp")）
    let vnodeTag = isComponent
      ? resolveComponentType(node as ComponentNode, context)
      : `"${tag}"`

    // 如果是动态组件（如 <component :is="comp" />），会变成 resolveDynamicComponent(comp)
    const isDynamicComponent =
      isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT

    // 构造 VNode 所需的字段
    let vnodeProps: VNodeCall['props']
    let vnodeChildren: VNodeCall['children']
    let patchFlag: VNodeCall['patchFlag'] | 0 = 0
    let vnodeDynamicProps: VNodeCall['dynamicProps']
    let dynamicPropNames: string[] | undefined
    let vnodeDirectives: VNodeCall['directives']

    // 是否需要使用 block（优化子树更新）
    // 动态组件或 <svg>、<foreignObject>、<math> 需要使用 block 模式；
    // block 是 Vue 编译器中的一种分组优化策略，可避免不必要的 diff。
    let shouldUseBlock =
      // dynamic component may resolve to plain elements
      isDynamicComponent ||
      vnodeTag === TELEPORT ||
      vnodeTag === SUSPENSE ||
      (!isComponent &&
        // <svg> and <foreignObject> must be forced into blocks so that block
        // updates inside get proper isSVG flag at runtime. (#639, #643)
        // This is technically web-specific, but splitting the logic out of core
        // leads to too much unnecessary complexity.
        (tag === 'svg' || tag === 'foreignObject' || tag === 'math'))

    // props
    // 构建 props
    // 调用 buildProps() 构建 props 对象
    // 收集动态属性名、patchFlag（更新优化标志），以及可能的指令（如 v-model）
    // 如果使用了某些指令，可能要求节点必须是 block
    if (props.length > 0) {
      const propsBuildResult = buildProps(
        node,
        context,
        undefined,
        isComponent,
        isDynamicComponent,
      )
      vnodeProps = propsBuildResult.props
      patchFlag = propsBuildResult.patchFlag
      dynamicPropNames = propsBuildResult.dynamicPropNames
      const directives = propsBuildResult.directives
      vnodeDirectives =
        directives && directives.length
          ? (createArrayExpression(
              directives.map(dir => buildDirectiveArgs(dir, context)),
            ) as DirectiveArguments)
          : undefined

      if (propsBuildResult.shouldUseBlock) {
        shouldUseBlock = true
      }
    }

    // children 处理子节点内容，分为以下几种情况：
    if (node.children.length > 0) {
      // 是特殊内置组件，会直接接收子节点作为 raw VNodes，而不是 slot
      // 需要确保 block 模式 + 强制更新（动态插槽）
      if (vnodeTag === KEEP_ALIVE) {
        // Although a built-in component, we compile KeepAlive with raw children
        // instead of slot functions so that it can be used inside Transition
        // or other Transition-wrapping HOCs.
        // To ensure correct updates with block optimizations, we need to:
        // 1. Force keep-alive into a block. This avoids its children being
        //    collected by a parent block.
        shouldUseBlock = true
        // 2. Force keep-alive to always be updated, since it uses raw children.
        patchFlag |= PatchFlags.DYNAMIC_SLOTS
        if (__DEV__ && node.children.length > 1) {
          context.onError(
            createCompilerError(ErrorCodes.X_KEEP_ALIVE_INVALID_CHILDREN, {
              start: node.children[0].loc.start,
              end: node.children[node.children.length - 1].loc.end,
              source: '',
            }),
          )
        }
      }

      // 默认插槽或具名插槽
      // 针对组件，会调用 buildSlots 构建 VNode 的 children 为 slot 函数对象；
      // 如果有动态插槽，则添加相应的 patchFlag。
      const shouldBuildAsSlots =
        isComponent &&
        // Teleport is not a real component and has dedicated runtime handling
        vnodeTag !== TELEPORT &&
        // explained above.
        vnodeTag !== KEEP_ALIVE

      if (shouldBuildAsSlots) {
        const { slots, hasDynamicSlots } = buildSlots(node, context)
        vnodeChildren = slots
        if (hasDynamicSlots) {
          patchFlag |= PatchFlags.DYNAMIC_SLOTS
        }
      } else if (node.children.length === 1 && vnodeTag !== TELEPORT) {
        // 单个文本子节点
        // 优化文本节点的情况（纯文字或插值），判断是否需要 TEXT patchFlag。
        const child = node.children[0]
        const type = child.type
        // check for dynamic text children
        const hasDynamicTextChild =
          type === NodeTypes.INTERPOLATION ||
          type === NodeTypes.COMPOUND_EXPRESSION
        if (
          hasDynamicTextChild &&
          getConstantType(child, context) === ConstantTypes.NOT_CONSTANT
        ) {
          patchFlag |= PatchFlags.TEXT
        }
        // pass directly if the only child is a text node
        // (plain / interpolation / expression)
        if (hasDynamicTextChild || type === NodeTypes.TEXT) {
          vnodeChildren = child as TemplateTextChildNode
        } else {
          vnodeChildren = node.children
        }
      } else {
        // 多子节点（数组）
        vnodeChildren = node.children
      }
    }

    // patchFlag & dynamicPropNames
    // 如果有动态属性（如 :foo="bar"），则生成对应的属性名列表（用于运行时 patch）。
    if (dynamicPropNames && dynamicPropNames.length) {
      vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames)
    }

    // 创建最终的 codegenNode（VNode AST）
    // 最终生成一个标准的 VNode 构造调用 AST（createVNode(...) 或 openBlock(); createBlock(...)）。
    node.codegenNode = createVNodeCall(
      context,
      vnodeTag,
      vnodeProps,
      vnodeChildren,
      patchFlag === 0 ? undefined : patchFlag,
      vnodeDynamicProps,
      vnodeDirectives,
      !!shouldUseBlock,
      false /* disableTracking */,
      isComponent,
      node.loc,
    )
  }
}

export function resolveComponentType(
  node: ComponentNode,
  context: TransformContext,
  ssr = false, // 是否为服务端渲染
): string | symbol | CallExpression {
  let { tag } = node

  // 1. dynamic component
  // 1. 处理动态组件
  const isExplicitDynamic = isComponentTag(tag) // 判断是否为显式的 <component>
  // 查找 is 属性
  const isProp = findProp(node, 'is', false, true /* allow empty */)
  if (isProp) {
    if (
      isExplicitDynamic || // 显式动态组件
      (__COMPAT__ &&
        isCompatEnabled(
          CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
          context,
        )) // 向后兼容的情况
    ) {
      let exp: ExpressionNode | undefined
      // 如果是静态属性（例如 is="foo"）
      if (isProp.type === NodeTypes.ATTRIBUTE) {
        exp = isProp.value && createSimpleExpression(isProp.value.content, true)
      } else {
        // 如果是动态绑定（例如 :is="foo"）
        exp = isProp.exp
        if (!exp) {
          // #10469 handle :is shorthand
          // 特殊处理语法糖 :is
          exp = createSimpleExpression(`is`, false, isProp.arg!.loc)
          if (!__BROWSER__) {
            exp = isProp.exp = processExpression(exp, context)
          }
        }
      }
      // 创建调用表达式 resolveDynamicComponent(exp)
      if (exp) {
        return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
          exp,
        ])
      }
    } else if (
      isProp.type === NodeTypes.ATTRIBUTE &&
      isProp.value!.content.startsWith('vue:')
    ) {
      // <button is="vue:xxx">
      // if not <component>, only is value that starts with "vue:" will be
      // treated as component by the parse phase and reach here, unless it's
      // compat mode where all is values are considered components
      // 处理 <button is="vue:xxx"> 这种情况（非 <component> 标签时）
      tag = isProp.value!.content.slice(4)
    }
  }

  // 2. built-in components (Teleport, Transition, KeepAlive, Suspense...)
  // 2. 处理内置组件（如 Teleport、Transition、KeepAlive 等）
  const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag)
  if (builtIn) {
    // built-ins are simply fallthroughs / have special handling during ssr
    // so we don't need to import their runtime equivalents
    if (!ssr) context.helper(builtIn) // 非 SSR 下添加 helper 函数
    // 返回内置组件标识符
    return builtIn
  }

  // 3. user component (from setup bindings)
  // this is skipped in browser build since browser builds do not perform
  // binding analysis.
  // 3. 从 setup 绑定中解析用户组件（非浏览器构建时才会走）
  if (!__BROWSER__) {
    const fromSetup = resolveSetupReference(tag, context)
    if (fromSetup) {
      // 若在 setup 中找到，直接返回引用
      return fromSetup
    }
    // 支持命名空间访问（如 `foo.bar`）
    const dotIndex = tag.indexOf('.')
    if (dotIndex > 0) {
      const ns = resolveSetupReference(tag.slice(0, dotIndex), context)
      if (ns) {
        return ns + tag.slice(dotIndex)
      }
    }
  }

  // 4. Self referencing component (inferred from filename)
  // 4. 处理当前组件自身的引用（如组件名称与文件名一致）
  if (
    !__BROWSER__ &&
    context.selfName &&
    capitalize(camelize(tag)) === context.selfName
  ) {
    context.helper(RESOLVE_COMPONENT) // 添加 helper
    // codegen.ts has special check for __self postfix when generating
    // component imports, which will pass additional `maybeSelfReference` flag
    // to `resolveComponent`.
    context.components.add(tag + `__self`) // 特殊标识当前组件自身
    return toValidAssetId(tag, `component`)
  }

  // 5. user component (resolve)
  // 5. 常规用户组件，通过 resolveComponent 去解析
  context.helper(RESOLVE_COMPONENT) // 添加 resolveComponent helper
  context.components.add(tag) // 注册组件名称
  return toValidAssetId(tag, `component`) // 生成合法组件 id
}

function resolveSetupReference(name: string, context: TransformContext) {
  const bindings = context.bindingMetadata
  // 如果没有绑定元数据，或者不是 <script setup>，直接返回
  if (!bindings || bindings.__isScriptSetup === false) {
    return
  }

  // 将变量名转为不同形式
  const camelName = camelize(name) // my-comp -> myComp
  const PascalName = capitalize(camelName) // myComp -> MyComp

  // 定义用于检查变量类型的辅助函数
  const checkType = (type: BindingTypes) => {
    if (bindings[name] === type) {
      return name
    }
    if (bindings[camelName] === type) {
      return camelName
    }
    if (bindings[PascalName] === type) {
      return PascalName
    }
  }

  // 处理 const 声明的绑定（如 import、const 定义等）
  const fromConst =
    checkType(BindingTypes.SETUP_CONST) ||
    checkType(BindingTypes.SETUP_REACTIVE_CONST) ||
    checkType(BindingTypes.LITERAL_CONST)
  if (fromConst) {
    return context.inline
      ? // in inline mode, const setup bindings (e.g. imports) can be used as-is
        fromConst // inline 模式下直接返回变量名
      : `$setup[${JSON.stringify(fromConst)}]` // 否则通过 $setup 引用
  }

  // 处理可能是 ref 的绑定
  const fromMaybeRef =
    checkType(BindingTypes.SETUP_LET) ||
    checkType(BindingTypes.SETUP_REF) ||
    checkType(BindingTypes.SETUP_MAYBE_REF)
  if (fromMaybeRef) {
    return context.inline
      ? // setup scope bindings that may be refs need to be unrefed
        `${context.helperString(UNREF)}(${fromMaybeRef})` // inline 模式下需要调用 unref() 解包
      : `$setup[${JSON.stringify(fromMaybeRef)}]` // 非 inline 模式从 $setup 中访问
  }

  // 处理 props 绑定（组件传入的 props）
  const fromProps = checkType(BindingTypes.PROPS)
  if (fromProps) {
    return `${context.helperString(UNREF)}(${
      context.inline ? '__props' : '$props'
    }[${JSON.stringify(fromProps)}])`
  }
}

export type PropsExpression = ObjectExpression | CallExpression | ExpressionNode

export function buildProps(
  node: ElementNode,
  context: TransformContext,
  props: ElementNode['props'] | undefined = node.props,
  isComponent: boolean,
  isDynamicComponent: boolean,
  ssr = false,
): {
  props: PropsExpression | undefined
  directives: DirectiveNode[]
  patchFlag: number
  dynamicPropNames: string[]
  shouldUseBlock: boolean
} {
  const { tag, loc: elementLoc, children } = node
  let properties: ObjectExpression['properties'] = [] // 存储构造的 props 对象属性
  const mergeArgs: PropsExpression[] = [] // 合并多个 props 对象的参数数组
  const runtimeDirectives: DirectiveNode[] = [] // 存储运行时指令（需 runtime 支持）
  const hasChildren = children.length > 0
  let shouldUseBlock = false // 是否强制使用 block

  // patchFlag analysis
  // patchFlag 用于优化渲染的标记
  let patchFlag = 0
  let hasRef = false
  let hasClassBinding = false
  let hasStyleBinding = false
  let hasHydrationEventBinding = false
  let hasDynamicKeys = false
  let hasVnodeHook = false
  const dynamicPropNames: string[] = [] // 收集动态 prop 名字

  // 辅助函数：将当前 properties 封装成对象表达式并压入 mergeArgs
  const pushMergeArg = (arg?: PropsExpression) => {
    if (properties.length) {
      mergeArgs.push(
        createObjectExpression(dedupeProperties(properties), elementLoc),
      )
      properties = []
    }
    if (arg) mergeArgs.push(arg)
  }

  // mark template ref on v-for
  // 如果 ref 出现在 v-for 里，添加 ref_for 标记
  const pushRefVForMarker = () => {
    if (context.scopes.vFor > 0) {
      properties.push(
        createObjectProperty(
          createSimpleExpression('ref_for', true),
          createSimpleExpression('true'),
        ),
      )
    }
  }

  // 分析属性对 patchFlag 的影响
  const analyzePatchFlag = ({ key, value }: Property) => {
    if (isStaticExp(key)) {
      const name = key.content
      const isEventHandler = isOn(name)
      // hydration 优化：跳过部分 click、v-model、vnode hook
      if (
        isEventHandler &&
        (!isComponent || isDynamicComponent) &&
        // omit the flag for click handlers because hydration gives click
        // dedicated fast path.
        name.toLowerCase() !== 'onclick' &&
        // omit v-model handlers
        name !== 'onUpdate:modelValue' &&
        // omit onVnodeXXX hooks
        !isReservedProp(name)
      ) {
        hasHydrationEventBinding = true
      }

      if (isEventHandler && isReservedProp(name)) {
        hasVnodeHook = true
      }

      // 特殊处理 wrapped handler，例如 withModifiers(fn)
      if (isEventHandler && value.type === NodeTypes.JS_CALL_EXPRESSION) {
        // handler wrapped with internal helper e.g. withModifiers(fn)
        // extract the actual expression
        value = value.arguments[0] as JSChildNode
      }

      // 如果是缓存表达式或常量，跳过
      if (
        value.type === NodeTypes.JS_CACHE_EXPRESSION ||
        ((value.type === NodeTypes.SIMPLE_EXPRESSION ||
          value.type === NodeTypes.COMPOUND_EXPRESSION) &&
          getConstantType(value, context) > 0)
      ) {
        // skip if the prop is a cached handler or has constant value
        return
      }

      // 标记特定属性
      if (name === 'ref') {
        hasRef = true
      } else if (name === 'class') {
        hasClassBinding = true
      } else if (name === 'style') {
        hasStyleBinding = true
      } else if (name !== 'key' && !dynamicPropNames.includes(name)) {
        dynamicPropNames.push(name)
      }

      // treat the dynamic class and style binding of the component as dynamic props
      // 组件上的 class/style 也视为动态 prop
      if (
        isComponent &&
        (name === 'class' || name === 'style') &&
        !dynamicPropNames.includes(name)
      ) {
        dynamicPropNames.push(name)
      }
    } else {
      hasDynamicKeys = true
    }
  }

  // 遍历所有属性和指令
  for (let i = 0; i < props.length; i++) {
    // static attribute
    const prop = props[i]
    if (prop.type === NodeTypes.ATTRIBUTE) {
      // 静态属性
      const { loc, name, nameLoc, value } = prop
      let isStatic = true
      if (name === 'ref') {
        hasRef = true
        pushRefVForMarker()
        // in inline mode there is no setupState object, so we can't use string
        // keys to set the ref. Instead, we need to transform it to pass the
        // actual ref instead.
        // inline 模式下直接转成 ref_key 绑定
        if (!__BROWSER__ && value && context.inline) {
          const binding = context.bindingMetadata[value.content]
          if (
            binding === BindingTypes.SETUP_LET ||
            binding === BindingTypes.SETUP_REF ||
            binding === BindingTypes.SETUP_MAYBE_REF
          ) {
            isStatic = false
            properties.push(
              createObjectProperty(
                createSimpleExpression('ref_key', true),
                createSimpleExpression(value.content, true, value.loc),
              ),
            )
          }
        }
      }
      // skip is on <component>, or is="vue:xxx"
      // 跳过特殊 is 属性
      if (
        name === 'is' &&
        (isComponentTag(tag) ||
          (value && value.content.startsWith('vue:')) ||
          (__COMPAT__ &&
            isCompatEnabled(
              CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
              context,
            )))
      ) {
        continue
      }
      properties.push(
        createObjectProperty(
          createSimpleExpression(name, true, nameLoc),
          createSimpleExpression(
            value ? value.content : '',
            isStatic,
            value ? value.loc : loc,
          ),
        ),
      )
    } else {
      // directives
      // 指令处理，如 v-bind/v-on/v-model 等
      const { name, arg, exp, loc, modifiers } = prop
      const isVBind = name === 'bind'
      const isVOn = name === 'on'

      // skip v-slot - it is handled by its dedicated transform.
      if (name === 'slot') {
        if (!isComponent) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_SLOT_MISPLACED, loc),
          )
        }
        continue
      }
      // skip v-once/v-memo - they are handled by dedicated transforms.
      if (name === 'once' || name === 'memo') {
        continue
      }
      // skip v-is and :is on <component>
      if (
        name === 'is' ||
        (isVBind &&
          isStaticArgOf(arg, 'is') &&
          (isComponentTag(tag) ||
            (__COMPAT__ &&
              isCompatEnabled(
                CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
                context,
              ))))
      ) {
        continue
      }
      // skip v-on in SSR compilation
      if (isVOn && ssr) {
        continue
      }

      if (
        // #938: elements with dynamic keys should be forced into blocks
        (isVBind && isStaticArgOf(arg, 'key')) ||
        // inline before-update hooks need to force block so that it is invoked
        // before children
        (isVOn && hasChildren && isStaticArgOf(arg, 'vue:before-update'))
      ) {
        shouldUseBlock = true
      }

      if (isVBind && isStaticArgOf(arg, 'ref')) {
        pushRefVForMarker()
      }

      // special case for v-bind and v-on with no argument
      if (!arg && (isVBind || isVOn)) {
        hasDynamicKeys = true
        if (exp) {
          if (isVBind) {
            // #10696 in case a v-bind object contains ref
            pushRefVForMarker()
            // have to merge early for compat build check
            pushMergeArg()
            if (__COMPAT__) {
              // 2.x v-bind object order compat
              // 2.x v-bind object 顺序兼容处理
              if (__DEV__) {
                const hasOverridableKeys = mergeArgs.some(arg => {
                  if (arg.type === NodeTypes.JS_OBJECT_EXPRESSION) {
                    return arg.properties.some(({ key }) => {
                      if (
                        key.type !== NodeTypes.SIMPLE_EXPRESSION ||
                        !key.isStatic
                      ) {
                        return true
                      }
                      return (
                        key.content !== 'class' &&
                        key.content !== 'style' &&
                        !isOn(key.content)
                      )
                    })
                  } else {
                    // dynamic expression
                    return true
                  }
                })
                if (hasOverridableKeys) {
                  checkCompatEnabled(
                    CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                    context,
                    loc,
                  )
                }
              }

              if (
                isCompatEnabled(
                  CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                  context,
                )
              ) {
                mergeArgs.unshift(exp)
                continue
              }
            }

            mergeArgs.push(exp)
          } else {
            // v-on="obj" -> toHandlers(obj)
            pushMergeArg({
              type: NodeTypes.JS_CALL_EXPRESSION,
              loc,
              callee: context.helper(TO_HANDLERS),
              arguments: isComponent ? [exp] : [exp, `true`],
            })
          }
        } else {
          context.onError(
            createCompilerError(
              isVBind
                ? ErrorCodes.X_V_BIND_NO_EXPRESSION
                : ErrorCodes.X_V_ON_NO_EXPRESSION,
              loc,
            ),
          )
        }
        continue
      }

      // force hydration for v-bind with .prop modifier
      if (isVBind && modifiers.some(mod => mod.content === 'prop')) {
        patchFlag |= PatchFlags.NEED_HYDRATION
      }

      const directiveTransform = context.directiveTransforms[name]
      if (directiveTransform) {
        // has built-in directive transform.
        const { props, needRuntime } = directiveTransform(prop, node, context)
        !ssr && props.forEach(analyzePatchFlag)
        if (isVOn && arg && !isStaticExp(arg)) {
          pushMergeArg(createObjectExpression(props, elementLoc))
        } else {
          properties.push(...props)
        }
        if (needRuntime) {
          runtimeDirectives.push(prop)
          if (isSymbol(needRuntime)) {
            directiveImportMap.set(prop, needRuntime)
          }
        }
      } else if (!isBuiltInDirective(name)) {
        // no built-in transform, this is a user custom directive.
        runtimeDirectives.push(prop)
        // custom dirs may use beforeUpdate so they need to force blocks
        // to ensure before-update gets called before children update
        if (hasChildren) {
          shouldUseBlock = true
        }
      }
    }
  }

  let propsExpression: PropsExpression | undefined = undefined

  // has v-bind="object" or v-on="object", wrap with mergeProps
  // 有多个对象需要合并（如 v-bind），使用 mergeProps 包装
  if (mergeArgs.length) {
    // close up any not-yet-merged props
    pushMergeArg()
    if (mergeArgs.length > 1) {
      propsExpression = createCallExpression(
        context.helper(MERGE_PROPS),
        mergeArgs,
        elementLoc,
      )
    } else {
      // single v-bind with nothing else - no need for a mergeProps call
      propsExpression = mergeArgs[0]
    }
  } else if (properties.length) {
    propsExpression = createObjectExpression(
      dedupeProperties(properties),
      elementLoc,
    )
  }

  // patchFlag analysis
  // patchFlag 分析：根据属性设置不同优化标记
  if (hasDynamicKeys) {
    patchFlag |= PatchFlags.FULL_PROPS
  } else {
    if (hasClassBinding && !isComponent) {
      patchFlag |= PatchFlags.CLASS
    }
    if (hasStyleBinding && !isComponent) {
      patchFlag |= PatchFlags.STYLE
    }
    if (dynamicPropNames.length) {
      patchFlag |= PatchFlags.PROPS
    }
    if (hasHydrationEventBinding) {
      patchFlag |= PatchFlags.NEED_HYDRATION
    }
  }
  if (
    !shouldUseBlock &&
    (patchFlag === 0 || patchFlag === PatchFlags.NEED_HYDRATION) &&
    (hasRef || hasVnodeHook || runtimeDirectives.length > 0)
  ) {
    patchFlag |= PatchFlags.NEED_PATCH
  }

  // pre-normalize props, SSR is skipped for now
  // 预规范化 props，主要是处理 class/style/dynamic keys 的规范函数包装
  if (!context.inSSR && propsExpression) {
    switch (propsExpression.type) {
      case NodeTypes.JS_OBJECT_EXPRESSION:
        // means that there is no v-bind,
        // but still need to deal with dynamic key binding
        let classKeyIndex = -1
        let styleKeyIndex = -1
        let hasDynamicKey = false

        for (let i = 0; i < propsExpression.properties.length; i++) {
          const key = propsExpression.properties[i].key
          if (isStaticExp(key)) {
            if (key.content === 'class') {
              classKeyIndex = i
            } else if (key.content === 'style') {
              styleKeyIndex = i
            }
          } else if (!key.isHandlerKey) {
            hasDynamicKey = true
          }
        }

        const classProp = propsExpression.properties[classKeyIndex]
        const styleProp = propsExpression.properties[styleKeyIndex]

        // no dynamic key
        if (!hasDynamicKey) {
          if (classProp && !isStaticExp(classProp.value)) {
            classProp.value = createCallExpression(
              context.helper(NORMALIZE_CLASS),
              [classProp.value],
            )
          }
          if (
            styleProp &&
            // the static style is compiled into an object,
            // so use `hasStyleBinding` to ensure that it is a dynamic style binding
            (hasStyleBinding ||
              (styleProp.value.type === NodeTypes.SIMPLE_EXPRESSION &&
                styleProp.value.content.trim()[0] === `[`) ||
              // v-bind:style and style both exist,
              // v-bind:style with static literal object
              styleProp.value.type === NodeTypes.JS_ARRAY_EXPRESSION)
          ) {
            styleProp.value = createCallExpression(
              context.helper(NORMALIZE_STYLE),
              [styleProp.value],
            )
          }
        } else {
          // dynamic key binding, wrap with `normalizeProps`
          propsExpression = createCallExpression(
            context.helper(NORMALIZE_PROPS),
            [propsExpression],
          )
        }
        break
      case NodeTypes.JS_CALL_EXPRESSION:
        // mergeProps call, do nothing
        break
      default:
        // single v-bind
        propsExpression = createCallExpression(
          context.helper(NORMALIZE_PROPS),
          [
            createCallExpression(context.helper(GUARD_REACTIVE_PROPS), [
              propsExpression,
            ]),
          ],
        )
        break
    }
  }

  return {
    props: propsExpression,
    directives: runtimeDirectives,
    patchFlag,
    dynamicPropNames,
    shouldUseBlock,
  }
}

// Dedupe props in an object literal.
// Literal duplicated attributes would have been warned during the parse phase,
// however, it's possible to encounter duplicated `onXXX` handlers with different
// modifiers. We also need to merge static and dynamic class / style attributes.
// - onXXX handlers / style: merge into array
// - class: merge into single expression with concatenation

// 去重属性（主要用于对象字面量中的属性）
// 字面量重复的属性在解析阶段已经会警告
// 但 `onXXX` 事件处理函数可能带有不同的修饰符而重复出现
// 我们还需要合并静态和动态的 class / style 属性
// - onXXX 或 style: 合并为数组
// - class: 合并为连接表达式
function dedupeProperties(properties: Property[]): Property[] {
  const knownProps: Map<string, Property> = new Map() // 用于记录已出现的静态属性名
  const deduped: Property[] = [] // 去重后的属性列表
  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i]
    // dynamic keys are always allowed
    // 动态 key 始终保留，例如 :[foo] 或 [foo]
    if (prop.key.type === NodeTypes.COMPOUND_EXPRESSION || !prop.key.isStatic) {
      deduped.push(prop)
      continue
    }
    // 获取静态属性名
    const name = prop.key.content
    const existing = knownProps.get(name)
    // 如果是 class/style/onXXX，则需要合并
    if (existing) {
      if (name === 'style' || name === 'class' || isOn(name)) {
        mergeAsArray(existing, prop)
      }
      // unexpected duplicate, should have emitted error during parse
      // 其他重复属性应在解析时就抛出错误，这里不处理
    } else {
      knownProps.set(name, prop)
      deduped.push(prop)
    }
  }
  return deduped
}

// 合并两个属性值为数组（如多个 onClick 或多个 style）
function mergeAsArray(existing: Property, incoming: Property) {
  if (existing.value.type === NodeTypes.JS_ARRAY_EXPRESSION) {
    // 已经是数组了，直接添加新值
    existing.value.elements.push(incoming.value)
  } else {
    // 否则创建一个数组，将两个值包装进去
    existing.value = createArrayExpression(
      [existing.value, incoming.value],
      existing.loc,
    )
  }
}

// 构建指令参数数组，最终输出为 [指令名, 值, 参数, 修饰符对象]
export function buildDirectiveArgs(
  dir: DirectiveNode,
  context: TransformContext,
): ArrayExpression {
  const dirArgs: ArrayExpression['elements'] = []
  // 是否是内置指令（v-model、v-show 等）
  const runtime = directiveImportMap.get(dir)
  if (runtime) {
    // built-in directive with runtime
    // 内置指令使用 helper 引用（如 vShow = resolveDirective("vShow")）
    dirArgs.push(context.helperString(runtime))
  } else {
    // user directive.
    // see if we have directives exposed via <script setup>
    // 用户自定义指令
    // 检查是否是 <script setup> 中暴露的
    const fromSetup =
      !__BROWSER__ && resolveSetupReference('v-' + dir.name, context)
    if (fromSetup) {
      dirArgs.push(fromSetup)
    } else {
      // inject statement for resolving directive
      // 注入 resolveDirective，运行时动态解析
      context.helper(RESOLVE_DIRECTIVE)
      context.directives.add(dir.name)
      dirArgs.push(toValidAssetId(dir.name, `directive`))
    }
  }
  const { loc } = dir
  // 指令的值，如 v-model="foo" 中的 foo
  if (dir.exp) dirArgs.push(dir.exp)
  if (dir.arg) {
    if (!dir.exp) {
      // 如果没有值，但有参数，插入 void 0 占位
      dirArgs.push(`void 0`)
    }
    // 参数，如 v-on:click 中的 click
    dirArgs.push(dir.arg)
  }
  if (Object.keys(dir.modifiers).length) {
    if (!dir.arg) {
      if (!dir.exp) {
        dirArgs.push(`void 0`)
      }
      dirArgs.push(`void 0`)
    }
    // 创建修饰符对象，如 v-on:click.stop.prevent => { stop: true, prevent: true }
    const trueExpression = createSimpleExpression(`true`, false, loc)
    dirArgs.push(
      createObjectExpression(
        dir.modifiers.map(modifier =>
          createObjectProperty(modifier, trueExpression),
        ),
        loc,
      ),
    )
  }
  return createArrayExpression(dirArgs, dir.loc)
}

// 将动态属性名数组转为字符串形式，用于生成代码时输出
function stringifyDynamicPropNames(props: string[]): string {
  let propsNamesString = `[`
  for (let i = 0, l = props.length; i < l; i++) {
    propsNamesString += JSON.stringify(props[i])
    if (i < l - 1) propsNamesString += ', '
  }
  return propsNamesString + `]`
}

// 判断是否是 <component> 动态组件标签
function isComponentTag(tag: string) {
  return tag === 'component' || tag === 'Component'
}
