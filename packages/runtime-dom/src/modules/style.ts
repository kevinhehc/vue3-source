import { capitalize, hyphenate, isArray, isString } from '@vue/shared'
import { camelize, warn } from '@vue/runtime-core'
import {
  type VShowElement,
  vShowHidden,
  vShowOriginalDisplay,
} from '../directives/vShow'
import { CSS_VAR_TEXT } from '../helpers/useCssVars'

type Style = string | Record<string, string | string[]> | null

const displayRE = /(^|;)\s*display\s*:/

// 功能	                实现方式
// 更新 style 对象	    对比新旧对象 key，逐一更新
// 处理 style 字符串	    直接赋值 style.cssText
// 自动添加前缀	        autoPrefix()
// 支持 !important	    通过 style.setProperty 设置
// 兼容 v-show	        维护 display 显隐状态
export function patchStyle(el: Element, prev: Style, next: Style): void {
  const style = (el as HTMLElement).style
  const isCssString = isString(next)
  let hasControlledDisplay = false
  if (next && !isCssString) {
    if (prev) {
      if (!isString(prev)) {
        for (const key in prev) {
          if (next[key] == null) {
            setStyle(style, key, '')
          }
        }
      } else {
        for (const prevStyle of prev.split(';')) {
          const key = prevStyle.slice(0, prevStyle.indexOf(':')).trim()
          if (next[key] == null) {
            setStyle(style, key, '')
          }
        }
      }
    }
    for (const key in next) {
      if (key === 'display') {
        hasControlledDisplay = true
      }
      setStyle(style, key, next[key])
    }
  } else {
    if (isCssString) {
      if (prev !== next) {
        // #9821
        const cssVarText = (style as any)[CSS_VAR_TEXT]
        if (cssVarText) {
          ;(next as string) += ';' + cssVarText
        }
        style.cssText = next as string
        hasControlledDisplay = displayRE.test(next)
      }
    } else if (prev) {
      el.removeAttribute('style')
    }
  }
  // indicates the element also has `v-show`.
  if (vShowOriginalDisplay in el) {
    // make v-show respect the current v-bind style display when shown
    el[vShowOriginalDisplay] = hasControlledDisplay ? style.display : ''
    // if v-show is in hidden state, v-show has higher priority
    if ((el as VShowElement)[vShowHidden]) {
      style.display = 'none'
    }
  }
}

const semicolonRE = /[^\\];\s*$/
const importantRE = /\s*!important$/

// 功能	              描述
// 数组值	          递归处理（如：['1px solid red', '1px dashed blue']）
// --custom-prop	  用 style.setProperty(name, val)
// 普通 prop	          用自动前缀后 style[prop] = val
// !important	      统一用 setProperty(..., ..., 'important')
// dev 提示	          检查是否意外包含 ;（容易出错）
function setStyle(
  style: CSSStyleDeclaration,
  name: string,
  val: string | string[],
) {
  if (isArray(val)) {
    val.forEach(v => setStyle(style, name, v))
  } else {
    if (val == null) val = ''
    if (__DEV__) {
      if (semicolonRE.test(val)) {
        warn(
          `Unexpected semicolon at the end of '${name}' style value: '${val}'`,
        )
      }
    }
    if (name.startsWith('--')) {
      // custom property definition
      style.setProperty(name, val)
    } else {
      const prefixed = autoPrefix(style, name)
      if (importantRE.test(val)) {
        // !important
        style.setProperty(
          hyphenate(prefixed),
          val.replace(importantRE, ''),
          'important',
        )
      } else {
        style[prefixed as any] = val
      }
    }
  }
}

const prefixes = ['Webkit', 'Moz', 'ms']
const prefixCache: Record<string, string> = {}
// 浏览器兼容性处理
// 使用 Webkit, Moz, ms 三种前缀尝试构建兼容名
// 缓存在 prefixCache 中避免重复计算
// 最终用于处理如 transform, user-select 等属性
function autoPrefix(style: CSSStyleDeclaration, rawName: string): string {
  const cached = prefixCache[rawName]
  if (cached) {
    return cached
  }
  let name = camelize(rawName)
  if (name !== 'filter' && name in style) {
    return (prefixCache[rawName] = name)
  }
  name = capitalize(name)
  for (let i = 0; i < prefixes.length; i++) {
    const prefixed = prefixes[i] + name
    if (prefixed in style) {
      return (prefixCache[rawName] = prefixed)
    }
  }
  return rawName
}
