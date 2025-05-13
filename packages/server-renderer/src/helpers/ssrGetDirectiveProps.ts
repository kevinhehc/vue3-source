import { type ComponentPublicInstance, type Directive, ssrUtils } from 'vue'

// 中用于处理**自定义指令的属性输出（v-*）**的工具函数之一。
export function ssrGetDirectiveProps(
  // 参数名	    类型	                    说明
  // instance	    ComponentPublicInstance	当前组件的公开实例
  // dir	        Directive	            自定义指令定义对象
  // value	    any	                    指令的绑定值（如 v-my-dir="foo" 中的 foo）
  // arg	        string	                指令的参数（如 v-my-dir:arg）
  // modifiers	Record<string, boolean>	指令修饰符（如 v-my-dir.foo.bar）
  instance: ComponentPublicInstance,
  dir: Directive,
  value?: any,
  arg?: string,
  modifiers: Record<string, boolean> = {},
): Record<string, any> {
  // 判断指令是否为对象 & 含 getSSRProps
  if (typeof dir !== 'function' && dir.getSSRProps) {
    // 指令不是函数式（即不是 function() {}）
    // 并且定义了 getSSRProps → 支持 SSR 的自定义指令
    return (
      // 构造一个标准的 DirectiveBinding 对象。
      // 第二个参数 vnode 传的是 null，因为在 SSR 阶段不涉及真实 VNode。
      // 如果 getSSRProps() 返回 null，就 fallback 为空对象。
      dir.getSSRProps(
        {
          dir,
          instance: ssrUtils.getComponentPublicInstance(instance.$),
          value,
          oldValue: undefined,
          arg,
          modifiers,
        },
        null as any,
      ) || {}
    )
  }
  return {}
}
