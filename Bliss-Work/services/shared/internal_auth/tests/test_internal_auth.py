"""Unit tests for ``internal_auth``.

Pure-logic: no network, no FastAPI. The dangerous failure mode this pins is
"unconfigured secret accepts any caller" — an empty `expected` must never
compare equal to anything, including another empty string.
"""
from __future__ import annotations

from internal_auth import internal_token_matches


def test_matching_tokens_are_accepted() -> None:
    assert internal_token_matches("shh", "shh") is True


def test_mismatched_tokens_are_rejected() -> None:
    assert internal_token_matches("wrong", "shh") is False


def test_missing_provided_token_is_rejected() -> None:
    assert internal_token_matches(None, "shh") is False
    assert internal_token_matches("", "shh") is False


def test_unconfigured_expected_token_fails_closed() -> None:
    """An empty `expected` (service misconfiguration) must reject every
    caller — including one that also sends an empty string — never "accept
    anything"."""
    assert internal_token_matches("anything", "") is False
    assert internal_token_matches("", "") is False
    assert internal_token_matches(None, "") is False


def test_non_ascii_tokens_are_compared_without_raising() -> None:
    assert internal_token_matches("sëcret🔑", "sëcret🔑") is True
    assert internal_token_matches("sëcret🔑", "sëcret🔒") is False
