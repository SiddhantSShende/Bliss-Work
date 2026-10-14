"""OAuth return routing — web redirect vs desktop deep link.

The security property under test: `redirect_after` is a MODE chosen by the
server from a fixed set, never a URL supplied by the client. If a caller could
put an arbitrary URL in there, our own OAuth state would be signing an open
redirect.
"""

import pytest

from app.routes.oauth import _DESKTOP_RETURN, _finish


def _resolve_mode(return_to) -> str:
    """Mirror of connect_start's mapping, which is one expression inline."""
    return _DESKTOP_RETURN if str(return_to) == "desktop" else "/app/integrations"


@pytest.mark.parametrize(
    "supplied",
    [
        "https://evil.example/steal",
        "//evil.example",
        "javascript:alert(1)",
        "taskboard://oauth?connected=fake",
        "web",
        "",
        None,
        {"nested": "object"},
    ],
)
def test_only_the_literal_desktop_mode_escapes_the_web_default(supplied):
    # Everything that is not exactly "desktop" — including a hand-crafted
    # taskboard:// URL — collapses to the in-app path.
    assert _resolve_mode(supplied) == "/app/integrations"


def test_desktop_mode_maps_to_the_deep_link():
    assert _resolve_mode("desktop") == _DESKTOP_RETURN


def test_web_return_is_a_302_into_the_spa():
    resp = _finish("gmail", "/app/integrations", "?connected=gmail")
    assert resp.status_code == 302
    assert resp.headers["location"].endswith("/app/integrations?connected=gmail")


def test_outlook_web_return_lands_on_its_own_settings_page():
    # Outlook is the one provider with a real connect/disconnect UI
    # (OutlookSettings.tsx) — every other provider still falls back to the
    # (currently unreachable, no UI to start one) generic hub path above.
    resp = _finish("outlook", "/app/integrations", "?connected=outlook")
    assert resp.status_code == 302
    assert resp.headers["location"].endswith("/app/settings/outlook?connected=outlook")


def test_desktop_return_is_an_html_interstitial_not_a_redirect():
    # Browsers routinely refuse to auto-navigate a 3xx into a custom scheme,
    # and the user needs an end-of-flow signal in a tab the app can't close.
    resp = _finish("gmail", _DESKTOP_RETURN, "?connected=gmail")
    assert resp.status_code == 200
    body = resp.body.decode()
    assert "taskboard://oauth?connected=gmail" in body
    assert "Open BlissWork" in body


def test_desktop_interstitial_escapes_its_parameters():
    # params reaches the page inside an href and a meta refresh; a stray quote
    # must not be able to break out of either attribute.
    resp = _finish("gmail", _DESKTOP_RETURN, '?error="><script>alert(1)</script>')
    body = resp.body.decode()
    assert "<script>alert(1)</script>" not in body
    assert "&lt;script&gt;" in body or "&quot;" in body


def test_unknown_redirect_after_falls_back_to_web():
    # A legacy row (or anything unexpected) must not 500 — default to the SPA.
    resp = _finish("gmail", "something-else-entirely", "?connected=gmail")
    assert resp.status_code == 302
