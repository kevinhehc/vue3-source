import path from 'path'
import {
  ConstantTypes,
  type ExpressionNode,
  type NodeTransform,
  NodeTypes,
  type SimpleExpressionNode,
  createCompoundExpression,
  createSimpleExpression,
} from '@vue/compiler-core'
import {
  isDataUrl,
  isExternalUrl,
  isRelativeUrl,
  parseUrl,
} from './templateUtils'
import {
  type AssetURLOptions,
  defaultAssetUrlOptions,
} from './transformAssetUrl'

// Vue 模板编译器中的另一个资源处理插件 —— transformSrcset，用于处理 <img srcset="..."> 或 <source srcset="..."> 中的多图片资源路径。
// 它的功能与 transformAssetUrl 类似，但专门为 srcset 属性设计，支持多个图像候选项（responsive images）。

// 示例：
// 原始模板：
// <img srcset="./img@1x.png 1x, ./img@2x.png 2x">
// 转换为：
// import _imports_0 from './img@1x.png'
// import _imports_1 from './img@2x.png'
// <img :srcset="_imports_0 + ' 1x, ' + _imports_1 + ' 2x'">

// 只有 <img> 和 <source> 标签会被处理，并且属性名必须是 srcset。

const srcsetTags = ['img', 'source']

interface ImageCandidate {
  url: string
  descriptor: string
}

// http://w3c.github.io/html/semantics-embedded-content.html#ref-for-image-candidate-string-5
const escapedSpaceCharacters = /( |\\t|\\n|\\f|\\r)+/g

export const createSrcsetTransformWithOptions = (
  options: Required<AssetURLOptions>,
): NodeTransform => {
  return (node, context) =>
    (transformSrcset as Function)(node, context, options)
}

export const transformSrcset: NodeTransform = (
  node,
  context,
  options: Required<AssetURLOptions> = defaultAssetUrlOptions,
) => {
  if (node.type === NodeTypes.ELEMENT) {
    // 当满足以下条件时开始处理：
    // 节点类型是 HTML 元素（NodeTypes.ELEMENT）
    // 标签名是 img 或 source
    // 存在 srcset 属性
    if (srcsetTags.includes(node.tag) && node.props.length) {
      node.props.forEach((attr, index) => {
        if (attr.name === 'srcset' && attr.type === NodeTypes.ATTRIBUTE) {
          if (!attr.value) return
          const value = attr.value.content
          if (!value) return
          // 分解 srcset 值为图片候选项
          const imageCandidates: ImageCandidate[] = value.split(',').map(s => {
            // The attribute value arrives here with all whitespace, except
            // normal spaces, represented by escape sequences
            const [url, descriptor] = s
              // 空格使用 escapedSpaceCharacters 正则标准化。
              .replace(escapedSpaceCharacters, ' ')
              .trim()
              .split(' ', 2)
            return { url, descriptor }
          })

          // data urls contains comma after the encoding so we need to re-merge
          // them
          for (let i = 0; i < imageCandidates.length; i++) {
            const { url } = imageCandidates[i]
            if (isDataUrl(url)) {
              imageCandidates[i + 1].url =
                url + ',' + imageCandidates[i + 1].url
              imageCandidates.splice(i, 1)
            }
          }

          // 判断哪些路径需要处理
          // 只处理：
          // 相对路径（如 ./a.png）
          // 显式配置为 includeAbsolute: true 时，也处理绝对路径（如 /images/b.png）
          const shouldProcessUrl = (url: string) => {
            return (
              !isExternalUrl(url) &&
              !isDataUrl(url) &&
              (options.includeAbsolute || isRelativeUrl(url))
            )
          }
          // When srcset does not contain any qualified URLs, skip transforming
          if (!imageCandidates.some(({ url }) => shouldProcessUrl(url))) {
            return
          }

          // 当 options.base 存在：
          // 以 . 开头的路径使用 path.join(base, url)
          // 转换后赋值回 attr.value.content
          // 若还有无法处理的路径（非相对路径），则标记为需导入
          if (options.base) {
            const base = options.base
            const set: string[] = []
            let needImportTransform = false

            imageCandidates.forEach(candidate => {
              let { url, descriptor } = candidate
              descriptor = descriptor ? ` ${descriptor}` : ``
              if (url[0] === '.') {
                candidate.url = (path.posix || path).join(base, url)
                set.push(candidate.url + descriptor)
              } else if (shouldProcessUrl(url)) {
                needImportTransform = true
              } else {
                set.push(url + descriptor)
              }
            })

            if (!needImportTransform) {
              attr.value.content = set.join(', ')
              return
            }
          }

          // 处理方式二：转为动态导入表达式（默认）
          // 构造一个 CompoundExpressionNode 复合表达式：
          // 所有路径都转为 _imports_n
          // 字符串拼接保持顺序与原 srcset 一致
          // 可开启 hoistStatic 提升性能
          const compoundExpression = createCompoundExpression([], attr.loc)
          imageCandidates.forEach(({ url, descriptor }, index) => {
            if (shouldProcessUrl(url)) {
              const { path } = parseUrl(url)
              let exp: SimpleExpressionNode
              if (path) {
                const existingImportsIndex = context.imports.findIndex(
                  i => i.path === path,
                )
                if (existingImportsIndex > -1) {
                  exp = createSimpleExpression(
                    `_imports_${existingImportsIndex}`,
                    false,
                    attr.loc,
                    ConstantTypes.CAN_STRINGIFY,
                  )
                } else {
                  exp = createSimpleExpression(
                    `_imports_${context.imports.length}`,
                    false,
                    attr.loc,
                    ConstantTypes.CAN_STRINGIFY,
                  )
                  context.imports.push({ exp, path })
                }
                compoundExpression.children.push(exp)
              }
            } else {
              // createSrcsetTransformWithOptions(...) 是工厂函数，供外部注册插件使用：
              const exp = createSimpleExpression(
                `"${url}"`,
                false,
                attr.loc,
                ConstantTypes.CAN_STRINGIFY,
              )
              compoundExpression.children.push(exp)
            }
            const isNotLast = imageCandidates.length - 1 > index
            if (descriptor && isNotLast) {
              compoundExpression.children.push(` + ' ${descriptor}, ' + `)
            } else if (descriptor) {
              compoundExpression.children.push(` + ' ${descriptor}'`)
            } else if (isNotLast) {
              compoundExpression.children.push(` + ', ' + `)
            }
          })

          let exp: ExpressionNode = compoundExpression
          if (context.hoistStatic) {
            exp = context.hoist(compoundExpression)
            exp.constType = ConstantTypes.CAN_STRINGIFY
          }

          node.props[index] = {
            type: NodeTypes.DIRECTIVE,
            name: 'bind',
            arg: createSimpleExpression('srcset', true, attr.loc),
            exp,
            modifiers: [],
            loc: attr.loc,
          }
        }
      })
    }
  }
}
