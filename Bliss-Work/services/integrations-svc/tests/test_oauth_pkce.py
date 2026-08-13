"""PKCE S256 derivation — validated against the RFC 7636 Appendix B test vector."""
from app.providers import oauth


def test_pkce_challenge_matches_rfc7636_vector():
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    assert oauth.pkce_challenge(verifier) == expected


def test_new_pkce_roundtrips():
    verifier, challenge = oauth.new_pkce()
    # base64url, no padding, and the challenge re-derives from the verifier.
    assert "=" not in verifier and "=" not in challenge
    assert oauth.pkce_challenge(verifier) == challenge


def test_authorize_url_has_pkce_and_state():
    cfg = oauth.OAuthConfig(
        name="gmail",
        authorize_endpoint="https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint="https://oauth2.googleapis.com/token",
        userinfo_endpoint="https://openidconnect.googleapis.com/v1/userinfo",
        scopes=["openid", "email"],
        client_id="cid",
        client_secret="secret",
        extra_authorize={"access_type": "offline", "prompt": "consent"},
    )
    url = oauth.authorize_url(cfg, "state123", "chal456", "https://x/ext/gmail/oauth/callback")
    assert "code_challenge=chal456" in url
    assert "code_challenge_method=S256" in url
    assert "state=state123" in url
    assert "access_type=offline" in url
    assert "response_type=code" in url
