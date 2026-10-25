#!/usr/bin/env python3
"""Manage the separately approved Homey 13.5.3 Lennox thermostat Off-temperature display workaround.

Uses the existing tested deployment guards. Rollback retains all prior activity, motion, and dial-control patches.
No service restart or thermostat setting change is performed.
"""
import hashlib
import importlib.util
from pathlib import Path
import sys

GUARDS_SHA256 = "677f7c8e9d3c528273ab1b40aa3b1d9f095f30a95021510210c1d150bf03d10d"
ORIGINAL_SHA256 = "36b6457bdb22bb9629e9395333db98964ec590160cebf5e61c4c34c459684640"
PATCHED_SHA256 = "c9677f4eb4923de3963459b3d23f95cfb987c98c78678c468da2cdb37d29e47d"


def load_guards():
    source = Path(__file__).with_name("manage-homey-web-icons.py")
    if hashlib.sha256(source.read_bytes()).hexdigest() != GUARDS_SHA256:
        raise RuntimeError("The reviewed deployment guards changed; review before use")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("homey_web_patch_guards", source)
    guards = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guards)
    guards.__doc__ = __doc__
    guards.ORIGINAL_SHA = ORIGINAL_SHA256
    guards.PATCHED_SHA = PATCHED_SHA256
    guards.PATCH_DIR = Path("/opt/docker/homey/local-patches/thermostat-off-temperature-13.5.3")
    guards.BACKUP = guards.PATCH_DIR / "index-LWSkNFnB.js.original"
    guards.METADATA = guards.PATCH_DIR / "metadata.json"
    return guards


if __name__ == "__main__":
    try:
        load_guards().main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
