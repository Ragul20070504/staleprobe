import express from 'express';

/** Dependencies are injected so HTTP behavior can be verified without services. */
export function createApp({ cache, redis, pool, ttlSeconds }) {
  const app = express(); app.use(express.json({ limit: '16kb' }));
  const validId = id => /^\d{1,10}$/.test(id);
  app.get('/products/:id', async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID' });
    const key = `product:${req.params.id}`;
    const cached = await cache.get(key);
    if (cached !== null) return res.json({ source: 'cache', product: JSON.parse(cached) });
    const { rows } = await pool.query('SELECT id, name, price::float8 AS price FROM products WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    // Normal application cache population; the auditor never writes Redis.
    await redis.set(key, JSON.stringify(rows[0]), 'EX', ttlSeconds);
    return res.json({ source: 'origin', product: rows[0] });
  });
  app.patch('/products/:id', async (req, res) => {
    const price = req.body?.price;
    if (!validId(req.params.id) || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1_000_000) {
      return res.status(400).json({ error: 'Invalid product ID or price' });
    }
    const { rows } = await pool.query('UPDATE products SET price = $1 WHERE id = $2 RETURNING id, name, price::float8 AS price', [price, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    // Deliberately leave the cache unchanged to demonstrate staleness.
    return res.json({ product: rows[0], cacheUpdated: false });
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use((_error, _req, res, _next) => res.status(503).json({ error: 'Service unavailable' }));
  return app;
}
