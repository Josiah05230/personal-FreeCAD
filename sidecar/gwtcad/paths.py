"""Where per-user GWT-CAD state lives (company.json, templates, materials,
recovery copies, the Firebase key). ~/.gwtcad normally; GWTCAD_CONFIG_DIR
overrides it - the e2e harness sets that so test runs never read or write
the real user's config (they used to, and silently repointed a real
company.json at /tmp test repos)."""
import os


def config_dir():
    return os.environ.get("GWTCAD_CONFIG_DIR") or os.path.expanduser("~/.gwtcad")


def config_path(name):
    return os.path.join(config_dir(), name)
