CREATE TABLE IF NOT EXISTS products (
  id integer PRIMARY KEY,
  name text NOT NULL,
  price numeric(12, 2) NOT NULL CHECK (price >= 0)
);
INSERT INTO products (id, name, price) VALUES (1, 'Mechanical keyboard', 99.00), (2, 'USB-C hub', 49.00)
ON CONFLICT (id) DO NOTHING;
