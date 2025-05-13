import type { PushFn } from '../render'

// 在服务端渲染时，直接渲染 <Suspense> 的 default 内容，不等待 fallback。
// 函数是 async 的（即便内部不真正使用 await），是为了统一渲染接口。
export async function ssrRenderSuspense(
  // push	写入 HTML 缓冲区的函数
  // { default: renderContent }	Suspense 的默认插槽内容，即 <template #default>
  push: PushFn,
  { default: renderContent }: Record<string, (() => void) | undefined>,
): Promise<void> {
  // 如果 default 插槽存在：
  // 调用它 → 渲染默认内容。
  // 如果没有默认内容：
  // 输出一个空注释节点占位（避免 DOM 结构错误）。
  if (renderContent) {
    renderContent()
  } else {
    push(`<!---->`)
  }

  // 不渲染 fallback！
  // 在 Vue SSR 中，Suspense 的 fallback 内容永远不会渲染，这是合理的，因为：
  // SSR 是同步/阻塞执行的。
  // 所有内容必须在一个 pass 中全部完成，不能“先显示 fallback 再替换”。
  // 这意味着：
  // <Suspense>
  //   <template #default>
  //     <AsyncComponent />
  //   </template>
  //   <template #fallback>
  //     Loading...
  //   </template>
  // </Suspense>
  // 在 SSR 中只会渲染 <AsyncComponent /> 的内容（当 setup() 中的异步 resolve 完成时），不会输出 Loading...。
}
