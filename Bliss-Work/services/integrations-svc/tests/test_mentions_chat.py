"""Teams mention extraction, and the cross-provider dispatch rules."""

from app.mentions import MentionScan, detect_mentions

AAD = "8f1e0000-0000-0000-0000-00000000aaaa"
AAD2 = "8f1e0000-0000-0000-0000-00000000bbbb"


# ── Teams ─────────────────────────────────────────────────────────────────────
def teams_msg(mentions=(), **over):
    msg = {
        "messageType": "message",
        "id": "msg1",
        "chatId": "chat1",
        "from": {"user": {"id": "sender"}},
        "mentions": list(mentions),
        "webUrl": "https://teams.microsoft.com/l/message/1",
    }
    msg.update(over)
    return msg


def user_mention(oid):
    return {"mentioned": {"user": {"id": oid, "displayName": "X"}}}


def tscan(msg):
    return detect_mentions("teams", msg)


def test_teams_user_mention_is_extracted():
    assert tscan(teams_msg([user_mention(AAD)])).handles == (AAD,)


def test_teams_multiple_mentions_dedupe_in_order():
    msg = teams_msg([user_mention(AAD), user_mention(AAD2), user_mention(AAD)])
    assert tscan(msg).handles == (AAD, AAD2)


def test_teams_channel_mention_is_not_personal():
    # @team / @channel — a broadcast, same exclusion as Slack's <!channel>.
    msg = teams_msg([{"mentioned": {"conversation": {"id": "chat1"}}}])
    assert tscan(msg).handles == ()


def test_teams_mixed_broadcast_and_user_keeps_only_the_user():
    msg = teams_msg([{"mentioned": {"conversation": {"id": "c"}}}, user_mention(AAD)])
    assert tscan(msg).handles == (AAD,)


def test_teams_bot_posts_are_ignored():
    msg = teams_msg([user_mention(AAD)], **{"from": {"application": {"id": "bot"}}})
    assert tscan(msg).handles == ()


def test_teams_non_message_types_are_ignored():
    for kind in ("systemEventMessage", "typing", "unknownFutureValue"):
        assert tscan(teams_msg([user_mention(AAD)], messageType=kind)).handles == (), kind


def test_teams_no_mentions_is_not_a_mention():
    assert tscan(teams_msg()).handles == ()


def test_teams_malformed_mention_entries_are_safe():
    for bad in ([{}], [{"mentioned": {}}], [{"mentioned": {"user": {}}}], [None]):
        assert tscan(teams_msg(bad)).handles == (), bad


def test_teams_thread_ref_and_permalink():
    s = tscan(teams_msg([user_mention(AAD)]))
    assert s.thread_ref == "chat1/msg1"
    assert s.permalink == "https://teams.microsoft.com/l/message/1"


# ── dispatch ──────────────────────────────────────────────────────────────────
def test_unknown_provider_yields_empty_scan_rather_than_raising():
    # A provider can start recording activity before its parser exists.
    assert detect_mentions("signal", {"text": "<@U1>"}) == MentionScan()


def test_removed_whatsapp_provider_is_inert_not_special_cased():
    # WhatsApp's scanner was deleted with the rest of that integration. Any row
    # still in the DB from before must fall through the same empty-scan path as
    # any unknown provider — never raise, and never resurrect a mention.
    msg = {"external_id": "wamid.X", "from": "15551234567", "text": "hello"}
    assert detect_mentions("whatsapp", msg) == MentionScan()
    assert detect_mentions("whatsapp", msg, owner_handle="15559999999") == MentionScan()


def test_scan_is_immutable():
    # Callers pass these around; accidental mutation would be a silent bug.
    import dataclasses

    import pytest

    s = detect_mentions("slack", {"type": "message", "text": "<@U0123ABCD>"})
    with pytest.raises(dataclasses.FrozenInstanceError):
        s.handles = ()  # type: ignore[misc]
