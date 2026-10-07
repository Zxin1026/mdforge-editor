import type { FileMeta, FileSnapshot, MdEncoding, WriteRequest } from '../../shared/ipc'

const ENCODING_LABEL: Record<MdEncoding, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 (BOM)',
  gbk: 'GBK',
  gb18030: 'GB18030',
  big5: 'Big5',
  unknown: '未知编码'
}

export function encodingLabel(encoding: MdEncoding): string {
  return ENCODING_LABEL[encoding]
}

export interface DocState {
  path: string | null
  text: string
  /** 最近一次载入或保存的内容，用于判定脏状态 */
  baseline: string
  meta: FileMeta
  /** 最近一次载入或保存时磁盘上的写回参数：换编码/换行符也算未保存 */
  baselineMeta: FileMeta
  baseHash: string
}

function sameMeta(a: FileMeta, b: FileMeta): boolean {
  return a.encoding === b.encoding && a.eol === b.eol && a.bom === b.bom && a.eolMixed === b.eolMixed
}

/** 新建文件在 Windows 上的默认写回参数 */
export const NEW_FILE_META: FileMeta = {
  encoding: 'utf-8',
  eol: 'crlf',
  eolMixed: false,
  bom: false
}

export function emptyDoc(): DocState {
  return { path: null, text: '', baseline: '', meta: NEW_FILE_META, baselineMeta: NEW_FILE_META, baseHash: '' }
}

export function fromSnapshot(snapshot: FileSnapshot): DocState {
  return {
    path: snapshot.path,
    text: snapshot.text,
    baseline: snapshot.text,
    meta: snapshot.meta,
    baselineMeta: snapshot.meta,
    baseHash: snapshot.hash
  }
}

export function withText(state: DocState, text: string): DocState {
  return state.text === text ? state : { ...state, text }
}

/** 只改写回参数（编码 / 换行符），正文不动：下一次保存生效 */
export function withMeta(state: DocState, meta: FileMeta): DocState {
  return { ...state, meta }
}

export function afterSave(snapshot: FileSnapshot, state: DocState): DocState {
  return {
    path: snapshot.path,
    text: state.text,
    baseline: state.text,
    meta: snapshot.meta,
    baselineMeta: snapshot.meta,
    baseHash: snapshot.hash
  }
}

export function isDirty(state: DocState): boolean {
  return state.text !== state.baseline || !sameMeta(state.meta, state.baselineMeta)
}

export function isUnsavedNew(state: DocState): boolean {
  return state.path === null && state.text.length > 0
}

export function writeRequest(state: DocState, force = false): WriteRequest {
  if (state.path === null) throw new Error('未命名文档请使用另存为')
  return { path: state.path, text: state.text, meta: state.meta, baseHash: state.baseHash, force }
}

/**
 * 草稿键：已保存过的文档用路径推导，这样崩溃重启后能对回同一份草稿；
 * 未命名文档用标签序号。
 */
export function draftKeyOf(path: string | null, tabId: string): string {
  return path === null ? `n:${tabId}` : `p:${path.toLowerCase()}`
}

export function displayNameOf(state: DocState): string {
  if (state.path === null) return '未命名'
  const segments = state.path.split(/[\\/]/)
  return segments[segments.length - 1] || '未命名'
}
