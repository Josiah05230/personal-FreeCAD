# First-time setup

Everything below is per-machine, one-time setup. None of it lives in git -
company data paths and credentials are never checked in, so a fresh
install always needs these steps before the app is fully working.

**The short version, for someone handing this to a new teammate:** you
give them (1) the installer for their OS (see step 1 - just a file, no
GitHub access needed to install the app itself), (2) GitHub collaborator
access to `pn-registry` and `pn-cad-files` (step 2 - this IS where GitHub
access matters, since those are the company's real data repos), and (3)
the ONE file `~/.gwtcad/firebase-service-account.json`, shared via Drive/a
password manager - not git (step 3). Everything else in this doc, they set
up themselves by following the steps below.

Do them in order - each step's "how to check it worked" catches a mistake
before it turns into a confusing failure two steps later.

## 1. Base app (required for everything)

**Using the packaged installer (recommended for anyone who isn't
developing the app itself):** grab the right file for your OS from the
latest release -
`GWT-CAD-<version>-amd64.deb` (Debian/Ubuntu), `GWT-CAD-<version>-x86_64.AppImage`
(any Linux, no install needed - just `chmod +x` and run it), or
`GWT-CAD-Setup-<version>.exe` (Windows). FreeCAD is bundled inside - there
is nothing else to install, no `freecadcmd` path to find, no Node.js
needed. Double-click it, or for the `.deb`: `sudo apt install ./GWT-CAD-*.deb`.

**Check it worked:** the app opens (from your applications menu, or by
running the AppImage/exe) and shows the first-run welcome dialog. If this
is all you need, skip straight to step 2 - none of the `freecadcmd`/
`npm install` steps below apply to you.

---

**Developing the app instead (building from source, contributing code):**

1. Get FreeCAD 1.1+ - either extract the AppImage or use a system install
   that provides `freecadcmd`.
2. Get Node.js 18+.
3. Clone this repo, then:
   ```bash
   cp config.example.json config.local.json
   ```
   Open `config.local.json` and set `"freecadcmd"` to the real path on your
   machine, e.g. `~/Applications/FreeCAD-1.1.1.AppDir/usr/bin/freecadcmd`.
   Find yours with:
   ```bash
   find ~ -iname freecadcmd 2>/dev/null
   ```
4. Install and run:
   ```bash
   cd app && npm install && cd ..
   scripts/dev.sh
   ```

**Check it worked:** the app window opens and shows the first-run welcome
dialog. If it hangs on a blank window, `freecadcmd` in `config.local.json`
is probably wrong - re-run the `find` command above.

## 2. Company directories (needed for anything PN-related: reserving a
   part number, promoting a lifecycle, opening a part by PN)

You need your own local clones of the company's two private data repos -
these are real, actively-changing git repos (not a one-time download), so
access has to be a real GitHub collaborator invite, not a copied folder.

**Whoever manages them (currently Josiah) needs to add you as a
collaborator** on both, from each repo's page: Settings > Collaborators
and teams > Add people > your GitHub username:

- `github.com/Josiah05230/pn-registry` - the shared PN registry
  (`registry.csv`, `types.yaml`, `bom.csv`)
- `github.com/Josiah05230/pn-cad-files` - the actual `.FCStd` files,
  organized `<project>/<type>/<PN>/<PN>.FCStd` (e.g. `CM/C/CMC0010/CMC0010.FCStd`) -
  grouped by project then type so a person can browse to a family of
  parts by hand without already knowing its exact PN

You'll get an email/GitHub notification to accept the invite - do that
first, or the clone below will fail with a permission error.

Once you have access:

```bash
git clone https://github.com/Josiah05230/pn-registry.git ~/pn-registry
git clone https://github.com/Josiah05230/pn-cad-files.git ~/pn-cad-files
```

(Anywhere on disk works - `~/pn-registry` is just a convenient default.)

Then in the app: **File > Company Directories…**

- **PN registry**: choose the `pn-registry` folder you just cloned.
- **Projects**: add one entry per project code your team uses (currently
  `PS`, `VP`, `HW`, `FA`, `SG`, `GM`, `CM`) - each one's path is the SAME
  `pn-cad-files` folder (one shared repo holds every project's parts, this
  isn't a separate clone per code). Type the code, a display name, then
  point it at `pn-cad-files`.

**Check it worked:** File > Open by PN (or similar) shows real part
numbers from the registry, not an empty list. Opening one actually loads
the part.

## 3. CAD-export pipeline (needed only for lifecycle promotion to `active`
   - everything else works without this)

