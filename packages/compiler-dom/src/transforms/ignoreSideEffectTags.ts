import { ElementTypes, type NodeTransform, NodeTypes } from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

// 移除 <script> 和 <style> 标签，因为它们在 Vue 模板中没有任何运行时作用，反而可能产生副作用。
// 在 Vue 模板中，<script> 和 <style> 标签被视为 副作用性标签（side-effect tags），
// 它们应只存在于单文件组件（.vue 文件）的 <script> 和 <style> 块中，而不应该出现在模板中（即 template 内部）。
// 这是一个 NodeTransform 类型的函数；
// 被用于遍历模板 AST，按节点处理。
export const ignoreSideEffectTags: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.ELEMENT &&
    (node.tag === 'script' || node.tag === 'style')
  ) {
    // 只处理：
    // 普通元素节点（不是组件）；
    // 标签名为 script 或 style。
    __DEV__ &&
      context.onError(
        // 仅在开发环境中触发；
        // 提示用户：Vue 模板中 <script> 或 <style> 是无效的；
        // 错误码：X_IGNORED_SIDE_EFFECT_TAG。
        createDOMCompilerError(
          DOMErrorCodes.X_IGNORED_SIDE_EFFECT_TAG,
          node.loc,
        ),
      )
    // 实际上从 AST 中删掉此节点；
    // 编译器后续阶段将完全忽略该节点。
    context.removeNode()
  }
}
