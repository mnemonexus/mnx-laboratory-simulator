// Node only (tests, tools): install the content the add-on ships, from the same asset files it
// reads through mnx.asset (assets/content/, written by `npm run content`). Never imported by the
// add-on or the standalone page.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleContent, bundlePaths, CONTENT_INDEX, installContent, type ContentStatus } from './content'

/** Read assets/content/ under `root` (default: the working directory) and install it. Throws when it is missing or damaged. */
export function installContentFromDisk(root = process.cwd()): ContentStatus {
  const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'))
  const index = readJson(CONTENT_INDEX)
  const paths = bundlePaths(index)
  if (typeof paths === 'string') throw new Error(paths)
  const assembled = assembleContent(index, new Map(paths.map((p) => [p, readJson(p)])))
  if (typeof assembled === 'string') throw new Error(assembled)
  return installContent(assembled)
}
