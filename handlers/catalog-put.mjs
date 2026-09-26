import { crearStore } from '../lib/store.mjs';
import { json, leerBody, idDeRuta, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';
import { validarProducto } from '../lib/reglas.mjs';

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

  const invalido = validarProducto(body);
  if (invalido) return json(400, { error: invalido });

  const actualizado = {
    ...producto,
    nombre: body.nombre.trim(),
    precio: body.precio,
    stock: body.stock,
  };
  await store.guardarProducto(actualizado);
  return json(200, actualizado);
});
