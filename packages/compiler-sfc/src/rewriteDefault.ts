import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import type { ParserPlugin } from '@babel/parser'
import type { Identifier, Statement } from '@babel/types'
import { resolveParserPlugins } from './script/context'

// 用于在编译阶段将 JavaScript 模块中的 export default 语句重写成变量声明。
// 这在 Vue 单文件组件 (.vue) 的编译器中非常关键，因为我们可能需要往默认导出的对象中注入额外属性或逻辑。
// 核心目标
// 将如下代码：
// export default {
//   name: 'MyComponent'
// }
// 重写为：
// const __default__ = {
//   name: 'MyComponent'
// }
// 这样，后续可以向 __default__ 添加属性（例如绑定 CSS 变量、注入 runtime 逻辑等）。

export function rewriteDefault(
  // input: 源代码字符串（例如 <script> 内的 JS 代码）
  // as: 目标变量名（如 __default__）
  // parserPlugins: Babel 解析插件数组（用于支持 TS、JSX 等语法）
  input: string,
  as: string,
  parserPlugins?: ParserPlugin[],
): string {
  // 解析 input 为 AST
  // 创建 MagicString 对象（用于修改源码字符串）
  // 调用 rewriteDefaultAST(...) 实际进行替换
  // 返回修改后的字符串
  const ast = parse(input, {
    sourceType: 'module',
    plugins: resolveParserPlugins('js', parserPlugins),
  }).program.body
  const s = new MagicString(input)

  rewriteDefaultAST(ast, s, as)

  return s.toString()
}

/**
 * Utility for rewriting `export default` in a script block into a variable
 * declaration so that we can inject things into it
 */
// 处理不同形式的 export default：
// 情况 1：标准默认导出对象
// export default { ... }
// 重写为：
// const __default__ = { ... }

// 情况 2：类定义
// export default class MyComp {}
// 重写为：
// class MyComp {}
// const __default__ = MyComp

// 情况 3：默认导出是命名导出的别名
// export { foo as default }
// 重写为：
// const __default__ = foo

// 情况 4：从模块 re-export 默认
// export { default } from './Foo'
// 重写为：
// import { default as __VUE_DEFAULT__ } from './Foo'
// const __default__ = __VUE_DEFAULT__

export function rewriteDefaultAST(
  ast: Statement[],
  s: MagicString,
  as: string,
): void {
  if (!hasDefaultExport(ast)) {
    s.append(`\nconst ${as} = {}`)
    return
  }

  // if the script somehow still contains `default export`, it probably has
  // multi-line comments or template strings. fallback to a full parse.
  ast.forEach(node => {
    if (node.type === 'ExportDefaultDeclaration') {
      if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
        const start: number =
          node.declaration.decorators && node.declaration.decorators.length > 0
            ? node.declaration.decorators[
                node.declaration.decorators.length - 1
              ].end!
            : node.start!
        s.overwrite(start, node.declaration.id.start!, ` class `)
        s.append(`\nconst ${as} = ${node.declaration.id.name}`)
      } else {
        s.overwrite(node.start!, node.declaration.start!, `const ${as} = `)
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      for (const specifier of node.specifiers) {
        if (
          specifier.type === 'ExportSpecifier' &&
          specifier.exported.type === 'Identifier' &&
          specifier.exported.name === 'default'
        ) {
          if (node.source) {
            if (specifier.local.name === 'default') {
              s.prepend(
                `import { default as __VUE_DEFAULT__ } from '${node.source.value}'\n`,
              )
              const end = specifierEnd(s, specifier.local.end!, node.end!)
              s.remove(specifier.start!, end)
              s.append(`\nconst ${as} = __VUE_DEFAULT__`)
              continue
            } else {
              s.prepend(
                `import { ${s.slice(
                  specifier.local.start!,
                  specifier.local.end!,
                )} as __VUE_DEFAULT__ } from '${node.source.value}'\n`,
              )
              const end = specifierEnd(s, specifier.exported.end!, node.end!)
              s.remove(specifier.start!, end)
              s.append(`\nconst ${as} = __VUE_DEFAULT__`)
              continue
            }
          }

          // 辅助逻辑：specifierEnd(...)
          // 用于确定 export { default, foo } 里 default 的完整删除范围，避免只删一半，造成语法错误。
          const end = specifierEnd(s, specifier.end!, node.end!)
          s.remove(specifier.start!, end)
          s.append(`\nconst ${as} = ${specifier.local.name}`)
        }
      }
    }
  })
}

export function hasDefaultExport(ast: Statement[]): boolean {
  // 扫描 AST，返回是否存在：
  // export default ...
  // 或 export { ... as default }
  for (const stmt of ast) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      return true
    } else if (
      stmt.type === 'ExportNamedDeclaration' &&
      stmt.specifiers.some(
        spec => (spec.exported as Identifier).name === 'default',
      )
    ) {
      return true
    }
  }
  return false
}

function specifierEnd(s: MagicString, end: number, nodeEnd: number | null) {
  // export { default   , foo } ...
  let hasCommas = false
  let oldEnd = end
  while (end < nodeEnd!) {
    if (/\s/.test(s.slice(end, end + 1))) {
      end++
    } else if (s.slice(end, end + 1) === ',') {
      end++
      hasCommas = true
      break
    } else if (s.slice(end, end + 1) === '}') {
      break
    }
  }
  return hasCommas ? end : oldEnd
}
