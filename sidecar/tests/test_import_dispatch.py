"""Universal Import-from-File classifier + ECAD placement. Plain pytest - no
FreeCAD needed (import_dispatch.py never imports it)."""
import os
import zipfile

import pytest

from gwtcad import import_dispatch as imp
from gwtcad.registry import RpcError

PCB = """(kicad_pcb (version 20240108)
  (footprint "Conn:USB_C" (at 10 10)
    (property "Reference" "J1")
    (model "${KIPRJMOD}/shapes/USB_C_Receptacle.step" (offset (xyz 0 0 0)))
  )
  (footprint "R_0603" (at 20 10)
    (model "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl")
  )
)
"""


def _zip(tmp_path, entries):
    z = tmp_path / "upload.zip"
    with zipfile.ZipFile(z, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return str(z)


@pytest.fixture
def staged():
    dirs = []
    yield dirs
    for d in dirs:
        imp.cleanup(d)


def test_step_referenced_by_a_footprint_is_classified_as_part_of_the_board(tmp_path, staged):
    z = _zip(tmp_path, {
        "proj/board.kicad_pcb": PCB,
        "proj/board.kicad_pro": "{}",
        "proj/shapes/USB_C_Receptacle.step": "ISO-10303-21;",
        "enclosure.step": "ISO-10303-21;",
        "proj/gerbers/board-F_Cu.gbr": "G04*",
    })
    r = imp.inspect(z)
    staged.append(r["extractDir"])
    roles = {f["relpath"]: f["role"] for f in r["files"]}
    assert roles["proj/shapes/USB_C_Receptacle.step"] == "footprint"
    assert roles["enclosure.step"] == "mechanical"
    assert roles["proj/board.kicad_pcb"] == "kicad"
    assert roles["proj/gerbers/board-F_Cu.gbr"] == "attachment"
    assert r["hasKicad"] is True
    assert r["sourceName"] == "upload"


def test_same_named_step_matches_a_wrl_model_reference(tmp_path, staged):
    # KiCad library footprints usually point at a .wrl; a vendor zip ships
    # the same-named .step - that's still the footprint's model.
    z = _zip(tmp_path, {"b.kicad_pcb": PCB, "R_0603_1608Metric.step": "x"})
    r = imp.inspect(z)
    staged.append(r["extractDir"])
    f = next(f for f in r["files"] if f["relpath"] == "R_0603_1608Metric.step")
    assert f["role"] == "footprint"


def test_step_only_zip_is_all_mechanical(tmp_path, staged):
    z = _zip(tmp_path, {"a.step": "x", "b.stl": "x", "readme.pdf": "x"})
    r = imp.inspect(z)
    staged.append(r["extractDir"])
    roles = {f["relpath"]: f["role"] for f in r["files"]}
    assert roles == {"a.step": "mechanical", "b.stl": "mechanical", "readme.pdf": "attachment"}
    assert r["hasKicad"] is False


def test_bare_step_file_is_staged_and_mechanical(tmp_path, staged):
    p = tmp_path / "bracket.step"
    p.write_text("x")
    r = imp.inspect(str(p))
    staged.append(r["extractDir"])
    assert r["files"] == [{"relpath": "bracket.step", "role": "mechanical", "matchedModel": None}]


def test_picking_one_kicad_file_brings_the_whole_project_folder(tmp_path, staged):
    proj = tmp_path / "proj"
    (proj / "shapes").mkdir(parents=True)
    (proj / "board.kicad_pcb").write_text(PCB)
    (proj / "board.kicad_sch").write_text("(kicad_sch)")
    (proj / "shapes" / "USB_C_Receptacle.step").write_text("x")
    (proj / "board-backups").mkdir()
    (proj / "board-backups" / "old.zip").write_text("x")
    r = imp.inspect(str(proj / "board.kicad_pcb"))
    staged.append(r["extractDir"])
    rels = {f["relpath"] for f in r["files"]}
    assert {"board.kicad_pcb", "board.kicad_sch", os.path.join("shapes", "USB_C_Receptacle.step")} <= rels
    assert not any("backups" in x for x in rels)


def test_zip_slip_is_refused_and_leaves_no_staging_dir(tmp_path):
    z = _zip(tmp_path, {"../../evil.txt": "x"})
    before = {d for d in os.listdir(imp.tempfile.gettempdir()) if d.startswith(imp._TMP_PREFIX)}
    with pytest.raises(RpcError):
        imp.inspect(z)
    after = {d for d in os.listdir(imp.tempfile.gettempdir()) if d.startswith(imp._TMP_PREFIX)}
    assert after == before


def test_place_ecad_keeps_layout_relative_to_the_board_folder(tmp_path, staged):
    z = _zip(tmp_path, {
        "proj/board.kicad_pcb": PCB,
        "proj/board.kicad_sch": "(kicad_sch)",
        "proj/shapes/USB_C_Receptacle.step": "x",
        "enclosure.step": "x",
    })
    r = imp.inspect(z)
    staged.append(r["extractDir"])
    ecad = [f["relpath"] for f in r["files"] if f["role"] != "mechanical"]
    dest = tmp_path / "ecad" / "CM" / "F" / "CMF0010"
    out = imp.place_ecad(r["extractDir"], ecad, str(dest))
    # ${KIPRJMOD}/shapes/... must still resolve next to the moved board
    assert (dest / "shapes" / "USB_C_Receptacle.step").is_file()
    assert out["pcbPath"] == str(dest / "board.kicad_pcb")
    assert out["schPath"] == str(dest / "board.kicad_sch")
    assert not (dest / "enclosure.step").exists()


def test_place_ecad_never_overwrites(tmp_path, staged):
    z = _zip(tmp_path, {"board.kicad_pcb": PCB})
    r = imp.inspect(z)
    staged.append(r["extractDir"])
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "board.kicad_pcb").write_text("ORIGINAL")
    out = imp.place_ecad(r["extractDir"], ["board.kicad_pcb"], str(dest))
    assert (dest / "board.kicad_pcb").read_text() == "ORIGINAL"
    assert out["skipped"] == [str(dest / "board.kicad_pcb")]


def test_place_and_cleanup_refuse_arbitrary_dirs(tmp_path):
    with pytest.raises(RpcError):
        imp.place_ecad(str(tmp_path), ["x"], str(tmp_path / "d"))
    victim = tmp_path / "keep"
    victim.mkdir()
    assert imp.cleanup(str(victim)) == {"ok": False}
    assert victim.exists()
