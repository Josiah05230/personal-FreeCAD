/* Unit tests for the Data Panel's file allow-list + folder-relevance walk
 * (app/src/shared/fileTypes.ts, app/src/main/fileFilter.ts). Pure node, no
 * Electron: run with `bash test/unit/run.sh`. Every tree is built fresh
 * under the OS temp dir. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_EXTENSIONS,
  fileKind,
  isAllowedFile,
  isCompanionFile,
  isSkippedDir,
  extOf
} from '../../app/src/shared/fileTypes'
import { FolderRelevance, walkForAllowedFile, searchDir } from '../../app/src/main/fileFilter'

function tree(spec: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), 'gwtcad-filefilter-'))
  for (const [rel, body] of Object.entries(spec)) {
    const p = join(root, rel)
    if (body === null) {
      mkdirSync(p, { recursive: true })
    } else {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, body)
    }
  }
  return root
}

test('allow-list covers everything the app can open or import', () => {
  for (const ext of [
    'fcstd', 'step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', 'obj', '3mf', 'ply', 'off',
    'dxf', 'svg', 'pdf', 'zip', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif',
    'kicad_pro', 'kicad_pcb', 'kicad_sch'
  ]) {
    assert.ok(ALLOWED_EXTENSIONS.includes(ext), ext)
    assert.ok(isAllowedFile(`x.${ext.toUpperCase()}`), `upper-case .${ext}`)
  }
})

test('junk and companion files are not allowed', () => {
  for (const n of ['a.dll', 'b.py', 'c.json', 'd.pyc', 'Makefile', 'e.exe', 'f.txt', '.hidden']) {
    assert.equal(isAllowedFile(n), false, n)
  }
  for (const n of ['CMC0010.FCBak', 'CMC0010.FCStd1', 'CMC0010.FCStd.gwtcad.json', 'CMG0010_supplier_meta.json']) {
    assert.ok(isCompanionFile(n), n)
    assert.equal(isAllowedFile(n), false, n)
  }
  // the supplier .stp and datasheet pdf next to them stay visible
  assert.ok(isAllowedFile('CMG0010.stp'))
  assert.ok(isAllowedFile('CMG0010.pdf'))
})

test('kinds and extensions', () => {
  assert.equal(extOf('/a/b.c/board.kicad_pcb'), 'kicad_pcb')
  assert.equal(extOf('noext'), '')
  assert.equal(fileKind('A.FCStd'), 'design')
  assert.equal(fileKind('a.STEP'), 'model')
  assert.equal(fileKind('a.3mf'), 'mesh')
  assert.equal(fileKind('label.png'), 'image')
  assert.equal(fileKind('drawing.pdf'), 'document')
  assert.equal(fileKind('x.zip'), 'archive')
  assert.equal(fileKind('x.kicad_pro'), 'ecad')
  assert.equal(fileKind('x.dll'), null)
})

test('skipped dirs', () => {
  for (const d of ['node_modules', '.git', '.venv', '__pycache__', '.pio', 'venv', '.anything']) {
    assert.ok(isSkippedDir(d), d)
  }
  assert.equal(isSkippedDir('CM'), false)
})

test('walk finds a usable file deep down, including a pdf', async () => {
  const root = tree({ 'a/b/c/d/datasheet.pdf': 'x', 'a/lib.dll': 'x' })
  try {
    const w = await walkForAllowedFile(root)
    assert.equal(w.result, true)
    assert.equal(w.proof, join(root, 'a/b/c/d/datasheet.pdf'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walk says false for code-only trees and never counts junk dirs', async () => {
  const root = tree({
    'src/main.py': 'x',
    'src/lib.dll': 'x',
    'node_modules/pkg/model.step': 'x', // inside a skipped tree - must not count
    '.git/objects/x.stl': 'x',
    '__pycache__/y.png': 'x',
    'build/CMC0010.FCBak': 'x' // a companion file alone doesn't count either
  })
  try {
    const w = await walkForAllowedFile(root)
    assert.equal(w.result, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty folder counts as relevant (fresh project/type folder stays reachable)', async () => {
  const root = tree({ 'empty': null, 'hasdotonly/.keep': 'x' })
  try {
    assert.equal((await walkForAllowedFile(join(root, 'empty'))).result, true)
    assert.equal((await walkForAllowedFile(join(root, 'hasdotonly'))).result, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('budget exhaustion answers null (caller shows the folder)', async () => {
  const spec: Record<string, string | null> = {}
  for (let i = 0; i < 40; i++) spec[`d${i}/x.py`] = 'x'
  const root = tree(spec)
  try {
    const w = await walkForAllowedFile(root, { timeMs: 10_000, maxDirs: 5, maxDepth: 16 })
    assert.equal(w.result, null)
    const deep = tree({ 'a/b/c/d/e/f.step': 'x' })
    try {
      const w2 = await walkForAllowedFile(deep, { timeMs: 10_000, maxDirs: 100, maxDepth: 2 })
      assert.equal(w2.result, null)
    } finally {
      rmSync(deep, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('symlink loops terminate', async () => {
  const root = tree({ 'a/x.py': 'x' })
  try {
    symlinkSync(root, join(root, 'a', 'loop'))
    const w = await walkForAllowedFile(root)
    assert.equal(w.result, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cache: negative answer is reused, then invalidated when a file appears deep down', async () => {
  const root = tree({ 'p/q/r/code.py': 'x' })
  try {
    const rel = new FolderRelevance()
    assert.equal(await rel.cached(root), undefined)
    assert.equal(await rel.isRelevant(root), false)
    assert.equal(await rel.cached(root), false)
    // adding a file bumps its own folder's mtime - force a distinct mtime
    // in case the filesystem's resolution is coarse
    writeFileSync(join(root, 'p/q/r/part.step'), 'x')
    const future = new Date(Date.now() + 5000)
    utimesSync(join(root, 'p/q/r'), future, future)
    assert.equal(await rel.cached(root), undefined)
    assert.equal(await rel.isRelevant(root), true)
    // intermediate folders got the answer for free
    assert.equal(await rel.cached(join(root, 'p/q')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cache: positive answer drops when its proving file is removed', async () => {
  const root = tree({ 'a/only.png': 'x' })
  try {
    const rel = new FolderRelevance()
    assert.equal(await rel.isRelevant(root), true)
    rmSync(join(root, 'a/only.png'))
    assert.equal(await rel.cached(root), undefined)
    assert.equal(await rel.isRelevant(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search: usable files only, skips junk, drops irrelevant folder hits', async () => {
  const root = tree({
    'sub/bracket-parts/bracket.step': 'x',
    'sub/bracket-tools/bracket.py': 'x',
    'node_modules/bracket/bracket.stl': 'x',
    'docs/bracket.pdf': 'x',
    'docs/bracket.dll': 'x',
    'bracket.FCStd': 'x',
    'bracket.FCBak': 'x'
  })
  try {
    const hits = await searchDir(root, 'bracket', { relevance: new FolderRelevance() })
    const names = hits.map((h) => h.path.slice(root.length + 1)).sort()
    assert.deepEqual(names, ['bracket.FCStd', 'docs/bracket.pdf', 'sub/bracket-parts', 'sub/bracket-parts/bracket.step'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
