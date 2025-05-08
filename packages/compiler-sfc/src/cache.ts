import { LRUCache } from 'lru-cache'

// 定义了一个通用的缓存创建函数 createCache<T>()，其作用是根据运行环境返回不同类型的缓存对象：
// 在浏览器等限制环境下使用 Map，在 Node 等环境下使用 LRUCache（最近最少使用缓存）。
export function createCache<T extends {}>(
  // max: 设置缓存容量上限（仅 LRUCache 有效），默认是 500。
  max = 500,
): Map<string, T> | LRUCache<string, T> {
  // 浏览器环境（如构建工具中为 __GLOBAL__ 或 __ESM_BROWSER__ 为真） → 返回普通 Map<string, T>
  // Node 环境 → 返回 LRUCache<string, T>
  /* v8 ignore next 3 */
  if (__GLOBAL__ || __ESM_BROWSER__) {
    return new Map<string, T>()
  }
  return new LRUCache({ max })
}

// 适用于 Vue SFC 编译器中所有需要缓存解析结果的地方，例如：
// 类型推导缓存
// 模块解析路径缓存
// AST 分析结果缓存
// srcset、assetUrl 转换缓存
