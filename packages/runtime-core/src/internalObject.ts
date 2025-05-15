/**
 * Used during vnode props/slots normalization to check if the vnode props/slots
 * are the internal attrs / slots object of a component via
 * `Object.getPrototypeOf`. This is more performant than defining a
 * non-enumerable property. (one of the optimizations done for ssr-benchmark)
 */

// 用于优化 组件 props / slots 标识与检测 的轻量实现，主要用于 VNode 的标准化过程（normalize）中区分“内部对象”与“普通对象”。
// 目的：性能优化中的“内部标识对象”
// 这套逻辑的目的是：
// 避免在对象上添加非枚举属性（如 __isInternal: true）
// 使用 Object.create(proto) 创建“标识性原型对象
// 使用 Object.getPrototypeOf(obj) === internalObjectProto 快速判断

// 这是一个 空对象的引用，用于作为内部对象的原型。
const internalObjectProto = {}

// 创建一个对象，其原型是 internalObjectProto。这个对象在 Vue 内部被用作：
export const createInternalObject = (): any =>
  Object.create(internalObjectProto)

export const isInternalObject = (obj: object): boolean =>
  Object.getPrototypeOf(obj) === internalObjectProto
