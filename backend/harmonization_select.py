"""Pick the harmonization module once, from the HARMONIZATION environment variable.

    HARMONIZATION=v1   backend/harmonization.py   (default)
    HARMONIZATION=v2   backend/harmonization2.py
    HARMONIZATION=v3   backend/harmonization3.py
    HARMONIZATION=v4   backend/harmonization4.py   (set in backend/Dockerfile for the hosted API)

All four expose the same functions, so `service.py` and `firms.py` use `hz` without knowing the version.
"""
from __future__ import annotations

import importlib
import os

MODULES = {"v1": "harmonization", "v2": "harmonization2", "v3": "harmonization3", "v4": "harmonization4"}
VERSION = os.getenv("HARMONIZATION", "v1").strip().lower()
if VERSION not in MODULES:
    raise ValueError(f"HARMONIZATION must be one of {sorted(MODULES)}, got {VERSION!r}")
hz = importlib.import_module(f".{MODULES[VERSION]}", __package__)
