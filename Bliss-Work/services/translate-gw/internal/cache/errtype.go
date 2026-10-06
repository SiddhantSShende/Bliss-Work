package cache

import "fmt"

// errType identifies a failure without printing its message, which for network
// errors embeds the Redis address.
func errType(err error) string { return fmt.Sprintf("%T", err) }
