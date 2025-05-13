import { type ComponentInternalInstance, type Slots, ssrUtils } from 'vue'
import {
  type Props,
  type PushFn,
  type SSRBufferItem,
  renderVNodeChildren,
} from '../render'
import { isArray } from '@vue/shared'

const { ensureValidVNode } = ssrUtils

// SSR 编译后的插槽函数签名：
// 接收 props（传入 slot 的参数）
// 接收 push 函数（将内容写入 HTML）
// 接收组件上下文和作用域 ID（支持 scoped 插槽）
export type SSRSlots = Record<string, SSRSlot>
export type SSRSlot = (
  props: Props,
  push: PushFn,
  parentComponent: ComponentInternalInstance | null,
  scopeId: string | null,
) => void

// 负责将组件中的具名插槽（如 <slot name="header" />）或默认插槽，在服务端渲染阶段输出为 HTML 内容，同时保留客户端兼容的结构。
export function ssrRenderSlot(
  // 参数名	类型	含义
  // slots	Slots（运行时）或 SSRSlots（模板编译）	所有插槽的 map
  // slotName	string	当前要渲染的插槽名称，如 "default"
  // slotProps	Props	插槽传入的参数（如 <slot :foo="bar" />）
  // fallbackRenderFn	() => void or null	插槽内容为空时使用的后备渲染函数
  // push	PushFn	用于输出 HTML 字符串的函数
  // parentComponent	ComponentInternalInstance	当前组件实例
  // slotScopeId	`string	undefined`
  slots: Slots | SSRSlots,
  slotName: string,
  slotProps: Props,
  fallbackRenderFn: (() => void) | null,
  push: PushFn,
  parentComponent: ComponentInternalInstance,
  slotScopeId?: string,
): void {
  // template-compiled slots are always rendered as fragments
  // 所有 SSR 渲染的插槽 统一以注释包裹的 Fragment 输出，形如：
  push(`<!--[-->`)
  ssrRenderSlotInner(
    slots,
    slotName,
    slotProps,
    fallbackRenderFn,
    push,
    parentComponent,
    slotScopeId,
  )
  // 这用于客户端 hydration 时正确识别插槽边界（尤其是多个插槽混合时）。
  push(`<!--]-->`)
}

// 插槽渲染的核心逻辑函数
// 是否调用具名插槽或默认插槽
// 插槽是否有效，是否为空
// 如果为空，是否渲染 fallback 内容（后备插槽）
// 是否跳过双重 <Fragment> 渲染（尤其在 Transition 中）
export function ssrRenderSlotInner(
  // 参数	含义
  // slots	插槽集合（运行时 or SSR 编译）
  // slotName	插槽名，如 "default"、"header"
  // slotProps	传入插槽的 props
  // fallbackRenderFn	插槽为空时的备用渲染函数
  // push	输出 HTML 字符串的函数
  // parentComponent	当前组件实例
  // slotScopeId	slot 的作用域 ID（用于 scoped 样式）
  // transition	是否是过渡组件内部的 slot
  slots: Slots | SSRSlots,
  slotName: string,
  slotProps: Props,
  fallbackRenderFn: (() => void) | null,
  push: PushFn,
  parentComponent: ComponentInternalInstance,
  slotScopeId?: string,
  transition?: boolean,
): void {
  //  获取插槽函数
  const slotFn = slots[slotName]
  //  插槽存在的情况
  if (slotFn) {
    // 收集渲染内容到局部 buffer
    // 不直接 push 到最终 HTML 输出，而是先临时收集内容，稍后决定是否采用。
    // 这用于判断“内容是否为空”或处理 Fragment 边界。
    const slotBuffer: SSRBufferItem[] = []
    const bufferedPush = (item: SSRBufferItem) => {
      slotBuffer.push(item)
    }
    // 调用插槽函数
    // 插槽函数通常会通过 bufferedPush(...) 来输出 VNode 内容或 HTML 字符串。
    const ret = slotFn(
      slotProps,
      bufferedPush,
      parentComponent,
      slotScopeId ? ' ' + slotScopeId : '',
    )
    // 检查返回值是否为 vnode 数组
    // 编译器生成的 slot 函数有时直接返回 VNode 数组（VNode children）。
    if (isArray(ret)) {
      const validSlotContent = ensureValidVNode(ret)
      if (validSlotContent) {
        // normal slot
        // 处理 VNode children slot
        // 直接渲染到主输出流中。
        renderVNodeChildren(
          push,
          validSlotContent,
          parentComponent,
          slotScopeId,
        )
      } else if (fallbackRenderFn) {
        // 没有有效内容，调用 fallback
        fallbackRenderFn()
      }
    } else {
      //  否则走 SSR slot 路径（函数中调用了 push）
      // ssr slot.
      // check if the slot renders all comments, in which case use the fallback
      // 判断 slotBuffer 是否为空（纯注释）
      // 如果 buffer 里全是注释（例如 fallback comment 占位），认为是空插槽。
      // 但如果是 transition slot，始终认为是非空（不要丢掉内容）。
      let isEmptySlot = true
      if (transition) {
        isEmptySlot = false
      } else {
        for (let i = 0; i < slotBuffer.length; i++) {
          if (!isComment(slotBuffer[i])) {
            isEmptySlot = false
            break
          }
        }
      }
      if (isEmptySlot) {
        if (fallbackRenderFn) {
          //  空插槽 → fallback
          fallbackRenderFn()
        }
      } else {
        // #9933
        // Although we handle Transition/TransitionGroup in the transform stage
        // without rendering it as a fragment, the content passed into the slot
        // may still be a fragment.
        // Therefore, here we need to avoid rendering it as a fragment again.
        // 有效 slot 内容 → 输出
        // 如果 slot 内容本身是 Fragment（以注释包裹），但已经被 <Transition> 包了一层，就跳过二次 fragment 包裹，防止冗余注释。
        let start = 0
        let end = slotBuffer.length
        if (
          transition &&
          slotBuffer[0] === '<!--[-->' &&
          slotBuffer[end - 1] === '<!--]-->'
        ) {
          start++
          end--
        }

        for (let i = start; i < end; i++) {
          push(slotBuffer[i])
        }
      }
    }
  } else if (fallbackRenderFn) {
    fallbackRenderFn()
  }
}

// 用于快速判断整段字符串是否是一个完整注释块（不分行）。
const commentTestRE = /^<!--[\s\S]*-->$/
// 全局匹配所有注释块（用于剥离注释内容，看剩下的是否还有非空文本）。
const commentRE = /<!--[^]*?-->/gm
function isComment(item: SSRBufferItem) {
  // 如果不是字符串或不匹配注释起始结构，直接返回 false。
  if (typeof item !== 'string' || !commentTestRE.test(item)) return false
  // if item is '<!---->' or '<!--[-->' or '<!--]-->', return true directly
  // 优化路径：对于标准注释结构且长度小于等于 8（如：
  // <!----> (7)
  // <!--[--> (8)
  // <!--]--> (8)
  // → 直接认为是注释。
  if (item.length <= 8) return true
  return !item.replace(commentRE, '').trim()
}
