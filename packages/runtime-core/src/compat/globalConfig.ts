import type { AppConfig } from '../apiCreateApp'
import {
  DeprecationTypes,
  softAssertCompatEnabled,
  warnDeprecation,
} from './compatConfig'
import { isCopyingConfig } from './global'
import { internalOptionMergeStrats } from '../componentOptions'

// legacy config warnings
export type LegacyConfig = {
  /**
   * @deprecated `config.silent` option has been removed
   */
  silent?: boolean
  /**
   * @deprecated use __VUE_PROD_DEVTOOLS__ compile-time feature flag instead
   * https://github.com/vuejs/core/tree/main/packages/vue#bundler-build-feature-flags
   */
  devtools?: boolean
  /**
   * @deprecated use `config.isCustomElement` instead
   * https://v3-migration.vuejs.org/breaking-changes/global-api.html#config-ignoredelements-is-now-config-iscustomelement
   */
  ignoredElements?: (string | RegExp)[]
  /**
   * @deprecated
   * https://v3-migration.vuejs.org/breaking-changes/keycode-modifiers.html
   */
  keyCodes?: Record<string, number | number[]>
  /**
   * @deprecated
   * https://v3-migration.vuejs.org/breaking-changes/global-api.html#config-productiontip-removed
   */
  productionTip?: boolean
}

// dev only
// 在开发模式下劫持 Vue 2 的 Vue.config.xxx 配置项，发出弃用警告
// 劫持旧配置项的访问和赋值操作，并在运行时打印废弃警告。
// 具体劫持的配置项：
// {
//   silent,         // Vue.config.silent
//   devtools,       // Vue.config.devtools
//   ignoredElements,// Vue.config.ignoredElements
//   keyCodes,       // Vue.config.keyCodes
//   productionTip   // Vue.config.productionTip
// }

// 这些配置项在 Vue 3 已被删除或更改，因此 compat build 会：
// 拦截 get 和 set；
// 如果你 set 了这些属性，就会触发 warnDeprecation()；
// 在 isCopyingConfig 为 true（内部迁移时）时不会警告。
export function installLegacyConfigWarnings(config: AppConfig): void {
  const legacyConfigOptions: Record<string, DeprecationTypes> = {
    silent: DeprecationTypes.CONFIG_SILENT,
    devtools: DeprecationTypes.CONFIG_DEVTOOLS,
    ignoredElements: DeprecationTypes.CONFIG_IGNORED_ELEMENTS,
    keyCodes: DeprecationTypes.CONFIG_KEY_CODES,
    productionTip: DeprecationTypes.CONFIG_PRODUCTION_TIP,
  }

  Object.keys(legacyConfigOptions).forEach(key => {
    let val = (config as any)[key]
    Object.defineProperty(config, key, {
      enumerable: true,
      get() {
        return val
      },
      set(newVal) {
        if (!isCopyingConfig) {
          warnDeprecation(legacyConfigOptions[key], null)
        }
        val = newVal
      },
    })
  })
}

// Vue.config.optionMergeStrategies 提供兼容性实现（返回内部合并策略）
// 兼容 Vue 2 中 Vue.config.optionMergeStrategies 的访问行为，使旧插件仍然能获取特定合并策略函数。
export function installLegacyOptionMergeStrats(config: AppConfig): void {
  // 返回的 optionMergeStrategies 是个 Proxy；
  // 只有当你访问某个 key 且该 key 存在于内部合并策略中时才返回；
  // 否则是 undefined；
  // softAssertCompatEnabled() 控制是否允许这种行为。
  config.optionMergeStrategies = new Proxy({} as any, {
    get(target, key) {
      if (key in target) {
        return target[key]
      }
      if (
        key in internalOptionMergeStrats &&
        softAssertCompatEnabled(
          DeprecationTypes.CONFIG_OPTION_MERGE_STRATS,
          null,
        )
      ) {
        return internalOptionMergeStrats[
          key as keyof typeof internalOptionMergeStrats
        ]
      }
    },
  })
}
