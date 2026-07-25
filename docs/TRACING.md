# Distributed Tracing Guide

## Overview

Distributed tracing provides end-to-end visibility into request processing across multiple systems:
- HTTP requests through the API
- Database queries
- Stellar network operations
- Webhook deliveries
- Background jobs

Traces help answer "why was a request slow?" and enable root cause analysis during incidents.

## Architecture

### Components

1. **OpenTelemetry SDK**: Provides the tracing infrastructure
2. **Exporter**: Sends spans to a collector (OTLP, Jaeger, etc.)
3. **Tracer**: Creates and manages spans
4. **Spans**: Individual operations (e.g., "db.select user", "stellar.submitTransaction")
5. **Trace Context**: Propagates trace IDs across system boundaries

### Trace Structure

```
HTTP Request (root span)
├── Validate (child span)
├── Database Query (child span)
│   └── db.select users
├── Stellar Operation (child span)
│   ├── horizon.loadAccount
│   └── stellar.submitTransaction
└── Webhook Delivery (child span)
    ├── http.post webhook.example.com
    └── db.insert webhook_delivery_history
```

## Enabling Tracing

### Installation

```bash
# Core OpenTelemetry API (always included)
npm install @opentelemetry/api

# SDK and exporters (optional for local tracing, required for production)
npm install @opentelemetry/sdk-node \
            @opentelemetry/exporter-trace-otlp-http \
            @opentelemetry/resources \
            @opentelemetry/semantic-conventions \
            @opentelemetry/auto-instrumentations-node
```

### Configuration

```javascript
// In src/app.js, before creating the server
const tracing = require('./utils/tracing');

// Initialize tracing (gracefully degrades if SDK not installed)
tracing.initTracing({
  enabled: process.env.OTEL_ENABLED !== 'false',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
  serviceName: process.env.OTEL_SERVICE_NAME || 'stellar-donation-api'
});
```

### Environment Variables

```bash
# Enable/disable tracing (default: true if SDK installed)
OTEL_ENABLED=true

# OTLP collector endpoint (default: http://localhost:4318)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Service name in traces (default: stellar-donation-api)
OTEL_SERVICE_NAME=stellar-donation-api

# Authentication headers (optional, comma-separated key=value pairs)
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer token123,X-Custom=value"
```

## Using Tracing

### HTTP Request Tracing

Add the HTTP tracing middleware to your Express app:

```javascript
const tracing = require('./utils/tracing');
const app = express();

// Add tracing middleware early in the chain
app.use(tracing.httpTracingMiddleware());
```

This middleware automatically:
- Creates a root span for each HTTP request
- Captures HTTP method, route, status code
- Injects W3C traceparent headers into responses
- Correlates with correlation IDs

### Database Query Tracing

Wrap database operations with `traceDbQuery`:

```javascript
const tracing = require('./utils/tracing');

async function fetchUser(userId) {
  return tracing.traceDbQuery('SELECT', 'users', async () => {
    return await Database.query('SELECT * FROM users WHERE id = ?', [userId]);
  });
}
```

**Span attributes captured:**
- `db.system`: Database type (sqlite)
- `db.operation`: Operation type (SELECT, INSERT, UPDATE, DELETE)
- `db.sql.table`: Target table name
- `db.rows_affected`: Number of rows affected

### Stellar Operation Tracing

Wrap Stellar network calls with `traceStellarCall`:

```javascript
const tracing = require('./utils/tracing');

class StellarService {
  async loadAccount(publicKey) {
    return tracing.traceStellarCall('loadAccount', async () => {
      return await this.horizon.loadAccount(publicKey);
    });
  }

  async submitTransaction(xdr) {
    return tracing.traceStellarCall('submitTransaction', {
      'stellar.xdr_length': xdr.length,
      'stellar.network': this.networkName
    }, async () => {
      return await this.horizon.submitTransaction(xdr);
    });
  }
}
```

**Span attributes captured:**
- `stellar.operation`: Operation name
- `peer.service`: Always "stellar-horizon"
- Custom attributes provided by caller

### Webhook Delivery Tracing

Wrap webhook HTTP calls with spans:

```javascript
const tracing = require('./utils/tracing');

async function sendWebhook(webhookUrl, payload) {
  return tracing.withSpan(
    'webhook.post',
    {
      'http.method': 'POST',
      'http.url': webhookUrl,
      'webhook.event': payload.event
    },
    async (span) => {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...tracing.injectTraceHeaders({})  // Propagate trace context
        },
        body: JSON.stringify(payload)
      });

      span.setAttribute('http.status_code', response.status);
      return response.json();
    }
  );
}
```

