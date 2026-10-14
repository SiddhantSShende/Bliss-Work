module github.com/task-board/region-bridge

go 1.26.0

require (
	github.com/nats-io/nats.go v1.54.0
	github.com/prometheus/client_golang v1.24.1
	github.com/segmentio/kafka-go v0.4.51
	github.com/task-board/shared-backoff v0.0.0-00010101000000-000000000000
	github.com/task-board/shared-kafkaauth v0.0.0-00010101000000-000000000000
)

require (
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/klauspost/compress v1.20.0 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/nats-io/nkeys v0.4.16 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/pierrec/lz4/v4 v4.1.22 // indirect
	github.com/prometheus/client_model v0.6.2 // indirect
	github.com/prometheus/common v0.70.1 // indirect
	github.com/prometheus/procfs v0.21.1 // indirect
	github.com/xdg-go/pbkdf2 v1.0.0 // indirect
	github.com/xdg-go/scram v1.1.2 // indirect
	github.com/xdg-go/stringprep v1.0.4 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)

replace github.com/task-board/shared-backoff => ../shared/backoff

replace github.com/task-board/shared-kafkaauth => ../shared/kafkaauth
