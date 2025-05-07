import type {
  BlockStatement,
  Expression,
  Identifier,
  Node,
  ObjectPattern,
  Program,
  VariableDeclaration,
} from '@babel/types'
import { walk } from 'estree-walker'
import {
  BindingTypes,
  TS_NODE_TYPES,
  extractIdentifiers,
  isFunctionType,
  isInDestructureAssignment,
  isReferencedIdentifier,
  isStaticProperty,
  unwrapTSNode,
  walkFunctionParams,
} from '@vue/compiler-dom'
import { genPropsAccessExp } from '@vue/shared'
import { isCallOf, resolveObjectKey } from './utils'
import type { ScriptCompileContext } from './context'
import { DEFINE_PROPS } from './defineProps'

// 提取解构结构中的每个属性，包括默认值和本地变量名映射，记录到编译上下文中，为后续生成 prop 类型、默认值、绑定信息等做准备。
export function processPropsDestructure(
  // ctx: 编译上下文，存储所有需要在编译过程中共享的信息。
  // declId: 解构语法的节点（ObjectPattern），即 const { ... } = defineProps() 中的 { ... } 部分的 AST 节点。
  ctx: ScriptCompileContext,
  declId: ObjectPattern,
): void {
  // 检查配置项 propsDestructure
  // 如果配置为 "error"，表示明确禁止使用 props 解构，直接抛出错误。
  // 如果是 false，表示关闭该功能，直接跳过处理。
  if (ctx.options.propsDestructure === 'error') {
    ctx.error(`Props destructure is explicitly prohibited via config.`, declId)
  } else if (ctx.options.propsDestructure === false) {
    return
  }

  // 记录这个解构模式声明节点
  // 用于后续引用，比如生成 prop 声明时分析位置、范围等。
  ctx.propsDestructureDecl = declId

  // 定义辅助函数 registerBinding
  // 这个函数把每个解构的属性信息记录到上下文里：
  // key: 原始 props 的属性名。
  // local: 解构后本地使用的变量名。
  // defaultValue: 是否有默认值。
  // 会保存到 ctx.propsDestructuredBindings 中。
  const registerBinding = (
    key: string,
    local: string,
    defaultValue?: Expression,
  ) => {
    ctx.propsDestructuredBindings[key] = { local, default: defaultValue }
    if (local !== key) {
      ctx.bindingMetadata[local] = BindingTypes.PROPS_ALIASED
      ;(ctx.bindingMetadata.__propsAliases ||
        (ctx.bindingMetadata.__propsAliases = {}))[local] = key
      // 如果使用了别名（例如 baz: localBaz），还要更新 bindingMetadata，标记为 PROPS_ALIASED，并记录原始与本地变量名的映射。
    }
  }

  // 遍历解构的每一项属性
  for (const prop of declId.properties) {
    // 如果是普通属性（ObjectProperty）：
    if (prop.type === 'ObjectProperty') {
      // 使用 resolveObjectKey 解析出属性名（例如字符串或标识符）。
      const propKey = resolveObjectKey(prop.key, prop.computed)

      if (!propKey) {
        ctx.error(
          `${DEFINE_PROPS}() destructure cannot use computed key.`,
          prop.key,
        )
      }

      if (prop.value.type === 'AssignmentPattern') {
        // 如果是 AssignmentPattern，表示有默认值，例如 bar = 123。
        // 检查左侧必须是标识符（不能是嵌套解构），否则报错。
        // default value { foo = 123 }
        const { left, right } = prop.value
        if (left.type !== 'Identifier') {
          ctx.error(
            `${DEFINE_PROPS}() destructure does not support nested patterns.`,
            left,
          )
        }
        registerBinding(propKey, left.name, right)
      } else if (prop.value.type === 'Identifier') {
        // 如果是普通的 Identifier，表示直接解构，如 foo。
        // simple destructure
        registerBinding(propKey, prop.value.name)
      } else {
        // 否则都是不支持的嵌套结构，报错。
        ctx.error(
          `${DEFINE_PROPS}() destructure does not support nested patterns.`,
          prop.value,
        )
      }
    } else {
      // rest spread
      // 记录 ctx.propsDestructureRestId，后续用于处理剩下的 props。
      // 绑定标记为 SETUP_REACTIVE_CONST，表示这是个响应式常量。
      ctx.propsDestructureRestId = (prop.argument as Identifier).name
      // register binding
      ctx.bindingMetadata[ctx.propsDestructureRestId] =
        BindingTypes.SETUP_REACTIVE_CONST
    }
  }
}

