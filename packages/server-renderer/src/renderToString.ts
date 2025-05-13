import {
  type App,
  type VNode,
  createApp,
  createVNode,
  ssrContextKey,
  ssrUtils,
} from 'vue'
import { isPromise, isString } from '@vue/shared'
import { type SSRBuffer, type SSRContext, renderComponentVNode } from './render'

const { isVNode } = ssrUtils

function nestedUnrollBuffer(
  buffer: SSRBuffer, // 嵌套或扁平的 SSRBuffer 数组
  parentRet: string,
  startIndex: number,
): Promise<string> | string {
  // 如果 buffer 中全是字符串，就同步拼接返回，性能最好。
  if (!buffer.hasAsync) {
    return parentRet + unrollBufferSync(buffer)
  }

  let ret = parentRet
  // 遍历处理每个项（从 startIndex 开始）
  for (let i = startIndex; i < buffer.length; i += 1) {
    const item = buffer[i]
    if (isString(item)) {
      // 如果是字符串，拼接即可：
      ret += item
      continue
    }

    // 将结果填入原位，再递归继续处理。递归确保顺序不会乱。
    if (isPromise(item)) {
      return item.then(nestedItem => {
        buffer[i] = nestedItem
        return nestedUnrollBuffer(buffer, ret, i)
      })
    }

    // 如果结果是 Promise，返回 then 继续递归
    // 否则累积返回值到 ret
    const result = nestedUnrollBuffer(item, ret, 0)
    if (isPromise(result)) {
      return result.then(nestedItem => {
        buffer[i] = nestedItem
        return nestedUnrollBuffer(buffer, '', i)
      })
    }

    ret = result
  }

  return ret
}

// 用于“展开”一个 SSRBuffer，将其内容转换成最终的字符串输出
// buffer: SSRBuffer：传入的 SSR 渲染缓冲区，内部结构是一个嵌套数组，内容可能是字符串、Promise 或其他 SSRBuffer。
// 返回值类型：可能是最终的字符串，或一个 Promise<string>（如果里面包含异步内容）。
export function unrollBuffer(buffer: SSRBuffer): Promise<string> | string {
  return nestedUnrollBuffer(buffer, '', 0)
}

// 函数接收一个 SSRBuffer（服务端渲染缓冲区）。
// 假设这个 buffer 是同步的，即内部不包含 Promise。
// 返回值是最终拼接好的纯字符串。
function unrollBufferSync(buffer: SSRBuffer): string {
  // 初始化结果字符串累加器。
  let ret = ''
  for (let i = 0; i < buffer.length; i++) {
    // 遍历 buffer 中的每个元素。
    // SSRBuffer 是一个数组，可以包含字符串或嵌套的 SSRBuffer。
    let item = buffer[i]
    if (isString(item)) {
      // 如果是字符串，直接拼接到结果中。
      ret += item
    } else {
      // since this is a sync buffer, child buffers are never promises
      // 否则认为是嵌套的 SSRBuffer，递归调用自己展开它。
      // 注释说明：由于是同步展开，不可能有 Promise，可以放心处理。
      ret += unrollBufferSync(item as SSRBuffer)
    }
  }
  return ret
}

// 负责将一个 Vue 应用或单个 VNode 渲染成最终的 HTML 字符串（可包含异步组件、teleport 等复杂结构）。
export async function renderToString(
  input: App | VNode, // 可以是一个完整的 Vue 应用（App），也可以是一个单独的 VNode。
  context: SSRContext = {}, // SSR 上下文对象，会被注入到组件树中，传递一些全局信息（如 teleports、watcherHandles 等）。
): Promise<string> {
  // 返回一个 Promise<string>，表示最终渲染结果 HTML 字符串。
  if (isVNode(input)) {
    // raw vnode, wrap with app (for context)
    // 如果传入的是原始 VNode 而不是应用实例，那么：
    // 创建一个临时 App 包装它（以便提供上下文等）。
    // 再次调用 renderToString（递归调用）。
    return renderToString(createApp({ render: () => input }), context)
  }

  // rendering an app
  // 从传入的 App 实例中提取组件及其 props，创建根 VNode。
  // 设置 app 上下文（provide/inject、插件等）。
  const vnode = createVNode(input._component, input._props)
  vnode.appContext = input._context
  // provide the ssr context to the tree
  // 将 SSR 上下文对象通过依赖注入传入组件树，供后续组件使用（如 useSSRContext）。
  input.provide(ssrContextKey, context)
  // 核心：将 vnode 渲染为 SSRBuffer。
  // 可能涉及异步（如 Suspense、异步组件等）。
  const buffer = await renderComponentVNode(vnode)

  // 将嵌套的 buffer 展开为最终字符串，处理异步与嵌套结构。
  const result = await unrollBuffer(buffer as SSRBuffer)

  // teleport 组件的内容先被收集到 context，最后统一插入到指定位置。
  // 此步骤将它们合并到 context.teleports 中，或嵌入 HTML 结果。
  await resolveTeleports(context)

  // 渲染过程中注册的副作用/监听器需要销毁，避免内存泄漏。
  if (context.__watcherHandles) {
    for (const unwatch of context.__watcherHandles) {
      unwatch()
    }
  }

  return result
}

// 将所有收集到的 teleport 内容展开成字符串，并填充进最终的 context.teleports 中，以便拼接进最终 HTML 输出。
export async function resolveTeleports(context: SSRContext): Promise<void> {
  // __teleportBuffers 是在组件渲染过程中，由 <teleport> 组件注册并填充的。
  // 是一个对象，结构为：
  // {
  //   [targetSelector: string]: SSRBuffer
  // }
  if (context.__teleportBuffers) {
    context.teleports = context.teleports || {}
    // key 是目标位置（如 body, #teleport-target），值是其渲染的内容缓冲区。
    for (const key in context.__teleportBuffers) {
      // context.__teleportBuffers[key] 是一个 SSRBuffer，可能包含异步内容。
      // 用 Promise.all([buf]) 确保等待其所有子项的异步内容（兼容结构）。
      // unrollBuffer(...) 会将这个嵌套缓冲区展开成最终字符串。
      // note: it's OK to await sequentially here because the Promises were
      // created eagerly in parallel.
      context.teleports[key] = await unrollBuffer(
        await Promise.all([context.__teleportBuffers[key]]),
      )
    }
  }
}
