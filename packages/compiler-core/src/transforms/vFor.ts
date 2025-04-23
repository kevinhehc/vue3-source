import {
  type NodeTransform,
  type TransformContext,
  createStructuralDirectiveTransform,
} from '../transform'
import {
  type BlockCodegenNode,
  ConstantTypes,
  type DirectiveNode,
  type ElementNode,
  type ExpressionNode,
  type ForCodegenNode,
  type ForIteratorExpression,
  type ForNode,
  type ForParseResult,
  type ForRenderListExpression,
  NodeTypes,
  type PlainElementNode,
  type RenderSlotCall,
  type SimpleExpressionNode,
  type SlotOutletNode,
  type VNodeCall,
  createBlockStatement,
  createCallExpression,
  createCompoundExpression,
  createFunctionExpression,
  createObjectExpression,
  createObjectProperty,
  createSimpleExpression,
  createVNodeCall,
  getVNodeBlockHelper,
  getVNodeHelper,
} from '../ast'
import { ErrorCodes, createCompilerError } from '../errors'
import {
  findDir,
  findProp,
  injectProp,
  isSlotOutlet,
  isTemplateNode,
} from '../utils'
import {
  FRAGMENT,
  IS_MEMO_SAME,
  OPEN_BLOCK,
  RENDER_LIST,
} from '../runtimeHelpers'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { PatchFlags } from '@vue/shared'
import { transformBindShorthand } from './vBind'

