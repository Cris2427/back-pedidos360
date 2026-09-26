import { crearStore } from '../lib/store.mjs';
import { json, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope } from '../lib/auth.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const denegado = exigirScope(event, 'catalog.read');
  if (denegado) return denegado;

  return json(200, await store.listarProductos());
});
