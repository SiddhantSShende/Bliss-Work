"""Slack mention extraction — the noise cases are the point.

A false positive here puts a bot's deploy notification into someone's task list;
a false negative loses a real request for help. Both are worth a test.
"""

from app.mentions import detect_mentions

U1 = "U0123ABCD"
U2 = "UZZZZ9999"


def slack_event(**over):
    base = {"type": "message", "text": "", "channel": "C0001", "ts": "1712.0001"}
    base.update(over)
    return base


def scan(**over):
    return detect_mentions("slack", slack_event(**over))


# ── positive cases ────────────────────────────────────────────────────────────
def test_plain_mention_is_extracted():
    assert scan(text=f"hey <@{U1}> can you look?").handles == (U1,)


def test_pipe_form_with_display_name_is_extracted():
    # Slack sometimes renders <@U0123ABCD|alice>.
    assert scan(text=f"<@{U1}|alice> ping").handles == (U1,)


def test_enterprise_grid_w_prefix_is_extracted():
    assert scan(text="<@W12345678> hi").handles == ("W12345678",)


def test_multiple_mentions_keep_order_and_dedupe():
    text = f"<@{U1}> and <@{U2}> and <@{U1}> again"
    assert scan(text=text).handles == (U1, U2)


def test_mention_anywhere_in_text_counts():
    assert scan(text=f"please ask <@{U1}> about it").handles == (U1,)


# ── noise: must NOT be mentions ───────────────────────────────────────────────
def test_no_mention_markup_is_not_a_mention():
    assert scan(text="deploy finished successfully").handles == ()


def test_empty_and_missing_text_are_safe():
    assert scan(text="").handles == ()
    ev = slack_event()
    ev.pop("text")
    assert detect_mentions("slack", ev).handles == ()


def test_bot_posts_are_ignored_even_when_they_mention_you():
    assert scan(text=f"<@{U1}> build failed", bot_id="B123").handles == ()


def test_bot_message_subtype_is_ignored():
    assert scan(text=f"<@{U1}>", subtype="bot_message").handles == ()


def test_membership_churn_is_ignored():
    for subtype in ("channel_join", "channel_leave", "group_join", "group_leave"):
        assert scan(text=f"<@{U1}> joined", subtype=subtype).handles == (), subtype


def test_edits_and_deletes_are_ignored():
    # Otherwise editing an old message re-notifies everyone it named.
    for subtype in ("message_changed", "message_deleted"):
        assert scan(text=f"<@{U1}>", subtype=subtype).handles == (), subtype


def test_non_message_events_are_ignored():
    assert scan(text=f"<@{U1}>", type="reaction_added").handles == ()


def test_broadcasts_are_not_personal_mentions():
    # <!here>/<!channel>/<!everyone> are room pings, not "someone asked for me".
    for token in ("<!here>", "<!channel>", "<!everyone>"):
        assert scan(text=f"{token} standup now").handles == (), token


def test_broadcast_alongside_a_real_mention_keeps_only_the_user():
    assert scan(text=f"<!channel> and <@{U1}>").handles == (U1,)


def test_malformed_markup_is_not_a_mention():
    for text in ("<@>", "<@123>", "@U0123ABCD", "<#C0123|general>"):
        assert scan(text=text).handles == (), text


# ── thread_ref ────────────────────────────────────────────────────────────────
def test_thread_ref_prefers_thread_ts_so_replies_group_with_their_root():
    s = scan(text=f"<@{U1}>", ts="1712.9999", thread_ts="1712.0001")
    assert s.thread_ref == "C0001/1712.0001"


def test_thread_ref_falls_back_to_ts_for_top_level_messages():
    assert scan(text=f"<@{U1}>", ts="1712.5555").thread_ref == "C0001/1712.5555"


def test_permalink_is_absent_events_api_does_not_supply_one():
    assert scan(text=f"<@{U1}>").permalink is None
