package config

import (
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime configuration sourced from environment variables.
type Config struct {
	Port         string
	JWKSURL      string
	JWTIssuer    string
	RedisURL     string
	KafkaBrokers []string
	WebOrigin    string
	LogLevel     string
	// Phase 5: messaging-svc internal endpoint for delivery acks. The gateway
	// translates a client-side `message.ack` frame into a POST against this
	// service so messaging-svc can emit MessageDelivered through its outbox
	// (preserves the outbox-then-Kafka invariant — gateway never produces).
	MessagingBaseInternal string
	// MessagingInternalToken authenticates the OUTBOUND delivery-ack POST to
	// messaging-svc above — messaging-svc's OWN secret, not this service's.
	//
	// No default. A secret is either configured or it is not; a built-in
	// fallback (as this used to have) is indistinguishable at runtime from a
	// real value and would silently authenticate every outbound call with a
	// well-known, source-controlled string the moment the env var is unset in
	// prod. Empty when unset instead — see internalauth.Matches, which fails
	// CLOSED on an empty expected secret, and messaging-svc's own
	// MESSAGING_INTERNAL_TOKEN (services/messaging-svc/internal/api/internal_delivery.go),
	// which follows the same no-default convention.
	MessagingInternalToken string
	// WSGatewayInternalToken authenticates callers of THIS service's own
	// /internal/push (see push.go) — presented in the X-Internal-Token
	// header by delivery-svc, the only trusted caller. Distinct from
	// MessagingInternalToken above: each service now validates against its
	// own secret rather than one token shared platform-wide (previously both
	// were the same TB_INTERNAL_TOKEN value) — see
	// docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2. Never log it.
	//
	// No default, for the same reason as MessagingInternalToken above — and
	// more sharply here, since holding this credential means being able to
	// deliver an arbitrary payload to any connected user (see push.go). Both
	// cmd/ws-gateway and cmd/delivery-svc refuse to start when this is empty
	// rather than falling back to a well-known development value.
	WSGatewayInternalToken string

	// ── Cryptographic internal-caller identity (/internal/push) ────────────
	// See services/ws-gateway/internal/push/svcjwt.go for the full design
	// rationale. These are additive to WSGatewayInternalToken above, not a
	// replacement for it: a process with none of these set keeps using
	// exactly the pre-existing shared-token + self-asserted-header behaviour.
	//
	// PushSigningKey is set on a CLIENT process (cmd/delivery-svc or
	// cmd/ws-gateway) to its own Ed25519 private key (base64 seed or raw
	// key) — the credential that process signs its pushes with. A given
	// process acts under exactly one role, so one env var name is reused for
	// whichever role that deployment is.
	PushSigningKey string
	// PushVerifyKeyDeliverySvc / PushVerifyKeyGatewayPeer are set on the
	// SERVER (cmd/ws-gateway's handlePush) to the PUBLIC half of each role's
	// keypair. A caller's role is derived from which of these verifies its
	// signature — never from the X-Internal-Caller header. Either or both
	// may be empty, in which case the signed path is simply unavailable for
	// that role and handlePush falls back to the legacy header for it (see
	// push.go's handlePush doc comment).
	PushVerifyKeyDeliverySvc string
	PushVerifyKeyGatewayPeer string

	// MaxConnections caps the number of concurrent WebSockets this node accepts.
	// Beyond it the upgrade is rejected (1013 Try Again Later) so a connection
	// storm can't OOM the pod. 0 = unlimited.
	MaxConnections int
	// MaxConnsPerUser caps concurrent sockets for a single user (web + desktop +
	// a few tabs is normal; a runaway reconnect loop is not). 0 = unlimited.
	MaxConnsPerUser int

	// FanoutMode selects how events reach this node's sockets.
	//
	//	broadcast  the gateway runs its own Kafka consumer under a group id
	//	           unique to this pod, so it receives EVERY event on every
	//	           fan-out topic and discards the ones it does not hold. The
	//	           original behaviour, and the default.
	//	routed     the gateway runs no consumer at all and waits to be pushed
	//	           only its own users' events by delivery-svc.
	//
	// Both may run at once during a migration — delivery is idempotent, so a
	// doubly-delivered event is deduped by the client on eventId. The intended
	// sequence is: deploy delivery-svc, watch it carry traffic, then flip
	// gateways to routed one at a time.
	FanoutMode string

	// AdvertiseAddr is the base URL delivery-svc should use to reach THIS pod,
	// e.g. http://10.1.2.3:8080. Registered in Redis under the node id and
	// refreshed on a ticker.
	//
	// Required in routed mode and there is no safe default: a gateway that
	// advertises an address nothing can reach is indistinguishable from one
	// that is simply down, except that it keeps attracting pushes. In
	// Kubernetes take it from the downward API (status.podIP); in compose the
	// service name works because there is one replica.
	AdvertiseAddr string

	// DeliveryPort is the port delivery-svc serves /metrics and health on. It
	// holds no sockets, so this is for the scrape and the probe only.
	DeliveryPort string

	// BroadcastGroupID is the Kafka consumer group the BROADCAST-mode consumer
	// joins. Unused in routed mode, which uses one shared group for the fleet.
	//
	// ── Why this is not just the node id ─────────────────────────────────────
	// It used to be "ws-gateway-"+nodeID, and nodeID is a UUID minted at process
	// start. A group that has never committed an offset starts at
	// StartOffset (LastOffset — the tip), so EVERY restart began a brand-new
	// group that skipped everything published while the pod was down.
	//
	// In broadcast mode the gateway is the ONLY writer of the replay outbox, so
	// those events were not merely missed live — they were never written to any
	// user's catch-up buffer, and no reconnect could recover them. A rolling
	// deploy was therefore a guaranteed, silent hole in delivery. It also leaked
	// one dead consumer group into __consumer_offsets per pod-lifetime, forever.
	//
	// A group id that is STABLE across restarts fixes both: the pod resumes from
	// its committed offset and re-reads the gap. It is deliberately separate
	// from nodeID rather than replacing it, because nodeID's ephemerality is
	// load-bearing elsewhere — the node-address cache is safe precisely because
	// a fresh UUID can only ever map to one address (see store.NodeAddrs), and
	// presence entries keyed `nodeId:connId` are expected to age out after a
	// crash rather than being reoccupied.
	//
	// Defaults to the hostname, which is stable per pod in compose and per pod
	// instance in Kubernetes. That is enough for a restart; it is NOT stable
	// across a Deployment rollout, which mints new pod names — so a rollout
	// still skips the gap unless this is set explicitly (or routed mode is
	// used, which has no per-pod group at all). main.go says so at boot.
	BroadcastGroupID string
}

// Fan-out modes.
const (
	FanoutBroadcast = "broadcast"
	FanoutRouted    = "routed"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

// Load reads configuration from the environment, applying sensible defaults.
func Load() Config {
	brokers := strings.Split(getenv("KAFKA_BROKERS", "kafka:9092"), ",")
	for i := range brokers {
		brokers[i] = strings.TrimSpace(brokers[i])
	}
	return Config{
		// The container always listens on 8080 (compose maps ${WS_GATEWAY_PORT}:8080).
		Port:                  "8080",
		JWKSURL:               getenv("JWKS_URL", "http://auth-svc:8001/.well-known/jwks.json"),
		JWTIssuer:             getenv("JWT_ISSUER", "task-board"),
		RedisURL:              getenv("REDIS_URL", "redis://redis:6379/0"),
		KafkaBrokers:          brokers,
		WebOrigin:             getenv("WEB_ORIGIN", "http://localhost:5173"),
		LogLevel:              getenv("LOG_LEVEL", "info"),
		MessagingBaseInternal: getenv("TB_MESSAGING_INTERNAL_BASE", "http://messaging-svc:8004"),
		// Secrets get no default — see the field comments above.
		MessagingInternalToken:   os.Getenv("MESSAGING_INTERNAL_TOKEN"),
		WSGatewayInternalToken:   os.Getenv("WS_GATEWAY_INTERNAL_TOKEN"),
		PushSigningKey:           os.Getenv("WS_GATEWAY_PUSH_SIGNING_KEY"),
		PushVerifyKeyDeliverySvc: os.Getenv("WS_GATEWAY_PUSH_VERIFY_KEY_DELIVERY_SVC"),
		PushVerifyKeyGatewayPeer: os.Getenv("WS_GATEWAY_PUSH_VERIFY_KEY_GATEWAY_PEER"),
		MaxConnections:           getenvInt("WS_MAX_CONNECTIONS", 50000),
		MaxConnsPerUser:          getenvInt("WS_MAX_CONNS_PER_USER", 20),
		// Defaults to the existing behaviour. Routed delivery is opt-in, and
		// stays that way until an operator has delivery-svc running.
		FanoutMode:       normalizeFanoutMode(getenv("WS_FANOUT_MODE", FanoutBroadcast)),
		AdvertiseAddr:    normalizeAddr(os.Getenv("WS_ADVERTISE_ADDR")),
		DeliveryPort:     getenv("DELIVERY_PORT", "8090"),
		BroadcastGroupID: broadcastGroupID(),
	}
}

// broadcastGroupID resolves the stable identity the broadcast consumer joins
// Kafka under. See Config.BroadcastGroupID for why stability matters.
//
// Falls back to the hostname, and to EMPTY if even that is unreadable. Empty is
// the interesting case, and it is deliberately not papered over with a constant:
// a shared literal would put every pod in ONE consumer group, Kafka would give
// each partition to exactly one of them, and a pod would silently stop receiving
// events for users whose sockets it is holding — worse than the bug being fixed.
// So this returns "" and main.go refuses to start broadcast mode without a real
// per-pod identity.
func broadcastGroupID() string {
	if v := strings.TrimSpace(os.Getenv("WS_BROADCAST_GROUP_ID")); v != "" {
		return v
	}
	if h, err := os.Hostname(); err == nil {
		if h = strings.TrimSpace(h); h != "" {
			return "ws-gateway-" + h
		}
	}
	return ""
}

// normalizeAddr makes an advertise address usable as a base URL.
//
// The value is joined to a path and used as a URL, so a bare host:port — the
// most natural thing to write, and what a Kubernetes downward-API fieldRef
// yields on its own — would produce "10.1.2.3/internal/push", which is not a
// URL and fails at request-build time rather than anywhere informative.
// Supplying the scheme is cheap and removes a whole class of "registered fine,
// nothing is delivered" configuration. A trailing slash is trimmed for the same
// reason: the path is appended, and "//internal/push" is a different route.
func normalizeAddr(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
		v = "http://" + v
	}
	return strings.TrimRight(v, "/")
}

// normalizeFanoutMode accepts either mode case-insensitively and falls back to
// broadcast for anything unrecognised.
//
// Fails SAFE rather than loudly, which is the opposite of the choice made for
// Kafka security, and for a reason: a typo here should leave the gateway
// serving traffic the way it always has, not refuse to start. The mode is
// logged at boot so a misspelling is visible in the first line of the log
// instead of silently doing the wrong thing.
func normalizeFanoutMode(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case FanoutRouted:
		return FanoutRouted
	default:
		return FanoutBroadcast
	}
}
