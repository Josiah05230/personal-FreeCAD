"""Drawing QA: read a finished drawing PDF and list everything wrong with it,
so a blank, wrong or off-page drawing never reaches the portal, a packet or
a supplier (user, 2026-10-17: "NEVER have anything empty/blank/off-page,
wrong"). Pure Python + poppler (pdftotext, pdftoppm, pdfinfo); no FreeCAD.

    from gwtcad.drawqa import check_pdf
    problems = check_pdf(path, pn, row=registry_row, bom=[{"pn":..}, ...])
    # [] = good; otherwise one plain sentence per problem

    python3 -m gwtcad.drawqa drawing.pdf PSC0030      (no registry checks)

Checks:
  - the PDF opens, has exactly one page, and is not blank
  - title block: PART NAME, DESCRIPTION, PART NUMBER and DATE all filled in;
    PART NUMBER is this part; PART NAME is one upper-case word and matches
    the registry name; DESCRIPTION matches the registry description; the
    manufacturer part number is not in the name or description
  - a purchased part's drawing names its manufacturer part number in a note
  - no placeholder text (?, TBD, XXX, PART, SUPPLIER, undefined, null, NaN...)
  - no em or en dashes
  - no text past the page edge, and no ink touching the page edge (clipped
    or off-page geometry)
  - a harness/assembly drawing lists every part of its registry BOM
Text overlapping lines/geometry is checked at build time on the SVG by
pn-cad-files tools/drawcheck.py; this checks what actually got printed.
"""
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile

LABELS = [("PART", "NAME"), ("DESCRIPTION",), ("PART", "NUMBER"), ("DATE",), ("ENGINEER",)]
LABEL_NAMES = {("PART", "NAME"): "PART NAME", ("DESCRIPTION",): "DESCRIPTION",
               ("PART", "NUMBER"): "PART NUMBER", ("DATE",): "DATE", ("ENGINEER",): "ENGINEER"}
REQUIRED = ["PART NAME", "DESCRIPTION", "PART NUMBER", "DATE"]
PLACEHOLDER_WORDS = {"?", "??", "???", "TBD", "TBA", "XXX", "XXXX", "PLACEHOLDER", "UNDEFINED",
                     "NULL", "NAN", "NONE", "LOREM", "IPSUM", "[OBJECT", "FIXME", "TODO"}
PLACEHOLDER_VALUES = {"PART", "SUPPLIER", "NAME", "DESCRIPTION", "-", "N/A", "UNKNOWN"}
DASHES = "–—"
PN_RE = re.compile(r"^[A-Z]{3}\d{4}$")


