// 这行定义了一个唯一的 Symbol，名字在开发环境下是 "Fragment"，生产环境下是空字符串（节省体积）。
// Symbol() 是全局唯一的，因此可以保证不会与用户变量名冲突。
// __DEV__ 是构建时的条件编译宏，仅在开发环境为 true。
// unique symbol 是 TypeScript 的语法，确保类型系统能正确追踪该常量的唯一性。
export const FRAGMENT: unique symbol = Symbol(__DEV__ ? `Fragment` : ``)
export const TELEPORT: unique symbol = Symbol(__DEV__ ? `Teleport` : ``)
export const SUSPENSE: unique symbol = Symbol(__DEV__ ? `Suspense` : ``)
export const KEEP_ALIVE: unique symbol = Symbol(__DEV__ ? `KeepAlive` : ``)
export const BASE_TRANSITION: unique symbol = Symbol(
  __DEV__ ? `BaseTransition` : ``,
)
export const OPEN_BLOCK: unique symbol = Symbol(__DEV__ ? `openBlock` : ``)
export const CREATE_BLOCK: unique symbol = Symbol(__DEV__ ? `createBlock` : ``)
export const CREATE_ELEMENT_BLOCK: unique symbol = Symbol(
  __DEV__ ? `createElementBlock` : ``,
)
export const CREATE_VNODE: unique symbol = Symbol(__DEV__ ? `createVNode` : ``)
export const CREATE_ELEMENT_VNODE: unique symbol = Symbol(
  __DEV__ ? `createElementVNode` : ``,
)
export const CREATE_COMMENT: unique symbol = Symbol(
  __DEV__ ? `createCommentVNode` : ``,
)
export const CREATE_TEXT: unique symbol = Symbol(
  __DEV__ ? `createTextVNode` : ``,
)
export const CREATE_STATIC: unique symbol = Symbol(
  __DEV__ ? `createStaticVNode` : ``,
)
export const RESOLVE_COMPONENT: unique symbol = Symbol(
  __DEV__ ? `resolveComponent` : ``,
)
export const RESOLVE_DYNAMIC_COMPONENT: unique symbol = Symbol(
  __DEV__ ? `resolveDynamicComponent` : ``,
)
export const RESOLVE_DIRECTIVE: unique symbol = Symbol(
  __DEV__ ? `resolveDirective` : ``,
)
export const RESOLVE_FILTER: unique symbol = Symbol(
  __DEV__ ? `resolveFilter` : ``,
)
export const WITH_DIRECTIVES: unique symbol = Symbol(
  __DEV__ ? `withDirectives` : ``,
)
export const RENDER_LIST: unique symbol = Symbol(__DEV__ ? `renderList` : ``)
export const RENDER_SLOT: unique symbol = Symbol(__DEV__ ? `renderSlot` : ``)
export const CREATE_SLOTS: unique symbol = Symbol(__DEV__ ? `createSlots` : ``)
export const TO_DISPLAY_STRING: unique symbol = Symbol(
  __DEV__ ? `toDisplayString` : ``,
)
export const MERGE_PROPS: unique symbol = Symbol(__DEV__ ? `mergeProps` : ``)
export const NORMALIZE_CLASS: unique symbol = Symbol(
  __DEV__ ? `normalizeClass` : ``,
)
export const NORMALIZE_STYLE: unique symbol = Symbol(
  __DEV__ ? `normalizeStyle` : ``,
)
export const NORMALIZE_PROPS: unique symbol = Symbol(
  __DEV__ ? `normalizeProps` : ``,
)
export const GUARD_REACTIVE_PROPS: unique symbol = Symbol(
  __DEV__ ? `guardReactiveProps` : ``,
)
export const TO_HANDLERS: unique symbol = Symbol(__DEV__ ? `toHandlers` : ``)
export const CAMELIZE: unique symbol = Symbol(__DEV__ ? `camelize` : ``)
export const CAPITALIZE: unique symbol = Symbol(__DEV__ ? `capitalize` : ``)
export const TO_HANDLER_KEY: unique symbol = Symbol(
  __DEV__ ? `toHandlerKey` : ``,
)
export const SET_BLOCK_TRACKING: unique symbol = Symbol(
  __DEV__ ? `setBlockTracking` : ``,
)
/**
 * @deprecated no longer needed in 3.5+ because we no longer hoist element nodes
 * but kept for backwards compat
 */
