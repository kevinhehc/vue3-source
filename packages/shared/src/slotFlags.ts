export enum SlotFlags {
  /**
   * Stable slots that only reference slot props or context state. The slot
   * can fully capture its own dependencies so when passed down the parent won't
   * need to force the child to update.
   */
  /**
   * 父组件更新 插槽组件不必强制更新
   */
  STABLE = 1,
  /**
   * Slots that reference scope variables (v-for or an outer slot prop), or
   * has conditional structure (v-if, v-for). The parent will need to force
   * the child to update because the slot does not fully capture its dependencies.
   */
  /**
   * 父组件更新时 插槽组件需要强制更新 v-for v-if 动态插槽 依赖父组件的状态
   * 会更改插槽位
   */
  DYNAMIC = 2,
  /**
   * `<slot/>` being forwarded into a child component. Whether the parent needs
   * to update the child is dependent on what kind of slots the parent itself
   * received. This has to be refined at runtime, when the child's vnode
   * is being created (in `normalizeChildren`)
   */
  /**
   * 插槽透传 插槽组件的插槽来自父组件转发外部插槽
   */
  FORWARDED = 3,
}

/**
 * Dev only
 */
export const slotFlagsText: Record<SlotFlags, string> = {
  [SlotFlags.STABLE]: 'STABLE',
  [SlotFlags.DYNAMIC]: 'DYNAMIC',
  [SlotFlags.FORWARDED]: 'FORWARDED',
}
