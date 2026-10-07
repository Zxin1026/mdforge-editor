import type { FileErrorCode } from '../../shared/ipc'

export class FileOpError extends Error {
  readonly code: FileErrorCode
  readonly path?: string
  readonly hint?: string

  constructor(code: FileErrorCode, message: string, options?: { path?: string; hint?: string }) {
    super(message)
    this.name = 'FileOpError'
    this.code = code
    this.path = options?.path
    this.hint = options?.hint
  }
}
