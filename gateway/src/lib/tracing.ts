import { NodeSdk } from '@effect/opentelemetry';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Layer, ManagedRuntime } from 'effect';

const SERVICE_NAME = 'bengali-tts-gateway';

/**
 * Where spans are run.
 *
 * Spans need somewhere to be recorded, and that somewhere has to outlive a
 * single request or every request would stand up its own exporter. This
 * runtime is built once at startup and holds the tracer for the process.
 *
 * It is deliberately the smallest thing that works: it carries the tracer
 * and nothing else, while connections are still constructed by hand in
 * server.ts. Moving those in here is a later step.
 */
export type GatewayRuntime = ManagedRuntime.ManagedRuntime<never, never>;

/**
 * Traces are exported only when a collector is configured. An unset
 * endpoint is a supported way to run this service, not a misconfiguration:
 * the spans still exist and cost almost nothing, they simply go nowhere.
 * Serving a request must never depend on anything watching.
 */
export function makeRuntime(otlpEndpoint: string | undefined): GatewayRuntime {
  if (otlpEndpoint === undefined || otlpEndpoint === '') {
    return ManagedRuntime.make(Layer.empty);
  }

  const url = `${otlpEndpoint.replace(/\/+$/, '')}/v1/traces`;
  return ManagedRuntime.make(
    NodeSdk.layer(() => ({
      resource: { serviceName: SERVICE_NAME },
      // Batched, so an unreachable or slow collector never sits in the
      // request path — spans queue and are dropped rather than waited on.
      spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url })),
    })),
  );
}
