"""mcmaster_models: which registry parts still need a McMaster model, and
how a fetched STEP is handed to the supplier-model sync. Storage is stubbed;
the registry and CAD repo are the conftest throwaway git repos."""
import io
import json
import os
import zipfile

import pytest

pytest.importorskip("FreeCAD")

from gwtcad import mcmaster_models as mm
from gwtcad import partnumbers as pn


@pytest.fixture
def storage(monkeypatch):
    state = {"objects": [], "uploads": {}}
    monkeypatch.setattr(mm._storage, "list_objects", lambda prefix: list(state["objects"]))
    monkeypatch.setattr(mm._storage, "upload_bytes",
                        lambda path, data, ctype: state["uploads"].__setitem__(path, data))
    return state


def test_list_missing_picks_mcmaster_parts_without_a_model(company_config, cad_repo, storage):
    pn.pn_reserve("CM", "B", 7, "screw", "No. 4 x 1/4 screw", mfg="McMaster-Carr", mfgPn="95893A707")
    pn.pn_reserve("CM", "B", 8, "screw", "No. 4 x 1/2 screw", mfg="McMaster", mfgPn="95893A334")
    pn.pn_reserve("CM", "B", 9, "screw", "has a model already", mfg="McMaster-Carr", mfgPn="95893A623")
    pn.pn_reserve("CM", "B", 10, "screw", "zip already waiting", mfg="McMaster-Carr", mfgPn="95893A624")
    pn.pn_reserve("CM", "G", 1, "resistor", "not McMaster", mfg="DigiKey", mfgPn="RC0603")
    pn.pn_reserve("CM", "B", 11, "screw", "no mfg pn", mfg="McMaster-Carr", mfgPn="")
    folder = os.path.join(str(cad_repo), "CM", "B")
    os.makedirs(folder)
    open(os.path.join(folder, "CMB0090.stp"), "w").write("ISO-10303-21;")
    storage["objects"] = ["cad-exports/CMB0100/CMB0100_supplier_model.zip"]

    got = {p["pn"]: p["mfgPn"] for p in mm.list_missing()}
    assert got == {"CMB0070": "95893A707", "CMB0080": "95893A334"}


def test_list_missing_is_empty_when_storage_is_unreachable(company_config, monkeypatch):
    pn.pn_reserve("CM", "B", 7, "screw", "x", mfg="McMaster-Carr", mfgPn="95893A707")

    def boom(prefix):
        raise mm.RpcError(mm.APP_ERROR, "no key")
    monkeypatch.setattr(mm._storage, "list_objects", boom)
    assert mm.list_missing() == []


def test_upload_step_drops_zip_and_meta_where_sync_looks(tmp_path, storage):
    step = tmp_path / "95893A707.step"
    step.write_bytes(b"ISO-10303-21;\nHEADER;\nEND-ISO-10303-21;\n")
    assert mm.upload_step("CMB0070", str(step), "95893A707", "No. 4 screw")["pn"] == "CMB0070"

    ups = storage["uploads"]
    meta = json.loads(ups["cad-exports/CMB0070/CMB0070_supplier_meta.json"])
    assert meta == {"supplier": "mcmaster-carr", "supplierPn": "95893A707", "description": "No. 4 screw"}
    with zipfile.ZipFile(io.BytesIO(ups["cad-exports/CMB0070/CMB0070_supplier_model.zip"])) as zf:
        assert zf.read("CMB0070.stp").startswith(b"ISO-10303-21")
    # the sync's own extractor accepts it
    assert mm._supplier_models._extract_stp_from_zip(ups["cad-exports/CMB0070/CMB0070_supplier_model.zip"]).startswith(b"ISO")


def test_upload_step_rejects_non_step(tmp_path, storage):
    bad = tmp_path / "x.step"
    bad.write_bytes(b"<html>blocked</html>")
    with pytest.raises(mm.RpcError):
        mm.upload_step("CMB0070", str(bad), "95893A707")
    assert storage["uploads"] == {}
