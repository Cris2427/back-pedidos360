// Repositorio de audit: guarda los registros del timeline y los busca.
// Dos adaptadores con los mismos métodos, igual que en report:
//   repositorioPostgres(pool)  tabla audit.registros
//   repositorioMemoria()       sin base de datos, para las pruebas
// Un registro nunca se modifica ni se borra: solo se agregan.

// La forma en que la API entrega un registro (sin el campo version del mensaje)
const paraApi = r => ({
  eventId: r.eventId,
  pedidoId: r.pedidoId,
  quien: r.quien,
  que: r.que,
  cuando: r.cuando,
  desdeDonde: r.desdeDonde,
  estadoAnterior: r.estadoAnterior,
  estadoNuevo: r.estadoNuevo,
  detalle: r.detalle,
});

// ---------------------------------------------------------------- PostgreSQL

// Una fila de audit.registros, de vuelta a la forma del registro
const filaARegistro = f => paraApi({
  eventId: f.event_id,
  pedidoId: f.pedido_id,
  quien: { usuarioId: f.usuario_id, rol: f.rol },
  que: f.que,
  cuando: f.cuando.toISOString(),
  desdeDonde: { canal: f.canal, comuna: f.comuna, sucursalId: f.sucursal_id },
  estadoAnterior: f.estado_anterior,
  estadoNuevo: f.estado_nuevo,
  detalle: f.detalle,
});

export function repositorioPostgres(pool) {
  return {
    // ON CONFLICT DO NOTHING: si el registro ya estaba (audit lo publicó dos
    // veces), no se guarda de nuevo y rowCount queda en 0
    async guardar(r) {
      const { rowCount } = await pool.query(
        `INSERT INTO audit.registros
           (event_id, pedido_id, que, estado_anterior, estado_nuevo, usuario_id, rol,
            cuando, canal, comuna, sucursal_id, detalle)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (event_id) DO NOTHING`,
        [r.eventId, r.pedidoId, r.que, r.estadoAnterior, r.estadoNuevo, r.quien.usuarioId, r.quien.rol,
          r.cuando, r.desdeDonde.canal, r.desdeDonde.comuna, r.desdeDonde.sucursalId, r.detalle],
      );
      return rowCount === 1 ? 'guardado' : 'duplicado';
    },

    async historial(pedidoId) {
      const { rows } = await pool.query(
        'SELECT * FROM audit.registros WHERE pedido_id = $1 ORDER BY cuando, event_id',
        [pedidoId],
      );
      return rows.map(filaARegistro);
    },

    // Cada filtro se agrega solo si viene. Los valores van como parámetros
    // ($1, $2...), nunca pegados al texto del SQL: así no hay inyección SQL.
    async buscar({ usuario, que, desde, hasta, limite }) {
      const condiciones = [];
      const valores = [];
      const filtrar = (columna, operador, valor) => {
        valores.push(valor);
        condiciones.push(`${columna} ${operador} $${valores.length}`);
      };
      if (usuario) filtrar('usuario_id', '=', usuario);
      if (que) filtrar('que', '=', que);
      if (desde) filtrar('cuando', '>=', desde);
      if (hasta) filtrar('cuando', '<=', hasta);
      valores.push(limite);
      const { rows } = await pool.query(
        `SELECT * FROM audit.registros
         ${condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : ''}
         ORDER BY cuando DESC, event_id
         LIMIT $${valores.length}`,
        valores,
      );
      return rows.map(filaARegistro);
    },
  };
}

// ---------------------------------------------------------------- memoria

export function repositorioMemoria() {
  const registros = new Map(); // eventId -> registro

  return {
    async guardar(r) {
      if (registros.has(r.eventId)) return 'duplicado';
      registros.set(r.eventId, paraApi(r));
      return 'guardado';
    },

    async historial(pedidoId) {
      return [...registros.values()]
        .filter(r => r.pedidoId === pedidoId)
        .sort((a, b) => a.cuando.localeCompare(b.cuando) || a.eventId.localeCompare(b.eventId));
    },

    async buscar({ usuario, que, desde, hasta, limite }) {
      return [...registros.values()]
        .filter(r => !usuario || r.quien.usuarioId === usuario)
        .filter(r => !que || r.que === que)
        .filter(r => !desde || r.cuando >= desde)
        .filter(r => !hasta || r.cuando <= hasta)
        .sort((a, b) => b.cuando.localeCompare(a.cuando) || a.eventId.localeCompare(b.eventId))
        .slice(0, limite);
    },
  };
}