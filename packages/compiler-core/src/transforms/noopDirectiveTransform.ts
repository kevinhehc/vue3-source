// 引入指令转换函数的类型定义
import type { DirectiveTransform } from '../transform'

// 定义一个空指令转换器：什么都不做，仅返回空 props
export const noopDirectiveTransform: DirectiveTransform = () => ({ props: [] })
