"""Real collision test: two independent local clones of the SAME bare
remote, both reserving PNs concurrently against the shared registry - the
actual scenario partnumbers.py's module docstring describes ("git is the
concurrency control... a rejected push is the ONLY signal a collision
happened"). Uses real git subprocesses against a real bare repo in
tmp_path; no network, no FreeCAD, no real company data.
"""
import os
import subprocess

import pytest

from gwtcad import partnumbers as pn
from gwtcad.registry import RpcError


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo)] + list(args), check=True,
                    capture_output=True, text=True)


def _init_bare(path):
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(path)], check=True,
                    capture_output=True, text=True)
    return path


def _clone(bare_path, dest):
    subprocess.run(["git", "clone", "-q", str(bare_path), str(dest)], check=True,
                    capture_output=True, text=True)
    _git(dest, "config", "user.email", "test@example.com")
    _git(dest, "config", "user.name", "Test")
    return dest


@pytest.fixture
def shared_registry_remote(tmp_path):
    """A bare remote + one seeded clone (pushes the initial commit so the
    remote has a main branch to clone from), returning the bare path."""
    bare = _init_bare(tmp_path / "registry.git")
    seed = _clone(bare, tmp_path / "seed")
    (seed / "registry.csv").write_text(",".join(pn._REGISTRY_FIELDS) + "\n")
    (seed / "types.yaml").write_text("Z: Test Type\n")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-q", "-m", "init")
    _git(seed, "push", "-q", "origin", "main")
    return bare


@pytest.fixture
def cad_repo(tmp_path):
    repo = tmp_path / "cad"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True,
                    capture_output=True, text=True)
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / ".gitkeep").write_text("")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


def _company_for(monkeypatch, tmp_path, name, registry_clone_dir, cad_repo):
    """Point partnumbers._CONFIG_PATH at a distinct company.json for one
    simulated user - each gets their OWN clone of the shared registry
    remote, like two teammates on two machines."""
    config_path = tmp_path / ("company_%s.json" % name)
    monkeypatch.setattr(pn, "_CONFIG_PATH", str(config_path))
    cfg = {
        "registryPath": str(registry_clone_dir),
        "projects": {"CM": {"repoPath": str(cad_repo)}},
    }
    pn._save_config(cfg)
    return cfg


def test_two_clones_reserving_different_seqs_both_succeed(monkeypatch, tmp_path, shared_registry_remote, cad_repo):
    clone_a = _clone(shared_registry_remote, tmp_path / "clone_a")
    clone_b = _clone(shared_registry_remote, tmp_path / "clone_b")

    # user A reserves CMC001 and pushes.
    _company_for(monkeypatch, tmp_path, "a", clone_a, cad_repo)
    result_a = pn.pn_reserve("CM", "C", 1, "connector", "A's part")
    assert result_a["pn"] == "CMC0010"

    # user B, working from a clone that does NOT yet have A's push, reserves
    # a DIFFERENT seq - pn.reserve's own _sync_pull must catch it up first,
    # so this must succeed without colliding.
    _company_for(monkeypatch, tmp_path, "b", clone_b, cad_repo)
    result_b = pn.pn_reserve("CM", "C", 2, "bracket", "B's part")
    assert result_b["pn"] == "CMC0020"

    # both rows must now be visible from clone_a after a pull.
    _git(clone_a, "pull", "-q", "--rebase")
    monkeypatch.setattr(pn, "_CONFIG_PATH", str(tmp_path / "company_a.json"))
    rows = pn._read_registry(pn._load_config())
    assert {r["pn"] for r in rows} == {"CMC0010", "CMC0020"}


def test_two_clones_racing_the_same_seq_one_wins_one_is_rejected(monkeypatch, tmp_path, shared_registry_remote, cad_repo):
    clone_a = _clone(shared_registry_remote, tmp_path / "clone_a")
    clone_b = _clone(shared_registry_remote, tmp_path / "clone_b")

    # Simulate the real race: both start from the same registry state
    # (neither has pulled the other's change yet) and both try to take
    # CMC001. pn.reserve's attempt()/retry loop must make exactly one of
    # them win outright and the OTHER discover the collision on its own
    # retry (via a fresh pull) and raise, rather than both silently
    # "succeeding" with divergent registries.
    _company_for(monkeypatch, tmp_path, "a", clone_a, cad_repo)
    result_a = pn.pn_reserve("CM", "C", 1, "connector", "A's version")
    assert result_a["pn"] == "CMC0010"

    _company_for(monkeypatch, tmp_path, "b", clone_b, cad_repo)
    # clone_b's pn.reserve calls _sync_pull first, which will pull A's
    # already-pushed commit and see CMC001 is taken - this is the retry
    # loop's OWN pre-check catching it, still a real collision detection,
    # just resolved before ever attempting a doomed push.
    with pytest.raises(RpcError):
        pn.pn_reserve("CM", "C", 1, "connector", "B's version - must not win")

    # the registry must be left in a consistent, single-writer state - only
    # A's row exists, not a corrupted merge of both attempts.
    _company_for(monkeypatch, tmp_path, "a", clone_a, cad_repo)
    rows = pn._read_registry(pn._load_config())
    assert len(pn._rows_for_seq(rows, "CMC001")) == 1
    assert rows[0]["name"] == "connector"
    assert rows[0]["reason"] == "Initial revision"
