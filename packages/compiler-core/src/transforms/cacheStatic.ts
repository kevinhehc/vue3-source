// 导入 AST 类型和工具函数
import {
  type CacheExpression,
  type CallExpression,
  type ComponentNode,
  ConstantTypes,
  ElementTypes,
  type ExpressionNode,
  type JSChildNode,
  NodeTypes,
  type ParentNode,
  type PlainElementNode,
  type RootNode,
  type SimpleExpressionNode,
  type SlotFunctionExpression,
  type TemplateChildNode,
  type TemplateNode,
  type TextCallNode,
  type VNodeCall,
  createArrayExpression,
  getVNodeBlockHelper,
  getVNodeHelper,
} from '../ast'
// 导入转换上下文类型
import type { TransformContext } from '../transform'
// 导入共享的工具方法和常量
import { PatchFlags, isArray, isString, isSymbol } from '@vue/shared'
// 导入实用工具函数：查找指令、判断是否是 <slot> 插槽出口
import { findDir, isSlotOutlet } from '../utils'
// 导入运行时辅助方法名，用于标记代码生成的 helper 函数
import {
  GUARD_REACTIVE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_PROPS,
  NORMALIZE_STYLE,
  OPEN_BLOCK,
} from '../runtimeHelpers'

// 顶层函数：为模板 AST 启用静态节点缓存机制
export function cacheStatic(root: RootNode, context: TransformContext): void {
  walk(
    root, // AST 根节点
    undefined, // 父节点初始为 undefined
    context, // 转换上下文
    // Root node is unfortunately non-hoistable due to potential parent
    // fallthrough attributes.
    isSingleElementRoot(root, root.children[0]), // 是否是单根元素（可提升优化）
  )
}

// 判断模板是否是一个单根元素（可以提升为静态节点）
// 注意：排除 <slot> 插槽，因为它可能具有 fallback 和不稳定性
export function isSingleElementRoot(
  root: RootNode,
  child: TemplateChildNode,
): child is PlainElementNode | ComponentNode | TemplateNode {
  const { children } = root
  return (
    children.length === 1 && // 根节点仅有一个子元素
    child.type === NodeTypes.ELEMENT && // 类型必须是元素（排除注释、文本等）
    !isSlotOutlet(child) // 不能是 <slot> 插槽出口
  )
}

