"""kicad.importBom: real BOM extraction from a .kicad_sch via kicad-cli,
matching each symbol's GWT_PN custom field against the real registry and
saving the result as an F (PCB Assembly) part's kit BOM (pn.saveBom).
This module imports FreeCAD/Part at the top (kicad.py), so run it under
the bundled freecadcmd, not plain pytest - see sidecar/scripts/run_tests.sh.
"""
import os
import shutil

import pytest

freecad_or_skip = pytest.importorskip("FreeCAD")

import FreeCAD as App

from gwtcad import kicad, partnumbers as pn, session


def _kicad_cli_available():
    return shutil.which("kicad-cli") is not None


TEMPLATE_SCH = "/usr/share/kicad/template/Arduino_Nano/Arduino_Nano.kicad_sch"


def _patch_gwt_pn(content, ref, gwt_pn):
    """Adds a GWT_PN custom field to a PLACED SYMBOL INSTANCE's property
    list (found by its Reference, e.g. "J1") - confirmed this must be the
    instance, not the shared lib_symbols template definition (kicad-cli's
    BOM export correctly reads only instance-level field overrides; a
    field added to the library template never appears in the export at
    all, even though it parses and looks identical at a glance)."""
    marker = '(property "Reference" "%s"' % ref
    idx = content.find(marker)
    if idx < 0:
        raise ValueError("reference %r not found in schematic" % ref)
    start_paren = content.find("(", idx)
    depth = 1
    i = start_paren + 1
    while depth > 0:
        if content[i] == "(":
            depth += 1
        elif content[i] == ")":
            depth -= 1
        i += 1
    addition = (
        '\n\t\t(property "GWT_PN" "%s"\n\t\t\t(at 0 0 0)\n\t\t\t(effects\n\t\t\t\t'
        '(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t\t(hide yes)\n\t\t\t)\n\t\t)'
    ) % gwt_pn
    return content[:i] + addition + content[i:]


@pytest.fixture
def real_schematic(tmp_path):
    if not os.path.isfile(TEMPLATE_SCH):
        pytest.skip("system KiCad templates not installed")
    return tmp_path / "test.kicad_sch"


@pytest.fixture(autouse=True)
def close_session_doc():
    yield
    try:
        d = session.doc(create=False)
        if d is not None:
            App.closeDocument(d.Name)
    except Exception:
        pass


@pytest.fixture
def registry_with_component(tmp_path, monkeypatch):
    """A throwaway registry (real git repo) with one real, reserved G
    (PCB Component) PN and one F (PCB Assembly) PN to attach a BOM to -
    never the real ~/.gwtcad/company.json."""
    import subprocess

    reg = tmp_path / "registry"
    reg.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(reg)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(reg), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(reg), "config", "user.name", "Test"], check=True)

    config_path = tmp_path / "company.json"
    monkeypatch.setattr(pn, "_CONFIG_PATH", str(config_path))
    pn._save_config({"registryPath": str(reg), "ecadRepoPath": None, "projects": {}})

    pn.pn_reserve("CM", "G", 1, "connector", "2 PIN WP FEMALE connector")
    pn.pn_reserve("CM", "F", 1, "sensor breakout", "Test breakout board")
    return reg


@pytest.mark.skipif(not _kicad_cli_available(), reason="kicad-cli not installed on this machine")
def test_import_bom_matches_real_gwt_pn_and_skips_unreserved(real_schematic, registry_with_component):
    content = open(TEMPLATE_SCH).read()
    content = _patch_gwt_pn(content, "J1", "CMG0010")  # real, reserved
    content = _patch_gwt_pn(content, "J2", "CMG9999")  # never reserved - must be skipped
    real_schematic.write_text(content)

    result = kicad.kicad_import_bom(str(real_schematic), "CMF0010")
    assert result["skipped"] == ["CMG9999"]
    assert result["itemCount"] == 1

    bom = pn.pn_bom_for("CMF0010")
    assert bom["items"] == [{"pn": "CMG0010", "componentName": "2 PIN WP FEMALE connector", "qty": 1}]


@pytest.mark.skipif(not _kicad_cli_available(), reason="kicad-cli not installed on this machine")
def test_import_bom_aggregates_repeated_components(real_schematic, registry_with_component):
    content = open(TEMPLATE_SCH).read()
    content = _patch_gwt_pn(content, "J1", "CMG0010")
    content = _patch_gwt_pn(content, "J2", "CMG0010")  # same PN as J1 - must aggregate to qty=2
    real_schematic.write_text(content)

    kicad.kicad_import_bom(str(real_schematic), "CMF0010")
    bom = pn.pn_bom_for("CMF0010")
    assert bom["items"] == [{"pn": "CMG0010", "componentName": "2 PIN WP FEMALE connector", "qty": 2}]


@pytest.mark.skipif(not _kicad_cli_available(), reason="kicad-cli not installed on this machine")
def test_import_bom_ignores_symbols_with_no_gwt_pn_field(real_schematic, registry_with_component):
    # the unmodified template has zero GWT_PN fields anywhere - every
    # symbol (including the power symbols) must be silently skipped, not
    # raise, and the resulting BOM must be genuinely empty.
    real_schematic.write_text(open(TEMPLATE_SCH).read())

    result = kicad.kicad_import_bom(str(real_schematic), "CMF0010")
    assert result["itemCount"] == 0
    assert result["skipped"] == []

    bom = pn.pn_bom_for("CMF0010")
    assert bom["items"] == []


def test_import_bom_raises_for_missing_schematic_file(registry_with_component, tmp_path):
    from gwtcad.registry import RpcError

    with pytest.raises(RpcError):
        kicad.kicad_import_bom(str(tmp_path / "does_not_exist.kicad_sch"), "CMF0010")
