import { getCurrentInstance, warn } from '@vue/runtime-core'
import { EMPTY_OBJ } from '@vue/shared'

// 在 <script setup> 或 setup() 中获取 CSS Modules 映射对象 的 Composition API 函数。
// instance.type.__cssModules	是编译器注入的对象，包含所有 <style module> 样式
// name = '$style'	默认模块名对应 <style module>；自定义如 <style module="abc"> 则传入 "abc"
// mod[name]	获取最终映射对象，例如 { red: "_red_abcd123" }
export function useCssModule(name = '$style'): Record<string, string> {
  if (!__GLOBAL__) {
    const instance = getCurrentInstance()!
    if (!instance) {
      __DEV__ && warn(`useCssModule must be called inside setup()`)
      return EMPTY_OBJ
    }
    const modules = instance.type.__cssModules
    if (!modules) {
      __DEV__ && warn(`Current instance does not have CSS modules injected.`)
      return EMPTY_OBJ
    }
    const mod = modules[name]
    if (!mod) {
      __DEV__ &&
        warn(`Current instance does not have CSS module named "${name}".`)
      return EMPTY_OBJ
    }
    return mod as Record<string, string>
  } else {
    /* v8 ignore start */
    if (__DEV__) {
      warn(`useCssModule() is not supported in the global build.`)
    }
    return EMPTY_OBJ
    /* v8 ignore stop */
  }
}
