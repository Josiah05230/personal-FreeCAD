import { BrowserWindow, WebContentsView } from 'electron'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Embedded "Insert McMaster-Carr Component" panel: a real Chromium view
 * loading mcmaster.com, attached over a region of the main window (positioned
 * by the renderer's McMasterPanel to match its DOM bounds every frame/resize,
 * same idea as any native-view-over-web-content Electron pattern). Not
 * headless, not a scraped HTTP fetch - a normal browser render, so it gets
 * the normal (non-gated) site MMC serves to real browsers, and can carry a
 * real logged-in session/cart via its own persistent partition if the user
 * ever logs in (optional - most part pages are readable without an account;
 * only checkout requires one).
 */

const PARTITION = 'persist:mcmaster'
let view: WebContentsView | null = null
let attachedTo: BrowserWindow | null = null
let downloadDir: string | null = null

function ensureView(): WebContentsView {
  if (view) return view
  view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true
    }
  })
  return view
}

export function show(win: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }): void {
  const v = ensureView()
  if (attachedTo !== win) {
    if (attachedTo) attachedTo.contentView.removeChildView(v)
    win.contentView.addChildView(v)
    attachedTo = win
  }
  v.setBounds(bounds)
  if (v.webContents.getURL() === '') void v.webContents.loadURL('https://www.mcmaster.com/')
}

export function setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  view?.setBounds(bounds)
}

export function hide(): void {
  if (view && attachedTo) {
    attachedTo.contentView.removeChildView(view)
    attachedTo = null
  }
}

export function currentUrl(): string {
  return view?.webContents.getURL() ?? ''
}

export function goBack(): void {
  const wc = view?.webContents
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
}

export function goForward(): void {
  const wc = view?.webContents
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
}

export function goHome(): void {
  void view?.webContents.loadURL('https://www.mcmaster.com/')
}

/**
 * Address-bar-style navigate: a real URL (mcmaster.com/<part>/, or any URL)
 * loads directly; anything else is typed into MMC's own on-page search box
 * and submitted, exactly like a user would - no guessed search-URL query
 * param scheme, since their search is a plain GET form on the page itself
 * (`SrchEntryWebPart_InpBox`) rather than a documented URL API.
 */
export async function navigate(input: string): Promise<void> {
  const wc = view?.webContents
  if (!wc) return
  const looksLikeUrl = /^https?:\/\//i.test(input) || /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(input)
  if (looksLikeUrl) {
    const url = /^https?:\/\//i.test(input) ? input : `https://${input}`
    await wc.loadURL(url)
    return
  }
  if (!/mcmaster\.com/.test(wc.getURL())) {
    await wc.loadURL('https://www.mcmaster.com/')
    await new Promise((r) => setTimeout(r, 1500))
  }
  await wc.executeJavaScript(
    `(function(){
      var box = document.getElementById('SrchEntryWebPart_InpBox');
      var form = box && box.closest('form');
      if (!box || !form) return false;
      box.value = ${JSON.stringify(input)};
      box.dispatchEvent(new Event('input', {bubbles:true}));
      form.submit();
      return true;
    })()`,
    true
  )
}

/**
 * Get the CAD file straight from MMC's own real download URL rather than
 * simulating a UI click. MMC's markup (found by inspecting a live page): a
 * format-toggle button showing the CURRENTLY selected format ("3-D
 * Solidworks" by default, say), which opens a <li> list of every format
 * ("3-D STEP", "3-D STEP no threads", "3-D IGES", "2-D DWG", ...); selecting
 * one updates a real <a class="_downloadAnchor..." href="..."> elsewhere on
 * the page to a direct file URL (e.g.
 * https://www.mcmaster.com/mvC/Library/CAD2/<date>/<hash>/<Part>_<Desc>.STEP).
 * So this opens the dropdown and clicks the exact "3-D STEP"/"3-D IGES" li
 * (never assumes STEP is already selected - a prior visit to this page may
 * have left a different format chosen), waits for the anchor's href to
 * reflect that extension, then fetches that URL from INSIDE the page via its
 * own `window.fetch()` (executeJavaScript, bytes returned as base64) - not a
 * simulated click, and not a request reconstructed from the main process.
 * Two earlier approaches both failed against this exact endpoint: (1)
 * simulating a click and catching Electron's session `will-download` event -
 * unreliable, a synthetic click's download can fall through to a native
 * "Save As" dialog instead of firing the listener (observed live: the
 * listener never saw the event even though the click genuinely triggered a
 * real Chromium download); (2) fetching the resolved URL with
 * `net.request({session: wc.session})` plus a manually-set Referer header -
 * 403s every time, even though the exact same URL + cookies (captured live
 * via `Network.getCookies` and replayed) succeeds from plain curl, meaning
 * MMC's Akamai bot mitigation on this endpoint keys on something about the
 * request net.request produces that a real Chromium fetch from the page's
 * own JS context doesn't reproduce. Fetching from inside the page sidesteps
 * that entirely - it IS the real browser tab making the request.
 */
