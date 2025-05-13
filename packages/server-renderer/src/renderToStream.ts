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
import type { Readable, Writable } from 'node:stream'
import { resolveTeleports } from './renderToString'

const { isVNode } = ssrUtils

// 用于输出流式 HTML 的一个最简版可读流接口 SimpleReadable，它并不是 Node.js 原生的 ReadableStream，而是一个轻量的、内部使用的抽象接口。
export interface SimpleReadable {
  // push(chunk: string | null): void
  // 功能：将数据块“推送”到流中。
  // 参数说明：
  // chunk: string 表示一段渲染好的 HTML 字符串。
  // null 表示流已经结束。
  // 类似于 Node.js 的 readable.push(...)。
  // 2. destroy(err: any): void
  // 功能：在遇到错误时销毁这个流。
  // 参数 err 是传入的异常对象。
  // 类似于 Node.js 的 readable.destroy(err)。
  push(chunk: string | null): void
  destroy(err: any): void
}

// 用于将 SSR 渲染缓冲区（SSRBuffer）逐步写入流（SimpleReadable）中，并处理异步内容。
async function unrollBuffer(
  // buffer：SSR 渲染缓冲区，内部是嵌套数组，可能包含：
  // 字符串
  // Promise（异步组件）
  // 嵌套 SSRBuffer
  // stream：输出接口，用于将字符串块写入响应流（HTML 内容逐步发出）。
  buffer: SSRBuffer,
  stream: SimpleReadable,
): Promise<void> {
  if (buffer.hasAsync) {
    // SSR 渲染时标记过：buffer.hasAsync = true 表示其中包含 Promise。
    // 此时必须逐项 await 展开。
    for (let i = 0; i < buffer.length; i++) {
      // 逐项处理，每一项可能是：
      // 字符串 → 直接推入
      // Promise → 先 await 再处理
      // 子 buffer → 递归展开
      let item = buffer[i]
      if (isPromise(item)) {
        item = await item
      }
      if (isString(item)) {
        // 如果是字符串，直接写入 stream.push(...)。
        // 如果是嵌套的 SSRBuffer，递归调用 unrollBuffer 处理它。
        stream.push(item)
      } else {
        await unrollBuffer(item, stream)
      }
    }
  } else {
    // sync buffer can be more efficiently unrolled without unnecessary await
    // ticks
    // 如果 buffer 没有异步内容，则使用同步版本 unrollBufferSync：
    // 避免不必要的 await，更高效。
    // 处理流程相同，但更快。
    unrollBufferSync(buffer, stream)
  }
}

// 用于将 同步的 SSR 渲染缓冲区 (SSRBuffer) 写入流 (SimpleReadable) 中
function unrollBufferSync(buffer: SSRBuffer, stream: SimpleReadable) {
  for (let i = 0; i < buffer.length; i++) {
    let item = buffer[i]
    if (isString(item)) {
      stream.push(item)
    } else {
      // since this is a sync buffer, child buffers are never promises
      unrollBufferSync(item as SSRBuffer, stream)
    }
  }
}

export function renderToSimpleStream<T extends SimpleReadable>(
  input: App | VNode,
  context: SSRContext,
  stream: T,
): T {
  if (isVNode(input)) {
    // raw vnode, wrap with app (for context)
    return renderToSimpleStream(
      createApp({ render: () => input }),
      context,
      stream,
    )
  }

  // rendering an app
  const vnode = createVNode(input._component, input._props)
  vnode.appContext = input._context
  // provide the ssr context to the tree
  input.provide(ssrContextKey, context)

  Promise.resolve(renderComponentVNode(vnode))
    .then(buffer => unrollBuffer(buffer, stream))
    .then(() => resolveTeleports(context))
    .then(() => {
      if (context.__watcherHandles) {
        for (const unwatch of context.__watcherHandles) {
          unwatch()
        }
      }
    })
    .then(() => stream.push(null))
    .catch(error => {
      stream.destroy(error)
    })

  return stream
}

/**
 * @deprecated
 */
export function renderToStream(
  input: App | VNode,
  context: SSRContext = {},
): Readable {
  console.warn(
    `[@vue/server-renderer] renderToStream is deprecated - use renderToNodeStream instead.`,
  )
  return renderToNodeStream(input, context)
}

export function renderToNodeStream(
  input: App | VNode,
  context: SSRContext = {},
): Readable {
  const stream: Readable = __CJS__
    ? new (require('node:stream').Readable)({ read() {} })
    : null

  if (!stream) {
    throw new Error(
      `ESM build of renderToStream() does not support renderToNodeStream(). ` +
        `Use pipeToNodeWritable() with an existing Node.js Writable stream ` +
        `instance instead.`,
    )
  }

  return renderToSimpleStream(input, context, stream)
}

export function pipeToNodeWritable(
  input: App | VNode,
  context: SSRContext | undefined = {},
  writable: Writable,
): void {
  renderToSimpleStream(input, context, {
    push(content) {
      if (content != null) {
        writable.write(content)
      } else {
        writable.end()
      }
    },
    destroy(err) {
      writable.destroy(err)
    },
  })
}

export function renderToWebStream(
  input: App | VNode,
  context: SSRContext = {},
): ReadableStream {
  if (typeof ReadableStream !== 'function') {
    throw new Error(
      `ReadableStream constructor is not available in the global scope. ` +
        `If the target environment does support web streams, consider using ` +
        `pipeToWebWritable() with an existing WritableStream instance instead.`,
    )
  }

  const encoder = new TextEncoder()
  let cancelled = false

  return new ReadableStream({
    start(controller) {
      renderToSimpleStream(input, context, {
        push(content) {
          if (cancelled) return
          if (content != null) {
            controller.enqueue(encoder.encode(content))
          } else {
            controller.close()
          }
        },
        destroy(err) {
          controller.error(err)
        },
      })
    },
    cancel() {
      cancelled = true
    },
  })
}

export function pipeToWebWritable(
  input: App | VNode,
  context: SSRContext | undefined = {},
  writable: WritableStream,
): void {
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  // #4287 CloudFlare workers do not implement `ready` property
  let hasReady = false
  try {
    hasReady = isPromise(writer.ready)
  } catch (e: any) {}

  renderToSimpleStream(input, context, {
    async push(content) {
      if (hasReady) {
        await writer.ready
      }
      if (content != null) {
        return writer.write(encoder.encode(content))
      } else {
        return writer.close()
      }
    },
    destroy(err) {
      // TODO better error handling?
      // eslint-disable-next-line no-console
      console.log(err)
      writer.close()
    },
  })
}
