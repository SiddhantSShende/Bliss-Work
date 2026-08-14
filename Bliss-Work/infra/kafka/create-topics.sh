#!/usr/bin/env bash
# One-shot Kafka topic creation (runs after the broker is healthy, then exits 0).
#
# PRODUCTION TOPIC SIZING
# -----------------------
# Dev/single-broker defaults to RF=1 and 12 partitions. For PRODUCTION you need a
# MULTI-broker cluster (3+ brokers) and should override via env:
#
#   REPLICATION_FACTOR=3   # tolerate 1 broker loss; never RF=1 in prod
#   TOPIC_PARTITIONS=12    # baseline; the high-fan-out notification topic gets
#                          # NOTIFICATION_PARTITIONS=200+ below (more partitions
#                          # = more consumer parallelism for the hot path)
#
# RF cannot exceed the number of live brokers, so RF>=3 REQUIRES >=3 brokers
# (managed MSK/Confluent/Redpanda, or the Helm chart's Kafka StatefulSet).
# Increasing partitions later is online; DECREASING them is not — size up front.
set -euo pipefail

BROKER="${KAFKA_BROKERS:-kafka:9092}"
PARTITIONS="${TOPIC_PARTITIONS:-12}"
# Replication factor: dev defaults to 1; set REPLICATION_FACTOR=3 in prod.
RF="${REPLICATION_FACTOR:-1}"
# The notification topic is the high-fan-out hot path — give it many more
# partitions in prod (200+). Defaults to the baseline partition count.
NOTIFICATION_PARTITIONS="${NOTIFICATION_PARTITIONS:-${PARTITIONS}}"

echo "Waiting for Kafka at ${BROKER}..."
for i in $(seq 1 60); do
  if /opt/kafka/bin/kafka-topics.sh --bootstrap-server "${BROKER}" --list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# min.insync.replicas — the half of durability that acks=all does not give you.
#
# Every producer in this system already sets acks=all (the two Go writers use
# kafka.RequireAll; the three Python pollers pass acks="all"). On its own that
# means "wait for all IN-SYNC replicas" — and if two of three replicas are down,
# the sole survivor is the entire ISR, so the write is acknowledged and then
# lost with that broker. min.insync.replicas=2 makes the broker REJECT the write
# instead, which the producers surface as a retryable error and the outbox
# retries. Refusing to accept data you cannot keep beats accepting it.
#
# Set to RF-1 (so 2 for RF=3): tolerates one broker down while still requiring a
# real quorum. Left at 1 for a single-broker dev cluster, where any higher value
# would make every produce fail.
MIN_ISR="${MIN_INSYNC_REPLICAS:-$(( RF > 1 ? RF - 1 : 1 ))}"

create() {
  local name="$1"
  # Optional 2nd arg overrides the partition count for this topic.
  local parts="${2:-${PARTITIONS}}"
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server "${BROKER}" \
    --create --if-not-exists \
    --topic "${name}" \
    --partitions "${parts}" \
    --replication-factor "${RF}" \
    --config "min.insync.replicas=${MIN_ISR}"
  echo "  topic ready: ${name} (partitions=${parts}, rf=${RF}, min.isr=${MIN_ISR})"
}

create "messaging.events.v1"
create "task.events.v1"
# External-integrations activity fanout (integrations-svc -> ws-gateway live hub).
create "integration.events.v1"
# Notification is the high-fan-out hot path — extra partitions in prod (200+).
create "notification.events.v1" "${NOTIFICATION_PARTITIONS}"
create "auth.events"
# Dead-letter topics for poison (unparseable / permanently-failing) messages.
# auto.create.topics.enable is false, so these MUST be created explicitly or the
# consumers' dead-letter producers fail and a poison message redelivers forever.
create "notification.events.v1.dlq"
create "email-worker-dlq"

echo "All topics created."
/opt/kafka/bin/kafka-topics.sh --bootstrap-server "${BROKER}" --list