export async function downloadCad(format: 'STEP' | 'IGES' = 'STEP'): Promise<string> {
  const wc = view?.webContents
  if (!wc) throw new Error('McMaster view not open')

  const wantLabel = format === 'IGES' ? '3-D IGES' : '3-D STEP'
  const ext = format === 'IGES' ? '.IGS' : '.STEP'

  const hrefHasExt = `
    (function(){
      var a = document.querySelector('a[class*="downloadAnchor"], a[class*="DownloadAnchor"]')
        || Array.from(document.querySelectorAll('a[href]')).find(function(x){ return /\\.(step|igs|sldprt|iges)(\\?|$)/i.test(x.getAttribute('href')||''); });
      return a ? a.getAttribute('href') : null;
    })()
  `
  const currentHref = (await wc.executeJavaScript(hrefHasExt, true)) as string | null

  if (!currentHref || currentHref.toUpperCase().indexOf(ext) === -1) {
    const opened = (await wc.executeJavaScript(
      `(function(){
        var toggle = Array.from(document.querySelectorAll('button')).find(function(b){
          return /^3-D |^2-D /.test((b.textContent||'').trim());
        });
        if (!toggle) return false;
        toggle.click();
        return true;
      })()`,
      true
    )) as boolean
    if (!opened) throw new Error('could not find the CAD format selector on this page')

    await new Promise((r) => setTimeout(r, 400))

    const picked = (await wc.executeJavaScript(
      `(function(){
        var want = ${JSON.stringify(wantLabel)};
        var items = Array.from(document.querySelectorAll('li'));
        var hit = items.find(function(li){ return (li.textContent||'').trim() === want; });
        if (!hit) return false;
        hit.click();
        return true;
      })()`,
      true
    )) as boolean
    if (!picked) throw new Error(`could not find "${wantLabel}" in the format list on this page`)

    // wait for the download anchor's href to actually update to the new format
    let ok = false
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const href = (await wc.executeJavaScript(hrefHasExt, true)) as string | null
      if (href && href.toUpperCase().indexOf(ext) !== -1) {
        ok = true
        break
      }
    }
    if (!ok) throw new Error(`format switched to ${wantLabel} but the download link never updated`)
  }

  // Rather than simulate a click and race Electron's will-download event
  // (unreliable - a synthetic click's download can fall through to the
  // native Save As dialog instead of being caught), or reconstruct the
  // request from the main process with net.request (MMC's CAD file server
  // sits behind Akamai bot mitigation - 403s that reconstruction even with
  // the right cookies/Referer copied over by hand, confirmed by testing the
  // same URL+cookies with curl: works from curl, still 403s from
  // net.request, so something about how Chromium's own fetch differs from a
  // manually-built request matters here), fetch the file from INSIDE the
  // page itself via the page's own window.fetch(). That's byte-identical to
  // what a real click produces - same cookies, same auto-added headers,
  // same Akamai sensor state - because it genuinely IS that browser tab
  // making the request, not a reconstruction of it. The bytes come back as
  // base64 through executeJavaScript's return value.
  const href = (await wc.executeJavaScript(hrefHasExt, true)) as string | null
  if (!href) throw new Error(`could not find a ${format} CAD download link on this page`)
  const fileUrl = new URL(href, wc.getURL()).toString()

  const fetchResult = (await wc.executeJavaScript(
    `(async function(){
      try {
        var res = await fetch(${JSON.stringify(fileUrl)});
        if (!res.ok) return { error: 'HTTP ' + res.status };
        var buf = await res.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return { base64: btoa(bin) };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`,
    true
  )) as { base64?: string; error?: string }

  if (fetchResult.error || !fetchResult.base64) {
    throw new Error(`download failed: ${fetchResult.error || 'no data'}`)
  }

  if (!downloadDir) downloadDir = await mkdtemp(join(tmpdir(), 'gwtcad-mmc-'))
  const filename = decodeURIComponent(fileUrl.split('/').pop() || `part${ext.toLowerCase()}`)
  const dest = join(downloadDir, filename)
  await writeFile(dest, Buffer.from(fetchResult.base64, 'base64'))

  return dest
}

