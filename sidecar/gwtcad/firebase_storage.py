"""Direct writes to the GrainWavePartners Firebase Storage bucket, as a
trusted first-party service account - not through the portal's `onCall`
functions (those need a real signed-in Firebase Auth admin session, which
is awkward to obtain from a desktop app; see uploadCadExport's own comment
in GrainWavePartners/functions/index.js for why this side exists instead).

Auth is a downloaded GCP/Firebase service-account JSON key, read from a
fixed local path - same "the user places one file once, nothing is bundled
or hardcoded" convention partnumbers.py's company.json already
establishes. Only `google-auth` is used (to sign the service-account JWT
and exchange it for a short-lived OAuth2 access token) plus the `requests`
library already bundled in FreeCAD's Python - deliberately not
`google-cloud-storage`, which pulls in a much heavier `grpc` dependency
for what is otherwise three plain HTTP PUTs.
"""
import json
import os

import requests

from .registry import RpcError, APP_ERROR

_KEY_PATH = os.path.expanduser("~/.gwtcad/firebase-service-account.json")

_BUCKET = "grainwavepartners.firebasestorage.app"

_SCOPES = ["https://www.googleapis.com/auth/devstorage.read_write"]

_credentials = None  # lazily built, then reused (module-level cache: each
                      # access token is valid ~1hr and google-auth refreshes
                      # it internally, so there's no need to rebuild this
                      # per call).


def _get_credentials():
    global _credentials
    if _credentials is not None:
        return _credentials
    if not os.path.isfile(_KEY_PATH):
        raise RpcError(
            APP_ERROR,
            "no Firebase service-account key at %s - download one from the "
            "GrainWavePartners Firebase project (IAM & Admin > Service "
            "Accounts > generate key), scoped to Storage Object Admin on "
            "the %s bucket, and save it at that exact path." % (_KEY_PATH, _BUCKET)
        )
    from google.oauth2 import service_account
    try:
        with open(_KEY_PATH) as f:
            info = json.load(f)
        _credentials = service_account.Credentials.from_service_account_info(
            info, scopes=_SCOPES
        )
    except RpcError:
        raise
    except Exception as e:
        raise RpcError(APP_ERROR, "invalid Firebase service-account key at %s: %s" % (_KEY_PATH, e))
    return _credentials


def _access_token():
    from google.auth.transport.requests import Request
    from google.auth.exceptions import RefreshError
    creds = _get_credentials()
    try:
        creds.refresh(Request())
    except RefreshError as e:
        raise RpcError(
            APP_ERROR,
            "Firebase service-account key at %s was rejected by Google (%s) - "
            "check the key hasn't been revoked/deleted in GCP IAM, and that it's "
            "scoped to Storage Object Admin on the %s bucket." % (_KEY_PATH, e, _BUCKET)
        )
    return creds.token


def upload_bytes(storage_path, data, content_type):
    """Upload `data` (bytes) to the GrainWavePartners bucket at
    `storage_path` (e.g. "cad-exports/PSA0011/PSA0011.step"), via the plain
    Storage JSON API's simple-upload endpoint - no google-cloud-storage
    client needed for a one-shot PUT this small (STEP/PDF/meta.json files,
    not multi-GB uploads that would need the resumable protocol)."""
    token = _access_token()
    url = "https://storage.googleapis.com/upload/storage/v1/b/%s/o" % _BUCKET
    resp = requests.post(
        url,
        params={"uploadType": "media", "name": storage_path},
        headers={
            "Authorization": "Bearer %s" % token,
            "Content-Type": content_type,
        },
        data=data,
        timeout=60,
    )
    if resp.status_code >= 300:
        raise RpcError(
            APP_ERROR,
            "Firebase Storage upload failed for %s: %s %s" % (
                storage_path, resp.status_code, resp.text[:500]
            )
        )
    return {"storagePath": storage_path}


def upload_file(local_path, storage_path, content_type):
    with open(local_path, "rb") as f:
        return upload_bytes(storage_path, f.read(), content_type)