export const PUSH_SCOPE_ID: unique symbol = Symbol(__DEV__ ? `pushScopeId` : ``)
/**
 * @deprecated kept for backwards compat
 */
export const POP_SCOPE_ID: unique symbol = Symbol(__DEV__ ? `popScopeId` : ``)
export const WITH_CTX: unique symbol = Symbol(__DEV__ ? `withCtx` : ``)
export const UNREF: unique symbol = Symbol(__DEV__ ? `unref` : ``)
export const IS_REF: unique symbol = Symbol(__DEV__ ? `isRef` : ``)
export const WITH_MEMO: unique symbol = Symbol(__DEV__ ? `withMemo` : ``)
export const IS_MEMO_SAME: unique symbol = Symbol(__DEV__ ? `isMemoSame` : ``)

// Name mapping for runtime helpers that need to be imported from 'vue' in
// generated code. Make sure these are correctly exported in the runtime!
// Symbol 与函数名的映射表 helperNameMap 这个映射用于将 Symbol 映射回字符串函数名
export const helperNameMap: Record<symbol, string> = {
  [FRAGMENT]: `Fragment`,
  [TELEPORT]: `Teleport`,
  [SUSPENSE]: `Suspense`,
  [KEEP_ALIVE]: `KeepAlive`,
  [BASE_TRANSITION]: `BaseTransition`,
  [OPEN_BLOCK]: `openBlock`,
  [CREATE_BLOCK]: `createBlock`,
  [CREATE_ELEMENT_BLOCK]: `createElementBlock`,
  [CREATE_VNODE]: `createVNode`,
  [CREATE_ELEMENT_VNODE]: `createElementVNode`,
  [CREATE_COMMENT]: `createCommentVNode`,
  [CREATE_TEXT]: `createTextVNode`,
  [CREATE_STATIC]: `createStaticVNode`,
  [RESOLVE_COMPONENT]: `resolveComponent`,
  [RESOLVE_DYNAMIC_COMPONENT]: `resolveDynamicComponent`,
  [RESOLVE_DIRECTIVE]: `resolveDirective`,
  [RESOLVE_FILTER]: `resolveFilter`,
  [WITH_DIRECTIVES]: `withDirectives`,
  [RENDER_LIST]: `renderList`,
  [RENDER_SLOT]: `renderSlot`,
  [CREATE_SLOTS]: `createSlots`,
  [TO_DISPLAY_STRING]: `toDisplayString`,
  [MERGE_PROPS]: `mergeProps`,
  [NORMALIZE_CLASS]: `normalizeClass`,
  [NORMALIZE_STYLE]: `normalizeStyle`,
  [NORMALIZE_PROPS]: `normalizeProps`,
  [GUARD_REACTIVE_PROPS]: `guardReactiveProps`,
  [TO_HANDLERS]: `toHandlers`,
  [CAMELIZE]: `camelize`,
  [CAPITALIZE]: `capitalize`,
  [TO_HANDLER_KEY]: `toHandlerKey`,
  [SET_BLOCK_TRACKING]: `setBlockTracking`,
  [PUSH_SCOPE_ID]: `pushScopeId`,
  [POP_SCOPE_ID]: `popScopeId`,
  [WITH_CTX]: `withCtx`,
  [UNREF]: `unref`,
  [IS_REF]: `isRef`,
  [WITH_MEMO]: `withMemo`,
  [IS_MEMO_SAME]: `isMemoSame`,
}

// 动态注册辅助函数（扩展点）
// 这允许你在运行时向 helperNameMap 动态添加 helper，比如通过插件系统注入新 helper，扩展 Vue 的编译功能。
export function registerRuntimeHelpers(helpers: Record<symbol, string>): void {
  Object.getOwnPropertySymbols(helpers).forEach(s => {
    helperNameMap[s] = helpers[s]
  })
}

// 应用示意：如何在 AST 里使用 Symbol
// 编译器生成 AST 时，不写死字符串，而是引用这些 Symbol：
// return {
//   type: NodeTypes.CALL_EXPRESSION,
//   callee: CREATE_VNODE, // 是 Symbol，不是字符串
//   arguments: [...]
// }
// 然后在生成代码阶段，通过：
// helperNameMap[CREATE_VNODE] // -> "createVNode"
// 生成代码字符串：
// createVNode("div", null, ...)
