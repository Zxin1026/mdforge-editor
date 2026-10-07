import { describe, expect, it } from 'vitest'
import { createSlugger, slugOnce } from '../src/shared/slug'

describe('GitHub 风格锚点', () => {
  it('保留中日韩字符，去掉标点', () => {
    expect(slugOnce('5.1 输入模型')).toBe('51-输入模型')
    expect(slugOnce('标题（一）')).toBe('标题一')
    expect(slugOnce('MDForge：完整开发流程')).toBe('mdforge完整开发流程')
    expect(slugOnce('阶段 0：明确规格')).toBe('阶段-0明确规格')
  })

  it('空格转连字符并去掉首尾空白', () => {
    expect(slugOnce('  Hello   World  ')).toBe('hello---world')
    expect(slugOnce('Under_Score-and-中文')).toBe('under_score-and-中文')
  })

  it('重复标题追加序号', () => {
    const slugger = createSlugger()
    expect(slugger.slug('安装')).toBe('安装')
    expect(slugger.slug('安装')).toBe('安装-1')
    expect(slugger.slug('安装')).toBe('安装-2')
    expect(slugger.slug('使用 说明')).toBe('使用-说明')
  })

  it('两个实例的计数互不影响', () => {
    const a = createSlugger()
    const b = createSlugger()
    a.slug('标题')
    a.slug('标题')
    expect(b.slug('标题')).toBe('标题')
    expect(a.slug('标题')).toBe('标题-2')
  })
})
