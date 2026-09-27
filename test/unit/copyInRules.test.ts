/* Unit tests for the copy-in gate's decision rules
 * (app/src/shared/copyInRules.ts). Run with `bash test/unit/run.sh`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyInNeed, guessPartType, isUnder } from '../../app/src/shared/copyInRules'

const ROOTS = ['/co/pn-cad-files', '/co/ecad-cad-files', '/co/pn-registry']
const DOC = '/co/pn-cad-files/CM/A/CMA0010.FCStd'

test('isUnder', () => {
  assert.ok(isUnder('/co/pn-cad-files/x.step', '/co/pn-cad-files'))
  assert.ok(isUnder('/co/pn-cad-files', '/co/pn-cad-files/'))
  assert.equal(isUnder('/co/pn-cad-files-old/x.step', '/co/pn-cad-files'), false)
  assert.ok(isUnder('C:\\Co\\Repo\\x.step', 'c:/co/repo'))
  assert.equal(isUnder('/x', ''), false)
})

test('outside CAD into a company doc is required', () => {
  for (const f of ['/home/u/Downloads/b.step', '/tmp/x.STL', '/tmp/p.FCStd', '/tmp/board.kicad_pcb', '/tmp/a.zip']) {
    assert.equal(copyInNeed(DOC, f, ROOTS).need, 'required', f)
  }
})

test('outside pictures / pdf / art are optional', () => {
  for (const f of ['/tmp/label.png', '/tmp/x.JPG', '/tmp/datasheet.pdf', '/tmp/logo.svg', '/tmp/cut.dxf']) {
    assert.equal(copyInNeed(DOC, f, ROOTS).need, 'optional', f)
  }
})

test('no gate when the source is already company data or the doc is not', () => {
  assert.equal(copyInNeed(DOC, '/co/pn-cad-files/CM/C/CMC0020.FCStd', ROOTS).need, 'none')
  assert.equal(copyInNeed(DOC, '/co/ecad-cad-files/CM/F/b.kicad_pcb', ROOTS).need, 'none')
  assert.equal(copyInNeed(DOC, '/co/pn-registry/logo.png', ROOTS).need, 'none')
  assert.equal(copyInNeed('/home/u/scratch/a.FCStd', '/tmp/b.step', ROOTS).need, 'none')
  assert.equal(copyInNeed(null, '/tmp/b.step', ROOTS).need, 'none')
  assert.equal(copyInNeed(DOC, '/tmp/b.step', []).need, 'none')
})

test('type guesses', () => {
  assert.equal(guessPartType('image'), 'Z')
  assert.equal(guessPartType('document'), 'Z')
  assert.equal(guessPartType('ecad'), 'F')
  assert.equal(guessPartType('model'), undefined)
})
