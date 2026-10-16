// pruebas de las 10 lambdas sin desplegar nada:
//   node test-local.mjs
// arma eventos como los que manda el api gateway y usa el store en memoria,
// asi que no necesita credenciales de aws ni internet

// esto va antes de importar los handlers porque cada uno arma su store al
// cargarse
process.env.STORE = 'memory';

// los handlers avisan en el log cada evento que publican; en las pruebas eso
// solo mete ruido entre los resultados
const logOriginal = console.log;
console.log = (...a) => {
  if (!String(a[0]).startsWith('evento ')) logOriginal(...a);
};

// por lo mismo el import es dinamico: uno normal se evalua antes que la
// linea de arriba y los handlers terminarian usando dynamodb
const h = {
  catalogGet: (await import('./handlers/catalog-get.mjs')).handler,
  catalogPost: (await import('./handlers/catalog-post.mjs')).handler,
  catalogPut: (await import('./handlers/catalog-put.mjs')).handler,
  catalogStock: (await import('./handlers/catalog-stock-put.mjs')).handler,
  catalogDelete: (await import('./handlers/catalog-delete.mjs')).handler,
  ordersGet: (await import('./handlers/orders-get.mjs')).handler,
  ordersPost: (await import('./handlers/orders-post.mjs')).handler,
  ordersPut: (await import('./handlers/orders-put.mjs')).handler,
  ordersStatus: (await import('./handlers/orders-status-patch.mjs')).handler,
  ordersDelete: (await import('./handlers/orders-delete.mjs')).handler,
};

// los handlers comparten la misma instancia del store, igual que en aws
// comparten dynamodb
const { crearStore } = await import('./lib/store.mjs');
const compartido = crearStore();

const SCOPES = 'orders.read orders.write catalog.read catalog.write';

const ADMIN = { roles: '[Admin]', user: 'admin@duoc.cl' };
const OPERADOR = { roles: '[Operador]', user: 'operador@duoc.cl' };
const CLIENTE = { roles: '[Cliente]', user: 'cliente@duoc.cl' };
const OTRO_CLIENTE = { roles: '[Cliente]', user: 'otro@duoc.cl' };

// evento como los que manda el api gateway, con los claims en texto igual
// que en aws
const ev = (method, rawPath, opts = {}) => {
  const { body, id, params, scp = SCOPES, roles = '[Admin]', user = 'x@duoc.cl' } = opts;
  return {
    rawPath,
    pathParameters: params ?? (id ? { id } : undefined),
    body: body ? JSON.stringify(body) : undefined,
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { scp, roles, preferred_username: user } } },
    },
  };
};

let fallos = 0;
const call = async (etiqueta, fn, event, esperado) => {
  const res = await fn(event);
  const ok = esperado === undefined || res.statusCode === esperado;
  if (!ok) fallos++;
  const cuerpo = res.body ? JSON.parse(res.body) : null;
  const extra = ok ? '' : `  <-- se esperaba ${esperado}: ${JSON.stringify(cuerpo)}`;
  console.log(`${ok ? 'OK ' : 'FAIL'} ${String(res.statusCode).padEnd(3)} ${etiqueta}${extra}`);
  return { status: res.statusCode, body: cuerpo };
};

const comprobar = (etiqueta, condicion, detalle) => {
  if (!condicion) fallos++;
  console.log(`${condicion ? 'OK ' : 'FAIL'}     ${etiqueta}${detalle ? ` (${detalle})` : ''}`);
};

const stockDe = async (id) => (await compartido.obtenerProducto(id)).stock;

// ===========================================================================
console.log('\n== Scopes: sin el scope no se entra, aunque el rol sea correcto ==');
await call('GET /api/catalog sin catalog.read', h.catalogGet,
  ev('GET', '/api/catalog', { ...ADMIN, scp: 'orders.read' }), 403);
await call('GET /api/catalog con scope', h.catalogGet, ev('GET', '/api/catalog', ADMIN), 200);

console.log('\n== Catálogo: lo administra el Admin ==');
await call('POST /api/catalog como Operador', h.catalogPost,
  ev('POST', '/api/catalog', { ...OPERADOR, body: { nombre: 'X', precio: 1, stock: 1 } }), 403);
await call('POST /api/catalog como Cliente', h.catalogPost,
  ev('POST', '/api/catalog', { ...CLIENTE, body: { nombre: 'X', precio: 1, stock: 1 } }), 403);
