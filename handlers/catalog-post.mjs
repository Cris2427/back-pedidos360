import { crearStore } from '../lib/store.mjs';
import { json, leerBody, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';
import { validarProducto } from '../lib/reglas.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'catalog.write');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Admin');
  if (sinRol) return sinRol;

  const body = leerBody(event);
  if (!body) return json(400, { error: 'El cuerpo no es JSON válido.' });

  const invalido = validarProducto(body);
  if (invalido) return json(400, { error: invalido });

  const producto = {
    id: await store.siguienteId('p'),
    nombre: body.nombre.trim(),
    precio: body.precio,
    stock: body.stock,
  };
  await store.guardarProducto(producto);
  return json(201, producto);
});
