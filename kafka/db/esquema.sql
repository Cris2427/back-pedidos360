-- Tablas de report y audit en PostgreSQL.
-- Cada servicio tiene su propio esquema (report, audit) y solo toca el suyo:
-- es la regla de microservicios de "una base de datos por servicio", dentro
-- de un mismo PostgreSQL.
-- Todo usa IF NOT EXISTS: se puede ejecutar las veces que sea (npm run db).

CREATE SCHEMA IF NOT EXISTS report;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------- report

-- El estado actual de cada pedido: una fila por pedido, que se actualiza con
-- cada evento. De aquí salen las ventas por hora, los pedidos activos y el
-- lead time.
CREATE TABLE IF NOT EXISTS report.pedidos (
  pedido_id      text        PRIMARY KEY,
  cliente_id     text        NOT NULL,
  estado         text        NOT NULL,
  total          integer     NOT NULL CHECK (total > 0),
  canal          text        NOT NULL,
  comuna         text        NOT NULL,
  sucursal_id    text        NOT NULL,
  creado_en      timestamptz NOT NULL,
  entregado_en   timestamptz,
  cancelado_en   timestamptz,
  actualizado_en timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pedidos_por_estado ON report.pedidos (estado);
CREATE INDEX IF NOT EXISTS pedidos_por_creacion ON report.pedidos (creado_en);

-- Los productos de cada pedido (vienen en PEDIDO_CREADO). De aquí sale el
-- top de productos.
CREATE TABLE IF NOT EXISTS report.items (
  pedido_id       text    NOT NULL REFERENCES report.pedidos (pedido_id),
  producto_id     text    NOT NULL,
  nombre          text    NOT NULL,
  categoria       text    NOT NULL,
  cantidad        integer NOT NULL CHECK (cantidad > 0),
  precio_unitario integer NOT NULL CHECK (precio_unitario > 0),
  PRIMARY KEY (pedido_id, producto_id)
);

-- Los eventos que report ya aplicó. Es la idempotencia: Kafka entrega "al
-- menos una vez", y si un evento llega de nuevo, su eventId ya está aquí y
-- no se cuenta dos veces. Como vive en la base, sirve aunque report se
-- reinicie o haya varias instancias.
CREATE TABLE IF NOT EXISTS report.eventos_aplicados (
  event_id    text        PRIMARY KEY,
  pedido_id   text        NOT NULL,
  tipo        text        NOT NULL,
  aplicado_en timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit

-- El historial de cada pedido, una fila por paso: quién, qué, cuándo y desde
-- dónde. Llega por audit.timeline. Solo se agregan filas, nunca se cambian.
CREATE TABLE IF NOT EXISTS audit.registros (
  event_id        text        PRIMARY KEY,
  pedido_id       text        NOT NULL,
  que             text        NOT NULL,
  estado_anterior text,
  estado_nuevo    text        NOT NULL,
  usuario_id      text        NOT NULL,
  rol             text        NOT NULL,
  cuando          timestamptz NOT NULL,
  canal           text        NOT NULL,
  comuna          text        NOT NULL,
  sucursal_id     text        NOT NULL,
  detalle         text        NOT NULL,
  registrado_en   timestamptz NOT NULL DEFAULT now()
);
-- las tres búsquedas de la API: por pedido, por usuario y por fechas
CREATE INDEX IF NOT EXISTS registros_por_pedido ON audit.registros (pedido_id, cuando);
CREATE INDEX IF NOT EXISTS registros_por_usuario ON audit.registros (usuario_id, cuando);
CREATE INDEX IF NOT EXISTS registros_por_fecha ON audit.registros (cuando);