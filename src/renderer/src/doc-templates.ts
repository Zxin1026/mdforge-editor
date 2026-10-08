/** 文档模板：新建时可选的内置骨架，{{date}} / {{time}} 在插入时替换成当前时间 */

export interface DocTemplate {
  id: string
  name: string
  description: string
  body: string
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: 'blog',
    name: '技术博客',
    description: '背景 / 实现 / 总结，front matter 带日期与标签',
    body: `---
title:
date: {{date}}
tags: []
---

# 标题

## 背景

要解决的问题、为什么现在做。

## 实现

方案拆解、关键代码与踩过的坑。

## 总结

结论与后续可以改进的地方。
`
  },
  {
    id: 'meeting',
    name: '会议记录',
    description: '时间 / 参会人 / 议题 / 结论 / 待办',
    body: `# 会议记录

- 时间：{{date}} {{time}}
- 地点：
- 参会人：

## 议题

1.

## 结论

-

## 待办

- [ ] 
`
  },
  {
    id: 'reading',
    name: '读书笔记',
    description: '书名 / 作者 / 摘要 / 金句 / 启发',
    body: `---
title: 《书名》
author:
date: {{date}}
tags: [读书]
---

# 《书名》

## 摘要

## 金句

> 

## 启发

- 
`
  },
  {
    id: 'requirement',
    name: '需求文档',
    description: '背景 / 目标 / 范围 / 验收标准 / 排期',
    body: `# 需求：功能名称

## 背景

## 目标

- 

## 范围

- 包含：
- 不包含：

## 验收标准

- [ ] 

## 排期

| 阶段 | 时间 | 负责人 |
| --- | --- | --- |
| 开发 |  |  |
| 测试 |  |  |
`
  },
  {
    id: 'weekly',
    name: '周报',
    description: '本周完成 / 下周计划 / 风险',
    body: `# 周报（{{date}}）

## 本周完成

- 

## 下周计划

- [ ] 

## 风险与需要帮助

- 
`
  }
]

/** 占位符替换：日期与时间按本地时区取当前值 */
export function renderTemplate(template: DocTemplate, when: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`
  return template.body.replaceAll('{{date}}', date).replaceAll('{{time}}', time)
}
