// Repositorio de report: guarda el estado de cada pedido y calcula los KPIs.
// Dos adaptadores con los mismos métodos, igual que el store de la EP4:
//   repositorioPostgres(pool)  el real: tablas del esquema report, KPIs en SQL
//   repositorioMemoria()       sin base de datos: para las pruebas y para
//                              reconstruir los KPIs desde cero (replay)
// kpis.js usa cualquiera de los dos sin saber cuál es.
import { enTransaccion } from '../shared/db.js';
import { ESTADOS } from '../shared/dto.js';
import { ACTIVOS } from '../shared/estados.js';

const redondear = n => Math.round(n * 10) / 10;

// Arma la respuesta del lead time a partir de una fila por sucursal
// ({ sucursalId, pedidos, minutos }). Lo usan los dos adaptadores.
function armarLeadTime(filas) {
  const pedidos = filas.reduce((s, f) => s + f.pedidos, 0);
  const minutos = filas.reduce((s, f) => s + f.minutos * f.pedidos, 0);
  return {
    pedidos,
    promedioMin: pedidos ? redondear(minutos / pedidos) : null,
    porSucursal: filas.map(f => ({ sucursalId: f.sucursalId, pedidos: f.pedidos, promedioMin: redondear(f.minutos) })),
  };
}

// Arma el resumen a partir de una fila por estado ({ estado, pedidos, monto }).
// Lo usan los dos adaptadores.
function armarResumen(filas, eventosAplicados) {
  const porEstado = Object.fromEntries(ESTADOS.map(e => [e, 0]));
  for (const f of filas) porEstado[f.estado] = f.pedidos;
  return {
    pedidos: filas.reduce((s, f) => s + f.pedidos, 0),
    porEstado,
    ventas: filas.filter(f => f.estado !== 'CANCELADO').reduce((s, f) => s + f.monto, 0),
    eventosAplicados,
  };
}

// ---------------------------------------------------------------- PostgreSQL

