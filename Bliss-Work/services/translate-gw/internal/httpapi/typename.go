package httpapi

import "fmt"

// typeName is the dynamic Go type of err ("*url.Error"), which identifies the
// failure without printing its message.
func typeName(err error) string { return fmt.Sprintf("%T", err) }
