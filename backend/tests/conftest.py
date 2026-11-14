"""Shared test setup: no test reads or writes the real burned-area cache in data/cache/burned_area."""
from __future__ import annotations

import pytest

from backend import burned_area


@pytest.fixture(autouse=True)
def isolated_burned_area_cache(tmp_path_factory, monkeypatch):
    monkeypatch.setattr(burned_area, "CACHE_DIR", tmp_path_factory.mktemp("burned_area"))