// Las escrituras de aplicarEvento, todas con la conexión de la transacción
function escrituraPostgres(db) {
  return {
    async yaAplicado(eventId) {
      const { rowCount } = await db.query('SELECT 1 FROM report.eventos_aplicados WHERE event_id = $1', [eventId]);
      return rowCount > 0;
    },
    // FOR UPDATE bloquea la fila del pedido hasta el COMMIT: si durante un
    // rebalanceo dos instancias reciben eventos del mismo pedido, la segunda
    // espera a la primera
    async estadoDe(pedidoId) {
      const { rows } = await db.query('SELECT estado FROM report.pedidos WHERE pedido_id = $1 FOR UPDATE', [pedidoId]);
      return rows[0]?.estado ?? null;
    },
    // Si dos instancias insertan el mismo eventId a la vez, la llave primaria
    // rechaza la segunda; el consumidor reintenta y ahí ya sale 'duplicado'
    async registrarEvento(e) {
      await db.query(
        'INSERT INTO report.eventos_aplicados (event_id, pedido_id, tipo) VALUES ($1, $2, $3)',
        [e.eventId, e.pedidoId, e.tipo],
      );
    },
    async crearPedido(e) {
      await db.query(
        `INSERT INTO report.pedidos
           (pedido_id, cliente_id, estado, total, canal, comuna, sucursal_id, creado_en, actualizado_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [e.pedidoId, e.clienteId, e.estadoNuevo, e.total, e.canal, e.comuna, e.sucursalId, e.fecha],
      );
      for (const it of e.items) {
        // si un producto viene dos veces en el mismo pedido, se suman las cantidades
        await db.query(
          `INSERT INTO report.items (pedido_id, producto_id, nombre, categoria, cantidad, precio_unitario)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (pedido_id, producto_id) DO UPDATE SET cantidad = report.items.cantidad + EXCLUDED.cantidad`,
          [e.pedidoId, it.productoId, it.nombre, it.categoria, it.cantidad, it.precioUnitario],
        );
      }
    },
    async cambiarEstado(e) {
      await db.query(
        `UPDATE report.pedidos SET
           estado = $2,
           actualizado_en = $3,
           entregado_en = CASE WHEN $2 = 'ENTREGADO' THEN $3 ELSE entregado_en END,
           cancelado_en = CASE WHEN $2 = 'CANCELADO' THEN $3 ELSE cancelado_en END
         WHERE pedido_id = $1`,
        [e.pedidoId, e.estadoNuevo, e.fecha],
      );
    },
  };
}

export function repositorioPostgres(pool) {
  return {
    // todo lo que hace aplicarEvento va en una sola transacción
    enTransaccion: fn => enTransaccion(pool, conexion => fn(escrituraPostgres(conexion))),

    async ventasPorHora() {
      const { rows } = await pool.query(`
        SELECT date_trunc('hour', creado_en) AS hora, count(*)::int AS pedidos, sum(total)::int AS ventas
        FROM report.pedidos
        WHERE estado <> 'CANCELADO'
        GROUP BY 1
        ORDER BY 1`);
      return rows.map(f => ({ ...f, hora: f.hora.toISOString() }));
    },

    async topProductos(limite) {
      const { rows } = await pool.query(`
        SELECT i.producto_id AS "productoId", i.nombre, i.categoria,
               sum(i.cantidad)::int AS unidades,
               sum(i.cantidad * i.precio_unitario)::int AS monto
        FROM report.items i
        JOIN report.pedidos p USING (pedido_id)
        WHERE p.estado <> 'CANCELADO'
        GROUP BY i.producto_id, i.nombre, i.categoria
        ORDER BY unidades DESC, monto DESC, i.producto_id
        LIMIT $1`, [limite]);
      return rows;
    },

    async pedidosActivos() {
      const { rows } = await pool.query(`
        SELECT estado, count(*)::int AS pedidos
        FROM report.pedidos
        WHERE estado = ANY($1)
        GROUP BY estado`, [ACTIVOS]);
      return ACTIVOS.map(estado => ({ estado, pedidos: rows.find(f => f.estado === estado)?.pedidos ?? 0 }));
    },

    async leadTime() {
      const { rows } = await pool.query(`
        SELECT sucursal_id AS "sucursalId", count(*)::int AS pedidos,
               avg(extract(epoch FROM entregado_en - creado_en) / 60)::float8 AS minutos
        FROM report.pedidos
        WHERE estado = 'ENTREGADO'
        GROUP BY sucursal_id
        ORDER BY sucursal_id`);
      return armarLeadTime(rows);
    },

    async resumen() {
      const { rows } = await pool.query(`
        SELECT estado, count(*)::int AS pedidos, sum(total)::int AS monto
        FROM report.pedidos
        GROUP BY estado`);
      const { rows: [{ eventos }] } = await pool.query('SELECT count(*)::int AS eventos FROM report.eventos_aplicados');
      return armarResumen(rows, eventos);
    },
  };
}

// ---------------------------------------------------------------- memoria

export function repositorioMemoria() {
  const pedidos = new Map();     // pedidoId -> pedido
  const aplicados = new Set();   // eventIds ya aplicados

  const escritura = {
    yaAplicado: async eventId => aplicados.has(eventId),
    estadoDe: async pedidoId => pedidos.get(pedidoId)?.estado ?? null,
    registrarEvento: async e => { aplicados.add(e.eventId); },
    crearPedido: async e => {
      const items = new Map();
      for (const it of e.items) {
        const previo = items.get(it.productoId);
        items.set(it.productoId, { ...it, cantidad: (previo?.cantidad ?? 0) + it.cantidad });
      }
      pedidos.set(e.pedidoId, {
        pedidoId: e.pedidoId,
        estado: e.estadoNuevo,
        total: e.total,
        sucursalId: e.sucursalId,
        creadoEn: e.fecha,
        entregadoEn: null,
        items: [...items.values()],
      });
    },
    cambiarEstado: async e => {
      const pedido = pedidos.get(e.pedidoId);
      pedido.estado = e.estadoNuevo;
      if (e.estadoNuevo === 'ENTREGADO') pedido.entregadoEn = e.fecha;
    },
  };

  const vigentes = () => [...pedidos.values()].filter(p => p.estado !== 'CANCELADO');

  return {
    // En memoria no hay transacciones, y no hacen falta: aplicarEvento revisa
    // todo antes de escribir, así un error nunca deja nada a medias
    enTransaccion: fn => fn(escritura),

    async ventasPorHora() {
      const porHora = new Map();
      for (const p of vigentes()) {
        const hora = new Date(p.creadoEn);
        hora.setUTCMinutes(0, 0, 0);
        const fila = porHora.get(hora.toISOString()) ?? { hora: hora.toISOString(), pedidos: 0, ventas: 0 };
        fila.pedidos++;
        fila.ventas += p.total;
        porHora.set(fila.hora, fila);
      }
      return [...porHora.values()].sort((a, b) => a.hora.localeCompare(b.hora));
    },

    async topProductos(limite) {
      const porProducto = new Map();
      for (const p of vigentes()) {
        for (const it of p.items) {
          const fila = porProducto.get(it.productoId)
            ?? { productoId: it.productoId, nombre: it.nombre, categoria: it.categoria, unidades: 0, monto: 0 };
          fila.unidades += it.cantidad;
          fila.monto += it.cantidad * it.precioUnitario;
          porProducto.set(it.productoId, fila);
        }
      }
      return [...porProducto.values()]
        .sort((a, b) => b.unidades - a.unidades || b.monto - a.monto || a.productoId.localeCompare(b.productoId))
        .slice(0, limite);
    },

    async pedidosActivos() {
      const todos = [...pedidos.values()];
      return ACTIVOS.map(estado => ({ estado, pedidos: todos.filter(p => p.estado === estado).length }));
    },

    async leadTime() {
      const porSucursal = new Map();
      for (const p of pedidos.values()) {
        if (p.estado !== 'ENTREGADO') continue;
        const fila = porSucursal.get(p.sucursalId) ?? { sucursalId: p.sucursalId, pedidos: 0, suma: 0 };
        fila.pedidos++;
        fila.suma += (Date.parse(p.entregadoEn) - Date.parse(p.creadoEn)) / 60000;
        porSucursal.set(p.sucursalId, fila);
      }
      const filas = [...porSucursal.values()]
        .sort((a, b) => a.sucursalId.localeCompare(b.sucursalId))
        .map(f => ({ sucursalId: f.sucursalId, pedidos: f.pedidos, minutos: f.suma / f.pedidos }));
      return armarLeadTime(filas);
    },

    async resumen() {
      const porEstado = new Map();
      for (const p of pedidos.values()) {
        const fila = porEstado.get(p.estado) ?? { estado: p.estado, pedidos: 0, monto: 0 };
        fila.pedidos++;
        fila.monto += p.total;
        porEstado.set(p.estado, fila);
      }
      return armarResumen([...porEstado.values()], aplicados.size);
    },
  };
}