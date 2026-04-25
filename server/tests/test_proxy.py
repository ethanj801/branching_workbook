import pytest

from bwbk.proxy import (
    DEFAULT_TABBY_STREAM_READ_TIMEOUT_SECONDS,
    _tabby_base_url,
    _tabby_headers,
    _tabby_stream_read_timeout_seconds,
    _tabby_stream_timeout,
    _tabby_url,
)


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


def test_tabby_stream_timeout_defaults_to_60s(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", raising=False)

    assert _tabby_stream_read_timeout_seconds() == DEFAULT_TABBY_STREAM_READ_TIMEOUT_SECONDS
    assert _tabby_stream_timeout().read == DEFAULT_TABBY_STREAM_READ_TIMEOUT_SECONDS


def test_tabby_stream_timeout_can_be_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", "2.5")

    assert _tabby_stream_read_timeout_seconds() == 2.5
    assert _tabby_stream_timeout().read == 2.5


def test_tabby_stream_timeout_rejects_invalid_values(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", "0")

    with pytest.raises(RuntimeError, match="greater than zero"):
        _tabby_stream_read_timeout_seconds()
