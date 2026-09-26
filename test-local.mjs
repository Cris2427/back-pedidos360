// backend/pedidos360-api/test-local.mjs
//
// Pruebas básicas de las 10 Lambdas, sin desplegar nada:
//   node backend/pedidos360-api/test-local.mjs
//
// Simula eventos de API Gateway HTTP API (payload v2) y usa el store en
// memoria, así que no necesita credenciales de AWS ni red.

// Debe ir ANTES de importar los handlers: cada uno crea su store al cargarse.
process.env.STORE = 'memory';

// Import dinámico por lo mismo: un `import` estático se evalúa antes que la
// línea de arriba y los handlers elegirían DynamoDB.
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

// Todos los handlers comparten la misma instancia del store en memoria
// (crearStore la memoiza por proceso), igual que en AWS comparten DynamoDB.
const { crearStore } = await import('./lib/store.mjs');
const compartido = crearStore();

const SCOPES = 'orders.read orders.write catalog.read catalog.write';

const ADMIN = { roles: '[Admin]', user: 'admin@duoc.cl' };
const OPERADOR = { roles: '[Operador]', user: 'operador@duoc.cl' };
const CLIENTE = { roles: '[Cliente]', user: 'cliente@duoc.cl' };
const OTRO_CLIENTE = { roles: '[Cliente]', user: 'otro@duoc.cl' };

/** Evento de API Gateway v2. Los claims van como string, igual que en AWS. */
const ev = (method, rawPath, opts = {}) => {
  const { body, id, scp = SCOPES, roles = '[Admin]', user = 'x@duoc.cl' } = opts;
  return {
    rawPath,
    pathParameters: id ? { id } : undefined,
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

// El contador vive en DynamoDB y arranca alineado con los ids sembrados.
// Sin expresiones regulares con barra invertida: en un template literal
// `\d` se colapsa a `d` y el patron deja de coincidir en silencio.
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

console.log(fallos === 0 ? '\nTODAS LAS PRUEBAS PASARON' : `\n${fallos} PRUEBA(S) FALLARON`);
process.exit(fallos === 0 ? 0 : 1);
