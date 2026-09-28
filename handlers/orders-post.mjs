import { crearStore } from '../lib/store.mjs';
import { json, leerBody, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol, tieneRol, getUserId } from '../lib/auth.mjs';
import { resolverItems } from '../lib/reglas.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'orders.write');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Cliente', 'Operador');
  if (sinRol) return sinRol;

  const body = leerBody(event);
  if (!body) return json(400, { error: 'El cuerpo no es JSON válido.' });

  const userId = getUserId(event);
  // al cliente se le ignora el clienteId del cuerpo y se usa el del token
  const clienteId = tieneRol(event, 'Operador')
    ? String(body.clienteId ?? '').trim()
    : userId;
  if (!clienteId) return json(400, { error: 'El campo "clienteId" es obligatorio.' });

  const resuelto = await resolverItems(store, body.items);
  if (resuelto.error) return json(resuelto.status, { error: resuelto.error });

  const pedido = {
    id: await store.siguienteId('o'),
    clienteId,
    items: resuelto.detalle,
    total: resuelto.total,
    estado: 'CREADO',
    stockDescontado: false,
    creadoEn: new Date().toISOString(),
    creadoPor: userId,
  };
  await store.guardarPedido(pedido);
  return json(201, pedido);
});
