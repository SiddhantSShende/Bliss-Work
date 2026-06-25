"""Pure-logic tests for ``app.mailer.is_valid_email``.

``is_valid_email`` is the cheap pre-flight guard that keeps obviously-undeliverable
recipients (empty, missing ``@``, no domain dot, embedded whitespace) from being
handed to SMTP -- an invalid recipient would otherwise be rejected by the server
and retried forever. We assert the accept/reject contract directly; the regex is
intentionally permissive (not full RFC 5322), so the cases below pin the *common
garbage* boundary the code documents, not every RFC corner.

No network/SMTP needed: ``conftest.py`` stubs the absent ``aiosmtplib`` import so
the real ``is_valid_email`` regex is exercised unchanged.
"""
from __future__ import annotations

import pytest

from app.mailer import is_valid_email


@pytest.mark.parametrize(
    "address",
    [
        "user@example.com",
        "u@d.co",
        "first.last@sub.domain.org",
        "a+tag@example.io",
        "name_123@host.co.uk",
        "  trimmed@example.com  ",  # is_valid_email strips before matching
    ],
)
def test_accepts_valid_addresses(address: str) -> None:
    assert is_valid_email(address) is True


@pytest.mark.parametrize(
    "address",
    [
        "not-an-email",   # no @ at all
        "@d",             # no local part, no domain dot
        "u@",             # no domain
        "",               # empty
        "   ",            # whitespace only
        "no-at-symbol.com",
        "two@@at.com",    # second @ matched by [^@\s] -> rejected
        "user@host",      # missing the required domain dot
        "user @host.com", # embedded space in local part
        "user@ho st.com", # embedded space in domain
        "user@.com",      # the documented "no domain dot" garbage shape's sibling
    ],
)
def test_rejects_invalid_addresses(address: str) -> None:
    assert is_valid_email(address) is False


def test_returns_plain_bool_not_match_object() -> None:
    # Callers rely on a real ``bool`` (e.g. ``if not is_valid_email(...)``); make
    # sure we never leak a truthy re.Match / None through the contract.
    assert is_valid_email("user@example.com") is True
    assert is_valid_email("nope") is False
