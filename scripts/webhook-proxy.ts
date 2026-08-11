import { createServer, request } from 'node:http';

const listenPort = Number(process.env.WEBHOOK_PROXY_PORT ?? 3101);
const runtimePort = Number(process.env.PORT ?? 3100);
const webhookPath = '/api/v1/webhooks/openwa';

const server = createServer((incoming, outgoing) => {
  const path = new URL(incoming.url ?? '/', 'http://localhost').pathname;
  if (incoming.method !== 'POST' || path !== webhookPath) {
    outgoing.writeHead(404, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ statusCode: 404, message: 'Not found' }));
    return;
  }

  const upstream = request(
    {
      hostname: '127.0.0.1',
      port: runtimePort,
      path: webhookPath,
      method: 'POST',
      headers: { ...incoming.headers, host: `127.0.0.1:${runtimePort}` },
    },
    response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on('error', error => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ statusCode: 502, message: error.message }));
  });
  incoming.pipe(upstream);
});

server.listen(listenPort, '127.0.0.1', () => {
  process.stdout.write(`Webhook-only proxy listening on http://127.0.0.1:${listenPort}${webhookPath}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
