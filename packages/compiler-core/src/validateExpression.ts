import type { SimpleExpressionNode } from './ast' // 从 ast 模块中导入 SimpleExpressionNode 类型，用于表示简单表达式节点
import type { TransformContext } from './transform' // 从 transform 模块中导入 TransformContext 类型，表示转换过程中的上下文信息
import { ErrorCodes, createCompilerError } from './errors' // 导入错误代码枚举和创建编译错误的方法

// these keywords should not appear inside expressions, but operators like
// 'typeof', 'instanceof', and 'in' are allowed
// 这些关键词在表达式中不允许出现，尽管某些操作符（例如 typeof, instanceof, in）是允许的
const prohibitedKeywordRE = new RegExp(
  '\\b' +
    // 不允许出现在表达式中的 JavaScript 保留字
    (
      'arguments,await,break,case,catch,class,const,continue,debugger,default,' +
      'delete,do,else,export,extends,finally,for,function,if,import,let,new,' +
      'return,super,switch,throw,try,var,void,while,with,yield'
    )
      .split(',') // 将字符串拆分为单个关键词
      .join('\\b|\\b') + // 使用 \b 匹配单词边界，确保精确匹配关键词
    '\\b',
)

// strip strings in expressions
// 用于剥离表达式中的字符串内容，避免误将关键词匹配到字符串里
const stripStringRE =
  /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*\$\{|\}(?:[^`\\]|\\.)*`|`(?:[^`\\]|\\.)*`/g

/**
 * Validate a non-prefixed expression.
 * This is only called when using the in-browser runtime compiler since it
 * doesn't prefix expressions.
 */
/**
 * 验证不带前缀的表达式是否合法。
 * 该函数仅在浏览器端运行时编译器中使用，因为那种模式下不会为表达式添加前缀。
 */
export function validateBrowserExpression(
  node: SimpleExpressionNode, // 要验证的表达式节点
  context: TransformContext, // 转换上下文，用于报告错误
  asParams = false, // 是否将表达式作为函数参数解析
  asRawStatements = false, // 是否将表达式当作原始语句块处理
): void {
  // 提取表达式的字符串内容
  const exp = node.content

  // empty expressions are validated per-directive since some directives
  // do allow empty expressions.
  // 空表达式是否有效由各个指令决定，此处不统一验证
  if (!exp.trim()) {
    return
  }

  try {
    // 尝试构造一个函数，用于检查表达式语法是否合法
    new Function(
      asRawStatements
        ? ` ${exp} ` // 若是语句块，直接原样放入函数体中
        : `return ${asParams ? `(${exp}) => {}` : `(${exp})`}`, // 若是函数参数形式，构造一个箭头函数；否则包装成一个返回表达式的函数
    )
  } catch (e: any) {
    // 默认使用原生语法错误提示信息
    let message = e.message
    // 在表达式中剥离字符串后，查找是否有不允许的关键词
    const keywordMatch = exp
      .replace(stripStringRE, '') // 去除字符串内容
      .match(prohibitedKeywordRE) // 匹配是否存在非法关键词
    if (keywordMatch) {
      message = `avoid using JavaScript keyword as property name: "${keywordMatch[0]}"`
      // 若有非法关键词，构造自定义错误信息提示
    }
    // 调用上下文的错误处理器，报告编译错误
    context.onError(
      createCompilerError(
        ErrorCodes.X_INVALID_EXPRESSION, // 指定错误代码
        node.loc, // 错误发生的位置
        undefined, // 其他参数留空
        message, // 错误提示信息
      ),
    )
  }
}
