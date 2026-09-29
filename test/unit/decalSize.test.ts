/* Unit tests for the Insert Decal sizing modes (app/src/renderer/decalSize.ts).
 * Pure node: run with `bash test/unit/run.sh`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decalSize } from '../../app/src/renderer/decalSize'

const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('a 1200 x 640 px label sized every way', () => {
  // 60 x 32 mm at 20 px/mm - the GWZ0010 label's decal PNG
  for (const [mode, v] of [
    ['width', 60],
    ['height', 32],
    ['long', 60],
    ['short', 32],
    ['pxPerMm', 20]
  ] as const) {
    const s = decalSize(mode, v, 1200, 640)!
    near(s.widthMm, 60)
    near(s.heightMm, 32)
  }
})

test('long / short edge follow a portrait image', () => {
  const long = decalSize('long', 50, 500, 1000)!
  near(long.heightMm, 50)
  near(long.widthMm, 25)
  const short = decalSize('short', 50, 500, 1000)!
  near(short.widthMm, 50)
  near(short.heightMm, 100)
})

test('a square image is the same on every edge', () => {
  for (const mode of ['width', 'height', 'long', 'short'] as const) {
    const s = decalSize(mode, 35.052, 701, 701)!
    near(s.widthMm, 35.052)
    near(s.heightMm, 35.052)
  }
})

test('nothing sensible for empty or zero inputs', () => {
  assert.equal(decalSize('width', 0, 100, 100), null)
  assert.equal(decalSize('pxPerMm', -2, 100, 100), null)
  assert.equal(decalSize('long', 10, 0, 100), null)
})
