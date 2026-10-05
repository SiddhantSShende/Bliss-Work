"""The web client's task-svc URLs, the edge's prefix handling and task-svc's real routes
must agree. Three separate layers build one URL, and when one of them drifts the symptom
is only a 404 in a user's console:

    client   VITE_TASK_BASE (…/api/tasks) + "/api/v1/tasks/…"      packages/shared/src/api/client.ts
    edge     handle_path /api/tasks/*  → strips "/api/tasks"        infra/caddy/Caddyfile{,.waf}
    service  the FastAPI route table                                app.routes (/api/v1 + router paths)

A deployed task-svc that is older than the client is a fourth way to get the same 404 and
cannot be caught from source; ``scripts/verify-edge-routes.sh`` probes a live edge for it.

Pure introspection: no DB, Kafka or Redis.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from app.main import app

REPO = Path(__file__).resolve().parents[3]
CLIENT_TS = REPO / "packages/shared/src/api/client.ts"
CADDYFILES = [REPO / "infra/caddy/Caddyfile", REPO / "infra/caddy/Caddyfile.waf"]
ENV_EXAMPLE = REPO / ".env.prod.example"


def _client_task_calls() -> list[tuple[str, str]]:
    """(METHOD, path) for every ApiClient call that targets task-svc, with `${…}` as {p}."""
    src = CLIENT_TS.read_text()
    calls: list[tuple[str, str]] = []
    for m in re.finditer(r"this\.cfg\.taskBase,", src):
        # Up to the end of the enclosing method: the next line that is just "  }".
        end = src.find("\n  }\n", m.end())
        window = src[m.end() : end if end != -1 else m.end() + 600]
        path = re.search(r"\s*[`\"]([^`\"]+)[`\"]", window)
        if not path or not path.group(1).startswith("/api/v1/"):
            continue
        method = re.search(r"method:\s*\"(\w+)\"", window)
        url = re.sub(r"\$\{[^}]*\}", "{p}", path.group(1))
        url = re.sub(r"\$\{[^}]*$", "", url).split("?")[0]  # an optional "${qs ? `?${qs}` : ''}" tail
        calls.append(((method.group(1) if method else "GET").upper(), url))
    # The paged list endpoints go through one helper that takes the path as an argument.
    for m in re.finditer(r"taskListAllPages\(\s*[`\"](/api/v1/[^`\"?]+)", src):
        calls.append(("GET", m.group(1)))
    return calls


# No lifespan (no `with`): nothing here needs a database. Every route authenticates before it
# touches one, so a request that REACHES a route answers 401, and one that does not answers 404.
_http = TestClient(app, raise_server_exceptions=False)


def _reaches_a_route(method: str, path: str) -> bool:
    return _http.request(method, path).status_code != 404


def _concrete(path: str) -> str:
    # `/assignees/me/{action}` is four literal routes, not a parameter.
    path = re.sub(r"/me/\{p\}$", "/me/acknowledge", path)
    return path.replace("{p}", str(uuid.uuid4()))


def test_the_client_actually_calls_task_svc_routes():
    # Guard the guard: if the parser stopped finding calls, every other test would pass vacuously.
    calls = _client_task_calls()
    assert len(calls) >= 18, calls
    assert ("POST", "/api/v1/tasks/{p}/reassign") in calls
    assert ("GET", "/api/v1/tasks/schedules") in calls


@pytest.mark.parametrize("method,path", sorted(set(_client_task_calls())))
def test_every_task_svc_url_the_client_builds_reaches_a_route(method: str, path: str):
    assert _reaches_a_route(method, _concrete(path)), f"client calls {method} {path} but task-svc has no such route"


def test_reassign_reaches_the_reassign_endpoint():
    assert _reaches_a_route("POST", f"/api/v1/tasks/{uuid.uuid4()}/reassign")
    assert "post" in app.openapi()["paths"]["/api/v1/tasks/{task_id}/reassign"]


def test_schedules_reaches_the_schedules_endpoint():
    assert _reaches_a_route("GET", "/api/v1/tasks/schedules")
    assert "get" in app.openapi()["paths"]["/api/v1/tasks/schedules"]


def test_schedules_is_not_shadowed_by_a_task_id_route():
    # "schedules" also satisfies a /tasks/{task_id} pattern, so the literal route has to be
    # registered first: the OpenAPI paths are in registration order, which is dispatch order.
    gets = [p for p, ops in app.openapi()["paths"].items() if "get" in ops]
    first = next(p for p in gets if re.fullmatch(re.sub(r"\{[^}]+\}", "[^/]+", p), "/api/v1/tasks/schedules"))
    assert first == "/api/v1/tasks/schedules", f"{first} would answer GET /api/v1/tasks/schedules"


@pytest.mark.parametrize("caddyfile", CADDYFILES, ids=lambda p: p.name)
def test_the_edge_strips_exactly_the_prefix_the_clients_base_url_carries(caddyfile: Path):
    # What the browser sends: VITE_TASK_BASE + client path, e.g.
    #   https://host/api/tasks + /api/v1/tasks/schedules
    base = re.search(r"^VITE_TASK_BASE=https?://[^/]+(/.*)$", ENV_EXAMPLE.read_text(), re.M)
    assert base, "VITE_TASK_BASE has no path prefix"
    prefix = base.group(1).rstrip("/")  # /api/tasks

    # handle_path strips its own prefix and proxies the REST to the named upstream.
    block = re.search(r"handle_path\s+(/api/tasks)/\*\s*\{(.*?)\n\t*\}\s*\n", caddyfile.read_text(), re.S)
    assert block, f"{caddyfile.name} has no handle_path /api/tasks/*"
    assert block.group(1) == prefix
    assert "upstream task-svc 8002" in block.group(2)

    for method, path in {("GET", "/api/v1/tasks/schedules"), ("POST", "/api/v1/tasks/{p}/reassign")}:
        sent = prefix + path  # what the console shows: /api/tasks/api/v1/tasks/…
        assert sent.startswith(prefix + "/api/v1/")  # the doubled "api" is intended
        arrives = sent[len(prefix):]  # what task-svc receives after the strip
        assert _reaches_a_route(method, _concrete(arrives)), f"{method} {sent} → {arrives}"