// 是一个结构化指令转换器，专门用于处理 v-for
// 使用 createStructuralDirectiveTransform 创建一个 v-for 转换器，本质上是将一个带有 v-for 的节点转换为渲染 list 的表达式，最终生成 block 结构和可循环的虚拟节点（VNode）
export const transformFor: NodeTransform = createStructuralDirectiveTransform(
  // 注册 v-for 结构指令
  'for', // 匹配 v-for 指令
  (node, dir, context) => {
    const { helper, removeHelper } = context
    // 调用 processFor 处理基础逻辑
    // 1.先把表达式解析成 ForNode
    // 2.提供一个 processCodegen 回调，稍后用于生成 codegenNode
    return processFor(node, dir, context, forNode => {
      // create the loop render function expression now, and add the
      // iterator on exit after all children have been traversed
      // 基于 v-for="item in list" 创建 RENDER_LIST(list) 结构
      const renderExp = createCallExpression(helper(RENDER_LIST), [
        forNode.source,
      ]) as ForRenderListExpression

      // 处理一些指令与属性（如 v-memo, :key）
      const isTemplate = isTemplateNode(node)
      const memo = findDir(node, 'memo')
      const keyProp = findProp(node, `key`, false, true)
      const isDirKey = keyProp && keyProp.type === NodeTypes.DIRECTIVE

      // 同名绑定 :key 简写形式（:key => :key="key"）
      if (isDirKey && !keyProp.exp) {
        // resolve :key shorthand #10882
        transformBindShorthand(keyProp, context)
      }

      // 提取 key 的表达式：处理属性是静态的 (如 :key="foo") 或动态表达式 (v-bind:key)
      let keyExp =
        keyProp &&
        (keyProp.type === NodeTypes.ATTRIBUTE
          ? keyProp.value
            ? createSimpleExpression(keyProp.value.content, true) // 静态值
            : undefined
          : keyProp.exp) // 动态表达式（v-bind）

      // 如果使用了 v-memo 且存在 key，则对 key 表达式进行作用域处理
      if (memo && keyExp && isDirKey) {
        if (!__BROWSER__) {
          keyProp.exp = keyExp = processExpression(
            keyExp as SimpleExpressionNode,
            context,
          )
        }
      }

      // 构建 key 属性表达式：{ key: ... }
      const keyProperty =
        keyProp && keyExp ? createObjectProperty(`key`, keyExp) : null

      // 如果是 <template v-for>，手动处理 v-memo 和 key 表达式（因为它们不会进入正常的 transform 阶段）
      if (!__BROWSER__ && isTemplate) {
        // #2085 / #5288 process :key and v-memo expressions need to be
        // processed on `<template v-for>`. In this case the node is discarded
        // and never traversed so its binding expressions won't be processed
        // by the normal transforms.
        // v-memo 表达式处理
        if (memo) {
          memo.exp = processExpression(
            memo.exp! as SimpleExpressionNode,
            context,
          )
        }
        // key 不是 attribute 类型时，手动处理其表达式
        if (keyProperty && keyProp!.type !== NodeTypes.ATTRIBUTE) {
          keyProperty.value = processExpression(
            keyProperty.value as SimpleExpressionNode,
            context,
          )
        }
      }

      // 判断是否为稳定的 fragment（常量来源 + 无副作用）
      const isStableFragment =
        forNode.source.type === NodeTypes.SIMPLE_EXPRESSION &&
        forNode.source.constType > ConstantTypes.NOT_CONSTANT

      // 设置 patchFlag：优化 diff 行为
      const fragmentFlag = isStableFragment
        ? PatchFlags.STABLE_FRAGMENT
        : keyProp
          ? PatchFlags.KEYED_FRAGMENT
          : PatchFlags.UNKEYED_FRAGMENT

      // 构建 v-for 的 codegenNode：VNode 调用，使用 Fragment 包裹整个循环
      forNode.codegenNode = createVNodeCall(
        context,
        helper(FRAGMENT), // 使用 Fragment 作为容器
        undefined, // 无 props
        renderExp, // 子节点内容：RENDER_LIST(...)
        fragmentFlag, // patch flag 优化类型
        undefined,
        undefined,
        true /* isBlock */, // isBlock：作为 block vnode
        !isStableFragment /* disableTracking */, // disableTracking：对非稳定列表启用追踪
        false /* isComponent */, // isComponent：不是组件
        node.loc, // 源码位置信息
      ) as ForCodegenNode

      return () => {
        // finish the codegen now that all children have been traversed
        // 所有子节点都处理完成，开始生成最终 codegen 结构
        let childBlock: BlockCodegenNode
        const { children } = forNode

        // check <template v-for> key placement
        // 检查 <template v-for> 中子元素是否错误地使用了 key（应当写在 <template> 上）
        if ((__DEV__ || !__BROWSER__) && isTemplate) {
          node.children.some(c => {
            if (c.type === NodeTypes.ELEMENT) {
              const key = findProp(c, 'key')
              if (key) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_FOR_TEMPLATE_KEY_PLACEMENT,
                    key.loc,
                  ),
                )
                return true
              }
            }
          })
        }

        // 判断是否需要 Fragment 包裹（子节点不是单个元素时需要）
        const needFragmentWrapper =
          children.length !== 1 || children[0].type !== NodeTypes.ELEMENT
        // 处理插槽出口情况：<slot v-for="..."> 或 <template v-for="..."><slot/></template>
        const slotOutlet = isSlotOutlet(node)
          ? node
          : isTemplate &&
              node.children.length === 1 &&
              isSlotOutlet(node.children[0])
            ? (node.children[0] as SlotOutletNode) // api-extractor somehow fails to infer this
            : null

        if (slotOutlet) {
          // <slot v-for="..."> or <template v-for="..."><slot/></template>
          // 插槽节点直接使用现有 codegenNode 作为 block
          childBlock = slotOutlet.codegenNode as RenderSlotCall
          if (isTemplate && keyProperty) {
            // <template v-for="..." :key="..."><slot/></template>
            // we need to inject the key to the renderSlot() call.
            // the props for renderSlot is passed as the 3rd argument.
            // <template v-for="..." :key="..."><slot/></template>
            // 将 key 注入到 renderSlot 的第三个参数（props）中
            injectProp(childBlock, keyProperty, context)
          }
        } else if (needFragmentWrapper) {
          // <template v-for="..."> with text or multi-elements
          // should generate a fragment block for each loop
          // 多元素或包含文本，使用 Fragment 包裹每个循环块
          childBlock = createVNodeCall(
            context,
            helper(FRAGMENT),
            keyProperty ? createObjectExpression([keyProperty]) : undefined,
            node.children,
            PatchFlags.STABLE_FRAGMENT,
            undefined,
            undefined,
            true,
            undefined,
            false /* isComponent */,
          )
        } else {
          // Normal element v-for. Directly use the child's codegenNode
          // but mark it as a block.
          // 正常元素，使用第一个子节点的 codegenNode 作为 block
          childBlock = (children[0] as PlainElementNode)
            .codegenNode as VNodeCall
          if (isTemplate && keyProperty) {
            injectProp(childBlock, keyProperty, context)
          }
          // 检查 block 状态是否需要切换
          if (childBlock.isBlock !== !isStableFragment) {
            if (childBlock.isBlock) {
              // switch from block to vnode
              // 从 block 改为 vnode
              removeHelper(OPEN_BLOCK)
              removeHelper(
                getVNodeBlockHelper(context.inSSR, childBlock.isComponent),
              )
            } else {
              // switch from vnode to block
              // 从 vnode 改为 block
              removeHelper(
                getVNodeHelper(context.inSSR, childBlock.isComponent),
              )
            }
          }
          // 更新 block 状态
          childBlock.isBlock = !isStableFragment
          if (childBlock.isBlock) {
            helper(OPEN_BLOCK)
            helper(getVNodeBlockHelper(context.inSSR, childBlock.isComponent))
          } else {
            helper(getVNodeHelper(context.inSSR, childBlock.isComponent))
          }
        }

        // v-memo 情况下，生成缓存逻辑函数
        if (memo) {
          const loop = createFunctionExpression(
            createForLoopParams(forNode.parseResult, [
              createSimpleExpression(`_cached`),
            ]),
          )
          loop.body = createBlockStatement([
            // 计算 memo 表达式
            createCompoundExpression([`const _memo = (`, memo.exp!, `)`]),
            // 判断缓存是否命中
            createCompoundExpression([
              `if (_cached`,
              ...(keyExp ? [` && _cached.key === `, keyExp] : []),
              ` && ${context.helperString(
                IS_MEMO_SAME,
              )}(_cached, _memo)) return _cached`,
            ]),
            // 创建 _item 并绑定 memo
            createCompoundExpression([`const _item = `, childBlock as any]),
            createSimpleExpression(`_item.memo = _memo`),
            createSimpleExpression(`return _item`),
          ])
          // 添加到 RENDER_LIST 的参数中
          renderExp.arguments.push(
            loop as ForIteratorExpression,
            createSimpleExpression(`_cache`),
            createSimpleExpression(String(context.cached.length)),
          )
          // increment cache count
          // 增加缓存计数
          context.cached.push(null)
        } else {
          // 普通 v-for：直接使用 item 参数函数
          renderExp.arguments.push(
            createFunctionExpression(
              createForLoopParams(forNode.parseResult),
              childBlock,
              true /* force newline */, // 强制换行
            ) as ForIteratorExpression,
          )
        }
      }
    })
  },
)

