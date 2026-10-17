import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.mjs';

test('catalog caches normal reads and deliberately leaves updates stale', async () => {
  let product = { id: 1, name: 'Keyboard', price: 99 };
  let cached = null, writes = 0;
  const app = createApp({
    cache: { async get() { return cached; } },
    redis: { async set(_key, value) { cached = value; writes++; } },
    pool: { async query(sql, values) { if (sql.startsWith('UPDATE')) product = { ...product, price: values[0] }; return { rows: [product] }; } },
    ttlSeconds: 300,
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(`${base}/products/1`)).json()).source, 'origin');
    assert.equal((await (await fetch(`${base}/products/1`)).json()).source, 'cache');
    await fetch(`${base}/products/1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: 109 }) });
    assert.equal((await (await fetch(`${base}/products/1`)).json()).product.price, 99);
    assert.equal(product.price, 109); assert.equal(writes, 1);
    assert.equal((await fetch(`${base}/products/nope`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
