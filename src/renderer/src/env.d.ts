interface Window {
  mdforge: import('../../shared/ipc').FileApi
}

// turndown-plugin-gfm 没有官方类型包，只声明用到的导出
declare module 'turndown-plugin-gfm' {
  import TurndownService = require('turndown')
  export const gfm: TurndownService.Plugin
}

// vite 把 ?raw / ?inline 导入变成内容字符串。web 侧由 vite/client 提供，
// tests 走 tsconfig.node.json（不含 vite/client），这里把用到的形态补齐
declare module 'katex/dist/katex.min.css?raw' {
  const content: string
  export default content
}

declare module '*.woff2?inline' {
  const content: string
  export default content
}
