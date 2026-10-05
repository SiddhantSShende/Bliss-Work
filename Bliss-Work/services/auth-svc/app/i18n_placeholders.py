"""Keeps interpolation placeholders, markup and URLs out of Google's hands.

The English catalogs are full of i18next `{{count}}` / `{{name}}` variables and
`<bold>…</bold>` Trans tags. Sent as plain text, Google is free to translate
`{{name}}` into `{{nombre}}` — which i18next then renders literally, or drops
the value of. So each such token is wrapped in `<span translate="no">` and the
request is sent as `format=html` (Google's documented way to say "leave this
alone"); the wrappers are stripped from the answer.

Belt and braces: after un-wrapping, the translation must contain exactly the
same multiset of protected tokens as its source. If it does not (Google
reordered into something a regex cannot recognise, dropped a variable, …) the
string is reported as NOT translated and the caller keeps the English text.
A visible English string is always better than a broken placeholder.
"""
from __future__ import annotations

import html
import re
from collections import Counter

# Order matters only for alternation priority; none of these overlap in
# practice. Covers: i18next `{{x}}` / `{{- x}}` / `{{x, number}}`, i18next
# nesting `$t(ns:key)`, Trans tags `<bold>` `</bold>` `<0>`, printf `%s` `%d`
# `%1$s`, single-brace `{count}`, and bare URLs.
_PROTECTED = re.compile(
    r"""
      \{\{[^{}]*\}\}
    | \$t\([^()]*\)
    | </?[A-Za-z0-9]+(?:\s[^<>]*)?/?>
    | %(?:\d+\$)?[-+\ 0\#]*\d*(?:\.\d+)?[sdif]
    | \{[A-Za-z0-9_]+\}
    | https?://[\w\-./?=&%\#:@+~]+
    """,
    re.VERBOSE,
)
_NO_TRANSLATE_SPAN = re.compile(r"<span\s+translate=[\"']no[\"']\s*>(.*?)</span\s*>", re.IGNORECASE | re.DOTALL)


def protect(text: str) -> str:
    """HTML-safe form of `text` with every protected token wrapped so Google
    leaves it untouched. Pair with `restore`."""
    out: list[str] = []
    last = 0
    for m in _PROTECTED.finditer(text):
        out.append(html.escape(text[last : m.start()], quote=False))
        out.append(f'<span translate="no">{html.escape(m.group(0), quote=False)}</span>')
        last = m.end()
    out.append(html.escape(text[last:], quote=False))
    return "".join(out)


def restore(translated_html: str, source: str) -> str | None:
    """Plain text from Google's HTML answer, or None when the answer does not
    carry exactly the placeholders `source` had."""
    plain = html.unescape(_NO_TRANSLATE_SPAN.sub(lambda m: m.group(1), translated_html))
    if Counter(_PROTECTED.findall(plain)) != Counter(_PROTECTED.findall(source)):
        return None
    return plain
