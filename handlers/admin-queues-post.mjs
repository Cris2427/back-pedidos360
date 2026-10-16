import { json, leerBody, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';
import { validarNuevaCola } from '../lib/validacion.mjs';
import { crearAdminMensajeria } from '../lib/admin-mensajeria.mjs';

const admin = crearAdminMensajeria();

// crea la cola y su dlq con la redrive policy
export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'messaging.manage');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Admin');
  if (sinRol) return sinRol;

  const body = leerBody(event);
  if (!body) return json(400, { error: 'El cuerpo no es JSON válido.' });
  const { dto, error } = validarNuevaCola(body);
  if (error) return json(400, { error });

  return json(201, await admin.crearCola(dto));
});
