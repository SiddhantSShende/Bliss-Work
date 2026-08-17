// Package kafkaauth turns Kafka connection-security environment variables into
// the dialer and transport the kafka-go clients need.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Every Kafka client in this repository was constructed from KAFKA_BROKERS and
// nothing else, which works exactly as long as the broker is the unauthenticated
// one that ships in docker-compose. Every managed Kafka — Confluent Cloud, MSK,
// Aiven, Redpanda Cloud — requires SASL over TLS, so moving off the bundled
// broker was a CODE change at every client, discovered during the cutover rather
// than before it. This is that code change, made ahead of time so the migration
// is a matter of setting variables.
//
// ── Fail loudly, not open ────────────────────────────────────────────────────
// A half-configured client that silently falls back to plaintext would connect
// to nothing in production and, worse, could connect to a plaintext listener
// somewhere else. So a protocol that names SASL with no credentials is a
// startup error, in the same spirit as livekit.New refusing a partially-filled
// config. Call Validate() from main before constructing anything.
//
// ── What is deliberately not supported ───────────────────────────────────────
// AWS MSK's IAM authentication. It needs a separate signer library and AWS
// credential chain; SCRAM-SHA-512 is available on MSK and is what this targets.
package kafkaauth

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl"
	"github.com/segmentio/kafka-go/sasl/plain"
	"github.com/segmentio/kafka-go/sasl/scram"
)

// Security protocols, spelled as the Kafka ecosystem spells them so an operator
// can copy the value straight out of their provider's console.
const (
	protoPlaintext     = "PLAINTEXT"
	protoSSL           = "SSL"
	protoSASLPlaintext = "SASL_PLAINTEXT"
	protoSASLSSL       = "SASL_SSL"
)

// SASL mechanisms.
const (
	mechPlain       = "PLAIN"
	mechScramSHA256 = "SCRAM-SHA-256"
	mechScramSHA512 = "SCRAM-SHA-512"
)

type config struct {
	protocol  string
	mechanism sasl.Mechanism
	tls       *tls.Config
}

var (
	once    sync.Once
	loaded  config
	loadErr error
)

// load reads the environment exactly once. Process environment does not change
// under us, and every client in a service wants the same answer.
func load() (config, error) {
	once.Do(func() { loaded, loadErr = parseEnv() })
	return loaded, loadErr
}

func parseEnv() (config, error) {
	proto := strings.ToUpper(strings.TrimSpace(os.Getenv("KAFKA_SECURITY_PROTOCOL")))
	if proto == "" {
		proto = protoPlaintext
	}
	c := config{protocol: proto}

	switch proto {
	case protoPlaintext:
		// The bundled broker. Nothing to configure, and no credentials are read
		// even if they happen to be set — otherwise a leftover password would
		// make a plaintext deployment look authenticated.
		return c, nil
	case protoSSL, protoSASLSSL:
		t, err := tlsConfig()
		if err != nil {
			return config{}, err
		}
		c.tls = t
	case protoSASLPlaintext:
		// SASL without TLS sends the password in the clear. Legitimate inside a
		// trusted network with its own encryption; a mistake anywhere else.
	default:
		return config{}, fmt.Errorf(
			"kafkaauth: KAFKA_SECURITY_PROTOCOL=%q; want one of %s, %s, %s, %s",
			proto, protoPlaintext, protoSSL, protoSASLPlaintext, protoSASLSSL)
	}

	if proto == protoSASLSSL || proto == protoSASLPlaintext {
		m, err := saslMechanism()
		if err != nil {
			return config{}, err
		}
		c.mechanism = m
	}
	return c, nil
}

func saslMechanism() (sasl.Mechanism, error) {
	user := os.Getenv("KAFKA_SASL_USERNAME")
	pass := os.Getenv("KAFKA_SASL_PASSWORD")
	if user == "" || pass == "" {
		return nil, fmt.Errorf(
			"kafkaauth: KAFKA_SECURITY_PROTOCOL requests SASL but " +
				"KAFKA_SASL_USERNAME/KAFKA_SASL_PASSWORD are not both set")
	}
	mech := strings.ToUpper(strings.TrimSpace(os.Getenv("KAFKA_SASL_MECHANISM")))
	if mech == "" {
		// PLAIN is what Confluent Cloud and most hosted brokers hand you in
		// their quick-start, so it is the least surprising default.
		mech = mechPlain
	}
	switch mech {
	case mechPlain:
		return plain.Mechanism{Username: user, Password: pass}, nil
	case mechScramSHA256:
		return scram.Mechanism(scram.SHA256, user, pass)
	case mechScramSHA512:
		return scram.Mechanism(scram.SHA512, user, pass)
	default:
		return nil, fmt.Errorf(
			"kafkaauth: KAFKA_SASL_MECHANISM=%q; want one of %s, %s, %s",
			mech, mechPlain, mechScramSHA256, mechScramSHA512)
	}
}

// tlsConfig validates against the system roots unless KAFKA_SSL_CA_LOCATION names a
// PEM bundle, which is what a private CA needs. Mirrors the Redis client's
// handling in ws-gateway so there is one shape to learn.
func tlsConfig() (*tls.Config, error) {
	t := &tls.Config{MinVersion: tls.VersionTLS12}
	caPath := os.Getenv("KAFKA_SSL_CA_LOCATION")
	if caPath == "" {
		return t, nil
	}
	// Operator-supplied path from the environment; not reachable from any
	// request, so there is no untrusted input to traverse with.
	pem, err := os.ReadFile(caPath) //nolint:gosec // G304: operator-supplied path
	if err != nil {
		return nil, fmt.Errorf("kafkaauth: read KAFKA_SSL_CA_LOCATION: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("kafkaauth: KAFKA_SSL_CA_LOCATION %s: no certificates parsed", caPath)
	}
	t.RootCAs = pool
	return t, nil
}

// Validate reports a bad Kafka security configuration. Call it from main before
// building any client, so a deployment mistake stops the process instead of
// surfacing later as an unexplained connection failure.
func Validate() error {
	_, err := load()
	return err
}

// Enabled reports whether any transport security is configured. Useful for a
// startup log line — an operator who thinks they enabled SASL and did not
// should be able to see that from the logs.
func Enabled() bool {
	c, err := load()
	return err == nil && c.protocol != protoPlaintext
}

// Protocol returns the configured protocol name, for logging.
func Protocol() string {
	c, err := load()
	if err != nil {
		return "INVALID"
	}
	return c.protocol
}

// Dialer returns the dialer for kafka.ReaderConfig.
//
// Returns nil for a plaintext broker, which is what ReaderConfig expects — it
// substitutes its own default dialer for a nil one.
func Dialer() *kafka.Dialer {
	c, err := load()
	if err != nil || c.protocol == protoPlaintext {
		return nil
	}
	return &kafka.Dialer{
		Timeout:       10 * time.Second,
		DualStack:     true,
		TLS:           c.tls,
		SASLMechanism: c.mechanism,
	}
}

// Transport returns the transport for kafka.Writer.
//
// The return type is the RoundTripper INTERFACE and the plaintext case returns
// an untyped nil, deliberately. Returning a nil *kafka.Transport would produce
// a non-nil interface holding a nil pointer, and kafka-go would call through it
// and panic rather than falling back to its default transport.
func Transport() kafka.RoundTripper {
	c, err := load()
	if err != nil || c.protocol == protoPlaintext {
		return nil
	}
	return &kafka.Transport{
		TLS:  c.tls,
		SASL: c.mechanism,
	}
}
