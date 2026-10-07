interface Window {
  mdforge: import('../../shared/ipc').FileApi
}

// turndown-plugin-gfm 没有官方类型包，只声明用到的导出
declare module 'turndown-plugin-gfm' {
  import TurndownService = require('turndown')
  export const gfm: TurndownService.Plugin
}