// target-agnostic transform used for both Client and SSR
// 用于处理 v-for 指令的通用转换逻辑（客户端 & SSR 都会使用）
export function processFor(
  node: ElementNode, // 当前处理的元素节点，如 <div v-for="..." />
  dir: DirectiveNode, // v-for 指令节点
  context: TransformContext, // 转换上下文
  processCodegen?: (forNode: ForNode) => (() => void) | undefined, // 可选：codegen 时回调
) {
  // 没有表达式，报错
  if (!dir.exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_NO_EXPRESSION, dir.loc),
    )
    return
  }

  const parseResult = dir.forParseResult

  // 表达式解析失败，报错
  if (!parseResult) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, dir.loc),
    )
    return
  }

  // 对解析结果做作用域变量处理、合法性校验等
  finalizeForParseResult(parseResult, context)

  const { addIdentifiers, removeIdentifiers, scopes } = context
  const { source, value, key, index } = parseResult

  // 创建 v-for 的 AST 节点对象 ForNode
  const forNode: ForNode = {
    type: NodeTypes.FOR,
    loc: dir.loc,
    source, // 循环来源，如 list
    valueAlias: value, // 循环项，如 item
    keyAlias: key, // 索引，如 key
    objectIndexAlias: index, // 第三个参数，如 index
    parseResult,
    children: isTemplateNode(node) ? node.children : [node], // 如果是 <template v-for>，子节点就是 template 的内容
  }

  // 替换当前元素为 forNode 节点
  context.replaceNode(forNode)

  // bookkeeping
  // --- 作用域管理 bookkeeping ---
  scopes.vFor++ // 嵌套层数 +1
  // 非浏览器构建 + 启用标识符前缀的情况下，将 alias 加入作用域管理
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // scope management
    // inject identifiers to context
    value && addIdentifiers(value)
    key && addIdentifiers(key)
    index && addIdentifiers(index)
  }

  // 如果传入了 codegen 回调处理，则执行，并保存返回的退出函数
  const onExit = processCodegen && processCodegen(forNode)

  // 返回退出阶段的清理函数（用于嵌套作用域管理）
  return (): void => {
    scopes.vFor-- // 离开 for block，作用域计数减一
    if (!__BROWSER__ && context.prefixIdentifiers) {
      value && removeIdentifiers(value)
      key && removeIdentifiers(key)
      index && removeIdentifiers(index)
    }
    // 如果有 codegen 的退出处理函数，调用它
    if (onExit) onExit()
  }
}

