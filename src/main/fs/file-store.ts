import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileMeta, MdEncoding, FileSnapshot, WriteRequest } from '../../shared/ipc'
import { decodeBuffer, decodeBufferWith, encodeText, type DecodedFile } from './encoding'
import { FileOpError } from './error'

interface LoadedFile {
  absolute: string
  originalBuffer: Buffer
  originalText: string
  meta: FileMeta
  hash: string
  mtimeMs: number
}

const granted = new Set<string>()
const roots = new Set<string>()
const folderRoots = new Set<string>()
const loaded = new Map<string, LoadedFile>()

export function cacheKeyOf(absolute: string): string {
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function grantPath(absolute: string): void {
  // 统一 resolve：相对链接解析出的正斜杠路径要能与 path.resolve 后的键对上
  const key = cacheKeyOf(path.resolve(absolute))
  granted.add(key)
  roots.add(path.dirname(key))
}

/** 打开文件夹：把该目录登记为可读可列的根，其下文件按需授权 */
export function grantFolder(absolute: string): void {
  folderRoots.add(cacheKeyOf(path.resolve(absolute)).replace(/[\\/]+$/, ''))
}

export function isGranted(absolute: string): boolean {
  return granted.has(cacheKeyOf(absolute))
}

function underFolderRoot(resolvedKey: string): boolean {
  for (const root of folderRoots) {
    if (resolvedKey === root || resolvedKey.startsWith(root + path.sep)) return true
  }
  return false
}

/** 资源协议用：允许读取已打开文档所在目录，或已授权文件夹下的文件 */
export function isUnderGrantedRoot(target: string): boolean {
  const key = cacheKeyOf(path.resolve(target))
  if (underFolderRoot(key)) return true
  // 目录本身是已打开文档的所在目录时同样可读
  if (roots.has(key)) return true
  const dir = path.dirname(key)
  for (const root of roots) {
    if (dir === root || dir.startsWith(root + path.sep)) return true
  }
  return false
}

export function resetFileStore(): void {
  granted.clear()
  roots.clear()
  folderRoots.clear()
  loaded.clear()
}

export function requireGranted(target: string): string {
  if (!target || target.includes('\0')) {
    throw new FileOpError('invalid-path', '非法文件路径', { path: target })
  }
  const absolute = path.resolve(target)
  if (!isGranted(absolute) && !underFolderRoot(cacheKeyOf(absolute))) {
    throw new FileOpError('not-granted', '该路径未经用户选择授权，拒绝访问', {
      path: absolute,
      hint: '请通过“打开”或“另存为”选择文件'
    })
  }
  return absolute
}

function hashOf(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex')
}

export function mapFsError(error: unknown, absolute: string): FileOpError {
  if (error instanceof FileOpError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') {
    return new FileOpError('not-found', '文件不存在', { path: absolute })
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return new FileOpError('permission', '没有读写权限，或文件被其他程序占用', {
      path: absolute,
      hint: code === 'EBUSY' ? '请关闭正在占用该文件的程序后重试' : undefined
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new FileOpError('unknown', `文件操作失败：${message}`, { path: absolute })
}

async function loadWith(target: string, decode: (buffer: Buffer) => DecodedFile): Promise<FileSnapshot> {
  const absolute = requireGranted(target)
  try {
    const buffer = await fs.readFile(absolute)
    const stat = await fs.stat(absolute)
    const decoded = decode(buffer)
    const hash = hashOf(buffer)
    loaded.set(cacheKeyOf(absolute), {
      absolute,
      originalBuffer: buffer,
      originalText: decoded.text,
      meta: decoded.meta,
      hash,
      mtimeMs: stat.mtimeMs
    })
    return {
      path: absolute,
      text: decoded.text,
      meta: decoded.meta,
      hash,
      size: buffer.length,
      mtimeMs: stat.mtimeMs
    }
  } catch (error) {
    throw mapFsError(error, absolute)
  }
}

export function readFile(target: string): Promise<FileSnapshot> {
  return loadWith(target, decodeBuffer)
}

/** 按指定编码重新解码磁盘原文：编码自动检测错判时用户的纠正入口 */
export function readFileWithEncoding(target: string, encoding: MdEncoding): Promise<FileSnapshot> {
  return loadWith(target, (buffer) => decodeBufferWith(buffer, encoding))
}

/** 磁盘当前字节哈希与修改时间；文件已不存在时返回 null。冲突判定与外部修改监测共用 */
export async function diskState(target: string): Promise<{ hash: string; mtimeMs: number } | null> {
  const absolute = path.resolve(target)
  try {
    const [buffer, stat] = await Promise.all([fs.readFile(absolute), fs.stat(absolute)])
    return { hash: hashOf(buffer), mtimeMs: stat.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw mapFsError(error, absolute)
  }
}

async function currentHash(absolute: string): Promise<string | null> {
  return (await diskState(absolute))?.hash ?? null
}

/** 最近一次载入/保存留下的哈希：用来区分"外部改动"和"我们自己写的盘" */
export function rememberedHash(target: string): string | null {
  return loaded.get(cacheKeyOf(path.resolve(target)))?.hash ?? null
}

function sameMeta(a: FileMeta, b: FileMeta): boolean {
  return a.encoding === b.encoding && a.eol === b.eol && a.bom === b.bom && a.eolMixed === b.eolMixed
}

async function writeFileAtomic(absolute: string, buffer: Buffer): Promise<void> {
  const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${Date.now()}.mdforge-tmp`)
  try {
    await fs.writeFile(temp, buffer)
    await fs.rename(temp, absolute)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw mapFsError(error, absolute)
  }
}

export async function writeFile(request: WriteRequest): Promise<FileSnapshot> {
  const absolute = requireGranted(request.path)
  const entry = loaded.get(cacheKeyOf(absolute))

  try {
    const onDisk = await currentHash(absolute)
    if (onDisk !== null && onDisk !== request.baseHash && !request.force) {
      throw new FileOpError('conflict', '文件在外部已被修改，直接保存会覆盖外部改动', {
        path: absolute,
        hint: '选择“覆盖保存”保留当前编辑内容，或“重新载入”丢弃当前编辑'
      })
    }

    const byteExact = entry !== undefined && entry.originalText === request.text && sameMeta(entry.meta, request.meta)
    const buffer = byteExact ? entry.originalBuffer : encodeText(request.text, request.meta, absolute)

    await writeFileAtomic(absolute, buffer)

    const stat = await fs.stat(absolute)
    const hash = hashOf(buffer)
    loaded.set(cacheKeyOf(absolute), {
      absolute,
      originalBuffer: buffer,
      originalText: request.text,
      meta: request.meta,
      hash,
      mtimeMs: stat.mtimeMs
    })

    return {
      path: absolute,
      text: request.text,
      meta: request.meta,
      hash,
      size: buffer.length,
      mtimeMs: stat.mtimeMs
    }
  } catch (error) {
    throw mapFsError(error, absolute)
  }
}
