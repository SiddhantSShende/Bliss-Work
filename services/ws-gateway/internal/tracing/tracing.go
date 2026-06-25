// Package tracing wires optional OpenTelemetry distributed tracing.
//
// Tracing is GATED on the OTEL_EXPORTER_OTLP_ENDPOINT environment variable:
// when it is unset (or empty) Init installs nothing and returns a no-op
// shutdown, so dev runs without a collector behave exactly as before — no
// exporter, no spans, no extra startup work. When set, an OTLP/gRPC exporter
// is built with a BATCHING (background, non-blocking) span processor, so an
// unreachable collector can never block or crash the service at startup.
package tracing

import (
	"context"
	"log/slog"
	"os"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Init configures the global tracer provider and W3C tracecontext propagator.
//
// It returns a shutdown func that flushes any buffered spans; callers should
// defer it with a bounded context. When OTEL_EXPORTER_OTLP_ENDPOINT is empty
// the returned shutdown is a no-op and no global state is mutated.
func Init(ctx context.Context, serviceName string, log *slog.Logger) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }

	endpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if endpoint == "" {
		// Tracing disabled: run exactly as before.
		return noop, nil
	}

	opts := []otlptracegrpc.Option{otlptracegrpc.WithEndpointURL(endpoint)}
	// http:// endpoints are plaintext OTLP/gRPC; skip TLS for them.
	if strings.HasPrefix(strings.ToLower(endpoint), "http://") {
		opts = append(opts, otlptracegrpc.WithInsecure())
	}

	// The exporter establishes its gRPC connection lazily, so this never blocks
	// startup even if the collector is unreachable.
	exporter, err := otlptracegrpc.New(ctx, opts...)
	if err != nil {
		return noop, err
	}

	res, err := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(serviceName),
		),
	)
	if err != nil {
		// Fall back to a bare resource carrying just the service name rather
		// than failing tracing init over a schema-merge mismatch.
		res = resource.NewSchemaless(semconv.ServiceName(serviceName))
	}

	tp := sdktrace.NewTracerProvider(
		// WithBatcher exports in the background, off the request path.
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	log.Info("tracing enabled", "endpoint", endpoint, "service", serviceName)

	return tp.Shutdown, nil
}