### Background Job Tracing

Wrap async operations with `withSpan`:

```javascript
const tracing = require('./utils/tracing');

async function processWebhookRetry(webhookId) {
  return tracing.withSpan('webhook.retry', { webhookId }, async (span) => {
    // Work here is traced as a child span
    const webhook = await getWebhook(webhookId);
    span.setAttribute('webhook.url', webhook.url);
    
    await sendWebhook(webhook.url, { /* ... */ });
    
    span.setAttribute('result', 'success');
  });
}
```

### Generic Span Creation

For custom operations:

```javascript
const tracing = require('./utils/tracing');

// Option 1: Auto-ending span (recommended)
await tracing.withSpan('my.operation', { customAttr: 'value' }, async (span) => {
  // Span is active here
  // Any nested DB/Stellar calls become child spans
  
  span.setAttribute('result', 'success');
  return result;
});

// Option 2: Manual span management
const span = tracing.startSpan('my.fire-and-forget', { customAttr: 'value' });
setImmediate(() => {
  try {
    doWork();
    span.setAttribute('result', 'success');
  } catch (err) {
    span.recordException(err);
  } finally {
    span.end();
  }
});
```

## Correlation ↔ Tracing Integration

Correlation IDs and trace IDs are linked for unified observability:

```javascript
const { getCorrelationContext } = require('./utils/correlation');
const tracing = require('./utils/tracing');

// In a request handler:
const spanContext = tracing.getActiveSpanContext();
const correlationContext = getCorrelationContext();

log.info('Service', 'Processing', {
  correlationId: correlationContext.correlationId,  // For log aggregation
  traceId: spanContext.traceId                      // For distributed tracing
});

// They refer to the same request:
// - correlationId tags log lines and webhook headers
// - traceId identifies spans in the tracing backend
```

### When to Use What

| Use Case | Tool | Why |
|----------|------|-----|
| Trace request across multiple services | Tracing (trace ID) | Spans show exact timing and dependencies |
| Find all logs for one request | Correlation (correlation ID) | Log aggregators index on this |
| Link logs to traces | Both | correlationId in logs, trace ID in spans |
| Debug slow webhook delivery | Tracing | Spans show exact network latency |
| Audit who changed what | Correlation | Audit logs include correlationId |

## Viewing Traces

### Local Development (In-Memory Store)

During development, traces are stored in memory and accessible via API:

```javascript
// In a debug endpoint
const tracing = require('./utils/tracing');

app.get('/api/debug/traces', (req, res) => {
  const traces = tracing.getTraces();
  const traceCount = tracing.getTraceCount();
  
  res.json({
    total: traceCount,
    traces: traces.slice(0, 50)  // Last 50 traces
  });
});

app.get('/api/debug/traces/:traceId', (req, res) => {
  const trace = tracing.getTrace(req.params.traceId);
  if (!trace) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  
  res.json(trace);
});
```

**Response format:**
```json
{
  "total": 1023,
  "traces": [
    {
      "traceId": "550e8400-e29b-41d4-a716-446655440000",
      "spanId": "span-123",
      "operation": "POST /api/donation/create",
      "durationMs": 342,
      "status": "ok",
      "timestamp": "2024-07-24T12:34:56.789Z",
      "spanCount": 8
    }
  ]
}
```

### Production (OTLP Exporter)

In production, configure an OTLP collector:

```bash
# Example: Jaeger all-in-one (includes collector and UI)
docker run -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one

# Point API to collector
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Then view traces in Jaeger UI: http://localhost:16686

**Alternative collectors:**
- [Grafana Loki](https://grafana.com/docs/loki/latest/): Lightweight log-based tracing
- [Datadog](https://www.datadoghq.com/): SaaS with APM
- [New Relic](https://newrelic.com/): SaaS with distributed tracing
- [Zipkin](https://zipkin.io/): Open-source trace aggregator

### Viewing Trace Context in Response Headers

Every response includes W3C trace headers:

```http
HTTP/1.1 200 OK
traceparent: 00-550e8400e29b41d4a716446655440000-3d0f96ca74f55241-01
tracestate: vendor-data
```

These can be used to correlate with backend traces:
- `00`: W3C version
- `550e8400...440000`: Trace ID
- `3d0f96ca...55241`: Span ID
- `01`: Trace flags (sampled)

## Performance Considerations

### Overhead

- Tracing adds minimal overhead (~1-2% CPU, ~2-5MB memory)
- In-memory trace store is capped at 1000 traces (evicts oldest)
- OTLP export is async and non-blocking

### Sampling

For high-traffic services, enable sampling:

```javascript
// Trace 10% of requests
const samplingProbability = 0.1;