// 遍历 AST 节点，找出可以被静态缓存的子节点
function walk(
  node: ParentNode, // 当前节点
  parent: ParentNode | undefined, // 父节点
  context: TransformContext, // 编译上下文
  doNotHoistNode: boolean = false, // 是否禁止提升该节点（用于 v-for / v-if 的单个分支）
  inFor = false, // 当前是否在 v-for 环境中（影响缓存策略）
) {
  const { children } = node
  // 待缓存的子节点集合
  const toCache: (PlainElementNode | TextCallNode)[] = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    // only plain elements & text calls are eligible for caching.
    // 只处理普通元素或 TEXT_CALL（文本插值）
    if (
      child.type === NodeTypes.ELEMENT &&
      child.tagType === ElementTypes.ELEMENT
    ) {
      // 判断静态等级（常量类型）
      const constantType = doNotHoistNode
        ? ConstantTypes.NOT_CONSTANT
        : getConstantType(child, context)
      // 如果是可缓存的静态节点
      if (constantType > ConstantTypes.NOT_CONSTANT) {
        if (constantType >= ConstantTypes.CAN_CACHE) {
          ;(child.codegenNode as VNodeCall).patchFlag = PatchFlags.CACHED
          toCache.push(child)
          continue
        }
      } else {
        // node may contain dynamic children, but its props may be eligible for
        // hoisting.
        // 尽管整个节点不能缓存，但可能 props 是静态的，可以 hoist
        const codegenNode = child.codegenNode!
        if (codegenNode.type === NodeTypes.VNODE_CALL) {
          const flag = codegenNode.patchFlag
          if (
            (flag === undefined ||
              flag === PatchFlags.NEED_PATCH ||
              flag === PatchFlags.TEXT) &&
            getGeneratedPropsConstantType(child, context) >=
              ConstantTypes.CAN_CACHE
          ) {
            const props = getNodeProps(child)
            if (props) {
              codegenNode.props = context.hoist(props)
            }
          }
          if (codegenNode.dynamicProps) {
            codegenNode.dynamicProps = context.hoist(codegenNode.dynamicProps)
          }
        }
      }
    } else if (child.type === NodeTypes.TEXT_CALL) {
      // 处理插值表达式（如 {{ msg }})
      const constantType = doNotHoistNode
        ? ConstantTypes.NOT_CONSTANT
        : getConstantType(child, context)
      if (constantType >= ConstantTypes.CAN_CACHE) {
        toCache.push(child)
        continue
      }
    }

    // walk further
    // 深度遍历子节点
    if (child.type === NodeTypes.ELEMENT) {
      const isComponent = child.tagType === ElementTypes.COMPONENT
      if (isComponent) {
        context.scopes.vSlot++
      }
      walk(child, node, context, false, inFor)
      if (isComponent) {
        // 处理组件插槽作用域
        context.scopes.vSlot--
      }
    } else if (child.type === NodeTypes.FOR) {
      // Do not hoist v-for single child because it has to be a block
      // v-for 不 hoist 单子节点
      walk(child, node, context, child.children.length === 1, true)
    } else if (child.type === NodeTypes.IF) {
      // 递归处理每个 v-if / v-else-if / v-else 分支
      for (let i = 0; i < child.branches.length; i++) {
        // Do not hoist v-if single child because it has to be a block
        walk(
          child.branches[i],
          node,
          context,
          child.branches[i].children.length === 1,
          inFor,
        )
      }
    }
  }

  let cachedAsArray = false
  // 检查是否所有 children 都可缓存，尝试整体缓存为数组
  if (toCache.length === children.length && node.type === NodeTypes.ELEMENT) {
    if (
      node.tagType === ElementTypes.ELEMENT &&
      node.codegenNode &&
      node.codegenNode.type === NodeTypes.VNODE_CALL &&
      isArray(node.codegenNode.children)
    ) {
      // all children were hoisted - the entire children array is cacheable.
      // 普通元素的所有子节点缓存为数组
      node.codegenNode.children = getCacheExpression(
        createArrayExpression(node.codegenNode.children),
      )
      cachedAsArray = true
    } else if (
      node.tagType === ElementTypes.COMPONENT &&
      node.codegenNode &&
      node.codegenNode.type === NodeTypes.VNODE_CALL &&
      node.codegenNode.children &&
      !isArray(node.codegenNode.children) &&
      node.codegenNode.children.type === NodeTypes.JS_OBJECT_EXPRESSION
    ) {
      // default slot
      // 处理默认插槽的缓存
      const slot = getSlotNode(node.codegenNode, 'default')
      if (slot) {
        slot.returns = getCacheExpression(
          createArrayExpression(slot.returns as TemplateChildNode[]),
        )
        cachedAsArray = true
      }
    } else if (
      node.tagType === ElementTypes.TEMPLATE &&
      parent &&
      parent.type === NodeTypes.ELEMENT &&
      parent.tagType === ElementTypes.COMPONENT &&
      parent.codegenNode &&
      parent.codegenNode.type === NodeTypes.VNODE_CALL &&
      parent.codegenNode.children &&
      !isArray(parent.codegenNode.children) &&
      parent.codegenNode.children.type === NodeTypes.JS_OBJECT_EXPRESSION
    ) {
      // named <template> slot
      // 处理具名插槽 <template v-slot:name> 缓存
      const slotName = findDir(node, 'slot', true)
      const slot =
        slotName &&
        slotName.arg &&
        getSlotNode(parent.codegenNode, slotName.arg)
      if (slot) {
        slot.returns = getCacheExpression(
          createArrayExpression(slot.returns as TemplateChildNode[]),
        )
        cachedAsArray = true
      }
    }
  }

  // 若不能整体缓存，单独缓存每个子节点
  if (!cachedAsArray) {
    for (const child of toCache) {
      child.codegenNode = context.cache(child.codegenNode!)
    }
  }

  // 工具函数：将表达式转换为缓存表达式
  function getCacheExpression(value: JSChildNode): CacheExpression {
    const exp = context.cache(value)
    // #6978, #7138, #7114
    // a cached children array inside v-for can caused HMR errors since
    // it might be mutated when mounting the first item
    // HMR 下需要标记为数组扩展，防止热更新失效（某些组件会 mutate 缓存数组）
    if (inFor && context.hmr) {
      exp.needArraySpread = true
    }
    return exp
  }

  // 工具函数：获取组件 VNode 的指定插槽（如 default、name）
  function getSlotNode(
    node: VNodeCall,
    name: string | ExpressionNode,
  ): SlotFunctionExpression | undefined {
    if (
      node.children &&
      !isArray(node.children) &&
      node.children.type === NodeTypes.JS_OBJECT_EXPRESSION
    ) {
      const slot = node.children.properties.find(
        p => p.key === name || (p.key as SimpleExpressionNode).content === name,
      )
      return slot && slot.value
    }
  }

  // 如果缓存了节点并定义了 transformHoist 钩子，进行后续处理（如将 hoisted 内容合并）
  if (toCache.length && context.transformHoist) {
    context.transformHoist(children, context, node)
  }
}

