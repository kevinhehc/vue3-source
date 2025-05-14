import type { VNode, VNodeChild } from '../vnode'
import {
  isReactive,
  isShallow,
  shallowReadArray,
  toReactive,
} from '@vue/reactivity'
import { isArray, isObject, isString } from '@vue/shared'
import { warn } from '../warning'

/**
 * v-for string
 * @private
 */
export function renderList(
  source: string,
  renderItem: (value: string, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for number
 */
export function renderList(
  source: number,
  renderItem: (value: number, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for array
 */
export function renderList<T>(
  source: T[],
  renderItem: (value: T, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for iterable
 */
export function renderList<T>(
  source: Iterable<T>,
  renderItem: (value: T, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for object
 */
export function renderList<T>(
  source: T,
  renderItem: <K extends keyof T>(
    value: T[K],
    key: string,
    index: number,
  ) => VNodeChild,
): VNodeChild[]

/**
 * Actual implementation
 */
// 将传入的数据源 source 转换成一个由 VNode 组成的数组，供模板渲染 v-for 列表使用。
// 这是编译器生成代码中的一个核心函数，用于把：
// <div v-for="(item, i) in list">{{ item }}</div>
// 编译成：
// renderList(list, (item, i) => h('div', null, item))
export function renderList(
  // 参数名	类型	含义
  // source	any	渲染的数据源（array、object、number、iterator）
  // renderItem	Function	接收当前项，返回 VNodeChild（即 vnode）
  // cache	any[]	缓存（用于编译优化场景）
  // index	number	当前 v-for 的缓存索引位置
  source: any,
  renderItem: (...args: any[]) => VNodeChild,
  cache?: any[],
  index?: number,
): VNodeChild[] {
  let ret: VNodeChild[]
  const cached = (cache && cache[index!]) as VNode[] | undefined
  const sourceIsArray = isArray(source)

  // 1. 数组或字符串
  if (sourceIsArray || isString(source)) {
    // 最常见的 v-for="(item, i) in arr"；
    // 字符串会被当作字符数组处理；
    // 如果是响应式数组，还会判断是否 shallow。
    const sourceIsReactiveArray = sourceIsArray && isReactive(source)
    let needsWrap = false
    if (sourceIsReactiveArray) {
      needsWrap = !isShallow(source)
      source = shallowReadArray(source)
    }
    ret = new Array(source.length)
    for (let i = 0, l = source.length; i < l; i++) {
      // cachedItem：用于 diff，编译时传入；
      // toReactive()：让 shallow 数组项临时转为 reactive（确保子项仍能追踪响应）。
      ret[i] = renderItem(
        needsWrap ? toReactive(source[i]) : source[i],
        i,
        undefined,
        cached && cached[i],
      )
    }
  } else if (typeof source === 'number') {
    // 2. 数字类型
    if (__DEV__ && !Number.isInteger(source)) {
      warn(`The v-for range expect an integer value but got ${source}.`)
    }
    // 如 v-for="n in 5"；
    // 会渲染出 1 ~ n，传入 renderItem(i + 1, i)；
    // 开始索引从 1 而非 0（符合用户直觉）。
    ret = new Array(source)
    for (let i = 0; i < source; i++) {
      ret[i] = renderItem(i + 1, i, undefined, cached && cached[i])
    }
  } else if (isObject(source)) {
    // 3. 对象（Map、Set 或普通对象）
    if (source[Symbol.iterator as any]) {
      // 可迭代对象（Map / Set）
      // 遍历迭代器；
      // 避免写复杂手动循环逻辑。
      ret = Array.from(source as Iterable<any>, (item, i) =>
        renderItem(item, i, undefined, cached && cached[i]),
      )
    } else {
      // 普通对象
      const keys = Object.keys(source)
      ret = new Array(keys.length)
      // 遍历对象的键；
      // renderItem(value, key, index)；
      // 这种结构用于 v-for="(val, key, i) in obj"。
      for (let i = 0, l = keys.length; i < l; i++) {
        const key = keys[i]
        ret[i] = renderItem(source[key], key, i, cached && cached[i])
      }
    }
  } else {
    ret = []
  }

  if (cache) {
    cache[index!] = ret
  }
  return ret
}
