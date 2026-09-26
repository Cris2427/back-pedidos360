// Va en su propia Lambda porque es su propia ruta y su propio método.
import { crearStore } from '../lib/store.mjs';
import { json, leerBody, idDeRuta, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'catalog.write');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Admin');
  if (sinRol) return sinRol;

  const id = idDeRuta(event);
  const producto = await store.obtenerProducto(id);
  if (!producto) return json(404, { error: `Producto '${id}' no encontrado.` });

  const body = leerBody(event);
  if (!body) return json(400, { error: 'El cuerpo no es JSON válido.' });
  if (!Number.isInteger(body.stock) || body.stock < 0) {
    return json(400, { error: 'El campo "stock" debe ser un entero >= 0.' });
  }

  return json(200, await store.fijarStock(id, body.stock));
});
