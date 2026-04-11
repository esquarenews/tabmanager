#!/usr/bin/env python3

import base64
import json
import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "manifest.json"
DEFAULT_KEY_PATH = ROOT / ".chrome-extension-dev-key.pem"


def derive_manifest_key(key_path: pathlib.Path) -> str:
    proc = subprocess.run(
        [
            "openssl",
            "rsa",
            "-in",
            str(key_path),
            "-pubout",
            "-outform",
            "DER",
        ],
        check=True,
        capture_output=True,
    )
    return base64.b64encode(proc.stdout).decode("ascii")


def main() -> int:
    key_path = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_KEY_PATH
    if not key_path.exists():
        print(f"Key file not found: {key_path}", file=sys.stderr)
        return 1

    manifest = json.loads(MANIFEST_PATH.read_text())
    manifest["key"] = derive_manifest_key(key_path)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Updated manifest key from {key_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
