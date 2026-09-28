import { crearStore } from '../lib/store.mjs';
import { json, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol, tieneRol, getUserId } from '../lib/auth.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'orders.read');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Cliente', 'Operador');
  if (sinRol) return sinRol;

  // el filtro se hace aca, no en el navegador
  const pedidos = await store.listarPedidos();
  if (tieneRol(event, 'Operador')) return json(200, pedidos);

  const userId = getUserId(event);
  return json(200, pedidos.filter((p) => p.clienteId === userId));
});
