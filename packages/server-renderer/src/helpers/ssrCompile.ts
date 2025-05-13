import {
  type ComponentInternalInstance,
  type ComponentOptions,
  warn,
} from 'vue'
import { compile } from '@vue/compiler-ssr'
import { NO, extend, generateCodeFrame, isFunction } from '@vue/shared'
import type { CompilerError, CompilerOptions } from '@vue/compiler-core'
import type { PushFn } from '../render'

import * as Vue from 'vue'
import * as helpers from '../internal'

type SSRRenderFunction = (
  // 参数	类型	说明
  // context	any	当前 SSR 渲染上下文（通常是组件实例或 ssrContext）
  // push	PushFn	用于将 HTML 输出字符串写入缓冲区
  // parentInstance	ComponentInternalInstance	父组件实例，用于上下文传递（如 inject）
  context: any,
  push: PushFn,
  parentInstance: ComponentInternalInstance,
) => void

// 这是一个简单的编译结果缓存 Map。
// Key 是编译输入（通常是模板字符串）。
// Value 是模板被 SSR 编译器编译后的 SSRRenderFunction。
// 使用 Object.create(null) 创建一个纯净对象，没有原型链，提高性能和安全性。
const compileCache: Record<string, SSRRenderFunction> = Object.create(null)

// 在 CommonJS 构建环境下动态编译模板字符串为 SSR 渲染函数 的核心函数：
// 在运行时将模板字符串编译为 SSR 渲染函数，并缓存结果（用于没有预编译 .vue 文件的环境，如纯 Node.js 动态 SSR）。

// 场景理解：什么时候用这个？
// 当使用 Vue 3 SSR，且没有预编译 .vue 模板（例如未用 vue-loader、vite-plugin-vue 时），Vue 会调用 ssrCompile() 来动态将 <template> 编译成渲染函数。
export function ssrCompile(
  template: string,
  instance: ComponentInternalInstance,
): SSRRenderFunction {
  // TODO: this branch should now work in ESM builds, enable it in a minor
  if (!__CJS__) {
    // 禁止在 ESM 构建中使用
    // Vue SSR 的 ESM 构建（用于现代打包器）不支持运行时编译模板。
    // 如果你想在 SSR 中使用模板，必须预编译成 ssrRender() 函数。
    throw new Error(
      `On-the-fly template compilation is not supported in the ESM build of ` +
        `@vue/server-renderer. All templates must be pre-compiled into ` +
        `render functions.`,
    )
  }

  // TODO: This is copied from runtime-core/src/component.ts and should probably be refactored
  // 全局配置：是否为自定义元素、compilerOptions。
  // 局部组件配置：delimiters, compilerOptions。
  const Component = instance.type as ComponentOptions
  const { isCustomElement, compilerOptions } = instance.appContext.config
  const { delimiters, compilerOptions: componentCompilerOptions } = Component

  // 合并最终 compilerOptions
  // 优先级：组件局部 > 应用全局 > 默认值。
  const finalCompilerOptions: CompilerOptions = extend(
    extend(
      {
        isCustomElement,
        delimiters,
      },
      compilerOptions,
    ),
    componentCompilerOptions,
  )

  finalCompilerOptions.isCustomElement =
    finalCompilerOptions.isCustomElement || NO
  finalCompilerOptions.isNativeTag = finalCompilerOptions.isNativeTag || NO

  // 构造缓存 key（确保同模板 + 同配置缓存命中）
  const cacheKey = JSON.stringify(
    {
      template,
      compilerOptions: finalCompilerOptions,
    },
    (key, value) => {
      return isFunction(value) ? value.toString() : value
    },
  )

  // 查询编译缓存
  // 如果已经编译过这个模板 + 配置 → 直接复用。
  const cached = compileCache[cacheKey]
  if (cached) {
    return cached
  }

  // 注册错误处理
  // 在开发模式中打印代码帧。
  // 在生产模式中直接抛出错误。
  finalCompilerOptions.onError = (err: CompilerError) => {
    if (__DEV__) {
      const message = `[@vue/server-renderer] Template compilation error: ${err.message}`
      const codeFrame =
        err.loc &&
        generateCodeFrame(
          template as string,
          err.loc.start.offset,
          err.loc.end.offset,
        )
      warn(codeFrame ? `${message}\n${codeFrame}` : message)
    } else {
      throw err
    }
  }

  // 编译模板
  // 使用 @vue/compiler-ssr 编译器，将模板编译为 SSR 渲染函数的 JS 代码字符串：
  const { code } = compile(template, finalCompilerOptions)
  // 通过 Function() 创建运行时函数
  // 用 Function('require', code) 构建运行时函数，手动注入 require('vue') 和 require('vue/server-renderer')。
  // 类似运行时编译器代码注入的机制。
  const requireMap = {
    vue: Vue,
    'vue/server-renderer': helpers,
  }
  const fakeRequire = (id: 'vue' | 'vue/server-renderer') => requireMap[id]
  return (compileCache[cacheKey] = Function('require', code)(fakeRequire))
}
