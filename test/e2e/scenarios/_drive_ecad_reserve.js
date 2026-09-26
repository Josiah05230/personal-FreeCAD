/* Manual driver (--drive): verifies reserving a real F (PCB Assembly) PN
 * through the ACTUAL File > New Part... dialog lands its .FCStd in the
 * shared ECAD repo (ecadRepoPath), not the project's mechanical repoPath -
 * against an isolated scratch registry + two scratch repos, never real
 * company data. */

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- point company.json at scratch registry + mechanical + ECAD repos ---');
const cfgBefore = await rpc('pn.getCompanyConfig', {});
await rpc('pn.setCompanyConfig', {
  registryPath: '/tmp/ecad_reserve_test/registry',
  ecadRepoPath: '/tmp/ecad_reserve_test/ecad-cad-files',
  projects: { CM: { name: 'Test Co', repoPath: '/tmp/ecad_reserve_test/pn-cad-files' } }
});

note('--- open File menu, click New Part... ---');
const fileTrigger = document.querySelector('.appbar-file');
assert(!!fileTrigger, 'found the File menu trigger');
fileTrigger.click();
await sleep(150);
const newPartItem = Array.from(document.querySelectorAll('.filemenu-item')).find((el) =>
  /New Part/.test(el.textContent || '')
);
assert(!!newPartItem, 'found the "New Part..." menu item');
newPartItem.click();
await sleep(300);

note('--- fill out the New Part dialog for a real F-type PCB assembly ---');

function setSelectValue(selectEl, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(selectEl, value);
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
}
const setInputVal = (el, val) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

// exactly two real <select>s in this dialog: project, then type.
const selects = Array.from(document.querySelectorAll('select'));
note('selects found: ' + selects.length);
assert(selects.length === 2, 'found exactly the project + type selects in the New Part dialog');
setSelectValue(selects[0], 'CM');
await sleep(200);
setSelectValue(selects[1], 'F');
await sleep(400); // pn.listAvailableSeq round-trip

// sequence numbers render as buttons showing a zero-padded 3-digit number
// (String(n).padStart(3, '0')) - pick the first one available.
const seqBtn = Array.from(document.querySelectorAll('button')).find((b) => /^\d{3}$/.test((b.textContent || '').trim()));
assert(!!seqBtn, 'found an available sequence-number button');
seqBtn.click();
await sleep(100);

const nameInput = Array.from(document.querySelectorAll('input')).find((i) => /^Name/.test(i.placeholder || ''));
const descInput = Array.from(document.querySelectorAll('input')).find((i) => /^Description/.test(i.placeholder || ''));
assert(!!nameInput, 'found the name input');
assert(!!descInput, 'found the description input');
setInputVal(nameInput, 'breakout board');
setInputVal(descInput, 'Test ESP32 breakout module mockup');
await sleep(100);

const submitBtn = Array.from(document.querySelectorAll('button')).find((b) => /^Create Part$/.test((b.textContent || '').trim()));
assert(!!submitBtn, 'found the "Create Part" submit button');
assert(!submitBtn.disabled, 'the submit button is enabled once every required field is filled');
submitBtn.click();
await sleep(600);

note('--- confirm the new document opened at a path INSIDE the ECAD repo, not pn-cad-files ---');
const info = await rpc('document.info', {});
note('opened at: ' + JSON.stringify(info));
assert(!!info.path, 'a document is open with a real path');
assert(info.path.includes('/ecad_reserve_test/ecad-cad-files/'), 'the F-type part was saved inside the ECAD repo');
assert(!info.path.includes('/pn-cad-files/'), 'the F-type part was NOT saved inside the mechanical repo');
assert(/CMF\d+\.FCStd$/.test(info.path), 'the saved filename matches the <PN>.FCStd convention');

note('--- restore the real company.json ---');
await rpc('pn.setCompanyConfig', cfgBefore);

note('--- done ---');