def _run(args, timeout=60):
    r = subprocess.run(args, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("%s failed: %s" % (args[0], r.stderr.decode("utf-8", "replace")[:200]))
    return r.stdout


def _words(path):
    """[(page, xMin, yMin, xMax, yMax, text)] and [(w, h)] per page."""
    out = _run(["pdftotext", "-bbox-layout", path, "-"]).decode("utf-8", "replace")
    pages, words = [], []
    for i, pg in enumerate(re.split(r"<page ", out)[1:]):
        m = re.match(r'width="([\d.]+)" height="([\d.]+)"', pg)
        pages.append((float(m.group(1)), float(m.group(2))))
        for w in re.finditer(r'<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">(.*?)</word>', pg):
            words.append((i, float(w.group(1)), float(w.group(2)), float(w.group(3)), float(w.group(4)), html.unescape(w.group(5))))
    return words, pages


def _title_block(words):
    """{label: value text} read off the title block: the words to the right
    of each label on the same line, up to the next label."""
    lines = {}
    for w in words:
        if w[0] != 0:
            continue
        key = round((w[2] + w[4]) / 2 / 3)          # 3pt line buckets
        lines.setdefault(key, []).append(w)
    found = {}
    for ws in lines.values():
        ws.sort(key=lambda w: w[1])
        texts = [w[5] for w in ws]
        for lab in LABELS:
            n = len(lab)
            for i in range(len(texts) - n + 1):
                if tuple(texts[i:i + n]) != lab:
                    continue
                end_x = ws[i + n - 1][3]
                vals = []
                for w in ws[i + n:]:
                    if w[1] - end_x > 140:            # past the title block cell
                        break
                    if any(tuple(texts[j:j + len(l)]) == l for l in LABELS for j in [ws.index(w)]):
                        break
                    vals.append(w[5])
                    end_x = w[3]
                name = LABEL_NAMES[lab]
                # the title block is bottom right: keep the right-most hit
                if name not in found or ws[i][1] > found[name][1]:
                    found[name] = (" ".join(vals).strip(), ws[i][1])
    return {k: v[0] for k, v in found.items()}


def _edge_ink(path, page_count):
    """True per page when anything is drawn in the outermost 1.5 mm."""
    tmp = tempfile.mkdtemp(prefix="drawqa-")
    try:
        _run(["pdftoppm", "-gray", "-r", "40", "-f", "1", "-l", str(page_count), path, os.path.join(tmp, "p")], timeout=120)
        result, ink_fraction = [], []
        for name in sorted(os.listdir(tmp)):
            data = open(os.path.join(tmp, name), "rb").read()
            m = re.match(rb"P5\s+(\d+)\s+(\d+)\s+(\d+)\s", data)
            w, h = int(m.group(1)), int(m.group(2))
            px = data[m.end():m.end() + w * h]
            edge = max(1, round(40 / 25.4 * 1.5))
            dark = lambda x, y: px[y * w + x] < 200
            touched = any(dark(x, y) for y in list(range(edge)) + list(range(h - edge, h)) for x in range(0, w, 1)) \
                or any(dark(x, y) for x in list(range(edge)) + list(range(w - edge, w)) for y in range(0, h, 1))
            result.append(touched)
            ink_fraction.append(sum(1 for b in px if b < 200) / float(w * h))
        return result, ink_fraction
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().upper()


def check_pdf(path, pn, row=None, bom=None, max_pages=1):
    """Every problem with the drawing PDF at `path` for part `pn`, as plain
    sentences ([] when it is good). `row` is the part's registry row (name,
    description, mfg, mfg_pn) and `bom` its registry BOM ([{"pn": ...}]);
    without them only the drawing itself is checked."""
    problems = []
    if not os.path.isfile(path) or os.path.getsize(path) < 500:
        return ["%s: the PDF is missing or empty." % pn]
    try:
        info = _run(["pdfinfo", path]).decode("utf-8", "replace")
        page_count = int(re.search(r"Pages:\s+(\d+)", info).group(1))
        words, pages = _words(path)
    except Exception as e:  # noqa: BLE001
        return ["%s: the PDF cannot be read (%s)." % (pn, e)]
    if page_count == 0:
        return ["%s: the PDF has no pages." % pn]
    if max_pages and page_count > max_pages:
        problems.append("%s: the drawing has %d pages; it should be %d." % (pn, page_count, max_pages))
    text = " ".join(w[5] for w in words)

    # title block
    tb = _title_block(words)
    for label in REQUIRED:
        value = tb.get(label)
        if value is None:
            problems.append("%s: the title block has no %s field." % (pn, label))
        elif not value:
            problems.append("%s: the title block's %s is empty." % (pn, label))
        elif norm(value) in PLACEHOLDER_VALUES:
            problems.append("%s: the title block's %s is a placeholder (%s)." % (pn, label, value))
    if tb.get("PART NUMBER") and norm(tb["PART NUMBER"]) != pn:
        problems.append("%s: the title block says PART NUMBER %s." % (pn, tb["PART NUMBER"]))
    name = tb.get("PART NAME") or ""
    if name and (" " in name.strip() or name != name.upper()):
        problems.append("%s: PART NAME must be one upper-case word, not \"%s\"." % (pn, name))
    if row:
        reg_name, reg_desc = norm(row.get("name")), norm(row.get("description"))
        if name and reg_name and norm(name) != reg_name:
            problems.append("%s: PART NAME is %s but the registry says %s." % (pn, name, reg_name))
        desc = tb.get("DESCRIPTION") or ""
        if desc and reg_desc and norm(desc) != reg_desc:
            problems.append("%s: DESCRIPTION is \"%s\" but the registry says \"%s\"." % (pn, desc, reg_desc))
        mfg_pn = norm(row.get("mfg_pn"))
        if mfg_pn and len(mfg_pn) > 3:
            if mfg_pn in norm(name) or mfg_pn in norm(desc):
                problems.append("%s: the manufacturer part number belongs in a note, not in the name or description." % pn)
            mfg = norm(row.get("mfg"))
            if mfg and mfg != "GWT" and mfg_pn not in norm(text).replace(" ", " "):
                problems.append("%s: a purchased part's drawing must name %s %s in a note." % (pn, row.get("mfg"), row.get("mfg_pn")))

    # placeholders and dashes anywhere on the page
    bad = sorted({w[5] for w in words if norm(w[5]).strip(".,:;()") in PLACEHOLDER_WORDS})
    if bad:
        problems.append("%s: placeholder text on the drawing: %s." % (pn, ", ".join(bad)))
    if any(ch in text for ch in DASHES):
        problems.append("%s: the drawing has an em or en dash; use a plain hyphen." % pn)

    # off the page
    for (pg, x0, y0, x1, y1, t) in words:
        w, h = pages[pg]
        if x0 < -0.5 or y0 < -0.5 or x1 > w + 0.5 or y1 > h + 0.5:
            problems.append("%s: text \"%s\" runs off the page." % (pn, t))
            break
    try:
        edges, ink = _edge_ink(path, min(page_count, 3))
        if any(edges):
            problems.append("%s: something is drawn right at the page edge (clipped or off the page)." % pn)
        if ink and ink[0] < 0.004:
            problems.append("%s: the drawing is nearly blank." % pn)
    except Exception as e:  # noqa: BLE001
        problems.append("%s: could not render the PDF to check its edges (%s)." % (pn, e))

    # a BOM drawing lists every part
    if bom:
        present = set(re.findall(r"\b[A-Z]{3}\d{4}\b", norm(text)))
        missing = sorted({b["pn"] for b in bom if PN_RE.match(b.get("pn") or "") and b["pn"] not in present})
        if missing:
            problems.append("%s: the drawing's BOM does not list %s." % (pn, ", ".join(missing)))
    return problems


def gate(path, pn, row=None, bom=None):
    """Raise with every problem if the drawing is not fit to publish."""
    problems = check_pdf(path, pn, row=row, bom=bom)
    if problems:
        raise RuntimeError("Drawing QA failed, not uploaded:\n  " + "\n  ".join(problems))


if __name__ == "__main__":
    probs = check_pdf(sys.argv[1], sys.argv[2])
    print("\n".join(probs) if probs else "OK")
    sys.exit(1 if probs else 0)
