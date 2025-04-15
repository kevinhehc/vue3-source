// Global compile-time constants
declare var __DEV__: boolean // true（开发）/ false（生产）
declare var __TEST__: boolean // true（测试时）/ false
declare var __BROWSER__: boolean // true（浏览器环境）/ false（Node.js）
declare var __GLOBAL__: boolean // 如果你构建的是 Global build（通过 <script> 引入 Vue），设置为 true【const { createApp, ref } = Vue】
declare var __ESM_BUNDLER__: boolean // true（模块打包器构建）	构建给 Vite / Rollup 用的版本
declare var __ESM_BROWSER__: boolean // false / true（浏览器原生模块）	通常设为 false
declare var __CJS__: boolean // false（除非构建 CJS 版本）	CommonJS 构建才需要
declare var __SSR__: boolean // true（服务端渲染时）/ false
declare var __VERSION__: string // 字符串	通常由打包工具自动替换，比如 "3.4.0"
declare var __COMPAT__: boolean // true（启用 Vue2 兼容性模式）	用于 vue-compat 构建

// Feature flags
declare var __FEATURE_OPTIONS_API__: boolean // 是否包含 Options API（data(), methods, computed 等）
declare var __FEATURE_PROD_DEVTOOLS__: boolean // false（生产）/ true（开发）	是否在生产环境启用 devtools 支持
declare var __FEATURE_SUSPENSE__: boolean //是否启用 <Suspense> 组件支持
declare var __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__: boolean // 控制是否在 SSR hydrate 报错时提供详细信息

declare module '*.vue' {}

declare module 'estree-walker' {
  export function walk<T>(
    root: T,
    options: {
      enter?: (node: T, parent: T | null) => any
      leave?: (node: T, parent: T | null) => any
      exit?: (node: T) => any
    } & ThisType<{ skip: () => void }>,
  )
}

declare interface String {
  /**
   * @deprecated Please use String.prototype.slice instead of String.prototype.substring in the repository.
   */
  substring(start: number, end?: number): string
}