await call('POST /api/catalog con precio negativo', h.catalogPost,
  ev('POST', '/api/catalog', { ...ADMIN, body: { nombre: 'X', precio: -5, stock: 1 } }), 400);
const nuevo = await call('POST /api/catalog como Admin', h.catalogPost,
  ev('POST', '/api/catalog', { ...ADMIN, body: { nombre: 'Monitor 27"', precio: 199990, stock: 5 } }), 201);
await call('PUT /api/catalog/{id}', h.catalogPut,
  ev('PUT', `/api/catalog/${nuevo.body.id}`, { ...ADMIN, id: nuevo.body.id, body: { nombre: 'Monitor 27" QHD', precio: 219990, stock: 5 } }), 200);
await call('PUT /api/catalog/{id}/stock', h.catalogStock,
  ev('PUT', `/api/catalog/${nuevo.body.id}/stock`, { ...ADMIN, id: nuevo.body.id, body: { stock: 42 } }), 200);
await call('PUT stock como Operador', h.catalogStock,
  ev('PUT', `/api/catalog/${nuevo.body.id}/stock`, { ...OPERADOR, id: nuevo.body.id, body: { stock: 1 } }), 403);
await call('DELETE /api/catalog/{id} como Admin', h.catalogDelete,
  ev('DELETE', `/api/catalog/${nuevo.body.id}`, { ...ADMIN, id: nuevo.body.id }), 200);
await call('DELETE de un producto inexistente', h.catalogDelete,
  ev('DELETE', '/api/catalog/no-existe', { ...ADMIN, id: 'no-existe' }), 404);

console.log('\n== Pedidos: el CRUD es del Cliente y del Operador, NO del Admin ==');
await call('GET /api/orders como Admin', h.ordersGet, ev('GET', '/api/orders', ADMIN), 403);
await call('POST /api/orders como Admin', h.ordersPost,
  ev('POST', '/api/orders', { ...ADMIN, body: { items: [{ productoId: 'p-001', cantidad: 1 }] } }), 403);
await call('PATCH estado como Admin', h.ordersStatus,
  ev('PATCH', '/api/orders/x/status', { ...ADMIN, id: 'x', body: { estado: 'ACEPTADO' } }), 403);

const pedido = await call('POST /api/orders como Cliente', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { clienteId: 'INTENTO-SUPLANTAR', items: [{ productoId: 'p-001', cantidad: 2 }] } }), 201);
comprobar('el servidor ignora el clienteId del cuerpo', pedido.body.clienteId === CLIENTE.user, pedido.body.clienteId);
comprobar('el servidor recalcula el total', pedido.body.total === 999980, pedido.body.total);

console.log('\n== Regla: el stock decrece al ACEPTAR, no al crear ==');
comprobar('stock intacto tras crear', (await stockDe('p-001')) === 8, `stock = ${await stockDe('p-001')}`);

const id = pedido.body.id;
await call('PATCH CREADO -> DESPACHADO (no se despacha sin aceptar)', h.ordersStatus,
  ev('PATCH', `/api/orders/${id}/status`, { ...OPERADOR, id, body: { estado: 'DESPACHADO' } }), 409);
await call('PATCH como Cliente (no cambia estados)', h.ordersStatus,
  ev('PATCH', `/api/orders/${id}/status`, { ...CLIENTE, id, body: { estado: 'ACEPTADO' } }), 403);
await call('PATCH CREADO -> ACEPTADO como Operador', h.ordersStatus,
  ev('PATCH', `/api/orders/${id}/status`, { ...OPERADOR, id, body: { estado: 'ACEPTADO' } }), 200);
comprobar('stock descontado al aceptar', (await stockDe('p-001')) === 6, `stock = ${await stockDe('p-001')}`);

console.log('\n== Editar y borrar solo mientras no haya stock comprometido ==');
await call('PUT /api/orders/{id} ya aceptado', h.ordersPut,
  ev('PUT', `/api/orders/${id}`, { ...CLIENTE, id, body: { items: [{ productoId: 'p-001', cantidad: 1 }] } }), 409);
await call('DELETE /api/orders/{id} ya aceptado', h.ordersDelete,
  ev('DELETE', `/api/orders/${id}`, { ...CLIENTE, id }), 409);

console.log('\n== Resto del ciclo de estados ==');
await call('ACEPTADO -> EN_PREPARACION', h.ordersStatus,
  ev('PATCH', `/api/orders/${id}/status`, { ...OPERADOR, id, body: { estado: 'EN_PREPARACION' } }), 200);
