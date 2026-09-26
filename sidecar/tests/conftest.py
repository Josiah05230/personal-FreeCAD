"""Shared fixtures for sidecar tests.

partnumbers.py has no FreeCAD import-time dependency (pure csv/os/yaml/
subprocess), so its tests run under plain pytest - no freecadcmd needed.
Every test gets an isolated registry repo + a fake company.json (via
monkeypatching partnumbers._CONFIG_PATH, never the real ~/.gwtcad/
company.json) so nothing here can touch real company data.
"""
import subprocess

import pytest

from gwtcad import partnumbers as pn


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo)] + list(args), check=True,
                    capture_output=True, text=True)


def _init_git_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "Test")
    return path


@pytest.fixture
def registry_repo(tmp_path):
    """A local git repo (no remote) holding registry.csv + types.yaml,
    matching the real pn-registry repo's shape."""
    repo = _init_git_repo(tmp_path / "registry")
    (repo / "registry.csv").write_text(
        ",".join(pn._REGISTRY_FIELDS) + "\n"
    )
    (repo / "types.yaml").write_text("Z: Test Type\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


@pytest.fixture
def cad_repo(tmp_path):
    """A local git repo (no remote) standing in for a project's CAD repo."""
    repo = _init_git_repo(tmp_path / "cad")
    (repo / ".gitkeep").write_text("")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


@pytest.fixture
def company_config(monkeypatch, tmp_path, registry_repo, cad_repo):
    """Points partnumbers._CONFIG_PATH at a throwaway company.json under
    tmp_path, with project CM mapped to cad_repo - never the real
    ~/.gwtcad/company.json. Returns the config dict for convenience."""
    config_path = tmp_path / "company.json"
    monkeypatch.setattr(pn, "_CONFIG_PATH", str(config_path))
    cfg = {
        "registryPath": str(registry_repo),
        "projects": {"CM": {"repoPath": str(cad_repo)}},
    }
    pn._save_config(cfg)
    return cfg
