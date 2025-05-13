import { type ComponentInternalInstance, ssrContextKey } from 'vue'
import {
  type PushFn,
  type SSRBufferItem,
  type SSRContext,
  createBuffer,
} from '../render'

// 它的作用是将传送的内容根据目标 to="#xxx" 缓存到一个特殊的 buffer 中（__teleportBuffers），以便在最终输出 HTML 时插入到正确的位置。
export function ssrRenderTeleport(
  // parentPush	父组件的 push() 函数，写入当前 buffer
  // contentRenderFn	用于渲染 teleport 子内容的函数（接收 push）
  // target	Teleport 的目标选择器，如 #footer
  // disabled	是否禁用 teleport（禁用时原地渲染）
  // parentComponent	当前组件上下文
  parentPush: PushFn,
  contentRenderFn: (push: PushFn) => void,
  target: string,
  disabled: boolean,
  parentComponent: ComponentInternalInstance,
): void {
  // 在父组件 buffer 中标记 teleport 的起始。
  parentPush('<!--teleport start-->')

  // 访问 SSR context & 初始化 teleport 缓冲区
  // 获取 SSR 渲染上下文（SSRContext）。
  // 创建或获取 __teleportBuffers 对象，用于缓存不同 teleport 目标的内容。
  const context = parentComponent.appContext.provides[
    ssrContextKey as any
  ] as SSRContext
  const teleportBuffers =
    context.__teleportBuffers || (context.__teleportBuffers = {})
  // 获取目标 buffer（按目标 selector）
  // 每个目标 selector（如 #footer）对应一个独立 buffer。
  const targetBuffer = teleportBuffers[target] || (teleportBuffers[target] = [])
  // record current index of the target buffer to handle nested teleports
  // since the parent needs to be rendered before the child
  // 记录当前 buffer 位置（支持嵌套）
  const bufferIndex = targetBuffer.length

  // 如果有嵌套 teleport，子 teleport 必须在父 teleport 渲染完成后插入，记录插入点顺序。
  let teleportContent: SSRBufferItem

  if (disabled) {
    // disabled = true → 原地渲染
    // eleport 被禁用，直接用父组件的 push() 渲染内容，表现为原地输出
    // 同时还是插入一个注释锚点，供客户端 patch 使用。
    contentRenderFn(parentPush)
    teleportContent = `<!--teleport start anchor--><!--teleport anchor-->`
  } else {
    // disabled = false → 写入独立 buffer
    // 创建独立的 buffer，并将子内容写入。
    // 在头尾插入注释锚点以支持客户端 hydration。
    const { getBuffer, push } = createBuffer()
    push(`<!--teleport start anchor-->`)
    contentRenderFn(push)
    push(`<!--teleport anchor-->`)
    teleportContent = getBuffer()
  }

  // 将 teleport 内容插入到目标 buffer 中
  // 把 teleport 内容插入目标 buffer 对应位置（支持嵌套的正确顺序）。
  targetBuffer.splice(bufferIndex, 0, teleportContent)
  // 表示 teleport 占位部分结束。
  parentPush('<!--teleport end-->')
}
