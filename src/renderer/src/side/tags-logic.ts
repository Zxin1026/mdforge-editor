/** 标签页的纯逻辑：聚合计数与按标签筛选，不碰 DOM 与磁盘 */

export interface TagDoc {
  path: string
  name: string
  tags: string[]
}

export interface TagCount {
  tag: string
  count: number
}

/** 大小写不同的标签合并成一个，显示名取先出现的那份写法 */
export function aggregateTags(docs: readonly TagDoc[]): TagCount[] {
  const map = new Map<string, TagCount>()
  for (const doc of docs) {
    for (const tag of doc.tags) {
      const key = tag.toLowerCase()
      const hit = map.get(key)
      if (hit !== undefined) hit.count += 1
      else map.set(key, { tag, count: 1 })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
}

/** 选中标签下的文档；标签为 null 时返回空表 */
export function docsForTag(docs: readonly TagDoc[], tag: string | null): TagDoc[] {
  if (tag === null) return []
  const key = tag.toLowerCase()
  return docs.filter((doc) => doc.tags.some((item) => item.toLowerCase() === key))
}

/** 标签名过滤：子串匹配（大小写不敏感） */
export function filterTags(tags: readonly TagCount[], query: string): TagCount[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...tags]
  return tags.filter((item) => item.tag.toLowerCase().includes(needle))
}
