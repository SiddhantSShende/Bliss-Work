package kafkaauth

import (
	"strings"
	"testing"
)

// Tests call parseEnv directly rather than the exported wrappers: those cache
// through a sync.Once, which is correct for a process that reads a fixed
// environment once at boot and useless for a table of cases.

// An unset environment must stay exactly as it was before this package existed
// — the bundled plaintext broker, no TLS, no credentials read.
func TestDefaultsToPlaintext(t *testing.T) {
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "")
	// Credentials present but unused: a leftover password from a previous
	// deployment must not quietly turn a plaintext broker into an authenticated
	// one, or the logs would claim security the connection does not have.
	t.Setenv("KAFKA_SASL_USERNAME", "leftover")
	t.Setenv("KAFKA_SASL_PASSWORD", "leftover")

	c, err := parseEnv()
	if err != nil {
		t.Fatalf("parseEnv: %v", err)
	}
	if c.protocol != protoPlaintext {
		t.Errorf("protocol = %q, want %q", c.protocol, protoPlaintext)
	}
	if c.mechanism != nil {
		t.Error("a plaintext broker carries a SASL mechanism")
	}
	if c.tls != nil {
		t.Error("a plaintext broker carries a TLS config")
	}
}

// The failure mode this package exists to prevent: a deployment that believes
// it enabled SASL, has no credentials, and silently talks plaintext instead.
func TestSASLWithoutCredentialsIsAStartupError(t *testing.T) {
	for _, proto := range []string{protoSASLSSL, protoSASLPlaintext} {
		t.Run(proto, func(t *testing.T) {
			t.Setenv("KAFKA_SECURITY_PROTOCOL", proto)
			t.Setenv("KAFKA_SASL_USERNAME", "")
			t.Setenv("KAFKA_SASL_PASSWORD", "")

			if _, err := parseEnv(); err == nil {
				t.Fatal("no error; a half-configured client must refuse to start, " +
					"not fall back to an unauthenticated connection")
			}
		})
	}
	// One half set is the same mistake, and easier to make.
	t.Run("password only", func(t *testing.T) {
		t.Setenv("KAFKA_SECURITY_PROTOCOL", protoSASLSSL)
		t.Setenv("KAFKA_SASL_USERNAME", "")
		t.Setenv("KAFKA_SASL_PASSWORD", "secret")
		if _, err := parseEnv(); err == nil {
			t.Fatal("username missing but no error")
		}
	})
}

func TestSASLSSLBuildsMechanismAndTLS(t *testing.T) {
	cases := []struct{ mech, name string }{
		{"", "default is PLAIN"},
		{mechPlain, mechPlain},
		{mechScramSHA256, mechScramSHA256},
		{mechScramSHA512, mechScramSHA512},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("KAFKA_SECURITY_PROTOCOL", protoSASLSSL)
			t.Setenv("KAFKA_SASL_MECHANISM", tc.mech)
			t.Setenv("KAFKA_SASL_USERNAME", "u")
			t.Setenv("KAFKA_SASL_PASSWORD", "p")
			t.Setenv("KAFKA_SSL_CA_LOCATION", "")

			c, err := parseEnv()
			if err != nil {
				t.Fatalf("parseEnv: %v", err)
			}
			if c.mechanism == nil {
				t.Fatal("no SASL mechanism built")
			}
			if c.tls == nil {
				t.Fatal("SASL_SSL built no TLS config; the password would go in the clear")
			}
		})
	}
}

// SASL_PLAINTEXT authenticates without encrypting. It is a legitimate choice
// inside a network that provides its own transport security, so it must be
// expressible — but it must not silently acquire a TLS config either.
func TestSASLPlaintextAuthenticatesWithoutTLS(t *testing.T) {
	t.Setenv("KAFKA_SECURITY_PROTOCOL", protoSASLPlaintext)
	t.Setenv("KAFKA_SASL_MECHANISM", mechScramSHA512)
	t.Setenv("KAFKA_SASL_USERNAME", "u")
	t.Setenv("KAFKA_SASL_PASSWORD", "p")

	c, err := parseEnv()
	if err != nil {
		t.Fatalf("parseEnv: %v", err)
	}
	if c.mechanism == nil {
		t.Error("no SASL mechanism for SASL_PLAINTEXT")
	}
	if c.tls != nil {
		t.Error("SASL_PLAINTEXT built a TLS config")
	}
}

