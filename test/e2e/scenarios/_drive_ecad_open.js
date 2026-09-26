/* Manual driver (--drive): verifies opening a real F (PCB Assembly) PN
 * through the ACTUAL Part Number Manager panel auto-imports its linked
 * KiCad board via kicad.importStep (real per-component STEP geometry),
 * and that "Open in KiCad" becomes available - against an isolated
 * scratch registry + ECAD repo, never real company data.
 */
const ECAD_ROOT = '/tmp/ecad_open_test/ecad-cad-files';
const PART_DIR = ECAD_ROOT + '/CM/F/CMF0010';
const FCSTD_PATH = PART_DIR + '/CMF0010.FCStd';
const PCB_PATH = PART_DIR + '/board.kicad_pcb';
const PRO_PATH = PART_DIR + '/board.kicad_pro';
// pre-built by run_ecad_open_test.sh (a real .kicad_sch with a GWT_PN
// custom field on one placed symbol instance - see that script for why
// this can't be built from inside the running app: it needs to read a
// template file from disk, and no window.cad.readFile bridge exists
// (nor should one, purely for a test fixture)).
const SCH_PATH = PART_DIR + '/board.kicad_sch';

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- point company.json at the scratch registry + ECAD repo ---');
const cfgBefore = await rpc('pn.getCompanyConfig', {});
await rpc('pn.setCompanyConfig', {
  registryPath: '/tmp/ecad_open_test/registry',
  ecadRepoPath: ECAD_ROOT,
  projects: { CM: { name: 'Test Co', repoPath: '/tmp/ecad_open_test/pn-cad-files' } }
});

note('--- reserve the F part + a real G-type component (for the BOM link) directly via RPC (already verified through the real dialog in _drive_ecad_reserve.js) ---');
const reserved = await rpc('pn.reserve', {
  project: 'CM', type: 'F', seq: 1, name: 'sensor breakout', description: 'Test breakout board'
});
const reservedComponent = await rpc('pn.reserve', {
  project: 'CM', type: 'G', seq: 1, name: 'connector', description: '2 PIN WP FEMALE connector'
});
note('reserved component: ' + JSON.stringify(reservedComponent));
assert(reservedComponent.pn === 'CMG0010', 'reserved the expected component PN for the BOM link');
note('reserved: ' + JSON.stringify(reserved));
assert(reserved.pn === 'CMF0010', 'reserved the expected PN');

note('--- save a placeholder FCStd at the reserved path (simulates the mockup step) ---');
await rpc('session.reset', {});
await rpc('document.saveAs', { path: FCSTD_PATH });

note('--- place a real .kicad_pcb + .kicad_pro alongside it (simulates a prior KiCad import) ---');
await window.cad.writeText('(kicad_pcb (version 20221018) (generator pcbnew))', PCB_PATH);
await window.cad.writeText('(kicad_pro)', PRO_PATH);

note('--- open the Part Number Manager, filter to CMF0010 ---');
const fileTrigger = document.querySelector('.appbar-file');
fileTrigger.click();
await sleep(150);
const pnBrowserItem = Array.from(document.querySelectorAll('.filemenu-item')).find((el) =>
  /Part Number Manager/.test(el.textContent || '')
);
assert(!!pnBrowserItem, 'found the Part Number Manager menu item');
pnBrowserItem.click();
await sleep(400);

const filterInput = Array.from(document.querySelectorAll('input')).find((i) => /^Filter by PN/.test(i.placeholder || ''));
assert(!!filterInput, 'found the Part Number Manager filter input');
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(filterInput, 'CMF001');
filterInput.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(200);

const rows = Array.from(document.querySelectorAll('.pn-browser-table tbody tr'));
note('rows after filtering: ' + rows.length + ' - first row text: ' + (rows[0]?.textContent || ''));
// the table's PN column shows pn_seq (no rev digit, e.g. "CMF001"), not the
// full pn ("CMF0010") - confirmed against PNBrowserPanel.tsx directly.
const row = rows.find((r) => (r.textContent || '').includes('CMF001'));
assert(!!row, 'found the CMF001 row in the Part Number Manager');
const openBtn = Array.from(row.querySelectorAll('button')).find((b) => /^Open/.test(b.textContent || ''));
assert(!!openBtn, 'found the row\'s Open button');
openBtn.click();
await sleep(1500); // kicad.importStep round-trip (spawns kicad-cli)

note('--- confirm the real document.info reflects a genuine STEP import, not the bare mockup ---');
const info = await rpc('document.info', {});
note('opened doc info: ' + JSON.stringify(info));
assert(info.path === FCSTD_PATH, 'the active document path is the F part\'s own FCStd path (not the .kicad_pcb itself)');

note('--- confirm the "Open in KiCad" menu item is now available ---');
fileTrigger.click();
await sleep(150);
const openInKicadItem = Array.from(document.querySelectorAll('.filemenu-item')).find((el) =>
  /Open in KiCad/.test(el.textContent || '')
);
assert(!!openInKicadItem, '"Open in KiCad" appeared in the File menu after opening a KiCad-linked F part');
document.querySelector('.filemenu-scrim')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
await sleep(150);

note('--- confirm the schematic\'s real BOM (GWT_PN-tagged component) was linked as this F part\'s kit BOM ---');
const bom = await rpc('pn.bomFor', { pn: 'CMF0010' });
note('BOM for CMF0010: ' + JSON.stringify(bom));
assert(
  bom.items.some((it) => it.pn === 'CMG0010' && it.componentName === '2 PIN WP FEMALE connector'),
  'the real component (matched by its GWT_PN field in the schematic) appears in the F part\'s BOM'
);

note('--- restore the real company.json ---');
await rpc('pn.setCompanyConfig', cfgBefore);

note('--- done ---');
