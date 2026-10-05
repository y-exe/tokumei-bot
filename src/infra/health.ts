import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { Store } from './store.js';

export function healthServer(client: Pick<Client, 'isReady'>, store: Pick<Store, 'pool'>, port: number): Server {
  const server = createServer((request, response) => {
    if (request.url === '/live') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return;
    }
    if (request.url !== '/ready') { response.writeHead(404).end(); return; }
    void (async () => {
      try {
        if (!client.isReady()) { response.writeHead(503).end('starting'); return; }
        await store.pool.query('SELECT 1'); response.writeHead(200).end('ready');
      } catch { response.writeHead(503).end('database unavailable'); }
    })();
  });
  server.listen(port, '0.0.0.0'); return server;
}

export async function heartbeat(url: string | undefined, healthy: boolean): Promise<void> {
  if (!url) return;
  const endpoint = new URL(url);
  endpoint.searchParams.set('status', healthy ? 'up' : 'down');
  endpoint.searchParams.set('msg', healthy ? 'Tokumei v2 ready' : 'Tokumei v2 not ready');
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('heartbeat failed');
}
