"""Unit tests for ``app.consumer._clean_str``.

``_clean_str`` is the only thing between a (trusted-ish) upstream event and the
``user_projection`` row we persist, so its contract is load-bearing:

  * non-``str`` input  -> ``""`` (never let a non-string reach the DB binding)
  * C0/C1 control chars stripped, EXCEPT tab / newline / carriage-return
  * DEL (0x7F) stripped
  * ordinary text + ordinary whitespace preserved
  * result truncated to ``max_len`` (default 255)

These are pure-logic checks: no Kafka / DB / Redis. ``app.consumer`` imports
``aiokafka`` and ``sqlalchemy`` at module top, which CI has (they're in
requirements.txt) but a bare local interpreter may not. We import the REAL
production helper and skip cleanly if that heavy chain is unavailable, so the
test never silently passes against a re-implemented copy.
"""
from __future__ import annotations

import pytest

clean_str = pytest.importorskip(
    "app.consumer",
    reason="task-svc runtime deps (aiokafka/sqlalchemy) not installed locally; "
    "CI installs requirements.txt and runs this.",
)._clean_str

# Import the module-level default bound too, so the truncation test tracks the
# production constant instead of hard-coding 255 in two places.
_MAX_STR = pytest.importorskip("app.consumer")._MAX_STR


class TestCleanStrTypeGuard:
    @pytest.mark.parametrize(
        "value",
        [
            None,
            123,
            1.5,
            True,  # bool is an int, definitely not a str
            ["a", "b"],
            {"x": 1},
            ("t",),
            b"bytes-are-not-str",
            object(),
        ],
    )
    def test_non_str_returns_empty(self, value):
        assert clean_str(value) == ""


class TestCleanStrControlChars:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            # Plain text is untouched.
            ("alice", "alice"),
            ("Alice Anderson", "Alice Anderson"),
            # Allowed whitespace survives.
            ("a\tb", "a\tb"),
            ("line1\nline2", "line1\nline2"),
            ("a\r\nb", "a\r\nb"),
            # C0 control chars (other than \t \n \r) are stripped.
            ("a\x00b", "ab"),  # NUL
            ("a\x07b", "ab"),  # BEL
            ("a\x08b", "ab"),  # BACKSPACE
            ("a\x1bb", "ab"),  # ESC
            ("a\x1fb", "ab"),  # unit separator (last C0)
            # DEL is explicitly stripped even though it is >= 0x20 boundary-adjacent.
            ("a\x7fb", "ab"),
            # C1 control chars (0x80-0x9F) are stripped.
            ("a\x80b", "ab"),
            ("a\x9fb", "ab"),
            # A printable above the C1 range (e.g. 0xA0+) is kept.
            ("café", "café"),
            ("emoji \U0001f600 ok", "emoji \U0001f600 ok"),
            # Mixed: only the control chars vanish.
            ("\x00clean\x07me\x7f", "cleanme"),
            # Space (0x20) is the first kept code point.
            ("a b", "a b"),
        ],
    )
    def test_strips_control_chars(self, raw, expected):
        assert clean_str(raw) == expected

    def test_empty_string_stays_empty(self):
        assert clean_str("") == ""

    def test_all_control_chars_collapse_to_empty(self):
        assert clean_str("\x00\x01\x02\x7f\x80") == ""


class TestCleanStrTruncation:
    def test_default_truncates_to_max(self):
        out = clean_str("x" * 1000)
        assert len(out) == _MAX_STR == 255

    def test_exact_length_is_untouched(self):
        s = "y" * _MAX_STR
        assert clean_str(s) == s

    def test_one_over_is_trimmed_by_one(self):
        s = "z" * (_MAX_STR + 1)
        assert clean_str(s) == "z" * _MAX_STR

    def test_custom_max_len_is_respected(self):
        assert clean_str("abcdef", max_len=3) == "abc"

    def test_truncation_happens_after_stripping(self):
        # 5 control chars + 4 real chars; with max_len=3 the controls must be
        # removed FIRST (otherwise we'd get an empty/short result), proving the
        # order is strip-then-truncate, not truncate-then-strip.
        raw = "\x00\x00\x00\x00\x00abcd"
        assert clean_str(raw, max_len=3) == "abc"

    @pytest.mark.parametrize(
        "raw, max_len, expected",
        [
            ("hello", 0, ""),
            ("hello", 1, "h"),
            ("hello", 5, "hello"),
            ("hello", 99, "hello"),
        ],
    )
    def test_table_of_lengths(self, raw, max_len, expected):
        assert clean_str(raw, max_len=max_len) == expected
