import type { PluginCreator } from 'postcss'

// 用于在 Vue 单文件组件（SFC）编译中 清理样式中的多余空白字符，使生成的 CSS 结构更整洁。
// 清除规则（rule）和 at-rule（如 @media）前后的多余空白，只保留换行符。
const trimPlugin: PluginCreator<{}> = () => {
  return {
    postcssPlugin: 'vue-sfc-trim',
    Once(root) {
      // 遍历所有 AST 节点
      // 对于类型是 rule（样式规则）或 atrule（如 @media, @keyframes）的节点：
      // 把 raws.before（声明之前的原始字符）设置为 \n
      // 把 raws.after（声明之后）也设置为 \n（如果存在）
      root.walk(({ type, raws }) => {
        if (type === 'rule' || type === 'atrule') {
          if (raws.before) raws.before = '\n'
          if ('after' in raws && raws.after) raws.after = '\n'
        }
      })
    },
  }
}

// 例效果：
// 原始输入样式（含多余空格）：

//   .foo {
//     color: red;
//   }
//
//   @media screen {
//     .bar {
//       margin: 0;
//     }
//   }

// 经过 vue-sfc-trim 处理后：

// .foo {
//   color: red;
// }
//
// @media screen {
// .bar {
//   margin: 0;
// }
// }

// （注意：这里只清理了空白字符，不改变结构或缩进格式）

trimPlugin.postcss = true
export default trimPlugin
