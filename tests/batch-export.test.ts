import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportBatch } from '../src/main/fs/batch-export'
import { DEFAULT_EXPORT_OPTIONS } from '../src/shared/ipc'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdforge-batch-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('批量导出截断提示', () => {
  it('提交总数超过未截断部分时如实报告 truncated 与总数', async () => {
    await withTempDir(async (dir) => {
      const result = await exportBatch({
        outDir: dir,
        files: [{ relative: 'a.html', html: '<p>1</p>', docPath: null }],
        extras: [],
        options: DEFAULT_EXPORT_OPTIONS,
        totalFiles: 1000
      })
      expect(result.written).toBe(1)
      expect(result.truncated).toBe(true)
      expect(result.totalCount).toBe(1000)
    })
  })

  it('没有截断时不报警', async () => {
    await withTempDir(async (dir) => {
      const result = await exportBatch({
        outDir: dir,
        files: [
          { relative: 'a.html', html: '<p>1</p>', docPath: null },
          { relative: 'b.html', html: '<p>2</p>', docPath: null }
        ],
        extras: [{ relative: 'index.html', content: '<p>目录</p>' }],
        options: DEFAULT_EXPORT_OPTIONS,
        totalFiles: 2
      })
      expect(result.written).toBe(3)
      expect(result.truncated).toBe(false)
      expect(result.totalCount).toBe(2)
    })
  })
})
