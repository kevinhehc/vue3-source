import {
  type Component,
  type ComponentInternalInstance,
  type Slots,
  createVNode,
} from 'vue'
import { type Props, type SSRBuffer, renderComponentVNode } from '../render'
import type { SSRSlots } from './ssrRenderSlot'

//  SSR 模板编译产物中的“渲染组件”入口，最终调用 renderComponentVNode() 进行真正的组件渲染。
export function ssrRenderComponent(
  // 参数名	类型	含义
  // comp	Component	要渲染的组件（可以是定义对象或 setup 函数）
  // props	`Props	null`
  // children	`Slots	SSRSlots
  // parentComponent	`ComponentInternalInstance	null`
  // slotScopeId	`string	undefined`
  comp: Component,
  props: Props | null = null,
  children: Slots | SSRSlots | null = null,
  parentComponent: ComponentInternalInstance | null = null,
  slotScopeId?: string,
): SSRBuffer | Promise<SSRBuffer> {
  // 渲染该组件 vnode，进入组件的 setup、render、template 编译流程。
  // 返回值是：
  // SSRBuffer（同步组件）
  // 或 Promise<SSRBuffer>（异步组件）
  return renderComponentVNode(
    // 创建组件的虚拟节点（VNode）：
    createVNode(comp, props, children),
    parentComponent,
    slotScopeId,
  )
}
