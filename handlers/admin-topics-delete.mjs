import { json, parametroDeRuta, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';
import { validarNombre } from '../lib/validacion.mjs';
import { crearAdminMensajeria } from '../lib/admin-mensajeria.mjs';

const admin = crearAdminMensajeria();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'messaging.manage');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Admin');
  if (sinRol) return sinRol;

  const nombre = parametroDeRuta(event, 'name') ?? '';
  const malo = validarNombre(nombre, { de: 'del topic', max: 256 });
  if (malo) return json(400, { error: malo });

  return json(200, await admin.eliminarTopic(nombre));
});
