// Package tracing wires optional OpenTelemetry distributed tracing.
//
// Tracing is strictly opt-in: it initializes only when OTEL_EXPORTER_OTLP_ENDPOINT
// is set and non-empty. When unset, Init is a no-op (no exporter, no spans, no
// startup change) so local/dev runs without a collector behave exactly as before.
package tracing

import (
	"context"
	"log/slog"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Init configures the global tracer provider and propagator when an OTLP
// endpoint is configured. It returns a shutdown func that flushes pending spans;
// when tracing is disabled the returned func is a no-op.
func Init(ctx context.Context, serviceName string, log *slog.Logger) func(context.Context) error {
	noop := func(context.Context) error { return nil }

	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		// Tracing disabled: leave the global no-op provider in place.
		return noop
	}

	// The OTLP gRPC exporter dials lazily and exports in the background, so an
	// unreachable collector never blocks or crashes startup.
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpointURL(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		log.Error("tracing exporter init failed; continuing without tracing", "error", err)
		return noop
	}

	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		semconv.ServiceName(serviceName),
	))
	if err != nil {
		log.Error("tracing resource init failed; continuing without tracing", "error", err)
		return noop
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	log.Info("tracing enabled", "endpoint", endpoint, "service", serviceName)

	return func(ctx context.Context) error {
		// Bound shutdown so a stuck collector cannot hang process exit.
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return tp.Shutdown(ctx)
	}
}
