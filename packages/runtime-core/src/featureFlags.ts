import { getGlobalThis } from '@vue/shared'

/**
 * This is only called in esm-bundler builds.
 * It is called when a renderer is created, in `baseCreateRenderer` so that
 * importing runtime-core is side-effects free.
 */
// 于初始化编译时特性标志（feature flags），尤其针对 ESM-Bundler 构建（例如 Vite 或 webpack + ESM 模式）。
// 它的目的是：
// 检查某些全局编译标志（如 __FEATURE_OPTIONS_API__）是否被显式定义；
// 若未定义，就设为默认值；
// 开发模式下给予警告，提示用户通过构建工具注入这些标志以获得更好的 tree-shaking。
export function initFeatureFlags(): void {
  // 初始化一个数组，用于收集缺失的标志名称，稍后用于开发警告。
  const needWarn = []

  if (typeof __FEATURE_OPTIONS_API__ !== 'boolean') {
    // 如果没有通过构建工具定义该标志（值不是 boolean），就设置默认值 true；
    // 同时记录缺失，用于开发时警告；
    // 实际注入的是 __VUE_OPTIONS_API__（注意和宏名称不同）。
    // 这个标志控制是否启用 Vue 的选项式 API（如 data, methods, watch, computed）。
    __DEV__ && needWarn.push(`__VUE_OPTIONS_API__`)
    getGlobalThis().__VUE_OPTIONS_API__ = true
  }

  if (typeof __FEATURE_PROD_DEVTOOLS__ !== 'boolean') {
    // 控制是否在生产模式下启用 Vue Devtools 支持；
    // 默认是关闭
    __DEV__ && needWarn.push(`__VUE_PROD_DEVTOOLS__`)
    getGlobalThis().__VUE_PROD_DEVTOOLS__ = false
  }

  if (typeof __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__ !== 'boolean') {
    // 控制在生产模式下是否打印 hydration mismatch 的详细信息；
    // 默认是关闭。
    __DEV__ && needWarn.push(`__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`)
    getGlobalThis().__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false
  }

  if (__DEV__ && needWarn.length) {
    // 如果存在未定义的标志，则打印警告。
    // 提示开发者应在打包器配置中定义这些全局变量（通过 define 插件、DefinePlugin、esbuild 的 define 等方式）；
    // 这样能启用 Vue 内部的条件编译和 dead code elimination，从而更好地 tree-shake 未用功能，减少生产包体积。
    const multi = needWarn.length > 1
    console.warn(
      `Feature flag${multi ? `s` : ``} ${needWarn.join(', ')} ${
        multi ? `are` : `is`
      } not explicitly defined. You are running the esm-bundler build of Vue, ` +
        `which expects these compile-time feature flags to be globally injected ` +
        `via the bundler config in order to get better tree-shaking in the ` +
        `production bundle.\n\n` +
        `For more details, see https://link.vuejs.org/feature-flags.`,
    )
  }
}