/**
 * Scrape everything readable off the currently-loaded product page: part
 * number (from the URL, MMC's own canonical id), title, description text,
 * the full spec table (every label/value row - "grab everything" per the
 * user), price, and image URLs. Returns raw JSON; the renderer/sidecar
 * decide what to keep. Reads the *rendered* DOM (executeJavaScript in the
 * real page context) - MMC's site has no embedded JSON state to parse, the
 * spec table only exists after their JS builds it.
 */
export async function scrapeCurrentPart(): Promise<Record<string, unknown> | null> {
  const wc = view?.webContents
  if (!wc) throw new Error('McMaster view not open')
  const url = wc.getURL()
  const m = /mcmaster\.com\/([A-Za-z0-9]+)\/?/.exec(url)
  const partNumber = m ? m[1] : null
  if (!partNumber) return null

  const data = (await wc.executeJavaScript(
    `(function(){
      function text(el){ return el ? el.textContent.replace(/\\s+/g,' ').trim() : ''; }

      // Spec table: MMC renders "InfoTable"-style rows, each a label cell +
      // value cell (dt/dd pairs, or two-cell table rows - the app varies by
      // section). Walk every table row / definition-list pair on the page
      // and keep ones that look like label:value (short label, no nested
      // table) rather than hardcoding one selector that breaks on redeploy.
      var specs = {};
      document.querySelectorAll('tr').forEach(function(row){
        var cells = row.querySelectorAll('td,th');
        if (cells.length === 2) {
          var k = text(cells[0]), v = text(cells[1]);
          if (k && v && k.length < 80) specs[k] = v;
        }
      });
      document.querySelectorAll('dl').forEach(function(dl){
        var dts = dl.querySelectorAll('dt'), dds = dl.querySelectorAll('dd');
        for (var i = 0; i < Math.min(dts.length, dds.length); i++) {
          var k = text(dts[i]), v = text(dds[i]);
          if (k && v) specs[k] = v;
        }
      });

      // Price: first element containing a $ amount near "per" / "pack"
      var price = null;
      var priceEl = Array.from(document.querySelectorAll('*')).find(function(el){
        return el.children.length === 0 && /\\$\\d/.test(el.textContent) && el.textContent.length < 60;
      });
      if (priceEl) price = text(priceEl);

      // Title / subtitle: MMC pages usually have an h1 (family name) and a
      // following description line (material/spec summary)
      var h1 = document.querySelector('h1');
      var title = text(h1);
      var subtitle = '';
      if (h1) {
        var sib = h1.nextElementSibling;
        if (sib) subtitle = text(sib);
      }

      // Images: any product image urls on the page
      var images = Array.from(document.querySelectorAll('img'))
        .map(function(im){ return im.src; })
        .filter(function(s){ return s && /mcmaster/i.test(s); });

      // Long-form description paragraphs (the prose blurbs below the spec
      // table, e.g. material notes)
      var paragraphs = Array.from(document.querySelectorAll('p'))
        .map(text)
        .filter(function(t){ return t.length > 40; });

      return JSON.stringify({
        title: title,
        subtitle: subtitle,
        price: price,
        specs: specs,
        images: images,
        paragraphs: paragraphs,
        pageText: document.body.innerText.slice(0, 20000)
      });
    })()`,
    true
  )) as string

  const parsed = JSON.parse(data) as Record<string, unknown>
  return { partNumber, url, ...parsed }
}

export async function cleanup(): Promise<void> {
  if (downloadDir) {
    await rm(downloadDir, { recursive: true, force: true }).catch(() => {})
    downloadDir = null
  }
}