await call('EN_PREPARACION -> DESPACHADO', h.ordersStatus,
  ev('PATCH', `/api/orders/${id}/status`, { ...OPERADOR, id, body: { estado: 'DESPACHADO' } }), 200);
await call('DESPACHADO -> ENTREGADO', h.ordersStatus,
  ev('PATCH', `/api/orders/${id}/status`, { ...OPERADOR, id, body: { estado: 'ENTREGADO' } }), 200);
await call('ENTREGADO -> CANCELADO (estado terminal)', h.ordersStatus,
  ev('PATCH', `/api/orders/${id}/status`, { ...OPERADOR, id, body: { estado: 'CANCELADO' } }), 409);

console.log('\n== Cancelar devuelve el stock solo si se había descontado ==');
const p2 = await call('POST /api/orders', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [{ productoId: 'p-002', cantidad: 3 }] } }), 201);
await call('CREADO -> CANCELADO (nunca se aceptó)', h.ordersStatus,
  ev('PATCH', `/api/orders/${p2.body.id}/status`, { ...OPERADOR, id: p2.body.id, body: { estado: 'CANCELADO' } }), 200);
comprobar('stock de p-002 sin tocar', (await stockDe('p-002')) === 40, `stock = ${await stockDe('p-002')}`);

const p3 = await call('POST /api/orders', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [{ productoId: 'p-003', cantidad: 4 }] } }), 201);
await call('-> ACEPTADO', h.ordersStatus,
  ev('PATCH', `/api/orders/${p3.body.id}/status`, { ...OPERADOR, id: p3.body.id, body: { estado: 'ACEPTADO' } }), 200);
comprobar('stock de p-003 descontado', (await stockDe('p-003')) === 8, `stock = ${await stockDe('p-003')}`);
await call('ACEPTADO -> CANCELADO', h.ordersStatus,
  ev('PATCH', `/api/orders/${p3.body.id}/status`, { ...OPERADOR, id: p3.body.id, body: { estado: 'CANCELADO' } }), 200);
comprobar('stock de p-003 devuelto', (await stockDe('p-003')) === 12, `stock = ${await stockDe('p-003')}`);

console.log('\n== Un Cliente solo ve y toca sus propios pedidos ==');
const mios = await call('GET /api/orders como Cliente', h.ordersGet, ev('GET', '/api/orders', CLIENTE), 200);
const ajenos = await call('GET /api/orders como otro Cliente', h.ordersGet, ev('GET', '/api/orders', OTRO_CLIENTE), 200);
const todos = await call('GET /api/orders como Operador', h.ordersGet, ev('GET', '/api/orders', OPERADOR), 200);
comprobar('el Operador los ve todos', todos.body.length === 3, `${todos.body.length} pedidos`);
comprobar('el Cliente ve solo los suyos', mios.body.length === 3, `${mios.body.length} pedidos`);
comprobar('otro Cliente no ve ninguno', ajenos.body.length === 0, `${ajenos.body.length} pedidos`);

const p4 = await call('POST /api/orders', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [{ productoId: 'p-002', cantidad: 1 }] } }), 201);
await call('PUT de un pedido ajeno (404, no se revela que existe)', h.ordersPut,
  ev('PUT', `/api/orders/${p4.body.id}`, { ...OTRO_CLIENTE, id: p4.body.id, body: { items: [{ productoId: 'p-002', cantidad: 9 }] } }), 404);
await call('DELETE de un pedido ajeno', h.ordersDelete,
  ev('DELETE', `/api/orders/${p4.body.id}`, { ...OTRO_CLIENTE, id: p4.body.id }), 404);
await call('PUT del propio pedido en CREADO', h.ordersPut,
  ev('PUT', `/api/orders/${p4.body.id}`, { ...CLIENTE, id: p4.body.id, body: { items: [{ productoId: 'p-002', cantidad: 5 }] } }), 200);
await call('DELETE del propio pedido en CREADO', h.ordersDelete,
  ev('DELETE', `/api/orders/${p4.body.id}`, { ...CLIENTE, id: p4.body.id }), 200);

console.log('\n== Validaciones y stock insuficiente ==');
await call('POST con cantidad 0', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [{ productoId: 'p-001', cantidad: 0 }] } }), 400);
await call('POST sin ítems', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [] } }), 400);
await call('POST de un producto inexistente', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [{ productoId: 'p-999', cantidad: 1 }] } }), 400);
await call('POST con más stock del que hay', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [{ productoId: 'p-001', cantidad: 999 }] } }), 409);

