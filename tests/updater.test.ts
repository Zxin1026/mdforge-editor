import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNEL } from '../src/shared/ipc'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: vi.fn(() => '1.2.1') },
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  send: vi.fn()
}))

vi.mock('electron', () => ({ app: mocks.app, ipcMain: mocks.ipcMain }))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))

type Updater = typeof import('../src/main/updater')
type WindowGetter = Parameters<Updater['initUpdater']>[0]
type Win = NonNullable<ReturnType<WindowGetter>>

/** 载入全新模块（清掉弹窗去重等跨用例状态），并挂一个假窗口收集推送 */
async function loadUpdater(): Promise<Updater> {
  vi.resetModules()
  const mod = await import('../src/main/updater')
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: mocks.send }
  }
  mod.initUpdater(() => win as unknown as Win)
  return mod
}

beforeEach(() => {
  vi.useFakeTimers()
  delete process.env['PORTABLE_EXECUTABLE_FILE']
  mocks.autoUpdater.checkForUpdates.mockReset()
  mocks.send.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('updater 检查更新', () => {
  it('服务器版本与当前相同：判为最新，不弹下载框（isUpdateAvailable=false）', async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.2.1' }
    })
    const mod = await loadUpdater()
    await expect(mod.manualCheck()).resolves.toEqual({ status: 'latest', version: '1.2.1' })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('服务器版本更高：返回 available 并推送一次下载询问', async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.2' }
    })
    const mod = await loadUpdater()
    await expect(mod.manualCheck()).resolves.toEqual({ status: 'available', version: '1.2.2' })
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledWith(CHANNEL.updateEvent, { kind: 'available', version: '1.2.2' })
  })

  it('检查请求失败：静默返回 error，不打扰用户', async () => {
    mocks.autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'))
    const mod = await loadUpdater()
    await expect(mod.manualCheck()).resolves.toEqual({ status: 'error', version: '1.2.1' })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('自动检查同一版本只提醒一次，之后不再打扰', async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.2' }
    })
    await loadUpdater()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})
