# MDForge

![Version](https://img.shields.io/badge/version-1.5.1-blue) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![License](https://img.shields.io/badge/license-MIT-green)

MDForge 是一款面向 Windows 的所见即所得 Markdown 编辑器。它以 Markdown 源文件作为唯一数据，编辑时通过 CodeMirror 装饰（decoration）实时渲染标题、图片、表格、任务列表、KaTeX 公式和 Mermaid 图表，让写作过程更接近最终阅读效果。

## 核心特性

### 编辑与渲染
- **所见即所得**：在编辑器内直接渲染，同时完整保留 Markdown 源码
- **富内容支持**：图片（粘贴即上传到工作区）、表格（悬停行首/列表头增删行列）、任务列表、KaTeX 公式、Mermaid 图表
- **代码块**：折叠（围栏、块引用与标题章节）、高亮、语言补全
- **快捷语法**：括号自动配对；行首输入 `[]`、`1、` 等后按空格直接转列表；一键切换代码块/任务勾选/标题级别
- **富文本粘贴**：从 Word、网页复制的内容自动转回 Markdown（基于 Turndown）

### 写作视图
- 分屏预览（左源码右渲染，分隔条可拖动）
- 阅读模式、打字机模式、专注模式
- 可调侧边栏宽度；界面主题：浅色、深色、护眼、高对比度

### 工作区管理
- **递归文件树**：子目录懒加载展开、新建/重命名/拖拽移动、移入回收站、收藏
- **工作区搜索**：文件名与全文搜索、正则、按路径 glob 过滤（含/排除）、批量替换
- **多标签**：自动保存、崩溃恢复、外部修改检测
- **文档导航**：后退/前进历史、反向链接与文档关系图
- **图片资源管理器**：尺寸与大小统计、未引用标记、批量重命名、压缩转格式并自动改写引用
- **front matter**：可视化表单编辑（标题、作者、日期、标签、摘要），原始 YAML 可查可改
- **标签页**：聚合文件夹内 tags/keywords，按标签筛选并跳转

### 质量与效率
- **文档检查**：缺图、坏链（含跨文档锚点）、标题层级、重复标题、空图片描述、未闭合代码块、front matter 问题、待办占位符（TODO/FIXME/待补充）与超长行，并在编辑器中行内标记
- **命令面板**（`Ctrl+Shift+P`）：模糊搜索全部菜单命令
- **自定义快捷键**：帮助 → 快捷键设置，录制式改绑，菜单提示自动跟随
- **文档模板**：技术博客、会议记录、读书笔记、需求文档、周报一键新建

### 导出与发布
| 格式 | 说明 |
| --- | --- |
| HTML | 支持自定义主题与页面模板（页眉/页脚/样式，`{{content}}` 占位符装配） |
| PDF | 纸张（A4/Letter/Legal/A5）与页边距可选 |
| Word (DOCX) | 含表格与图片 |
| EPUB | 电子书 |
| Markdown 副本 / 纯文本 / OPML | 轻量导出 |
| 静态站点 | 导航页 + 搜索索引，整个文件夹批量导出 |

- 导出链完整保留 KaTeX 公式与 Mermaid 图表：HTML / PDF / EPUB 内联渲染（公式字体内嵌），DOCX 栅格化为图片嵌入
- 超出单次导出上限时如实提示，不静默丢弃
- 自定义导出主题：CSS 编辑器带实时预览，可导入/导出主题文件；代码高亮可选 GitHub、Monokai、Dracula 等内置配色
- 菜单复制/剪切同时写入 HTML 与纯文本格式，粘到 Word、微信不丢表格与强调

### 兼容性
- 支持 UTF-8、GBK、GB18030、Big5 等编码自动识别
- 关联 `.md` / `.markdown` / `.mdown` / `.mkd` 文件

## 下载

前往 GitHub 仓库的 [Releases](../../releases) 页面：

- `MDForge-*-setup.exe`：安装版（NSIS，可选安装目录，创建快捷方式）
- `MDForge-*-portable.exe`：便携版，免安装

> 程序目前未做代码签名，Windows 首次运行可能弹出 SmartScreen 提示，选择“仍要运行”即可。
> 内置 electron-updater 自动更新，安装版可在应用内检查更新。

## 开发

环境要求：Node.js、pnpm。

```bash
pnpm install        # 安装依赖
pnpm dev            # 启动开发环境（electron-vite dev）
pnpm typecheck      # 类型检查（node + web 两套 tsconfig）
pnpm lint           # oxlint 代码检查
pnpm test           # Vitest 单元测试
pnpm verify         # Playwright 端到端自检脚本
pnpm build          # 构建应用
pnpm dist           # 构建 Windows 安装包 + 便携版
```

打包说明：`electron-builder.yml` 直接复用本机已安装的 Electron 解包目录，只保留中英语言包；仅被渲染进程使用的库（katex、mermaid 等）留在 devDependencies，避免依赖树整体进入 asar 撑大安装包。

## 项目结构

```
src/
├── main/       # Electron 主进程：文件系统、IPC、导出、窗口管理、自动更新
│   └── fs/     # 文件存取、编码识别、搜索、资源管理、批量导出、EPUB 构建
├── preload/    # 预加载桥接
├── renderer/   # 渲染进程：编辑器、侧栏（文件/搜索/资源/标签）、导出、主题
│   └── editor/ # CodeMirror 装饰渲染、公式、Mermaid、文档检查、视图模式
└── shared/     # 主进程与渲染进程共享的类型与工具
tests/          # Vitest 单元测试
scripts/        # 构建辅助（clean-dist、verify-app）
```

## 技术栈

Electron · TypeScript · CodeMirror 6 · Lezer Markdown · Vite (electron-vite) · unified（remark / rehype）· KaTeX · Mermaid · Turndown · electron-builder · Vitest · oxlint · Prettier

## 许可证

[MIT](LICENSE)