console.log('\n== El claim `roles` tal como lo entrega el API Gateway ==');
await call('roles "[Admin, Operador]" en catálogo', h.catalogPost,
  ev('POST', '/api/catalog', { roles: '[Admin, Operador]', user: 'a@b.cl', body: { nombre: 'Z', precio: 1, stock: 1 } }), 201);
await call('roles "[Operador Cliente]" en catálogo (sin Admin)', h.catalogPost,
  ev('POST', '/api/catalog', { roles: '[Operador Cliente]', user: 'a@b.cl', body: { nombre: 'Z', precio: 1, stock: 1 } }), 403);
await call('sin roles', h.ordersGet, ev('GET', '/api/orders', { roles: '', user: 'a@b.cl' }), 403);

// el contador arranca desde el mayor id que ya existe
// nada de regex armadas con template literal: ahi \d se convierte en d y
// deja de calzar sin avisar
console.log('\n== Numeracion correlativa de ids ==');
const pa = await call('POST /api/catalog', h.catalogPost,
  ev('POST', '/api/catalog', { ...ADMIN, body: { nombre: 'Uno', precio: 100, stock: 1 } }), 201);
const pb = await call('POST /api/catalog', h.catalogPost,
  ev('POST', '/api/catalog', { ...ADMIN, body: { nombre: 'Dos', precio: 100, stock: 1 } }), 201);
const oa = await call('POST /api/orders', h.ordersPost,
  ev('POST', '/api/orders', { ...CLIENTE, body: { items: [{ productoId: 'p-002', cantidad: 1 }] } }), 201);
const num = (id) => Number(String(id).split('-')[1]);
comprobar('formato prefijo-NNN en productos', /^p-[0-9]{3,}$/.test(pa.body.id), pa.body.id);
comprobar('formato prefijo-NNN en pedidos', /^o-[0-9]{3,}$/.test(oa.body.id), oa.body.id);
comprobar('el segundo producto es el correlativo siguiente',
  num(pb.body.id) === num(pa.body.id) + 1, `${pa.body.id} -> ${pb.body.id}`);
comprobar('no choca con los ids sembrados (p-001..p-003)',
  num(pa.body.id) > 3, pa.body.id);

console.log('\n== Preflight ==');
await call('OPTIONS no lo bloquea el rol', h.ordersGet, ev('OPTIONS', '/api/orders', { roles: '' }), 204);

// ===========================================================================
// consumidores: eventos armados como los que entrega sqs, la dlq es una lista
// en memoria y los logs se capturan para revisar que cada decision quede escrita
const { dlqEnMemoria, crearConsumidor } = await import('./lib/mensajeria.mjs');
const { config } = await import('./lib/config.mjs');
const email = await import('./consumers/notificar-email.mjs');
const bodega = await import('./consumers/preparar-pedido.mjs');
const boleta = await import('./consumers/generar-boleta.mjs');

let nMsg = 0;
const sqsEvent = (...cuerpos) => ({
  Records: cuerpos.map((c) => ({
    messageId: `m-${++nMsg}`,
    body: typeof c === 'string' ? c : JSON.stringify(c),
    attributes: { ApproximateReceiveCount: '1' },
  })),
});
const evento = (type, extra = {}) => ({
  type, eventId: `e-${++nMsg}`, pedidoId: 'o-900', clienteId: 'cliente@duoc.cl', ...extra,
});
const notifs = async (canal) => (await compartido.listarNotificaciones()).filter((n) => n.canal === canal);

const capturarLogs = async (fn) => {
  const lineas = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lineas.push(a.join(' '));
  try {
    return { res: await fn(), lineas };
  } finally {
    Object.assign(console, original);
  }
};

// la decision se deduce de lo que devuelve el handler y de la dlq, y ademas
// tiene que quedar escrita en el log
const consumir = async (etiqueta, handler, event, esperado) => {
  const antes = dlqEnMemoria.length;
  const { res, lineas } = await capturarLogs(() => handler(event));
  const decision = res.batchItemFailures.length > 0 ? 'reintento'
    : dlqEnMemoria.length > antes ? 'dlq' : 'ack';
  const enLog = lineas.some((l) => l.includes(` ${decision.toUpperCase()} `));
  comprobar(`${etiqueta}: ${esperado}`, decision === esperado && enLog, enLog ? decision : `${decision}, sin log`);
};

