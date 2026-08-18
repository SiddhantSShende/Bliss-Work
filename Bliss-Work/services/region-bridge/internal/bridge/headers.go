package bridge

import (
	"strings"

	"github.com/nats-io/nats.go"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/region-bridge/internal/loop"
)

// Header plumbing shared by both directions.
//
// The two transports disagree about header keys: NATS canonicalizes them the
// way Go's textproto does, Kafka treats them as raw case-sensitive bytes. Every
// read here is therefore case-insensitive and every write uses the canonical
// spelling, so an event survives a round trip through either one without the
// provenance silently going missing — which, on the import side, is the
// difference between a rejected event and a replication loop.

// headerValue reads a Kafka header by name, case-insensitively.
func headerValue(hdrs []kafka.Header, name string) string {
	for _, h := range hdrs {
		if strings.EqualFold(h.Key, name) {
			return string(h.Value)
		}
	}
	return ""
}

// provenanceOf reads where a Kafka record came from and how far it has come.
func provenanceOf(hdrs []kafka.Header) loop.Provenance {
	return loop.Provenance{
		Origin: headerValue(hdrs, loop.HeaderOriginRegion),
		Hops:   loop.ParseHops(headerValue(hdrs, loop.HeaderHops)),
	}
}

// natsProvenanceOf reads the same two facts off a NATS message.
func natsProvenanceOf(h nats.Header) loop.Provenance {
	return loop.Provenance{
		Origin: h.Get(loop.HeaderOriginRegion),
		Hops:   loop.ParseHops(h.Get(loop.HeaderHops)),
	}
}

// isTraceHeader reports whether a header carries W3C trace context, which is
// forwarded verbatim so a request's spans join up across the region boundary
// instead of starting again on the far side.
func isTraceHeader(key string) bool {
	switch strings.ToLower(key) {
	case "traceparent", "tracestate", "baggage":
		return true
	}
	return false
}

// topicOf recovers the Kafka topic a bridged message belongs to, for metrics.
// Carried on the message rather than derived from the subject so the label is
// exactly the topic name operators already know, dots and all.
func topicOf(m *nats.Msg) string {
	if m == nil {
		return "unknown"
	}
	if t := m.Header.Get(loop.HeaderKafkaTopic); t != "" {
		return t
	}
	return "unknown"
}
