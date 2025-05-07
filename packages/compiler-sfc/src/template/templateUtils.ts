import { type UrlWithStringQuery, parse as uriParse } from 'url'
import { isString } from '@vue/shared'

//  判断一个 URL 是否是“相对路径”。
export function isRelativeUrl(url: string): boolean {
  // 只要开头是：
  // . → 例如 ./image.png
  // ~ → 通常表示 webpack 中的模块别名
  // @ → 通常表示路径别名（如 @/assets/logo.png）
  // 返回 true。
  const firstChar = url.charAt(0)
  return firstChar === '.' || firstChar === '~' || firstChar === '@'
}

// 判断是否是“外部 URL”。
const externalRE = /^(https?:)?\/\//
export function isExternalUrl(url: string): boolean {
  // 以 http:// 或 https:// 开头（也支持协议相对 //）
  // 正则：/^(https?:)?\/\//
  return externalRE.test(url)
}

const dataUrlRE = /^\s*data:/i
// 判断是否是 data: 协议开头的内联资源（如内联图片、base64 字符串等）。
// 正则： /^\s*data:/i
// data:image/png;base64,... → true
export function isDataUrl(url: string): boolean {
  return dataUrlRE.test(url)
}

/**
 * Parses string url into URL object.
 */
//  将字符串形式的 URL 转换为一个结构化的 URL 对象。
export function parseUrl(url: string): UrlWithStringQuery {
  // 如果以 ~ 开头（如 ~@/assets/foo.png）：
  // 会裁掉 ~ 或 ~/ 前缀（兼容 webpack 的 ~ 语法）
  // 然后调用 parseUriParts() 做进一步处理
  const firstChar = url.charAt(0)
  if (firstChar === '~') {
    const secondChar = url.charAt(1)
    url = url.slice(secondChar === '/' ? 2 : 1)
  }
  return parseUriParts(url)
}

/**
 * vuejs/component-compiler-utils#22 Support uri fragment in transformed require
 * @param urlString - an url as a string
 */
//  使用 Node.js 的 url.parse()（或 polyfill）将 URL 字符串解析为对象。
function parseUriParts(urlString: string): UrlWithStringQuery {
  // 如果参数不是字符串，会安全降级为 ''
  // 传递参数：
  // 第二个参数：false → 不解析 query 为对象
  // 第三个参数：true → 允许识别 // 的主机标识
  // 返回的结构通常包括：
  // protocol
  // host
  // pathname
  // hash
  // query（仍是字符串）
  // A TypeError is thrown if urlString is not a string
  // @see https://nodejs.org/api/url.html#url_url_parse_urlstring_parsequerystring_slashesdenotehost
  return uriParse(isString(urlString) ? urlString : '', false, true)
}