console.log('\n== Consumidores: ACK, reintento y DLQ ==');
const creado = evento('PedidoCreado');
await consumir('correo de PedidoCreado', email.handler, sqsEvent(creado), 'ack');
await consumir('el mismo mensaje entregado dos veces', email.handler, sqsEvent(creado), 'ack');
comprobar('idempotencia: un solo correo registrado', (await notifs('email')).length === 1,
  `${(await notifs('email')).length} correo(s)`);
await consumir('cuerpo que no es JSON', email.handler, sqsEvent('esto no es json'), 'dlq');
await consumir('evento sin eventId', email.handler,
  sqsEvent({ type: 'PedidoCreado', pedidoId: 'o-900', clienteId: 'x@duoc.cl' }), 'dlq');
await consumir('correo sin clienteId', email.handler, sqsEvent(evento('PedidoCreado', { clienteId: undefined })), 'dlq');
await consumir('tipo de evento desconocido', email.handler, sqsEvent(evento('PedidoRaro')), 'dlq');
comprobar('la DLQ guarda el motivo', String(dlqEnMemoria.at(-1)?.motivo).includes('desconocido'),
  dlqEnMemoria.at(-1)?.motivo);

config.mensajeria.simularCaida = true;
const antesCaida = dlqEnMemoria.length;
await consumir('servicio caído (recuperable)', email.handler, sqsEvent(evento('PedidoAceptado')), 'reintento');
comprobar('un error recuperable no va directo a la DLQ', dlqEnMemoria.length === antesCaida);
config.mensajeria.simularCaida = false;

// lote de dos: solo se devuelve el que fallo, el otro se confirma
const parcial = crearConsumidor('prueba-lote', async (e) => {
  if (e.pedidoId === 'o-falla') throw new Error('timeout de un servicio');
  return 'ok';
});
const lote = sqsEvent(evento('PedidoCreado'), evento('PedidoCreado', { pedidoId: 'o-falla' }));
const { res: resLote } = await capturarLogs(() => parcial(lote));
comprobar('en un lote solo se reintenta el mensaje que falló',
  resLote.batchItemFailures.length === 1 &&
    resLote.batchItemFailures[0].itemIdentifier === lote.Records[1].messageId,
  JSON.stringify(resLote.batchItemFailures));

const dlqCaida = crearConsumidor('prueba-dlq-caida', email.procesar, {
  enviarADlq: async () => { throw new Error('la DLQ no responde'); },
});
await consumir('si la DLQ no responde, se reintenta en vez de perderlo', dlqCaida, sqsEvent('roto'), 'reintento');

console.log('\n== Bodega y facturación ==');
const items = [{ productoId: 'p-001', nombre: 'Notebook 14"', cantidad: 2, precio: 499990 }];
await consumir('orden de preparación de PedidoAceptado', bodega.handler,
  sqsEvent(evento('PedidoAceptado', { pedidoId: 'o-901', items })), 'ack');
const ordenes = await notifs('bodega');
comprobar('la orden lista lo que hay que preparar', ordenes[0]?.detalle?.[0] === '2 x Notebook 14"',
  ordenes[0]?.detalle?.[0]);
await consumir('el mismo pedido aceptado otra vez (otro eventId)', bodega.handler,
  sqsEvent(evento('PedidoAceptado', { pedidoId: 'o-901', items })), 'ack');
comprobar('idempotencia: una sola orden por pedido', (await notifs('bodega')).length === 1,
  `${(await notifs('bodega')).length} orden(es)`);
await consumir('bodega rechaza un PedidoDespachado', bodega.handler,
  sqsEvent(evento('PedidoDespachado', { items })), 'dlq');
await consumir('pedido aceptado sin ítems', bodega.handler, sqsEvent(evento('PedidoAceptado', { items: [] })), 'dlq');

await consumir('boleta de PedidoDespachado', boleta.handler,
  sqsEvent(evento('PedidoDespachado', { pedidoId: 'o-902', total: 119000 })), 'ack');
const b = (await notifs('boleta'))[0]?.boleta;
comprobar('la boleta desglosa el IVA', b?.neto === 100000 && b?.iva === 19000 && b?.total === 119000,
  JSON.stringify(b));
await consumir('boleta con total inválido', boleta.handler,
  sqsEvent(evento('PedidoDespachado', { total: 'abc' })), 'dlq');