// A typo in either variable must stop the process, not degrade the connection.
// The error names the accepted values, because the failure otherwise arrives as
// "cannot reach broker" hours into a migration.
func TestTyposAreRejectedWithAUsefulMessage(t *testing.T) {
	t.Run("protocol", func(t *testing.T) {
		t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL-SSL") // hyphen, not underscore
		_, err := parseEnv()
		if err == nil {
			t.Fatal("bad protocol accepted")
		}
		if !strings.Contains(err.Error(), protoSASLSSL) {
			t.Errorf("error %q does not name the accepted values", err)
		}
	})
	t.Run("mechanism", func(t *testing.T) {
		t.Setenv("KAFKA_SECURITY_PROTOCOL", protoSASLSSL)
		t.Setenv("KAFKA_SASL_MECHANISM", "SCRAM-SHA512") // missing hyphen
		t.Setenv("KAFKA_SASL_USERNAME", "u")
		t.Setenv("KAFKA_SASL_PASSWORD", "p")
		_, err := parseEnv()
		if err == nil {
			t.Fatal("bad mechanism accepted")
		}
		if !strings.Contains(err.Error(), mechScramSHA512) {
			t.Errorf("error %q does not name the accepted values", err)
		}
	})
}

// Values are matched case-insensitively and trimmed, because these arrive from
// a .env file or a Helm value where a trailing space is invisible.
func TestProtocolIsCaseAndWhitespaceInsensitive(t *testing.T) {
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "  sasl_ssl ")
	t.Setenv("KAFKA_SASL_MECHANISM", " scram-sha-512 ")
	t.Setenv("KAFKA_SASL_USERNAME", "u")
	t.Setenv("KAFKA_SASL_PASSWORD", "p")

	c, err := parseEnv()
	if err != nil {
		t.Fatalf("parseEnv: %v", err)
	}
	if c.protocol != protoSASLSSL {
		t.Errorf("protocol = %q, want %q", c.protocol, protoSASLSSL)
	}
	if c.mechanism == nil {
		t.Error("no mechanism built from a padded lowercase value")
	}
}

// A missing CA file is a startup error, not a silent fall back to the system
// roots — the whole reason to name one is that the system roots will not do.
func TestUnreadableCAFileIsAnError(t *testing.T) {
	t.Setenv("KAFKA_SECURITY_PROTOCOL", protoSSL)
	t.Setenv("KAFKA_SSL_CA_LOCATION", "/nonexistent/ca.pem")
	if _, err := parseEnv(); err == nil {
		t.Fatal("missing CA bundle accepted")
	}
}

// THE INTERFACE-NIL TRAP.
//
// Transport returns kafka.RoundTripper, an interface. Returning a nil
// *kafka.Transport would produce a NON-nil interface holding a nil pointer, so
// kafka-go would call through it and panic instead of falling back to its own
// default transport. `== nil` on the interface is exactly what distinguishes
// the two, which is what makes this worth asserting rather than eyeballing.
//
// This uses the exported accessors deliberately: the trap lives in their return
// types, and the default (unset) environment is the plaintext path.
func TestPlaintextAccessorsReturnTrueNils(t *testing.T) {
	if got := Transport(); got != nil {
		t.Errorf("Transport() = %#v, want an untyped nil interface. A typed nil here "+
			"is not nil to kafka-go and panics rather than using the default transport.", got)
	}
	if got := Dialer(); got != nil {
		t.Errorf("Dialer() = %#v, want nil so ReaderConfig substitutes its default", got)
	}
	if Protocol() != protoPlaintext {
		t.Errorf("Protocol() = %q, want %q", Protocol(), protoPlaintext)
	}
}
