"""Unit tests for LazyKafkaProducer — no real Kafka broker involved.

AIOKafkaProducer itself is monkeypatched with a small fake that records how it
was constructed and whether start()/stop() were called, so these assert the
connect-on-first-use and discard-on-failure behavior without a broker.
"""
from __future__ import annotations

import pytest

import kafka_lazy_producer
from kafka_lazy_producer import LazyKafkaProducer


class _FakeProducer:
    instances: list["_FakeProducer"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.started = False
        self.stopped = False
        _FakeProducer.instances.append(self)

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


class _FailingStartProducer(_FakeProducer):
    async def start(self) -> None:
        raise ConnectionError("broker unreachable")


@pytest.fixture(autouse=True)
def _reset_instances():
    _FakeProducer.instances = []
    yield
    _FakeProducer.instances = []


async def test_ensure_connects_on_first_call(monkeypatch):
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FakeProducer)
    lazy = LazyKafkaProducer(bootstrap_servers="kafka:9092", security_kwargs={})
    producer = await lazy.ensure()
    assert producer.started is True
    assert len(_FakeProducer.instances) == 1


async def test_ensure_reuses_the_same_producer(monkeypatch):
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FakeProducer)
    lazy = LazyKafkaProducer(bootstrap_servers="kafka:9092", security_kwargs={})
    first = await lazy.ensure()
    second = await lazy.ensure()
    assert first is second
    assert len(_FakeProducer.instances) == 1  # only ever constructed once


async def test_failed_start_discards_the_producer_and_propagates(monkeypatch):
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FailingStartProducer)
    lazy = LazyKafkaProducer(bootstrap_servers="kafka:9092", security_kwargs={})
    with pytest.raises(ConnectionError):
        await lazy.ensure()
    # The failed producer was stopped (cleanup), not left dangling.
    assert _FakeProducer.instances[0].stopped is True


async def test_next_ensure_after_a_failure_builds_a_fresh_producer(monkeypatch):
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FailingStartProducer)
    lazy = LazyKafkaProducer(bootstrap_servers="kafka:9092", security_kwargs={})
    with pytest.raises(ConnectionError):
        await lazy.ensure()

    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FakeProducer)
    producer = await lazy.ensure()
    assert producer.started is True
    assert len(_FakeProducer.instances) == 2  # the failed one, then a fresh one


async def test_stop_before_any_ensure_is_a_noop(monkeypatch):
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FakeProducer)
    lazy = LazyKafkaProducer(bootstrap_servers="kafka:9092", security_kwargs={})
    await lazy.stop()  # must not raise
    assert _FakeProducer.instances == []


async def test_stop_after_connecting_stops_the_producer_and_clears_state(monkeypatch):
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FakeProducer)
    lazy = LazyKafkaProducer(bootstrap_servers="kafka:9092", security_kwargs={})
    producer = await lazy.ensure()
    await lazy.stop()
    assert producer.stopped is True

    # Reconnecting after stop() builds a fresh producer, not the stopped one.
    next_producer = await lazy.ensure()
    assert next_producer is not producer
    assert len(_FakeProducer.instances) == 2


async def test_security_kwargs_and_serializers_are_passed_through(monkeypatch):
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FakeProducer)
    value_ser = lambda v: str(v).encode()
    key_ser = lambda k: k.encode() if k else None
    lazy = LazyKafkaProducer(
        bootstrap_servers="kafka:9092",
        security_kwargs={"security_protocol": "SASL_SSL"},
        value_serializer=value_ser,
        key_serializer=key_ser,
    )
    producer = await lazy.ensure()
    assert producer.kwargs["bootstrap_servers"] == "kafka:9092"
    assert producer.kwargs["security_protocol"] == "SASL_SSL"
    assert producer.kwargs["enable_idempotence"] is True
    assert producer.kwargs["acks"] == "all"
    assert producer.kwargs["value_serializer"] is value_ser
    assert producer.kwargs["key_serializer"] is key_ser


async def test_serializers_are_omitted_when_not_provided(monkeypatch):
    # auth-svc's use case: pre-encoded bytes, no serializer functions at all.
    monkeypatch.setattr(kafka_lazy_producer, "AIOKafkaProducer", _FakeProducer)
    lazy = LazyKafkaProducer(bootstrap_servers="kafka:9092", security_kwargs={})
    producer = await lazy.ensure()
    assert "value_serializer" not in producer.kwargs
    assert "key_serializer" not in producer.kwargs
