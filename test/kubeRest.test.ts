import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { KubeRest } from '../src/core/kubeRest';

test('lists are requested gzip-compressed and decoded transparently', async () => {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['accept-encoding']);
    const body = JSON.stringify({ items: [{ metadata: { name: 'a' } }] });
    if (req.headers['accept-encoding']?.includes('gzip')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(body));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: 'c', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }],
      users: [{ name: 'u' }],
      contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
      currentContext: 'x'
    });
    const rest = new KubeRest(kc);
    assert.deepEqual(await rest.get('/api/v1/pods'), { items: [{ metadata: { name: 'a' } }] });
    assert.equal(seen[0], 'gzip');
    // Streams (watch, logs) stay uncompressed so chunks arrive as they are written.
    const stream = await rest.stream('/api/v1/pods', { watch: true }, () => undefined);
    await stream.done;
    assert.equal(seen[1], undefined);
  } finally {
    server.close();
  }
});
