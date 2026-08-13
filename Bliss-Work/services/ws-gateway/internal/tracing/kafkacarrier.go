package tracing

import "github.com/segmentio/kafka-go"

// KafkaHeaderCarrier adapts a slice of kafka.Header to the
// propagation.TextMapCarrier interface so the global OpenTelemetry propagator
// can inject/extract W3C trace context (traceparent/tracestate) on Kafka
// messages. Header values are bytes; this carrier treats them as UTF-8 strings.
//
// On Inject the propagator may Set multiple keys; Set replaces an existing
// header of the same key in place (case-insensitive, matching Kafka/HTTP-style
// header semantics) so we never emit duplicates.
type KafkaHeaderCarrier struct {
	headers *[]kafka.Header
}

// NewKafkaHeaderCarrier wraps an existing header slice (which may be nil). The
// pointer lets Set append to / mutate the caller's slice in place.
func NewKafkaHeaderCarrier(headers *[]kafka.Header) KafkaHeaderCarrier {
	return KafkaHeaderCarrier{headers: headers}
}

// Get returns the value of the header with the given key, or "" if absent.
func (c KafkaHeaderCarrier) Get(key string) string {
	if c.headers == nil {
		return ""
	}
	for _, h := range *c.headers {
		if equalFold(h.Key, key) {
			return string(h.Value)
		}
	}
	return ""
}

// Set stores key=value, replacing any existing header with the same key.
func (c KafkaHeaderCarrier) Set(key, value string) {
	if c.headers == nil {
		return
	}
	for i := range *c.headers {
		if equalFold((*c.headers)[i].Key, key) {
			(*c.headers)[i].Value = []byte(value)
			return
		}
	}
	*c.headers = append(*c.headers, kafka.Header{Key: key, Value: []byte(value)})
}

// Keys lists the header keys present in the carrier.
func (c KafkaHeaderCarrier) Keys() []string {
	if c.headers == nil {
		return nil
	}
	keys := make([]string, 0, len(*c.headers))
	for _, h := range *c.headers {
		keys = append(keys, h.Key)
	}
	return keys
}

// equalFold is a tiny ASCII case-insensitive comparison; trace-context header
// keys are lowercase ASCII so this avoids pulling in strings just for this.
func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
