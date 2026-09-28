import { json } from './http.mjs';

const getClaims = (event) => event.requestContext?.authorizer?.jwt?.claims ?? {};

export function getScopes(event) {
  const c = getClaims(event);
  return String(c.scp ?? c.scope ?? '').split(' ').filter(Boolean);
}

export function getRoles(event) {
  const c = getClaims(event);
  if (Array.isArray(c.roles)) return c.roles;

  // el api gateway manda los claims como texto: roles llega "[Cliente]"
  // con corchetes, y sin sacarlos nunca calza y todo da 403
  return String(c.roles ?? '')
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

export function getUserId(event) {
  const c = getClaims(event);
  return c.preferred_username ?? c.upn ?? c.email ?? c.oid ?? c.sub ?? 'desconocido';
}

export const tieneRol = (event, ...roles) => {
  const propios = getRoles(event);
  return roles.some((r) => propios.includes(r));
};

// devuelve el 403 o null si puede pasar
export function exigirScope(event, scope) {
  if (getScopes(event).includes(scope)) return null;
  return json(403, {
    error: `Falta el scope '${scope}' en el access token.`,
    hint: 'Agrega el permiso en Entra ID → Pedidos360-Frontend → Permisos de API, y concede el consentimiento.',
  });
}

export function exigirRol(event, ...roles) {
  if (tieneRol(event, ...roles)) return null;
  return json(403, {
    error: `Esta operación requiere uno de estos App Roles: ${roles.join(', ')}.`,
    hint: 'Asígnalo en Entra ID → Aplicaciones empresariales → Pedidos360-API → Usuarios y grupos.',
  });
}
