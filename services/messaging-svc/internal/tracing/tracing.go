// Package tracing wires optional OpenTelemetry distributed tracing.
//
// Tracing is gated on OTEL_EXPORTER_OTLP_ENDPOINT: when that env var is unset
// or empty, Init is a no-op and the service runs exactly as before (no exporter,
// no spans, no startup change). This keeps local dev runs — which have no
// collector — clean. When set, the OTLP gRPC exporter is non-blocking at startup
// (batched/background), so an unreachable collector never blocks or crashes the
// service.
package tracing

import (
	"context"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Init sets up the global tracer provider and W3C tracecontext propagator when
// OTEL_EXPORTER_OTLP_ENDPOINT is set. It returns a shutdown func that flushes
// buffered spans; the returned func is always safe to call (a no-op when tracing
// is disabled). On exporter setup error it logs and degrades to a no-op rather
// than failing service startup.
func Init(ctx context.Context, serviceName string, log *slog.Logger) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }

	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		// Tracing disabled: leave the global provider/propagator untouched so the
		// service behaves exactly as before.
		return noop, nil
	}

	// WithEndpointURL parses the scheme; http:// implies an insecure (plaintext)
	// connection. The exporter dials lazily, so an unreachable collector does not
	// block startup.
	opts := []otlptracegrpc.Option{otlptracegrpc.WithEndpointURL(endpoint)}
	if len(endpoint) >= 7 && endpoint[:7] == "http://" {
		opts = append(opts, otlptracegrpc.WithInsecure())
	}

	exporter, err := otlptracegrpc.New(ctx, opts...)
	if err != nil {
		log.Error("tracing: otlp exporter init failed; continuing without tracing", "err", err)
		return noop, nil
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(semconv.ServiceName(serviceName)),
	)
	if err != nil {
		log.Error("tracing: resource init failed; continuing without tracing", "err", err)
		// Best-effort cleanup of the exporter we already created.
		_ = exporter.Shutdown(ctx)
		return noop, nil
	}

	// WithBatcher exports spans in the background, off the request path.
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	// W3C tracecontext so trace context flows across services via HTTP headers.
	otel.SetTextMapPropagator(propagation.TraceContext{})

	log.Info("tracing enabled", "endpoint", endpoint, "service", serviceName)
	return tp.Shutdown, nil
}