console.log('\n== Productor: la API publica los eventos ==');
{
  const { eventosEnMemoria, publicador } = await import('./lib/mensajeria.mjs');
  eventosEnMemoria.length = 0; // los de las secciones anteriores no cuentan
  const ultimo = () => eventosEnMemoria.at(-1);
  const cuerpo = { items: [{ productoId: 'p-002', cantidad: 1 }] };

  const creadoRes = await call('POST /api/orders', h.ordersPost,
    ev('POST', '/api/orders', { ...CLIENTE, body: cuerpo }), 201);
  const pid = creadoRes.body.id;
  comprobar('crear un pedido publica PedidoCreado',
    eventosEnMemoria.length === 1 && ultimo().type === 'PedidoCreado' && ultimo().pedidoId === pid,
    ultimo()?.type);
  comprobar('el evento trae lo que necesitan los consumidores',
    ultimo().clienteId === CLIENTE.user && ultimo().total === creadoRes.body.total &&
      Boolean(ultimo().items?.[0]?.nombre) && Boolean(ultimo().eventId),
    `${ultimo().clienteId}, ${ultimo().items?.[0]?.nombre}, total ${ultimo().total}`);

  const patch = (estado, quien = OPERADOR) =>
    ev('PATCH', `/api/orders/${pid}/status`, { ...quien, id: pid, body: { estado } });

  const cuenta = eventosEnMemoria.length;
  await call('PATCH como Cliente', h.ordersStatus, patch('ACEPTADO', CLIENTE), 403);
  await call('PATCH CREADO -> DESPACHADO', h.ordersStatus, patch('DESPACHADO'), 409);
  comprobar('un cambio rechazado no publica nada', eventosEnMemoria.length === cuenta);

  for (const [estado, tipo] of [
    ['ACEPTADO', 'PedidoAceptado'],
    ['EN_PREPARACION', 'PedidoEnPreparacion'],
    ['DESPACHADO', 'PedidoDespachado'],
    ['ENTREGADO', 'PedidoEntregado'],
  ]) {
    await call(`PATCH -> ${estado}`, h.ordersStatus, patch(estado), 200);
    comprobar(`publica ${tipo}`, ultimo().type === tipo && ultimo().estado === estado, ultimo().type);
  }

  // sns caido: el pedido no puede depender de las notificaciones
  const original = publicador.enviar;
  publicador.enviar = async () => {
    throw new Error('SNS no responde');
  };
  const { res, lineas } = await capturarLogs(() =>
    h.ordersPost(ev('POST', '/api/orders', { ...CLIENTE, body: cuerpo })));
  publicador.enviar = original;
  const guardado = res.statusCode === 201 &&
    (await compartido.obtenerPedido(JSON.parse(res.body).id)) !== null;
  comprobar('si SNS falla, el pedido igual se crea', guardado, `HTTP ${res.statusCode}`);
  comprobar('y el error queda en el log', lineas.some((l) => l.includes('no se pudo publicar PedidoCreado')));
}

// usa lo que dejaron registrado los consumidores en las secciones anteriores
console.log('\n== Notificaciones: quién ve qué ==');
{
  const notifGet = (await import('./handlers/notifications-get.mjs')).handler;
  const pedir = async (quien) => JSON.parse((await notifGet(ev('GET', '/api/notifications', quien))).body);

  const canalesOp = new Set((await pedir(OPERADOR)).map((n) => n.canal));
  comprobar('el Operador ve los tres canales', ['email', 'bodega', 'boleta'].every((c) => canalesOp.has(c)),
    [...canalesOp].join(', '));

  const delCliente = await pedir(CLIENTE);
  comprobar('el Cliente ve sus correos y sus boletas',
    delCliente.some((n) => n.canal === 'email') && delCliente.some((n) => n.canal === 'boleta'));
  comprobar('pero no las órdenes de bodega, que son internas', !delCliente.some((n) => n.canal === 'bodega'));
  comprobar('y nada que sea de otro cliente', delCliente.every((n) => n.clienteId === CLIENTE.user));
  const deOtro = await pedir(OTRO_CLIENTE);
  comprobar('otro Cliente no ve las del primero', deOtro.every((n) => n.clienteId === OTRO_CLIENTE.user),
    `${deOtro.length} propias`);
  await call('el Admin no ve notificaciones de pedidos', notifGet, ev('GET', '/api/notifications', ADMIN), 403);

  // llegan en desorden: se procesa primero el evento mas viejo, pero despues
  const nueva = { canal: 'email', clienteId: 'orden@duoc.cl' };
  await compartido.guardarNotificacion({
    ...nueva, id: 'email#b', ocurridoEn: '2026-01-01T10:00:00.000Z', creadoEn: '2026-01-01T10:00:05.000Z',
  });
  await compartido.guardarNotificacion({
    ...nueva, id: 'email#a', ocurridoEn: '2026-01-01T09:00:00.000Z', creadoEn: '2026-01-01T10:00:09.000Z',
  });
  const orden = (await pedir({ roles: '[Cliente]', user: 'orden@duoc.cl' })).map((n) => n.id);
  comprobar('se ordenan por la hora del evento, no por la de llegada',
    orden[0] === 'email#b' && orden[1] === 'email#a', orden.join(' antes que '));
}

