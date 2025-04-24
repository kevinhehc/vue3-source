import { initDirectivesForSSR } from 'vue'
initDirectivesForSSR()

// public
export type { SSRContext } from './render'

// 核心方法
export { renderToString } from './renderToString'
export {
  // 核心方法
  renderToSimpleStream,
  renderToNodeStream,
  pipeToNodeWritable,
  renderToWebStream,
  pipeToWebWritable,
  type SimpleReadable,
  // deprecated
  renderToStream,
} from './renderToStream'

// internal runtime helpers
export * from './internal'
