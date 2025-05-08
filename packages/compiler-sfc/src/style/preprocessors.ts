import merge from 'merge-source-map'
import type { RawSourceMap } from '@vue/compiler-core'
import type { SFCStyleCompileOptions } from '../compileStyle'
import { isFunction } from '@vue/shared'

//  Vue SFC 编译器中对 <style lang="scss">、<style lang="less">、<style lang="stylus"> 等 预处理器语言 的编译适配器，
//  核心功能是将开发者书写的样式源码通过对应预处理器转为普通 CSS，并支持 source map、错误收集、依赖追踪等功能。

export type StylePreprocessor = (
  // source: 原始源码
  // map: 原始 source map（用于链式合并）
  // options: 预处理器配置，如 filename、additionalData（预拼接数据）
  // customRequire: 自定义的 require，用于动态加载 sass/less/stylus
  source: string,
  map: RawSourceMap | undefined,
  options: {
    [key: string]: any
    additionalData?: string | ((source: string, filename: string) => string)
    filename: string
  },
  customRequire: SFCStyleCompileOptions['preprocessCustomRequire'],
) => StylePreprocessorResults

export interface StylePreprocessorResults {
  // code: 编译后的 CSS 字符串
  // map: 最终合并后的 source map（可选）
  // errors: 错误列表（兼容多个）
  // dependencies: 所有导入文件路径数组（用于缓存、监听）
  code: string
  map?: object
  errors: Error[]
  dependencies: string[]
}

// .scss/.sass processor
const scss: StylePreprocessor = (source, map, options, load = require) => {
  // 动态加载 sass（Dart Sass 或 Node Sass）
  // 如果 compileString 存在 → 使用新 API（Dart Sass）
  // 否则 → 使用 renderSync（Node Sass）
  // 调用时添加 additionalData（例如全局变量注入）
  // 自动处理 sourceMap 和依赖文件列表
  // sass 是 scss 的缩进语法变体，区别是传入 indentedSyntax: true
  const nodeSass: typeof import('sass') = load('sass')
  const { compileString, renderSync } = nodeSass

  const data = getSource(source, options.filename, options.additionalData)
  let css: string
  let dependencies: string[]
  let sourceMap: any

  try {
    if (compileString) {
      const { pathToFileURL, fileURLToPath }: typeof import('url') = load('url')

      const result = compileString(data, {
        ...options,
        url: pathToFileURL(options.filename),
        sourceMap: !!map,
      })
      css = result.css
      dependencies = result.loadedUrls.map(url => fileURLToPath(url))
      sourceMap = map ? result.sourceMap! : undefined
    } else {
      const result = renderSync({
        ...options,
        data,
        file: options.filename,
        outFile: options.filename,
        sourceMap: !!map,
      })
      css = result.css.toString()
      dependencies = result.stats.includedFiles
      sourceMap = map ? JSON.parse(result.map!.toString()) : undefined
    }

    if (map) {
      return {
        code: css,
        errors: [],
        dependencies,
        map: merge(map, sourceMap!),
      }
    }
    return { code: css, errors: [], dependencies }
  } catch (e: any) {
    return { code: '', errors: [e], dependencies: [] }
  }
}

const sass: StylePreprocessor = (source, map, options, load) =>
  scss(
    source,
    map,
    {
      ...options,
      indentedSyntax: true,
    },
    load,
  )

// .less
const less: StylePreprocessor = (source, map, options, load = require) => {
  // 使用 less.render() 异步转同步（设置 syncImport: true）
  // 传入源码和 options
  // 回调中获取错误或输出对象
  // 输出 .css、.map、.imports
  const nodeLess = load('less')

  let result: any
  let error: Error | null = null
  nodeLess.render(
    getSource(source, options.filename, options.additionalData),
    { ...options, syncImport: true },
    (err: Error | null, output: any) => {
      error = err
      result = output
    },
  )

  if (error) return { code: '', errors: [error], dependencies: [] }
  const dependencies = result.imports
  if (map) {
    return {
      code: result.css.toString(),
      map: merge(map, result.map),
      errors: [],
      dependencies: dependencies,
    }
  }

  return {
    code: result.css.toString(),
    errors: [],
    dependencies: dependencies,
  }
}

// .styl
const styl: StylePreprocessor = (source, map, options, load = require) => {
  // 使用 stylus(...) 创建 Stylus 实例
  // 设置 sourcemap 选项（非 inline）
  // 使用 ref.render() 得到 CSS
  // ref.deps() 获取所有依赖文件
  // 捕获异常并返回错误结构
  const nodeStylus = load('stylus')
  try {
    const ref = nodeStylus(source, options)
    if (map) ref.set('sourcemap', { inline: false, comment: false })

    const result = ref.render()
    const dependencies = ref.deps()
    if (map) {
      return {
        code: result,
        map: merge(map, ref.sourcemap),
        errors: [],
        dependencies,
      }
    }

    return { code: result, errors: [], dependencies }
  } catch (e: any) {
    return { code: '', errors: [e], dependencies: [] }
  }
}

// 辅助函数，用于拼接 additionalData 和原始源码：
// 若未配置 → 返回原始 source
// 若是字符串 → 直接拼接
// 若是函数 → 执行该函数并传入原始源码和文件名
function getSource(
  source: string,
  filename: string,
  additionalData?: string | ((source: string, filename: string) => string),
) {
  if (!additionalData) return source
  if (isFunction(additionalData)) {
    return additionalData(source, filename)
  }
  return additionalData + source
}

export type PreprocessLang = 'less' | 'sass' | 'scss' | 'styl' | 'stylus'

// 导出一个 { lang: processor } 的映射对象，供外部调用时按 lang 选择合适的预处理器。
// 支持：
// less
// sass
// scss
// styl
// stylus（是 styl 的别名）
export const processors: Record<PreprocessLang, StylePreprocessor> = {
  less,
  sass,
  scss,
  styl,
  stylus: styl,
}