// 判断某个 AST 节点的静态等级（ConstantTypes 枚举）
// 目的是优化性能，能缓存则缓存
export function getConstantType(
  node: TemplateChildNode | SimpleExpressionNode | CacheExpression,
  context: TransformContext,
): ConstantTypes {
  // 缓存对象，避免重复计算
  const { constantCache } = context
  switch (node.type) {
    // 对 ELEMENT 元素节点做处理
    case NodeTypes.ELEMENT:
      // 如果不是普通 HTML 元素（比如组件），直接认为不是静态
      if (node.tagType !== ElementTypes.ELEMENT) {
        return ConstantTypes.NOT_CONSTANT
      }
      // 缓存命中，直接返回
      const cached = constantCache.get(node)
      if (cached !== undefined) {
        return cached
      }
      const codegenNode = node.codegenNode!
      // 非 VNODE_CALL（VNode 构造调用）不能静态提升
      if (codegenNode.type !== NodeTypes.VNODE_CALL) {
        return ConstantTypes.NOT_CONSTANT
      }
      // 块级节点（如 div 是 block）不能静态缓存（除 SVG 等少数特例）
      if (
        codegenNode.isBlock &&
        node.tag !== 'svg' &&
        node.tag !== 'foreignObject' &&
        node.tag !== 'math'
      ) {
        return ConstantTypes.NOT_CONSTANT
      }
      // 如果没有 patchFlag（说明是静态节点）
      if (codegenNode.patchFlag === undefined) {
        // 初始设为最优等级
        let returnType = ConstantTypes.CAN_STRINGIFY

        // Element itself has no patch flag. However we still need to check:

        // 1. Even for a node with no patch flag, it is possible for it to contain
        // non-hoistable expressions that refers to scope variables, e.g. compiler
        // injected keys or cached event handlers. Therefore we need to always
        // check the codegenNode's props to be sure.
        // 检查 codegenNode 的 props 是不是静态的
        const generatedPropsType = getGeneratedPropsConstantType(node, context)
        if (generatedPropsType === ConstantTypes.NOT_CONSTANT) {
          constantCache.set(node, ConstantTypes.NOT_CONSTANT)
          return ConstantTypes.NOT_CONSTANT
        }
        if (generatedPropsType < returnType) {
          returnType = generatedPropsType
        }

        // 2. its children.
        // 检查 children 是不是静态的
        for (let i = 0; i < node.children.length; i++) {
          const childType = getConstantType(node.children[i], context)
          if (childType === ConstantTypes.NOT_CONSTANT) {
            constantCache.set(node, ConstantTypes.NOT_CONSTANT)
            return ConstantTypes.NOT_CONSTANT
          }
          if (childType < returnType) {
            returnType = childType
          }
        }

        // 3. if the type is not already CAN_SKIP_PATCH which is the lowest non-0
        // type, check if any of the props can cause the type to be lowered
        // we can skip can_patch because it's guaranteed by the absence of a
        // patchFlag.
        // 如果类型还不是最差的，那就再检查 v-bind
        if (returnType > ConstantTypes.CAN_SKIP_PATCH) {
          for (let i = 0; i < node.props.length; i++) {
            const p = node.props[i]
            if (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && p.exp) {
              const expType = getConstantType(p.exp, context)
              if (expType === ConstantTypes.NOT_CONSTANT) {
                constantCache.set(node, ConstantTypes.NOT_CONSTANT)
                return ConstantTypes.NOT_CONSTANT
              }
              if (expType < returnType) {
                returnType = expType
              }
            }
          }
        }

        // only svg/foreignObject could be block here, however if they are
        // static then they don't need to be blocks since there will be no
        // nested updates.
        // 如果是 block（通常是 SVG 特殊节点），但 props 是静态的，也可以转成非 block 提升
        if (codegenNode.isBlock) {
          // except set custom directives.
          for (let i = 0; i < node.props.length; i++) {
            const p = node.props[i]
            if (p.type === NodeTypes.DIRECTIVE) {
              constantCache.set(node, ConstantTypes.NOT_CONSTANT)
              return ConstantTypes.NOT_CONSTANT
            }
          }

          // 去掉 block 标记并修改相关 helper
          context.removeHelper(OPEN_BLOCK)
          context.removeHelper(
            getVNodeBlockHelper(context.inSSR, codegenNode.isComponent),
          )
          codegenNode.isBlock = false
          context.helper(getVNodeHelper(context.inSSR, codegenNode.isComponent))
        }

        // 最终缓存并返回类型
        constantCache.set(node, returnType)
        return returnType
      } else {
        // 有 patchFlag，说明一定不是静态节点
        constantCache.set(node, ConstantTypes.NOT_CONSTANT)
        return ConstantTypes.NOT_CONSTANT
      }
    // 文本或注释节点总是静态可字符串化
    case NodeTypes.TEXT:
    case NodeTypes.COMMENT:
      return ConstantTypes.CAN_STRINGIFY

    // v-if、v-for、if 分支都视为动态（不可提升）
    case NodeTypes.IF:
    case NodeTypes.FOR:
    case NodeTypes.IF_BRANCH:
      return ConstantTypes.NOT_CONSTANT

    // 插值表达式或 TEXT_CALL，递归检查内容是否静态
    case NodeTypes.INTERPOLATION:
    case NodeTypes.TEXT_CALL:
      return getConstantType(node.content, context)

    // 简单表达式直接使用它本身的 constType 标记
    case NodeTypes.SIMPLE_EXPRESSION:
      return node.constType

    // 复合表达式（多个节点组合），递归检查每个部分
    case NodeTypes.COMPOUND_EXPRESSION:
      let returnType = ConstantTypes.CAN_STRINGIFY
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (isString(child) || isSymbol(child)) {
          continue
        }
        const childType = getConstantType(child, context)
        if (childType === ConstantTypes.NOT_CONSTANT) {
          return ConstantTypes.NOT_CONSTANT
        } else if (childType < returnType) {
          returnType = childType
        }
      }
      return returnType

    // 缓存表达式永远可缓存
    case NodeTypes.JS_CACHE_EXPRESSION:
      return ConstantTypes.CAN_CACHE
    // 理论上不应到达此处，类型检查兜底
    default:
      if (__DEV__) {
        const exhaustiveCheck: never = node
        exhaustiveCheck
      }
      return ConstantTypes.NOT_CONSTANT
  }
}

