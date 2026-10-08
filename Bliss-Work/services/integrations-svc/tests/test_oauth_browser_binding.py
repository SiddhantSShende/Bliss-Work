from app.providers import oauth


def test_oauth_state_browser_binding_rejects_another_session():
    session_a = "session-a-secret"
    session_b = "session-b-secret"
    session_hash = oauth.browser_session_hash(session_a)

    assert oauth.browser_session_matches(session_hash, session_a)
    assert not oauth.browser_session_matches(session_hash, session_b)
    assert not oauth.browser_session_matches(None, session_a)
    assert oauth.browser_session_cookie_name("state-a") != oauth.browser_session_cookie_name(
        "state-b"
    )
