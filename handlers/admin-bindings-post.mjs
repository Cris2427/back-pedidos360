import { json, leerBody, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';
import { validarNuevoBinding } from '../lib/validacion.mjs';
import { crearAdminMensajeria } from '../lib/admin-mensajeria.mjs';

const admin = crearAdminMensajeria();

// suscribe una cola a un topic: el binding de rabbitmq, con el filtro como
// routing key
export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'messaging.manage');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Admin');
  if (sinRol) return sinRol;

  const body = leerBody(event);
  if (!body) return json(400, { error: 'El cuerpo no es JSON válido.' });
  const { dto, error } = validarNuevoBinding(body);
  if (error) return json(400, { error });

  return json(201, await admin.crearBinding(dto));
});
