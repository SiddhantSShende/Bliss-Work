"""WhatsApp (Meta) X-Hub-Signature-256 verification + inbound parsing."""
import hashlib
import hmac

from app.providers import whatsapp


def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_accepts_valid_signature():
    secret, body = "app-secret", b'{"object":"whatsapp_business_account"}'
    assert whatsapp.verify_signature(secret, body, _sign(secret, body)) is True


def test_rejects_tampered_body():
    secret = "app-secret"
    sig = _sign(secret, b'{"amount":1}')
    assert whatsapp.verify_signature(secret, b'{"amount":9999}', sig) is False


def test_rejects_wrong_secret():
    body = b"hello"
    assert whatsapp.verify_signature("attacker", body, _sign("real", body)) is False


def test_rejects_malformed():
    assert whatsapp.verify_signature("", b"x", "sha256=abc") is False
    assert whatsapp.verify_signature("s", b"x", "") is False
    assert whatsapp.verify_signature("s", b"x", "abc-no-prefix") is False


def test_parse_inbound_extracts_forward_flag():
    payload = {
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "metadata": {"phone_number_id": "PNID123"},
                            "messages": [
                                {
                                    "id": "wamid.AAA",
                                    "from": "15550001111",
                                    "type": "text",
                                    "text": {"body": "forwarded hello"},
                                    "context": {"forwarded": True, "frequently_forwarded": False, "id": "wamid.ORIG"},
                                }
                            ],
                        }
                    }
                ]
            }
        ]
    }
    assert whatsapp.phone_number_id_of(payload) == "PNID123"
    msgs = whatsapp.parse_inbound(payload)
    assert len(msgs) == 1
    assert msgs[0]["external_id"] == "wamid.AAA"
    assert msgs[0]["text"] == "forwarded hello"
    assert msgs[0]["forwarded"] is True
    assert msgs[0]["frequently_forwarded"] is False
