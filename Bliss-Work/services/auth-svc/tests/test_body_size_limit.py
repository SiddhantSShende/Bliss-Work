from __future__ import annotations

import pytest

from app.middleware import BodySizeLimitMiddleware


async def _run_middleware(body_chunks, *, headers=(), limit=8):
    received = iter(
        {"type": "http.request", "body": body, "more_body": index < len(body_chunks) - 1}
        for index, body in enumerate(body_chunks)
    )
    sent = []
    app_called = False

    async def receive():
        return next(received)

    async def send(message):
        sent.append(message)

    async def app(scope, request_receive, response_send):
        nonlocal app_called
        app_called = True
        chunks = []
        while True:
            message = await request_receive()
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        await response_send(
            {"type": "http.response.start", "status": 200, "headers": []}
        )
        await response_send(
            {"type": "http.response.body", "body": b"".join(chunks)}
        )

    scope = {"type": "http", "headers": list(headers)}
    await BodySizeLimitMiddleware(app, max_bytes=limit)(scope, receive, send)
    return sent, app_called


@pytest.mark.asyncio
async def test_rejects_chunked_body_over_limit() -> None:
    sent, app_called = await _run_middleware([b"1234", b"56789"])
    assert not app_called
    assert sent[0]["status"] == 413


@pytest.mark.asyncio
async def test_allows_chunked_body_at_limit_and_replays_it() -> None:
    sent, app_called = await _run_middleware([b"1234", b"5678"])
    assert app_called
    assert sent[0]["status"] == 200
    assert sent[1]["body"] == b"12345678"


@pytest.mark.asyncio
async def test_rejects_oversized_content_length_before_reading_body() -> None:
    sent, app_called = await _run_middleware(
        [b"123456789"],
        headers=((b"content-length", b"9"),),
    )
    assert not app_called
    assert sent[0]["status"] == 413
