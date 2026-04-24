import pytest

from bwbk.proxy import _tabby_base_url, _tabby_headers, _tabby_url


def test_tabby_headers_empty_without_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_API_KEY", raising=False)

    assert _tabby_headers() == {}


def test_tabby_headers_forwards_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_API_KEY", "secret")

    assert _tabby_headers() == {"x-api-key": "secret"}


def test_tabby_base_url_defaults_from_completions_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_BASE_URL", raising=False)
    monkeypatch.setenv(
        "BWBK_TABBY_COMPLETIONS_URL",
        "http://127.0.0.1:5001/v1/completions",
    )

    assert _tabby_base_url() == "http://127.0.0.1:5001"
    assert _tabby_url("/v1/model") == "http://127.0.0.1:5001/v1/model"
    assert (
        _tabby_url("http://127.0.0.1:9999/custom/completions")
        == "http://127.0.0.1:9999/custom/completions"
    )


def test_tabby_base_url_env_takes_precedence(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_BASE_URL", "http://127.0.0.1:5002/")
    monkeypatch.setenv(
        "BWBK_TABBY_COMPLETIONS_URL",
        "http://127.0.0.1:5001/v1/completions",
    )

    assert _tabby_base_url() == "http://127.0.0.1:5002"