// 标准化 v-for 解析结果
export function finalizeForParseResult(
  result: ForParseResult, // v-for 的解析结果对象
  context: TransformContext, // 转换上下文
): void {
  // 避免重复处理
  if (result.finalized) return

  // 在非浏览器构建环境 + 开启了标识符前缀时处理
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // 对 source 表达式（如 `list`）加作用域前缀
    result.source = processExpression(
      result.source as SimpleExpressionNode,
      context,
    )
    // 对 key 表达式（如 (item, key) in list）处理为作用域参数
    if (result.key) {
      result.key = processExpression(
        result.key as SimpleExpressionNode,
        context,
        true, // 标记为函数参数处理
      )
    }
    // index 表达式（如 (item, key, index)）同样处理
    if (result.index) {
      result.index = processExpression(
        result.index as SimpleExpressionNode,
        context,
        true,
      )
    }
    // value 代表 item，也作为参数处理
    if (result.value) {
      result.value = processExpression(
        result.value as SimpleExpressionNode,
        context,
        true,
      )
    }
  }
  // 浏览器端开发模式下：做表达式合法性校验（浏览器运行时限制）
  if (__DEV__ && __BROWSER__) {
    validateBrowserExpression(result.source as SimpleExpressionNode, context)
    if (result.key) {
      validateBrowserExpression(
        result.key as SimpleExpressionNode,
        context,
        true,
      )
    }
    if (result.index) {
      validateBrowserExpression(
        result.index as SimpleExpressionNode,
        context,
        true,
      )
    }
    if (result.value) {
      validateBrowserExpression(
        result.value as SimpleExpressionNode,
        context,
        true,
      )
    }
  }
  // 标记已处理完成，防止重复处理
  result.finalized = true
}

// 将解析结果中的 value, key, index + 可选的 memoArgs 组合成函数参数列表
export function createForLoopParams(
  { value, key, index }: ForParseResult,
  // memo 表达式（如 v-memo）插入
  memoArgs: ExpressionNode[] = [],
): ExpressionNode[] {
  return createParamsList([value, key, index, ...memoArgs])
}

// 参数列表生成（自动补位）
function createParamsList(
  args: (ExpressionNode | undefined)[],
): ExpressionNode[] {
  let i = args.length
  while (i--) {
    // 找到最后一个非空参数的位置
    if (args[i]) break
  }
  return (
    args
      // 截取非空结尾前的部分
      .slice(0, i + 1)
      .map((arg, i) => arg || createSimpleExpression(`_`.repeat(i + 1), false))
  ) // 空位填 _:、__:
}

// <!-- v-for 示例 -->
// <div v-for="(item, key, index) in list" />
//
// // 最终函数参数会变成
// ['item', 'key', 'index']
// // 若 index 不存在，会变成 ['item', 'key']
