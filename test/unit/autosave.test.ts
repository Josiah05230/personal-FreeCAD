/* Unit tests for the autosave rules (app/src/renderer/autosave.ts): which
 * documents may be written in place, what defers a background save, and
 * which KiCad files an ECAD autosave commits. Pure node. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deferReason,
  inPlaceBlocker,
  kicadSourceChanges,
  setAutosaveQuietMs,
  type EngineIdleState
} from '../../app/src/renderer/autosave'

test('in place: non-company files and in-work current revisions only', () => {
  assert.equal(inPlaceBlocker({ pn: null, row: null, lockedByOther: false }), null)
  assert.equal(
    inPlaceBlocker({ pn: 'CMC0010', row: { pn: 'CMC0010', lifecycle: 'in_work' }, lockedByOther: false }),
    null
  )
  assert.match(
    inPlaceBlocker({ pn: 'CMC0010', row: { pn: 'CMC0010', lifecycle: 'active' }, lockedByOther: false }) ?? '',
    /released/
  )
  assert.match(
    inPlaceBlocker({ pn: 'CMC0010', row: { pn: 'CMC0010', lifecycle: 'discontinued' }, lockedByOther: false }) ??
      '',
    /released/
  )
  assert.match(
    inPlaceBlocker({ pn: 'CMC0010', row: { pn: 'CMC0011', lifecycle: 'in_work' }, lockedByOther: false }) ?? '',
    /superseded/
  )
  // a failed registry read never counts as in work
  assert.ok(inPlaceBlocker({ pn: 'CMC0010', row: undefined, lockedByOther: false }))
  assert.ok(inPlaceBlocker({ pn: 'CMC0010', row: { pn: 'CMC0010' }, lockedByOther: false }))
  // someone else's lock beats everything, company part or not
  assert.match(inPlaceBlocker({ pn: null, row: null, lockedByOther: true }) ?? '', /someone else/)
})

test('defer: anything in progress holds a background save back', () => {
  setAutosaveQuietMs(0)
  const idle: EngineIdleState = {
    engineReady: true,
    queueBusy: false,
    rpcInFlight: 0,
    opOpen: false,
    sketching: false,
    previewing: false,
    promptOpen: false,
    modalOpen: false,
    reviewing: false
  }
  assert.equal(deferReason(idle), null)
  assert.equal(deferReason({ ...idle, queueBusy: true }), 'command queue busy')
  assert.equal(deferReason({ ...idle, rpcInFlight: 1 }), 'engine call in flight')
  assert.equal(deferReason({ ...idle, opOpen: true }), 'operation dialog open')
  assert.equal(deferReason({ ...idle, sketching: true }), 'sketch open')
  assert.equal(deferReason({ ...idle, previewing: true }), 'live preview active')
  assert.equal(deferReason({ ...idle, promptOpen: true }), 'prompt open')
  assert.equal(deferReason({ ...idle, modalOpen: true }), 'tool in progress')
  assert.equal(deferReason({ ...idle, reviewing: true }), 'reviewing an upstream change')
  assert.equal(deferReason({ ...idle, engineReady: false }), 'engine not ready')
})

test('ECAD: only KiCad source files under the part\'s KiCad folder', () => {
  const dir = 'CM/F/CMF001-kicad'
  const changed = [
    'CM/F/CMF001-kicad/board.kicad_pcb',
    'CM/F/CMF001-kicad/board.kicad_sch',
    'CM/F/CMF001-kicad/board.kicad_pro',
    'CM/F/CMF001-kicad/fp-lib-table',
    'CM/F/CMF001-kicad/lib/part.kicad_sym',
    'CM/F/CMF001-kicad/~board.kicad_pcb.lck',
    'CM/F/CMF001-kicad/_autosave-board.kicad_sch',
    'CM/F/CMF001-kicad/board-backups/',
    'CM/F/CMF001-kicad/board-backups/board-2026.zip',
    'CM/F/CMF001-kicad/fp-info-cache',
    'CM/F/CMF001-kicad/old.kicad_pcb -> CM/F/CMF001-kicad/new.kicad_pcb',
    'CM/F/CMF0010.FCStd',
    'CM/F/CMF002-kicad/other.kicad_pcb'
  ].map((path) => ({ path }))
  assert.deepEqual(kicadSourceChanges(changed, dir), [
    'CM/F/CMF001-kicad/board.kicad_pcb',
    'CM/F/CMF001-kicad/board.kicad_sch',
    'CM/F/CMF001-kicad/board.kicad_pro',
    'CM/F/CMF001-kicad/fp-lib-table',
    'CM/F/CMF001-kicad/lib/part.kicad_sym'
  ])
  assert.deepEqual(kicadSourceChanges(changed, dir + '/'), kicadSourceChanges(changed, dir))
  assert.deepEqual(kicadSourceChanges(changed, ''), [])
})
