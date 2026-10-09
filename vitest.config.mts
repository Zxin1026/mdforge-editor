import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 导出链要读 katex 的样式文本（?raw）；不开启时 vitest 会把 CSS 导入替换成空串
    css: true
  }
})
