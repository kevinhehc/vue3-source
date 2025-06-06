import postcss, {
  type LazyResult,
  type Message,
  type ProcessOptions,
  type Result,
  type SourceMap,
} from 'postcss'
import trimPlugin from './style/pluginTrim'
import scopedPlugin from './style/pluginScoped'
import {
  type PreprocessLang,
  type StylePreprocessor,
  type StylePreprocessorResults,
  processors,
} from './style/preprocessors'
import type { RawSourceMap } from '@vue/compiler-core'
import { cssVarsPlugin } from './style/cssVars'
import postcssModules from 'postcss-modules'

// Vue SFC (*.vue) 文件中 <style> 区块的 样式编译处理逻辑。这是构建 Vue 单文件组件时不可或缺的一个环节。

export interface SFCStyleCompileOptions {
  source: string
  filename: string
  id: string
  scoped?: boolean
  trim?: boolean
  isProd?: boolean
  inMap?: RawSourceMap
  preprocessLang?: PreprocessLang
  preprocessOptions?: any
  preprocessCustomRequire?: (id: string) => any
  postcssOptions?: any
  postcssPlugins?: any[]
  /**
   * @deprecated use `inMap` instead.
   */
  map?: RawSourceMap
}

/**
 * Aligns with postcss-modules
 * https://github.com/css-modules/postcss-modules
 */
export interface CSSModulesOptions {
  scopeBehaviour?: 'global' | 'local'
  generateScopedName?:
    | string
    | ((name: string, filename: string, css: string) => string)
  hashPrefix?: string
  localsConvention?: 'camelCase' | 'camelCaseOnly' | 'dashes' | 'dashesOnly'
  exportGlobals?: boolean
  globalModulePaths?: RegExp[]
}

export interface SFCAsyncStyleCompileOptions extends SFCStyleCompileOptions {
  isAsync?: boolean
  // css modules support, note this requires async so that we can get the
  // resulting json
  modules?: boolean
  modulesOptions?: CSSModulesOptions
}

export interface SFCStyleCompileResults {
  code: string
  map: RawSourceMap | undefined
  rawResult: Result | LazyResult | undefined
  errors: Error[]
  modules?: Record<string, string>
  dependencies: Set<string>
}

// compileStyle() 和 compileStyleAsync() 的主要职责是将 <style> 块：
// 编译预处理语言（如 SCSS、Less、Stylus）
// 应用 PostCSS 插件（包括 scoped 插件、CSS Modules、CSS 变量处理器等）
// 支持 Source Map 合并
// 收集依赖文件（如 @import 的其他样式）
// 返回最终样式代码和依赖分析信息
export function compileStyle(
  options: SFCStyleCompileOptions,
): SFCStyleCompileResults {
  return doCompileStyle({
    ...options,
    isAsync: false,
  }) as SFCStyleCompileResults
}

export function compileStyleAsync(
  options: SFCAsyncStyleCompileOptions,
): Promise<SFCStyleCompileResults> {
  return doCompileStyle({
    ...options,
    isAsync: true,
  }) as Promise<SFCStyleCompileResults>
}

export function doCompileStyle(
  options: SFCAsyncStyleCompileOptions,
): SFCStyleCompileResults | Promise<SFCStyleCompileResults> {
  const {
    filename,
    id,
    scoped = false,
    trim = true,
    isProd = false,
    modules = false,
    modulesOptions = {},
    preprocessLang,
    postcssOptions,
    postcssPlugins,
  } = options
  const preprocessor = preprocessLang && processors[preprocessLang]
  const preProcessedSource = preprocessor && preprocess(options, preprocessor)
  const map = preProcessedSource
    ? preProcessedSource.map
    : options.inMap || options.map
  const source = preProcessedSource ? preProcessedSource.code : options.source

  const shortId = id.replace(/^data-v-/, '')
  const longId = `data-v-${shortId}`

  const plugins = (postcssPlugins || []).slice()
  plugins.unshift(cssVarsPlugin({ id: shortId, isProd }))
  if (trim) {
    plugins.push(trimPlugin())
  }
  if (scoped) {
    plugins.push(scopedPlugin(longId))
  }
  let cssModules: Record<string, string> | undefined
  if (modules) {
    if (__GLOBAL__ || __ESM_BROWSER__) {
      throw new Error(
        '[@vue/compiler-sfc] `modules` option is not supported in the browser build.',
      )
    }
    if (!options.isAsync) {
      throw new Error(
        '[@vue/compiler-sfc] `modules` option can only be used with compileStyleAsync().',
      )
    }
    plugins.push(
      postcssModules({
        ...modulesOptions,
        getJSON: (_cssFileName: string, json: Record<string, string>) => {
          cssModules = json
        },
      }),
    )
  }

  const postCSSOptions: ProcessOptions = {
    ...postcssOptions,
    to: filename,
    from: filename,
  }
  if (map) {
    postCSSOptions.map = {
      inline: false,
      annotation: false,
      prev: map,
    }
  }

  let result: LazyResult | undefined
  let code: string | undefined
  let outMap: SourceMap | undefined
  // stylus output include plain css. so need remove the repeat item
  const dependencies = new Set(
    preProcessedSource ? preProcessedSource.dependencies : [],
  )
  // sass has filename self when provided filename option
  dependencies.delete(filename)

  const errors: Error[] = []
  if (preProcessedSource && preProcessedSource.errors.length) {
    errors.push(...preProcessedSource.errors)
  }

  const recordPlainCssDependencies = (messages: Message[]) => {
    messages.forEach(msg => {
      if (msg.type === 'dependency') {
        // postcss output path is absolute position path
        dependencies.add(msg.file)
      }
    })
    return dependencies
  }

  try {
    result = postcss(plugins).process(source, postCSSOptions)

    // In async mode, return a promise.
    if (options.isAsync) {
      return result
        .then(result => ({
          code: result.css || '',
          map: result.map && result.map.toJSON(),
          errors,
          modules: cssModules,
          rawResult: result,
          dependencies: recordPlainCssDependencies(result.messages),
        }))
        .catch(error => ({
          code: '',
          map: undefined,
          errors: [...errors, error],
          rawResult: undefined,
          dependencies,
        }))
    }

    recordPlainCssDependencies(result.messages)
    // force synchronous transform (we know we only have sync plugins)
    code = result.css
    outMap = result.map
  } catch (e: any) {
    errors.push(e)
  }

  return {
    code: code || ``,
    map: outMap && outMap.toJSON(),
    errors,
    rawResult: result,
    dependencies,
  }
}

function preprocess(
  options: SFCStyleCompileOptions,
  preprocessor: StylePreprocessor,
): StylePreprocessorResults {
  if ((__ESM_BROWSER__ || __GLOBAL__) && !options.preprocessCustomRequire) {
    throw new Error(
      `[@vue/compiler-sfc] Style preprocessing in the browser build must ` +
        `provide the \`preprocessCustomRequire\` option to return the in-browser ` +
        `version of the preprocessor.`,
    )
  }

  return preprocessor(
    options.source,
    options.inMap || options.map,
    {
      filename: options.filename,
      ...options.preprocessOptions,
    },
    options.preprocessCustomRequire,
  )
}