/**
 * true -> prop binding
 * false -> local binding
 */
// 这是一个作用域对象，key 是变量名，value 是布尔值，表示该变量是 props 绑定（true）还是 local 绑定（false）。
type Scope = Record<string, boolean>

// 用于转换和分析哪些变量是从 props 解构来的（即“prop绑定”），哪些是用户自己声明的本地变量（即“local绑定”），从而在后续代码生成时，正确处理这些绑定的作用域和访问方式。
export function transformDestructuredProps(
  // ctx：编译上下文。
  // vueImportAliases：记录 Vue 中导入的别名，比如 ref、reactive 等可能被用户重命名的 Vue API。
  ctx: ScriptCompileContext,
  vueImportAliases: Record<string, string>,
): void {
  // 先判断 ctx.options.propsDestructure 是否为 false，如果是，说明禁用了解构支持，直接返回。
  if (ctx.options.propsDestructure === false) {
    return
  }

  // rootScope: 最顶层作用域。
  // scopeStack: 作用域栈，用于进入/离开代码块时追踪变量定义。
  // currentScope: 当前正在使用的作用域，初始为 rootScope。
  // excludedIds: 一个 WeakSet，记录所有本地绑定的变量标识符，后面生成代码时要跳过这些变量。
  // parentStack: 一个 AST 节点栈，在整个语法树遍历过程中用于追踪父节点关系。
  // propsLocalToPublicMap: 把用户定义的本地变量名映射回原始 prop 名称，例如 localBaz → baz。
  const rootScope: Scope = Object.create(null)
  const scopeStack: Scope[] = [rootScope]
  let currentScope: Scope = rootScope
  const excludedIds = new WeakSet<Identifier>()
  const parentStack: Node[] = []
  const propsLocalToPublicMap: Record<string, string> = Object.create(null)

  // 然后，初始化 rootScope 中的绑定变量：
  // 从 ctx.propsDestructuredBindings 中取出所有解构变量，把它们加入 rootScope，并标记为 true，表示它们来自 prop 解构。
  // 同时填充 propsLocalToPublicMap，用于记录本地变量名与原始 prop 名之间的映射。
  for (const key in ctx.propsDestructuredBindings) {
    const { local } = ctx.propsDestructuredBindings[key]
    rootScope[local] = true
    propsLocalToPublicMap[local] = key
  }

  // 进入新作用域（例如函数、代码块），创建一个新的 scope 并入栈。
  function pushScope() {
    scopeStack.push((currentScope = Object.create(currentScope)))
  }

  // 离开当前作用域，从作用域栈中弹出。
  function popScope() {
    scopeStack.pop()
    currentScope = scopeStack[scopeStack.length - 1] || null
  }

  // 把某个变量注册为本地绑定，即明确不是 props 解构的一部分。
  // 会将这个标识符加入 excludedIds，表示它不是要处理的 prop；
  // 同时将 currentScope 中这个变量标记为 false；
  // 如果当前作用域为空，则抛出错误，表示作用域追踪有问题。
  function registerLocalBinding(id: Identifier) {
    excludedIds.add(id)
    if (currentScope) {
      currentScope[id.name] = false
    } else {
      ctx.error(
        'registerBinding called without active scope, something is wrong.',
        id,
      )
    }
  }

  // 用于遍历一段作用域代码块（如整个程序或一个代码块语句），目的是识别和注册当前作用域中所有由用户声明的本地变量。
  // 这是 Vue <script setup> 编译器处理中 defineProps() 解构的重要部分之一，用于区分哪些变量来自 props，哪些是用户自己定义的。
  function walkScope(node: Program | BlockStatement, isRoot = false) {
    // node 是一个 AST 节点，可以是 Program（整个模块）或 BlockStatement（代码块）。
    // isRoot 是布尔值，表示是否是顶层作用域。

    // 遍历当前作用域下的所有语句（node.body），识别出所有定义的变量（特别是那些会覆盖 prop 的本地变量），并将它们注册到作用域中。
    for (const stmt of node.body) {
      if (stmt.type === 'VariableDeclaration') {
        // 如果语句是 VariableDeclaration（如 let x = 1 或 const y = 2）：
        // 调用 walkVariableDeclaration，进入该声明处理逻辑，收集变量。
        // isRoot 参数会传入，用于判断变量是顶层定义还是嵌套作用域定义。
        walkVariableDeclaration(stmt, isRoot)
      } else if (
        stmt.type === 'FunctionDeclaration' ||
        stmt.type === 'ClassDeclaration'
      ) {
        // 如果语句是 FunctionDeclaration 或 ClassDeclaration：
        // 例如 function foo() {} 或 class Bar {}
        // 如果是 declare 声明（TS 特性）或没有标识符（匿名声明），就跳过。
        // 否则调用 registerLocalBinding，将函数名或类名注册为本地绑定。
        if (stmt.declare || !stmt.id) continue
        registerLocalBinding(stmt.id)
      } else if (
        (stmt.type === 'ForOfStatement' || stmt.type === 'ForInStatement') &&
        stmt.left.type === 'VariableDeclaration'
      ) {
        // 如果语句是 for-in 或 for-of 循环，且左侧是变量声明：
        // 例如：for (const x of arr)，处理左侧的变量声明部分。
        walkVariableDeclaration(stmt.left)
      } else if (
        // 如果语句是导出语句（export），且内部是变量声明：
        // 例如：export const foo = 1
        // 同样调用 walkVariableDeclaration。
        stmt.type === 'ExportNamedDeclaration' &&
        stmt.declaration &&
        stmt.declaration.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.declaration, isRoot)
      } else if (
        // 如果语句是带标签的变量声明（比较少见的结构）：
        // 例如：
        // label: const x = 1
        // 处理其内部的变量声明。
        stmt.type === 'LabeledStatement' &&
        stmt.body.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.body, isRoot)
      }
    }
    // 这个函数负责“扫一遍当前作用域内的变量定义”，将用户定义的变量标记为本地绑定（非 props），以避免后续将其误处理成 props。
    // 例如：
    // const { foo } = defineProps()
    // const foo = 123
    // 这种情况下第二个 foo 是本地变量，应覆盖掉解构自 props 的 foo，这就是 walkScope 和 registerLocalBinding 联合处理的目的。
  }

  //  Vue <script setup> 编译器处理作用域变量的一部分，它用于分析一条变量声明语句（VariableDeclaration），
  //  并从中识别出所有声明的变量，然后判断这些变量是否是 defineProps() 的解构产物，或普通本地变量，并作出相应处理。
  function walkVariableDeclaration(stmt: VariableDeclaration, isRoot = false) {
    // 如果这是 TypeScript 的 declare 声明（比如 declare const foo: string），表示只是类型声明，没有实际代码意义，直接跳过。
    if (stmt.declare) {
      return
    }
    for (const decl of stmt.declarations) {
      // 遍历变量声明列表（比如 const a = 1, b = 2 会包含两个 VariableDeclarator 节点）。
      // 然后判断这个声明是否是 defineProps() 的调用，并处于顶层作用域（isRoot 为 true）：

      // unwrapTSNode(decl.init)：剥去 TS 类型节点包装，获取实际的初始化表达式；
      // isCallOf(...)：判断是否是对 defineProps 的调用。
      const isDefineProps =
        isRoot && decl.init && isCallOf(unwrapTSNode(decl.init), 'defineProps')
      for (const id of extractIdentifiers(decl.id)) {
        // 接着提取出所有被声明的变量名（无论是标识符、解构、嵌套解构）：
        if (isDefineProps) {
          // for defineProps destructure, only exclude them since they
          // are already passed in as knownProps
          // 如果是 defineProps() 的解构变量（如 const { foo } = defineProps()）：
          // 不调用 registerLocalBinding，而是：
          // excludedIds.add(id)
          // 表示这些变量虽然在代码里被声明，但它们其实是 props 的别名绑定，不应该被当作普通的本地变量处理，避免冲突。
          excludedIds.add(id)
        } else {
          // 正常注册这些变量为本地绑定变量：
          registerLocalBinding(id)
        }
      }
    }
  }

  //  Vue <script setup> 编译器处理 defineProps() 解构变量引用的核心步骤之一。
  //  它的作用是：当发现某个变量（标识符 id）来自 props 解构时，将这个变量在代码中的使用替换为 __props.xxx 的访问形式，以保证在运行时正确地访问 props 数据。
  function rewriteId(id: Identifier, parent: Node, parentStack: Node[]) {
    // id：当前正在遍历到的标识符（变量名）。
    // parent：该标识符的父 AST 节点。
    // parentStack：该标识符的所有祖先节点，形成从根到当前的访问路径。

    // 第一段处理 props 被赋值或修改的情况：
    // 如果你尝试给解构出来的 prop 赋值或做 ++/-- 操作（比如 foo = 123 或 foo++），会抛出错误。因为 props 是只读的，Vue 中不允许修改 props。
    if (
      (parent.type === 'AssignmentExpression' && id === parent.left) ||
      parent.type === 'UpdateExpression'
    ) {
      ctx.error(`Cannot assign to destructured props as they are readonly.`, id)
    }

    // 处理属性简写的情况：
    if (isStaticProperty(parent) && parent.shorthand) {
      // let binding used in a property shorthand
      // skip for destructure patterns
      // 如果变量是在一个对象字面量中被用作简写属性，比如：
      // const obj = { foo }  // 等同于 { foo: foo }
      // 这时需要展开它的真实值，以访问 __props.foo。
      if (
        !(parent as any).inPattern ||
        isInDestructureAssignment(parent, parentStack)
      ) {
        // 排除掉结构模式（例如 const { foo } = obj）中的属性，避免误处理。
        // 如果是合法的简写属性，就将代码改写成完整写法：
        // { prop } -> { prop: __props.prop }
        ctx.s.appendLeft(
          id.end! + ctx.startOffset!,
          `: ${genPropsAccessExp(propsLocalToPublicMap[id.name])}`,
        )
      }
    } else {
      // x --> __props.x
      // 普通变量引用的改写：
      ctx.s.overwrite(
        id.start! + ctx.startOffset!,
        id.end! + ctx.startOffset!,
        genPropsAccessExp(propsLocalToPublicMap[id.name]),
      )
      // 比如你写了：
      // console.log(foo)
      // 如果 foo 是从 defineProps 解构来的变量，会被改写成：
      // console.log(__props.foo)
      // 确保访问的是 props，而不是一个局部变量。
      //
      // ctx.s 是 MagicString 实例，表示正在操作的源码字符串，它支持高精度的代码覆盖、插入、重写等操作，而不会破坏原本的代码结构。
    }
  }

  // 检查某个函数调用（如 watch、watchEffect 等）中传入的参数是否直接使用了解构出来的 prop，如果是，则抛出错误。
  function checkUsage(node: Node, method: string, alias = method) {
    // isCallOf(node, alias) 判断当前节点是否是一个指定方法的调用，比如调用了 watch。
    if (isCallOf(node, alias)) {
      // 提取第一个参数 arg，并用 unwrapTSNode 去掉类型包装。
      const arg = unwrapTSNode(node.arguments[0])
      if (arg.type === 'Identifier' && currentScope[arg.name]) {
        // 如果第一个参数是一个标识符（变量名），并且它在 currentScope 中被标记为 true（也就是来自 props 解构），那么报错。
        // 提示开发者不能将 props 直接传入这些响应式函数，而应传入一个 getter，例如 () => foo。
        // 这种限制是为了避免 props 被直接绑定响应式依赖，确保 props 的只读性和正确的依赖追踪。
        ctx.error(
          `"${arg.name}" is a destructured prop and should not be passed directly to ${method}(). ` +
            `Pass a getter () => ${arg.name} instead.`,
          arg,
        )
      }
    }
  }

  // check root scope first
  // 使用 walk（一个 AST 遍历器）遍历整个 <script setup> 中的语法树，分析变量作用域、识别 prop 引用、执行必要的代码改写。
  // 首先获取 scriptSetup 的 AST
  const ast = ctx.scriptSetupAst!
  // 对整个模块的顶层作用域进行扫描，提取本地变量定义：
  // 这样可以在 AST 遍历开始前，先建立 rootScope，并注册顶层变量。
  walkScope(ast, true)
  // 使用 walk(ast, { enter, leave }) 开始遍历整棵语法树：
  walk(ast, {
    // 每遇到一个 AST 节点会执行这个函数：
    enter(node: Node, parent: Node | null) {
      // 首先把 parent 放进 parentStack，方便后续判断上下文结构
      parent && parentStack.push(parent)

      // skip type nodes
      if (
        parent &&
        parent.type.startsWith('TS') &&
        !TS_NODE_TYPES.includes(parent.type)
      ) {
        // 然后检查当前节点是否是 TS 类型节点，如果是但不在允许的类型里，则跳过遍历它（不处理类型节点）：
        return this.skip()
      }

      // 接着调用 checkUsage 检查是否有对 watch 或 toRef 的非法使用（直接传入 props 变量），如果有则报错。
      checkUsage(node, 'watch', vueImportAliases.watch)
      checkUsage(node, 'toRef', vueImportAliases.toRef)

      // function scopes
      // 如果进入函数作用域（如函数声明、箭头函数、方法）：
      if (isFunctionType(node)) {
        // 压栈进入新作用域；
        // 收集函数参数中的变量定义；
        // 如果函数体是块语句，递归调用 walkScope 扫描变量；
        // 然后退出当前 enter 分支（避免重复处理函数体）。
        pushScope()
        walkFunctionParams(node, registerLocalBinding)
        if (node.body.type === 'BlockStatement') {
          walkScope(node.body)
        }
        return
      }

      // catch param
      if (node.type === 'CatchClause') {
        // 如果是 try-catch 中的 catch 块：
        // 新建作用域；
        // 将 catch 参数注册为本地变量；
        // 扫描 catch 的作用域变量。
        pushScope()
        if (node.param && node.param.type === 'Identifier') {
          registerLocalBinding(node.param)
        }
        walkScope(node.body)
        return
      }

      // non-function block scopes
      if (node.type === 'BlockStatement' && !isFunctionType(parent!)) {
        // 如果是一个普通的块语句（非函数体），例如 if、for、while 等中包含的代码块：
        // 新建作用域；
        // 调用 walkScope 扫描其中变量。
        pushScope()
        walkScope(node)
        return
      }

      if (node.type === 'Identifier') {
        // 如果遇到 Identifier（变量名）节点，并且：
        // 是一个真正的变量引用（不是声明或属性名）；
        // 不在 excludedIds（不是本地变量）中；
        // 当前作用域中存在该变量名（说明它是解构的 prop）：
        if (
          isReferencedIdentifier(node, parent!, parentStack) &&
          !excludedIds.has(node)
        ) {
          if (currentScope[node.name]) {
            rewriteId(node, parent!, parentStack)
          }
        }
      }
    },
    leave(node: Node, parent: Node | null) {
      // 每当退出一个节点时执行：
      // 从 parentStack 中弹出当前节点；
      // 如果退出的是一个非函数代码块或函数作用域，则出栈当前作用域（调用 popScope()）；
      parent && parentStack.pop()
      if (
        (node.type === 'BlockStatement' && !isFunctionType(parent!)) ||
        isFunctionType(node)
      ) {
        popScope()
      }
    },
  })
}
