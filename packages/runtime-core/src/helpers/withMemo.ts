import { hasChanged } from '@vue/shared'
import { type VNode, currentBlock, isBlockTreeEnabled } from '../vnode'

// 用于避免重复渲染静态内容或某些依赖未变的片段。
export function withMemo(
  // memo	当前帧的依赖数组（如 [a, b]）
  // render	返回 VNode 的函数
  // cache	vnode 缓存数组（每个组件一个）
  // index	当前 memo 节点在缓存中的索引
  memo: any[],
  render: () => VNode<any, any>,
  cache: any[],
  index: number,
): VNode<any, any> {
  // 若存在缓存并且依赖未变，直接返回缓存 VNode。
  const cached = cache[index] as VNode | undefined
  if (cached && isMemoSame(cached, memo)) {
    return cached
  }

  // 否则执行 render()，获取新的 VNode；
  // 将依赖 memo 存入 VNode.memo；
  // 缓存在组件的 cache 中以供下次使用；
  // 并返回该节点。
  const ret = render()

  // shallow clone
  ret.memo = memo.slice()
  ret.cacheIndex = index

  return (cache[index] = ret)
}

// 判断是否依赖相同
export function isMemoSame(cached: VNode, memo: any[]): boolean {
  // 比较依赖项是否全等（使用 hasChanged()）；
  // 若不等 → 必须重新渲染。
  const prev: any[] = cached.memo!
  if (prev.length != memo.length) {
    return false
  }

  for (let i = 0; i < prev.length; i++) {
    if (hasChanged(prev[i], memo[i])) {
      return false
    }
  }

  // make sure to let parent block track it when returning cached
  if (isBlockTreeEnabled > 0 && currentBlock) {
    // 特别逻辑（用于 block tree）
    // 如果当前处于编译优化的 block tree 模式（动态节点收集）；
    // 即使使用了缓存，也要将 VNode 收集进 currentBlock 中；
    // 确保 diff 正常工作。
    currentBlock.push(cached)
  }
  return true
}
