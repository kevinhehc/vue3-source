import { isArray } from '@vue/shared'
import type { ComponentInternalInstance } from '../component'
import type { DirectiveHook, ObjectDirective } from '../directives'
import { DeprecationTypes, softAssertCompatEnabled } from './compatConfig'

export interface LegacyDirective {
  bind?: DirectiveHook
  inserted?: DirectiveHook
  update?: DirectiveHook
  componentUpdated?: DirectiveHook
  unbind?: DirectiveHook
}

const legacyDirectiveHookMap: Partial<
  Record<
    keyof ObjectDirective,
    keyof LegacyDirective | (keyof LegacyDirective)[]
  >
> = {
  beforeMount: 'bind',
  mounted: 'inserted',
  updated: ['update', 'componentUpdated'],
  unmounted: 'unbind',
}

// 用于兼容 Vue 2 自定义指令钩子名称的转换函数：

// 在 Vue 2 中，自定义指令的钩子名称和 Vue 3 是不一样的：
//
// Vue 2 钩子	    Vue 3 对应钩子
// bind	            beforeMount
// inserted	        mounted
// update	        beforeUpdate
// componentUpdated	updated
// unbind	        unmounted
export function mapCompatDirectiveHook(
  name: keyof ObjectDirective,
  dir: ObjectDirective & LegacyDirective,
  instance: ComponentInternalInstance | null,
): DirectiveHook | DirectiveHook[] | undefined {
  const mappedName = legacyDirectiveHookMap[name]
  if (mappedName) {
    if (isArray(mappedName)) {
      const hook: DirectiveHook[] = []
      mappedName.forEach(mapped => {
        const mappedHook = dir[mapped]
        if (mappedHook) {
          softAssertCompatEnabled(
            DeprecationTypes.CUSTOM_DIR,
            instance,
            mapped,
            name,
          )
          hook.push(mappedHook)
        }
      })
      return hook.length ? hook : undefined
    } else {
      if (dir[mappedName]) {
        softAssertCompatEnabled(
          DeprecationTypes.CUSTOM_DIR,
          instance,
          mappedName,
          name,
        )
      }
      return dir[mappedName]
    }
  }
}