// 允许被提升的 runtime helper 函数（仅当参数本身是静态的）
const allowHoistedHelperSet = new Set([
  // 处理 class 的 normalizeClass()
  NORMALIZE_CLASS,
  // 处理 style 的 normalizeStyle()
  NORMALIZE_STYLE,
  // 综合处理 props 的 normalizeProps()
  NORMALIZE_PROPS,
  // 处理响应式属性安全包裹
  GUARD_REACTIVE_PROPS,
])

// 判断某个 helper 调用表达式是否可以提升为静态（例如 normalizeClass({...})）
function getConstantTypeOfHelperCall(
  value: CallExpression,
  context: TransformContext,
): ConstantTypes {
  // 必须是调用表达式 + 不是字符串名称（即真实 helper）+ 在白名单内
  if (
    value.type === NodeTypes.JS_CALL_EXPRESSION &&
    !isString(value.callee) &&
    allowHoistedHelperSet.has(value.callee)
  ) {
    const arg = value.arguments[0] as JSChildNode
    // 如果参数是简单表达式，直接判断
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      return getConstantType(arg, context)

      // 如果是嵌套 helper 调用，如 normalizeProps(guardReactiveProps(xxx))
    } else if (arg.type === NodeTypes.JS_CALL_EXPRESSION) {
      // in the case of nested helper call, e.g. `normalizeProps(guardReactiveProps(exp))`
      return getConstantTypeOfHelperCall(arg, context)
    }
  }
  // 其余情况视为非静态
  return ConstantTypes.NOT_CONSTANT
}

