import pytest

from bwbk.proxy import _tabby_headers


def test_tabby_headers_empty_without_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_API_KEY", raising=False)

    assert _tabby_headers() == {}


def test_tabby_headers_forwards_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_API_KEY", "secret")

    assert _tabby_headers() == {"x-api-key": "secret"}
