/* Verifies the Browser tree's right-click context menu (Rename etc.) is
 * portaled to <body> instead of rendered as a nested child of the tree's
 * own scrollable `.browser` container. The old behaviour combined with
 * `.browser`'s `backdrop-filter: blur(8px)` (which establishes a new
 * containing block, silently turning the menu's `position: fixed` into
 * "relative to .browser" instead of the viewport per spec) to (a) grow the
 * tree's scrollable content box and force unwanted scrollbars around it,
 * and (b) potentially clip/mis-show the menu so a real user reported never
 * seeing a Rename option at all. */

note('--- build a body and open its context menu ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s0.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();

const browserEl = document.querySelector('.browser');
assert(!!browserEl, 'the model tree (.browser) is mounted');

const scrollBefore = browserEl ? { h: browserEl.scrollHeight, w: browserEl.scrollWidth } : null;
note('tree scrollHeight/scrollWidth before right-click: ' + JSON.stringify(scrollBefore));

// find the body's tree row and right-click it for real
const bodyRow = Array.from(document.querySelectorAll('.browser [class*="row"], .browser *')).find(
  (el) => el.textContent && el.textContent.trim() === 'Body' && el.children.length === 0
);
assert(!!bodyRow, 'found the Body row in the tree to right-click');

if (bodyRow) {
  const r = bodyRow.getBoundingClientRect();
  bodyRow.dispatchEvent(
    new MouseEvent('contextmenu', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true, cancelable: true })
  );
  await sleep(150);

  const menu = document.querySelector('.ctxmenu');
  assert(!!menu, 'a context menu actually opened for the Body row');

  if (menu) {
    assert(
      menu.closest('.browser') === null,
      'the context menu is portaled OUTSIDE the scrollable tree container, not nested inside it'
    );
    assert(
      menu.parentElement === document.body,
      'the context menu is a direct child of <body> (real React portal target)'
    );
    const items = Array.from(menu.querySelectorAll('.ctx-item')).map((el) => el.textContent);
    note('context menu items for Body: ' + JSON.stringify(items));
    assert(
      items.some((t) => /Rename/i.test(t || '')),
      'the Body row context menu actually includes a Rename option'
    );
  }

  const scrollAfter = browserEl ? { h: browserEl.scrollHeight, w: browserEl.scrollWidth } : null;
  note('tree scrollHeight/scrollWidth after right-click (menu open): ' + JSON.stringify(scrollAfter));
  assert(
    JSON.stringify(scrollAfter) === JSON.stringify(scrollBefore),
    'opening the context menu does NOT grow the tree\'s own scrollable content (no unwanted scrollbars)'
  );

  // exercise the actual rename flow end to end
  const renameItem = Array.from(document.querySelectorAll('.ctxmenu .ctx-item')).find((el) =>
    /Rename/i.test(el.textContent || '')
  );
  if (renameItem) {
    renameItem.click();
    await sleep(150);
    // promptText auto-cancels under --e2e (see PromptDialog.tsx _e2e()
    // guard) so the rename won't actually commit here - this still proves
    // the menu item is reachable and clickable, which is the actual bug
    // report (the menu never showing/working at all)
    note('Rename item clicked without throwing - menu interaction reaches the real handler');
  }
}

note('--- done ---');
