import { describe, expect, it } from 'vitest'
import {
  assetUrl,
  resolveLocalPath,
  stripTitle,
  titleWithWidth,
  widthFromTitle
} from '../src/renderer/src/editor/assets'

const DOC = 'E:/项目/文档/a.md'

describe('本地图片路径解析', () => {
  it('相对路径基于文档所在目录', () => {
    expect(resolveLocalPath(DOC, 'img/x.png')).toBe('E:/项目/文档/img/x.png')
  })

  it('反斜杠写法同样解析', () => {
    expect(resolveLocalPath(DOC, 'img\\x.png')).toBe('E:/项目/文档/img/x.png')
  })

  it('折叠 . 与 ..', () => {
    expect(resolveLocalPath(DOC, './img/./x.png')).toBe('E:/项目/文档/img/x.png')
    expect(resolveLocalPath(DOC, '../assets/x.png')).toBe('E:/项目/assets/x.png')
    expect(resolveLocalPath(DOC, 'sub/../img/x.png')).toBe('E:/项目/文档/img/x.png')
  })

  it('百分号编码与空格', () => {
    expect(resolveLocalPath(DOC, 'my%20img.png')).toBe('E:/项目/文档/my img.png')
    expect(resolveLocalPath(DOC, '<带空格 的路径.png>')).toBe('E:/项目/文档/带空格 的路径.png')
  })

  it('去掉 title 与锚点', () => {
    expect(stripTitle('x.png "图片说明"')).toBe('x.png')
    expect(resolveLocalPath(DOC, 'x.png#center')).toBe('E:/项目/文档/x.png')
  })

  it('绝对路径与盘根路径', () => {
    expect(resolveLocalPath(DOC, 'D:/其他/x.png')).toBe('D:/其他/x.png')
    expect(resolveLocalPath(DOC, '/共享/x.png')).toBe('E:/共享/x.png')
  })

  it('远程与 data 地址不解析', () => {
    expect(resolveLocalPath(DOC, 'https://cdn.example.com/a.png')).toBeNull()
    expect(resolveLocalPath(DOC, 'http://a/b.png')).toBeNull()
    expect(resolveLocalPath(DOC, 'data:image/png;base64,AAAA')).toBeNull()
    expect(resolveLocalPath('', 'a.png')).toBeNull()
    expect(resolveLocalPath(DOC, '')).toBeNull()
  })

  it('非法百分号序列不抛异常', () => {
    expect(resolveLocalPath(DOC, 'a%2.png')).toBe('E:/项目/文档/a%2.png')
  })
})

describe('资源 URL', () => {
  it('编码后可被协议还原', () => {
    const url = assetUrl(DOC, 'sub dir/图 片.png')
    expect(url).not.toBeNull()
    expect(url).toMatch(/^mdasset:\/\/file\//)
    const decoded = decodeURIComponent(String(url).replace('mdasset://file/', ''))
    expect(decoded).toBe('E:/项目/文档/sub dir/图 片.png')
  })

  it('远程地址返回 null', () => {
    expect(assetUrl(DOC, 'https://a/b.png')).toBeNull()
  })
})

describe('图片宽度提示写在 title 槽', () => {
  it('读取宽度', () => {
    expect(widthFromTitle('w=640')).toBe(640)
    expect(widthFromTitle('w=640px')).toBe(640)
    expect(widthFromTitle('说明 w=320')).toBe(320)
    expect(widthFromTitle('W=320')).toBe(320)
  })

  it('普通说明与空值不当作宽度', () => {
    expect(widthFromTitle(null)).toBeNull()
    expect(widthFromTitle('2024 年度图')).toBeNull()
    expect(widthFromTitle('w=0')).toBeNull()
    expect(widthFromTitle('draw=1')).toBeNull()
  })

  it('宽度解析不影响路径解析', () => {
    expect(resolveLocalPath(DOC, 'x.png "w=640"')).toBe('E:/项目/文档/x.png')
    expect(stripTitle('x.png "说明 w=640"')).toBe('x.png')
  })

  it('改写宽度时保留原说明', () => {
    expect(titleWithWidth(null, 640)).toBe('"w=640"')
    expect(titleWithWidth('', 640)).toBe('"w=640"')
    expect(titleWithWidth('流程图', 500)).toBe('"流程图 w=500"')
    expect(titleWithWidth('流程图 w=300', 500)).toBe('"流程图 w=500"')
    expect(titleWithWidth('w=300 流程图', 500)).toBe('"w=500 流程图"')
  })

  it('取整并拒绝非正数', () => {
    expect(titleWithWidth(null, 640.4)).toBe('"w=640"')
    expect(titleWithWidth(null, -10)).toBe('"w=1"')
  })
})
