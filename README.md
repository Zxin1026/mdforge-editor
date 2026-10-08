# MDForge

MDForge 是一款面向 Windows 的所见即所得 Markdown 编辑器。

它以 Markdown 源文件作为唯一数据，编辑时实时渲染标题、图片、表格、任务列表、公式和 Mermaid 图表，让 Markdown 文件更接近最终阅读效果。

## 主要功能

- 所见即所得编辑，同时保留 Markdown 源码
- 支持图片、表格（悬停行首/列表头即可增删行列）、任务列表、KaTeX 公式和 Mermaid 图表
- 写作视图：分屏预览（左源码右渲染，分隔条可拖动）、阅读模式、打字机模式与专注模式；侧边栏宽度可调
- 命令面板（Ctrl+Shift+P）：模糊搜索全部菜单命令
- 自定义快捷键：帮助 → 快捷键设置，录制式改绑，菜单提示与帮助弹窗自动跟随
- 支持多标签、自动保存、崩溃恢复和外部修改检测
- 工作区搜索：文件夹范围的文件名与全文搜索、正则、按路径 glob 过滤（含/排除）、批量替换
- 递归文件树：子目录展开、新建文件/文件夹、重命名、拖拽移动、移入回收站与收藏
- 图片资源管理器：尺寸与大小、未引用标记、批量重命名、压缩转格式并自动改写引用、一键复制图片
- front matter 可视化编辑：标题、作者、日期、标签、摘要的表单，原始 YAML 可查可改
- 标签页：汇总文件夹内 front matter 的 tags/keywords，按标签筛选并跳转
- 文档导航：后退/前进历史、反向链接与文档关系图
- 文档检查：缺图、坏链（含跨文档锚点）、标题层级、重复标题、空图片描述、未闭合代码块、front matter、待办占位符（TODO/FIXME/待补充）与超长行，并在编辑器中行内标记
- 代码块折叠（围栏、块引用与标题章节）、括号自动配对和 HTML 标签/语言补全
- 语法转换快捷键：切换代码块、切换任务勾选、提升/降低标题级别；行首输入 `[]`、`1、` 等内容后按空格直接转成列表
- 文档模板：技术博客、会议记录、读书笔记、需求文档、周报一键新建
- 支持 HTML、PDF、Markdown 副本、纯文本、Word（DOCX，含表格与图片）与 OPML 大纲导出
- 发布导出：整个文件夹批量导出 HTML、静态站点（导航页 + 搜索索引）、EPUB 电子书
- 自定义导出主题：CSS 编辑器带实时预览，可导入/导出主题文件；代码高亮可选 GitHub、Monokai、Dracula 等内置配色
- 页面模板：为导出 HTML 定制外壳（页眉、页脚、自己的样式），`{{content}}` 等占位符装配
- 菜单复制/剪切同时写入 HTML 与纯文本格式，粘到 Word、微信不丢表格与强调
- 支持大纲；界面主题有浅色、深色、护眼与高对比度四种
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
