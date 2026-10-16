import { crearStore } from '../lib/store.mjs';
import { json, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol, tieneRol, getUserId } from '../lib/auth.mjs';

const store = crearStore();

// la orden de bodega es interna: al cliente solo le corresponden sus correos
// y sus boletas
const CANALES_DEL_CLIENTE = ['email', 'boleta'];

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'orders.read');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Cliente', 'Operador');
  if (sinRol) return sinRol;

  const todas = await store.listarNotificaciones();
  if (tieneRol(event, 'Operador')) return json(200, todas);

  const userId = getUserId(event);
  return json(200, todas.filter((n) => n.clienteId === userId && CANALES_DEL_CLIENTE.includes(n.canal)));
});
