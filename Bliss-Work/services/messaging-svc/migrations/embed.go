// Package migrations embeds the idempotent SQL migration files applied on startup.
package migrations

import "embed"

// FS contains all *.sql migration files in lexical order.
//
//go:embed *.sql
var FS embed.FS
