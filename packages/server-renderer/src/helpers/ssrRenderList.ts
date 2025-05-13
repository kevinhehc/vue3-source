import { isArray, isObject, isString } from '@vue/shared'
import { warn } from '@vue/runtime-core'

// v-for 的核心：ssrRenderList
export function ssrRenderList(
  // source	v-for 所遍历的数据（数组、字符串、数字、对象、可迭代）
  // renderItem	针对每一项要执行的渲染函数（通常负责 push 输出）
  source: unknown,
  renderItem: (value: unknown, key: string | number, index?: number) => void,
): void {
  //  数组或字符串
  if (isArray(source) || isString(source)) {
    // 遍历索引，调用 renderItem(value, index)。
    // 字符串每个字符会被作为一项。
    for (let i = 0, l = source.length; i < l; i++) {
      renderItem(source[i], i)
    }
  } else if (typeof source === 'number') {
    // 数字：v-for="n in 5"
    if (__DEV__ && !Number.isInteger(source)) {
      warn(`The v-for range expect an integer value but got ${source}.`)
      return
    }
    // 渲染从 1 到 source 的数字。
    // 注意：值是 i + 1，索引是 i，符合 Vue 的数字循环行为。
    // 开发环境中非整数会报警告。
    for (let i = 0; i < source; i++) {
      renderItem(i + 1, i)
    }
  } else if (isObject(source)) {
    // 对象或 Map/Set
    if (source[Symbol.iterator as any]) {
      // 可迭代对象（如 Map、Set、自定义 iterable）

      // 使用 Array.from() 将其转为数组。
      // 对每一项调用 renderItem(item, index)。
      const arr = Array.from(source as Iterable<any>)
      for (let i = 0, l = arr.length; i < l; i++) {
        renderItem(arr[i], i)
      }
    } else {
      // 普通对象
      const keys = Object.keys(source)
      for (let i = 0, l = keys.length; i < l; i++) {
        const key = keys[i]
        renderItem(source[key], key, i)
      }
    }
  }
  // 示例
  // 模板：
  // <li v-for="(item, index) in items">{{ item }}</li>
  // 编译后 SSR 渲染：
  // ssrRenderList(items, (item, index) => {
  //   push(`<li>${escapeHtml(item)}</li>`)
  // })
}
