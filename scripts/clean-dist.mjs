/* 打包前清掉 dist 里上一轮的安装包：生成新包时不留下旧 exe / blockmap */
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
const OLD_PACKAGE = /\.exe(\.blockmap)?$/i

let removed = 0
try {
  for (const name of readdirSync(dist)) {
    if (!OLD_PACKAGE.test(name)) continue
    rmSync(path.join(dist, name), { force: true })
    removed += 1
    console.log(`  已删除旧包 dist/${name}`)
  }
} catch (error) {
  // 首次打包还没有 dist 目录，没什么可清的
  if (error.code !== 'ENOENT') throw error
}

console.log(removed === 0 ? '  dist 里没有旧包' : `  旧包清理完成（${removed} 个）`)