// 判断生成的 VNode props（属性对象）是否为静态的（用于决定是否 hoist）
function getGeneratedPropsConstantType(
  // 节点为普通元素
  node: PlainElementNode,
  context: TransformContext,
): ConstantTypes {
  let returnType = ConstantTypes.CAN_STRINGIFY
  // 获取 codegenNode 的 props
  const props = getNodeProps(node)
  if (props && props.type === NodeTypes.JS_OBJECT_EXPRESSION) {
    // 取出属性对（key-value）
    const { properties } = props
    for (let i = 0; i < properties.length; i++) {
      const { key, value } = properties[i]
      // 判断 key 是不是静态
      const keyType = getConstantType(key, context)
      if (keyType === ConstantTypes.NOT_CONSTANT) {
        return keyType
      }
      if (keyType < returnType) {
        returnType = keyType
      }

      // 判断 value 是不是静态
      let valueType: ConstantTypes
      if (value.type === NodeTypes.SIMPLE_EXPRESSION) {
        valueType = getConstantType(value, context)
      } else if (value.type === NodeTypes.JS_CALL_EXPRESSION) {
        // some helper calls can be hoisted,
        // such as the `normalizeProps` generated by the compiler for pre-normalize class,
        // in this case we need to respect the ConstantType of the helper's arguments
        // 处理 normalizeClass/Style 等生成的 helper 调用
        valueType = getConstantTypeOfHelperCall(value, context)
      } else {
        valueType = ConstantTypes.NOT_CONSTANT
      }
      if (valueType === ConstantTypes.NOT_CONSTANT) {
        return valueType
      }
      if (valueType < returnType) {
        returnType = valueType
      }
    }
  }
  return returnType
}

// 从 VNode 的 codegenNode 中提取 props 表达式
function getNodeProps(node: PlainElementNode) {
  const codegenNode = node.codegenNode!
  if (codegenNode.type === NodeTypes.VNODE_CALL) {
    return codegenNode.props
  }
}
