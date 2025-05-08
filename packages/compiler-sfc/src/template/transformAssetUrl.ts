import path from 'path'
import {
  ConstantTypes,
  type ExpressionNode,
  type NodeTransform,
  NodeTypes,
  type SimpleExpressionNode,
  type SourceLocation,
  type TransformContext,
  createSimpleExpression,
} from '@vue/compiler-core'
import {
  isDataUrl,
  isExternalUrl,
  isRelativeUrl,
  parseUrl,
} from './templateUtils'
import { isArray } from '@vue/shared'

// Vue 编译器中用于处理模板中资源路径（如 <img src="./logo.png">）的插件 —— transformAssetUrl，
// 其核心功能是将相对路径资源转化为静态导入，以支持构建工具（如 Vite、Webpack）自动处理图片、视频等资源文件。

export interface AssetURLTagConfig {
  [name: string]: string[]
}

export interface AssetURLOptions {
  // base：若提供，则不转为导入，而是拼接为绝对路径（用于 CDN 或公共路径）
  // includeAbsolute：是否也处理绝对路径（以 / 开头）
  // tags：定义哪些标签的哪些属性要转换（例如 <img src>、<video poster>）
  /**
   * If base is provided, instead of transforming relative asset urls into
   * imports, they will be directly rewritten to absolute urls.
   */
  base?: string | null
  /**
   * If true, also processes absolute urls.
   */
  includeAbsolute?: boolean
  tags?: AssetURLTagConfig
}

// 默认规则：
export const defaultAssetUrlOptions: Required<AssetURLOptions> = {
  base: null,
  includeAbsolute: false,
  tags: {
    video: ['src', 'poster'],
    source: ['src'],
    img: ['src'],
    image: ['xlink:href', 'href'],
    use: ['xlink:href', 'href'],
  },
}

// 兼容旧格式的配置转换器（如果传入的 options 是 tags 结构，则合并为新结构）。
export const normalizeOptions = (
  options: AssetURLOptions | AssetURLTagConfig,
): Required<AssetURLOptions> => {
  if (Object.keys(options).some(key => isArray((options as any)[key]))) {
    // legacy option format which directly passes in tags config
    return {
      ...defaultAssetUrlOptions,
      tags: options as any,
    }
  }
  return {
    ...defaultAssetUrlOptions,
    ...options,
  }
}

export const createAssetUrlTransformWithOptions = (
  options: Required<AssetURLOptions>,
): NodeTransform => {
  return (node, context) =>
    (transformAssetUrl as Function)(node, context, options)
}

/**
 * A `@vue/compiler-core` plugin that transforms relative asset urls into
 * either imports or absolute urls.
 *
 * ``` js
 * // Before
 * createVNode('img', { src: './logo.png' })
 *
 * // After
 * import _imports_0 from './logo.png'
 * createVNode('img', { src: _imports_0 })
 * ```
 */
// 这是实际的 Node 转换器（NodeTransform）：
export const transformAssetUrl: NodeTransform = (
  node,
  context,
  options: AssetURLOptions = defaultAssetUrlOptions,
) => {
  // 判断 node 是 HTML 元素节点
  // 根据标签名找出需要处理的属性（例如 img.src）
  // 遍历该元素的 props（属性）：
  // 排除条件：
  //   属性不是字面量
  //   是外部链接（http://）
  //   是 data URI（data:）
  //   是锚点（#id）
  //   是绝对路径但未开启 includeAbsolute
  if (node.type === NodeTypes.ELEMENT) {
    if (!node.props.length) {
      return
    }

    const tags = options.tags || defaultAssetUrlOptions.tags
    const attrs = tags[node.tag]
    const wildCardAttrs = tags['*']
    if (!attrs && !wildCardAttrs) {
      return
    }

    const assetAttrs = (attrs || []).concat(wildCardAttrs || [])
    node.props.forEach((attr, index) => {
      if (
        attr.type !== NodeTypes.ATTRIBUTE ||
        !assetAttrs.includes(attr.name) ||
        !attr.value ||
        isExternalUrl(attr.value.content) ||
        isDataUrl(attr.value.content) ||
        attr.value.content[0] === '#' ||
        (!options.includeAbsolute && !isRelativeUrl(attr.value.content))
      ) {
        return
      }

      const url = parseUrl(attr.value.content)
      if (options.base && attr.value.content[0] === '.') {
        // explicit base - directly rewrite relative urls into absolute url
        // to avoid generating extra imports
        // Allow for full hostnames provided in options.base
        const base = parseUrl(options.base)
        const protocol = base.protocol || ''
        const host = base.host ? protocol + '//' + base.host : ''
        const basePath = base.path || '/'

        // when packaged in the browser, path will be using the posix-
        // only version provided by rollup-plugin-node-builtins.
        attr.value.content =
          host +
          (path.posix || path).join(basePath, url.path + (url.hash || ''))
        return
      }

      // otherwise, transform the url into an import.
      // this assumes a bundler will resolve the import into the correct
      // absolute url (e.g. webpack file-loader)
      const exp = getImportsExpressionExp(url.path, url.hash, attr.loc, context)
      node.props[index] = {
        type: NodeTypes.DIRECTIVE,
        name: 'bind',
        arg: createSimpleExpression(attr.name, true, attr.loc),
        exp,
        modifiers: [],
        loc: attr.loc,
      }
    })
  }
}

// 管理 context.imports 列表
// 查找当前资源是否已存在导入
// 生成 _imports_0, _imports_1 命名
// 若存在 #hash：
// 生成表达式 _imports_0 + '#foo'
// 可自动 hoist 提高复用性（配合 context.hoist）
function getImportsExpressionExp(
  path: string | null,
  hash: string | null,
  loc: SourceLocation,
  context: TransformContext,
): ExpressionNode {
  if (path) {
    let name: string
    let exp: SimpleExpressionNode
    const existingIndex = context.imports.findIndex(i => i.path === path)
    if (existingIndex > -1) {
      name = `_imports_${existingIndex}`
      exp = context.imports[existingIndex].exp as SimpleExpressionNode
    } else {
      name = `_imports_${context.imports.length}`
      exp = createSimpleExpression(
        name,
        false,
        loc,
        ConstantTypes.CAN_STRINGIFY,
      )

      // We need to ensure the path is not encoded (to %2F),
      // so we decode it back in case it is encoded
      context.imports.push({
        exp,
        path: decodeURIComponent(path),
      })
    }

    if (!hash) {
      return exp
    }

    const hashExp = `${name} + '${hash}'`
    const finalExp = createSimpleExpression(
      hashExp,
      false,
      loc,
      ConstantTypes.CAN_STRINGIFY,
    )

    if (!context.hoistStatic) {
      return finalExp
    }

    const existingHoistIndex = context.hoists.findIndex(h => {
      return (
        h &&
        h.type === NodeTypes.SIMPLE_EXPRESSION &&
        !h.isStatic &&
        h.content === hashExp
      )
    })
    if (existingHoistIndex > -1) {
      return createSimpleExpression(
        `_hoisted_${existingHoistIndex + 1}`,
        false,
        loc,
        ConstantTypes.CAN_STRINGIFY,
      )
    }
    return context.hoist(finalExp)
  } else {
    return createSimpleExpression(`''`, false, loc, ConstantTypes.CAN_STRINGIFY)
  }
}
