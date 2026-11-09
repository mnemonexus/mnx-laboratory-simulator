// Keep distributable notices with the data they accompany. Canonical notices
// stay in their source packs; generated copies serve the pack and standalone.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(join(root, 'packages/pack-aqueous/NOTICE-PHREEQC.txt'))
for (const path of ['assets/notices/aq/NOTICE-PHREEQC.txt', 'public/assets/notices/aq/NOTICE-PHREEQC.txt']) {
  const target = join(root, path)
  if (existsSync(target) && readFileSync(target).equals(source)) continue
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, source)
}