Promoting a part to `active` exports its STEP + a PDF of its drawing and
uploads both to Firebase Storage, for the GrainWavePartners dealer portal
to pick up. Three things, all local to this machine:

### 3a. `rsvg-convert`

Converts the drawing page (built as SVG) to PDF - FreeCAD's own
print-to-PDF can't run headless, so this fills that gap.

```bash
sudo apt install librsvg2-bin        # Debian/Ubuntu
# or: brew install librsvg           # macOS
```

**Check it worked:**
```bash
rsvg-convert -v
```
prints a version number.

### 3b. `google-auth` in FreeCAD's own Python

Used to authenticate to Firebase Storage. This MUST go into the exact same
Python interpreter `freecadcmd` uses (not your system Python) - pip pulls
compiled wheels that only work if their Python version matches exactly
(e.g. `cp311` for Python 3.11), so installing into the wrong interpreter
either silently does nothing useful or fails to import with a confusing
`_cffi_backend` error.

Find your FreeCAD interpreter's site-packages folder (same directory tree
as the `freecadcmd` path from step 1, with `usr/lib/pythonX.Y/site-packages`
appended):

```bash
find ~/Applications -path "*/site-packages" -iname "site-packages" 2>/dev/null
```

Then:

```bash
pip install --target <that path> google-auth
```

**Check it worked:**
```bash
echo "from google.oauth2 import service_account; print('OK')" | ~/Applications/FreeCAD-1.1.1.AppDir/usr/bin/freecadcmd
```
(swap in your real `freecadcmd` path) should print `OK`, not an
`ImportError`/`ModuleNotFoundError`.

If you hit a `_cffi_backend` or similar native-module error: the wheel pip
grabbed doesn't match your FreeCAD interpreter's Python version. Check the
version with:
```bash
~/Applications/FreeCAD-1.1.1.AppDir/usr/bin/freecadcmd -c "import sys; print(sys.version)"
```
then download matching wheels explicitly and unzip them into
site-packages by hand:
```bash
pip download --dest /tmp/wheels --python-version 311 --implementation cp \
  --abi cp311 --platform manylinux2014_x86_64 --only-binary=:all: \
  cffi cryptography pyasn1 pyasn1-modules
cd /tmp/wheels && for w in *.whl; do python3 -m zipfile -e "$w" extracted/; done
cp -r extracted/* <your site-packages path>/
```
(adjust `--python-version`/`--abi` to match whatever step 3b's version
check printed).

### 3c. Firebase service-account key

This is one real file, not something you set up yourself - and unlike the
two repos above, it should NOT go through git. It's a live credential
(write access to the company's Storage bucket), and git keeps every
version forever even after a file's "deleted" in a later commit - a
plain shared file (Google Drive, a password manager's shared-item
feature, etc.) can actually be replaced or revoked outright if it ever
needs to be, which a committed secret can't.

- **Whoever manages the GrainWavePartners Firebase project generates it**
  (only needs doing once, ever - every teammate uses the SAME file):
  Firebase console > GrainWavePartners project > Project Settings >
  Service Accounts tab > "Generate new private key" > downloads a JSON
  file.
- **They share that exact file** via Drive (or similar) restricted to the
  people who need it.
- **You download it and save it** at exactly:
  ```
  ~/.gwtcad/firebase-service-account.json
  ```
  (create the `~/.gwtcad` folder if it doesn't exist yet - `company.json`
  from step 2 also lives there once you've used Company Directories at
  least once). The filename must be exact - `firebase-service-account.json`,
  nothing else.

**Check it worked:**
```bash
echo "
import sys
sys.path.insert(0, '<path to this repo>/sidecar')
from gwtcad import firebase_storage
print(firebase_storage.upload_bytes('cad-exports/_setup_test/test.txt', b'ok', 'text/plain'))
" | <your freecadcmd path>
```
should print `{'storagePath': 'cad-exports/_setup_test/test.txt'}`. Delete
the test file from the Firebase console's Storage browser afterward (or
ask whoever has admin access to).

If this fails with "no Firebase service-account key" - the file isn't at
the exact path above. If it fails with "rejected by Google" - the key
itself is bad (revoked, wrong project) - get a fresh one.

## What happens if you skip step 3

Steps 1-2 alone give you a fully working app for everything except
lifecycle promotion's export step. Promoting a part to `active` still
works - the lifecycle change always lands - but you'll see a notice saying
the export failed and why, instead of a confirmation that STEP+PDF
uploaded. That's expected until step 3 is done; it's not a bug.
