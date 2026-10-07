# MDForge

MDForge 是一款面向 Windows 的所见即所得 Markdown 编辑器。

它以 Markdown 源文件作为唯一数据，编辑时实时渲染标题、图片、表格、任务列表、公式和 Mermaid 图表，让 Markdown 文件更接近最终阅读效果。

## 主要功能

- 所见即所得编辑，同时保留 Markdown 源码
- 支持图片、表格、任务列表、KaTeX 公式和 Mermaid 图表
- 支持多标签、自动保存、崩溃恢复和外部修改检测
- 支持 HTML、PDF、Markdown 副本和纯文本导出
- 支持大纲、文档检查、主题切换和深色模式
- 支持 UTF-8、GBK、GB18030、Big5 等编码

## 下载

打开 GitHub 仓库的 [Releases](../../releases) 页面，下载以下任一版本：

- `MDForge-*-setup.exe`：安装版
- `MDForge-*-portable.exe`：便携版，无需安装

程序目前未进行代码签名，Windows 首次运行时可能显示 SmartScreen 提示。

## 开发

环境要求：Node.js、pnpm。

```bash
pnpm install
pnpm dev          # 启动开发环境
pnpm typecheck    # 类型检查
pnpm test         # 运行单元测试
pnpm build        # 构建应用
pnpm dist         # 构建 Windows 安装包和便携版
```

## 技术栈

Electron、TypeScript、CodeMirror 6、Vite、unified、remark、rehype 和 Vitest。

## 许可证

MIT
