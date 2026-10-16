import { json, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';
import { crearAdminMensajeria } from '../lib/admin-mensajeria.mjs';

const admin = crearAdminMensajeria();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'messaging.manage');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Admin');
  if (sinRol) return sinRol;

  return json(200, await admin.listarTopics());
});