tracing.httpTracingMiddleware({
  sampler: {
    shouldSample: () => Math.random() < samplingProbability
  }
});
```

### Production Recommendations

```javascript
tracing.initTracing({
  enabled: process.env.OTEL_ENABLED !== 'false',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  exporterHeaders: {
    'Authorization': `Bearer ${process.env.OTEL_EXPORTER_TOKEN}`
  }
});
```

## Testing

### Unit Tests with Mock Tracer

```javascript
const tracing = require('../utils/tracing');
const api = require('@opentelemetry/api');

describe('Donation Service', () => {
  let mockTracer;

  beforeEach(() => {
    mockTracer = {
      startActiveSpan: jest.fn((name, opts, fn) => fn({ 
        end: jest.fn(),
        setAttribute: jest.fn(),
        setStatus: jest.fn(),
        recordException: jest.fn()
      }))
    };
    
    tracing._setTracerForTesting(mockTracer);
  });

  afterEach(() => {
    tracing._setTracerForTesting(null);
  });

  it('should trace donation processing', async () => {
    await DonationService.process({ id: 123, amount: 100 });
    
    expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
      expect.stringContaining('donation'),
      expect.any(Object),
      expect.any(Function)
    );
  });
});
```

### Integration Tests with Real Spans

```javascript
const tracing = require('../utils/tracing');

describe('Tracing Integration', () => {
  beforeAll(() => {
    tracing._clearTraceStore();
    tracing.initTracing({ enabled: true });
  });

  it('should create spans for database queries', async () => {
    const startCount = tracing.getTraceCount();
    
    // Trigger a request that queries DB
    await request(app).get('/api/users/123');
    
    // Check traces were created
    const traces = tracing.getTraces();
    expect(traces.length).toBeGreaterThan(startCount);
    
    const dbSpans = traces.flatMap(t => t.spans)
      .filter(s => s.name.startsWith('db.'));
    expect(dbSpans.length).toBeGreaterThan(0);
  });
});
```

## Troubleshooting

### Tracing Not Working

1. **Check if SDK is installed:**
   ```bash
   npm ls @opentelemetry/sdk-node
   ```

2. **Verify initialization:**
   ```javascript
   const tracing = require('./utils/tracing');
   tracing.initTracing();  // Must be called before routes
   ```

3. **Check logs for errors:**
   ```javascript
   const enabled = tracing.initTracing();
   console.log('Tracing enabled:', enabled);
   ```

### Spans Not Appearing

1. **Verify middleware is registered:**
   ```javascript
   app.use(tracing.httpTracingMiddleware());  // Must be early
   ```

2. **Check OTLP endpoint connectivity:**
   ```bash
   curl -X POST http://localhost:4318/v1/traces \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

3. **Enable debug logging:**
   ```bash
   OTEL_SDK_DISABLED=false DEBUG=otel* npm start
   ```

### High Memory Usage

In-memory trace store may grow large. Solutions:

1. **Reduce trace retention** (update code):
   ```javascript
   // In tracing.js, reduce MAX_STORED_TRACES
   const MAX_STORED_TRACES = 100;  // Was 1000
   ```

2. **Export to remote collector** to offload memory

3. **Implement sampling** to reduce span count

## Best Practices

1. **Use meaningful span names**: "db.select users" not "query"
2. **Add span attributes for context**: operation name, input size, result status
3. **Record exceptions**: Let span capture error details
4. **Inject headers in outbound requests**: Propagate trace context
5. **Link correlation IDs to trace IDs**: For unified observability
6. **Clean up spans**: Always call `span.end()` or use `withSpan()`
7. **Don't log secrets in spans**: Use span attributes only for metadata

## Related Documentation

- [Structured Logging Guide](./LOGGING.md)
- [Correlation ID Propagation](./CORRELATION.md)
- [Error Handling](./ERROR_HANDLING.md)
- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