// ===========================================================================
// microservicio administrador: las mismas reglas que en aws, con el adaptador
// en memoria
console.log('\n== Administrador: permisos y validación ==');
{
  const imp = async (archivo) => (await import(`./handlers/${archivo}.mjs`)).handler;
  const a = {
    colasGet: await imp('admin-queues-get'),
    colasPost: await imp('admin-queues-post'),
    colasDelete: await imp('admin-queues-delete'),
    topicsGet: await imp('admin-topics-get'),
    topicsPost: await imp('admin-topics-post'),
    topicsDelete: await imp('admin-topics-delete'),
    bindingsGet: await imp('admin-bindings-get'),
    bindingsPost: await imp('admin-bindings-post'),
    bindingsDelete: await imp('admin-bindings-delete'),
  };
  const { simular } = (await import('./lib/admin-mensajeria.mjs')).crearAdminMensajeria();

  const CON_SCOPE = `${SCOPES} messaging.manage`;
  const req = (method, path, extra = {}) => ev(method, path, { ...ADMIN, scp: CON_SCOPE, ...extra });
  const crearCola = (body) => req('POST', '/api/admin/queues', { body });
  const crearTopic = (body) => req('POST', '/api/admin/topics', { body });
  const crearBinding = (body) => req('POST', '/api/admin/bindings', { body });
  const borrarCola = (nombre) => req('DELETE', `/api/admin/queues/${nombre}`, { params: { name: nombre } });
  const borrarTopic = (nombre) => req('DELETE', `/api/admin/topics/${nombre}`, { params: { name: nombre } });

  await call('Admin sin el scope messaging.manage', a.colasGet, ev('GET', '/api/admin/queues', { ...ADMIN }), 403);
  await call('Operador con el scope pero sin el rol', a.colasGet,
    ev('GET', '/api/admin/queues', { ...OPERADOR, scp: CON_SCOPE }), 403);

  await call('cola sin nombre', a.colasPost, crearCola({}), 400);
  await call('cola con espacios', a.colasPost, crearCola({ nombre: 'q mala' }), 400);
  await call('cola con tilde', a.colasPost, crearCola({ nombre: 'q-notificación' }), 400);
  await call('cola FIFO', a.colasPost, crearCola({ nombre: 'q-prueba.fifo' }), 400);
  await call('nombre terminado en -dlq', a.colasPost, crearCola({ nombre: 'q-prueba-dlq' }), 400);
  await call('77 caracteres (su DLQ pasaría de 80)', a.colasPost, crearCola({ nombre: 'q'.repeat(77) }), 400);
  await call('maxReceiveCount 0', a.colasPost, crearCola({ nombre: 'q-prueba', maxReceiveCount: 0 }), 400);
  await call('visibilidad negativa', a.colasPost, crearCola({ nombre: 'q-prueba', visibilidadSegundos: -1 }), 400);
  await call('campo con error de tipeo', a.colasPost, crearCola({ nombre: 'q-prueba', maxRecieveCount: 3 }), 400);
  await call('topic sin nombre', a.topicsPost, crearTopic({ nombre: '  ' }), 400);
  await call('nombre inválido en la ruta', a.colasDelete, borrarCola('q mala'), 400);

  console.log('\n== Administrador: crear colas, topics y bindings ==');
  const cola = await call('POST /api/admin/queues', a.colasPost, crearCola({ nombre: 'q-prueba', maxReceiveCount: 5 }), 201);
  comprobar('crea su DLQ con la redrive policy',
    cola.body.dlq?.nombre === 'q-prueba-dlq' && cola.body.maxReceiveCount === 5, cola.body.dlq?.nombre);
  comprobar('lo que no viene sale de la configuración', cola.body.visibilidadSegundos === 30,
    `visibilidad ${cola.body.visibilidadSegundos} s`);
  await call('la misma cola otra vez', a.colasPost, crearCola({ nombre: 'q-prueba' }), 409);
  const colas = await call('GET /api/admin/queues', a.colasGet, req('GET', '/api/admin/queues'), 200);
  comprobar('la DLQ aparece dentro de su cola, no suelta',
    colas.body.some((c) => c.nombre === 'q-prueba') && !colas.body.some((c) => c.nombre === 'q-prueba-dlq'));

  await call('POST /api/admin/topics', a.topicsPost, crearTopic({ nombre: 'eventos-prueba' }), 201);
  await call('el mismo topic otra vez', a.topicsPost, crearTopic({ nombre: 'eventos-prueba' }), 409);

  await call('binding a un topic que no existe', a.bindingsPost,
    crearBinding({ topic: 'no-existe', cola: 'q-prueba' }), 404);
  await call('binding a una cola que no existe', a.bindingsPost,
    crearBinding({ topic: 'eventos-prueba', cola: 'q-no-existe' }), 404);
  await call('filtro que no es una lista', a.bindingsPost,
    crearBinding({ topic: 'eventos-prueba', cola: 'q-prueba', filtro: { tipo_evento: 'PedidoAceptado' } }), 400);
  await call('filtro con un operador que no existe', a.bindingsPost,
    crearBinding({ topic: 'eventos-prueba', cola: 'q-prueba', filtro: { tipo_evento: [{ empiezaCon: 'P' }] } }), 400);
  await call('suscribir una DLQ', a.bindingsPost, crearBinding({ topic: 'eventos-prueba', cola: 'q-prueba-dlq' }), 409);
  const binding = await call('POST /api/admin/bindings', a.bindingsPost,
    crearBinding({ topic: 'eventos-prueba', cola: 'q-prueba', filtro: { tipo_evento: [{ prefix: 'Pedido' }] } }), 201);
  await call('el mismo binding otra vez', a.bindingsPost, crearBinding({ topic: 'eventos-prueba', cola: 'q-prueba' }), 409);
  const bindings = await call('GET /api/admin/bindings', a.bindingsGet, req('GET', '/api/admin/bindings'), 200);
  comprobar('el binding guarda su filtro', bindings.body[0]?.filtro?.tipo_evento?.[0]?.prefix === 'Pedido',
    JSON.stringify(bindings.body[0]?.filtro));

  console.log('\n== Administrador: reglas para no romper nada ==');
  await call('borrar un topic con bindings', a.topicsDelete, borrarTopic('eventos-prueba'), 409);
  await call('borrar una cola suscrita a un topic', a.colasDelete, borrarCola('q-prueba'), 409);
  await call('borrar un binding que no existe', a.bindingsDelete,
    req('DELETE', '/api/admin/bindings/x', { id: 'no-existe' }), 404);
  await call('DELETE /api/admin/bindings/{id}', a.bindingsDelete,
    req('DELETE', `/api/admin/bindings/${binding.body.id}`, { id: binding.body.id }), 200);

  await call('borrar la DLQ suelta', a.colasDelete, borrarCola('q-prueba-dlq'), 409);
  simular.conectarConsumidor('q-prueba', 'una-lambda');
  await call('borrar una cola que tiene consumidor', a.colasDelete, borrarCola('q-prueba'), 409);
  simular.conectarConsumidor('q-prueba', null);
  simular.encolar('q-prueba', 2);
  await call('borrar una cola con mensajes pendientes', a.colasDelete, borrarCola('q-prueba'), 409);
  simular.vaciar('q-prueba');
  simular.encolar('q-prueba-dlq', 1);
  await call('borrar una cola cuya DLQ tiene mensajes', a.colasDelete, borrarCola('q-prueba'), 409);
  simular.vaciar('q-prueba-dlq');

  const borrada = await call('DELETE /api/admin/queues/{name}', a.colasDelete, borrarCola('q-prueba'), 200);
  comprobar('borra la cola junto con su DLQ', borrada.body.dlq === 'q-prueba-dlq', JSON.stringify(borrada.body));
  await call('borrar una cola que ya no existe', a.colasDelete, borrarCola('q-prueba'), 404);
  await call('DELETE /api/admin/topics/{name}', a.topicsDelete, borrarTopic('eventos-prueba'), 200);
  const topics = await call('GET /api/admin/topics', a.topicsGet, req('GET', '/api/admin/topics'), 200);
  comprobar('el topic ya no aparece', !topics.body.some((t) => t.nombre === 'eventos-prueba'));
}

console.log(fallos === 0 ? '\nTODAS LAS PRUEBAS PASARON' : `\n${fallos} PRUEBA(S) FALLARON`);
process.exit(fallos === 0 ? 0 : 1);
