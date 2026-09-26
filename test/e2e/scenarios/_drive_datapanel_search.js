/* Manual driver (--drive): verifies the Data Panel's new recursive search
 * (filename AND registry name/description), inline name/description
 * metadata on every design row, and the "Company CAD" location footer -
 * against an isolated scratch registry + CAD tree, symlinked under the
 * real home directory as ~/dp_search_test so the panel's own default
 * start point (homedir()) can reach it with normal folder clicks (never
 * real company data). */

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- point company.json at the scratch registry, so pn.listAll resolves real name/description ---');
const cfgBefore = await rpc('pn.getCompanyConfig', {});
await rpc('pn.setCompanyConfig', {
  registryPath: '/tmp/dp_search_test/registry',
  projects: { CM: { repoPath: '/tmp/dp_search_test/cad' } }
});

note('--- open the Data Panel (the "waffle" button in the app bar) ---');
const waffleBtn = document.querySelector('.waffle');
assert(!!waffleBtn, 'found the waffle (Show Data Panel) button');
waffleBtn.click();
await sleep(400);
const panel = document.querySelector('.datapanel');
assert(!!panel && panel.classList.contains('open'), 'the Data Panel is open');

note('--- navigate: home -> dp_search_test -> cad -> CMZ0010 (real PN-folder convention: <PN>/<PN>.FCStd) ---');
function clickRowByName(name) {
  const row = Array.from(document.querySelectorAll('.dp-row .dp-name'))
    .find((el) => el.textContent === name);
  if (!row) return false;
  row.closest('.dp-row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  return true;
}
assert(clickRowByName('dp_search_test'), 'found the symlinked scratch folder from home');
await sleep(300);
assert(clickRowByName('cad'), 'navigated into the scratch cad folder');
await sleep(300);
assert(clickRowByName('CMZ0010'), 'navigated into the CMZ0010 PN folder');
await sleep(300);

const rowsBeforeSearch = Array.from(document.querySelectorAll('.dp-row.file .dp-name')).map((el) => el.textContent);
note('rows before searching (should include CMZ0010.FCStd at this level): ' + JSON.stringify(rowsBeforeSearch));
assert(rowsBeforeSearch.includes('CMZ0010.FCStd'), 'CMZ0010 is visible at this folder level, browsing normally');

note('--- inline metadata shows under the file even with no search active ---');
await sleep(300); // let the pn.listAll effect resolve
const metaEls = Array.from(document.querySelectorAll('.dp-meta')).map((el) => el.textContent);
note('inline metadata found while browsing: ' + JSON.stringify(metaEls));
assert(metaEls.some((t) => t && t.includes('connector') && t.includes('2 PIN WP FEMALE')),
  'CMZ0010 shows its real name/description inline, without any search active');

note('--- search by a NAME/DESCRIPTION word that appears nowhere in any filename ---');
const searchInput = document.querySelector('.datapanel-search input');
assert(!!searchInput, 'found the search input');
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(searchInput, 'connector');
searchInput.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(600); // debounce (200ms) + the extra registry-name lookup pass

const resultsAfterConnectorSearch = Array.from(document.querySelectorAll('.dp-row.file .dp-name')).map((el) => el.textContent);
note('results for "connector": ' + JSON.stringify(resultsAfterConnectorSearch));
assert(resultsAfterConnectorSearch.includes('CMZ0010.FCStd'),
  'searching "connector" (a NAME field value, not a filename substring) finds CMZ0010.FCStd');
assert(!resultsAfterConnectorSearch.includes('CMZ0020.FCStd'),
  'CMZ0020 (an unrelated bracket) does NOT show up for a "connector" search - the match is real, not everything');

note('--- go back up to cad/ so the search root is a common ancestor of both parts ---');
setter.call(searchInput, '');
searchInput.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(300);
const upRow = document.querySelector('.dp-row.up');
assert(!!upRow, 'found the "up" row to navigate back to cad/');
upRow.click();
await sleep(300);
const rowsInCad = Array.from(document.querySelectorAll('.dp-row.file .dp-name')).map((el) => el.textContent);

note('--- search finds a match nested several folders deep, from a shallower starting point ---');
setter.call(searchInput, 'bracket');
searchInput.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(600);
const resultsAfterBracketSearch = Array.from(document.querySelectorAll('.dp-row.file .dp-name')).map((el) => el.textContent);
note('results for "bracket" (description-only match, file is 2 folders deep): ' + JSON.stringify(resultsAfterBracketSearch));
assert(resultsAfterBracketSearch.includes('CMZ0020.FCStd'),
  'searching "bracket" finds CMZ0020.FCStd even though it is nested inside subdir/deep/ and "bracket" is only in its description');

note('--- clearing the search restores normal browsing ---');
const clearBtn = document.querySelector('.dp-search-clear');
assert(!!clearBtn, 'found the clear-search button');
clearBtn.click();
await sleep(300);
const rowsAfterClear = Array.from(document.querySelectorAll('.dp-row.file .dp-name')).map((el) => el.textContent);
note('rows after clearing: ' + JSON.stringify(rowsAfterClear));
assert(JSON.stringify(rowsAfterClear) === JSON.stringify(rowsInCad), 'clearing the search restores the exact prior folder view');

note('--- "Company CAD" footer names where the configured repo actually lives ---');
const footer = document.querySelector('.datapanel-footer');
note('footer text: ' + (footer ? footer.textContent : null));
assert(!!footer && footer.textContent.includes('/tmp/dp_search_test/cad'), 'the footer names the real configured company CAD path');

note('--- restore the real company.json ---');
await rpc('pn.setCompanyConfig', cfgBefore);

note('--- done ---');
