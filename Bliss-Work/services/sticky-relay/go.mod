module github.com/task-board/sticky-relay

go 1.26

require (
	github.com/google/uuid v1.6.0
	github.com/segmentio/kafka-go v0.4.51
	github.com/task-board/shared-kafkaauth v0.0.0-00010101000000-000000000000
)

require (
	github.com/klauspost/compress v1.18.0 // indirect
	github.com/pierrec/lz4/v4 v4.1.22 // indirect
	github.com/xdg-go/pbkdf2 v1.0.0 // indirect
	github.com/xdg-go/scram v1.1.2 // indirect
	github.com/xdg-go/stringprep v1.0.4 // indirect
	golang.org/x/text v0.39.0 // indirect
)

replace github.com/task-board/shared-kafkaauth => ../shared/kafkaauth
