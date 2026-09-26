// backend/pedidos360-api/lib/auth.mjs
//
// Autorización compartida por todas las Lambdas: lee los claims del access
// token que el JWT authorizer ya validó (firma, issuer, audience, expiración)
// y decide si esta petición puede seguir.
//
// Es la segunda capa de control que pide la pauta: el API Gateway dice
// "el token es legítimo", esta capa dice "este usuario puede hacer esto".

import { json } from './http.mjs';

const getClaims = (event) => event.requestContext?.authorizer?.jwt?.claims ?? {};

/** Scopes delegados (`scp`), que llegan como string separado por espacios. */
export function getScopes(event) {
  const c = getClaims(event);
  return String(c.scp ?? c.scope ?? '').split(' ').filter(Boolean);
}

/** App Roles (`roles`) del usuario. */
export function getRoles(event) {
  const c = getClaims(event);
  if (Array.isArray(c.roles)) return c.roles;

  // OJO: el API Gateway (HTTP API) entrega TODOS los claims como string, así
  // que un claim de tipo array como `roles` llega envuelto en corchetes:
  //   roles: ["Cliente"]   (en el JWT)
  //   "[Cliente]"          (lo que recibe la Lambda)
  // Sin quitar los corchetes, "[Cliente]" nunca coincide con "Cliente" y todo
  // control por rol falla con 403. El separador puede ser coma o espacio.
  return String(c.roles ?? '')
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/** Identidad del usuario: con esto un Cliente solo ve y crea sus pedidos. */
export function getUserId(event) {
  const c = getClaims(event);
  return c.preferred_username ?? c.upn ?? c.email ?? c.oid ?? c.sub ?? 'desconocido';
}

export const tieneRol = (event, ...roles) => {
  const propios = getRoles(event);
  return roles.some((r) => propios.includes(r));
};

/**
 * Devuelve una respuesta 403 si falta el scope, o null si puede seguir.
 * Uso:  const no = exigirScope(event, 'catalog.read'); if (no) return no;
 */
export function exigirScope(event, scope) {
  if (getScopes(event).includes(scope)) return null;
  return json(403, {
    error: `Falta el scope '${scope}' en el access token.`,
    hint: 'Agrega el permiso en Entra ID → Pedidos360-Frontend → Permisos de API, y concede el consentimiento.',
  });
}

/** Igual que exigirScope, pero con App Roles: basta con tener uno. */
export function exigirRol(event, ...roles) {
  if (tieneRol(event, ...roles)) return null;
  return json(403, {
    error: `Esta operación requiere uno de estos App Roles: ${roles.join(', ')}.`,
    hint: 'Asígnalo en Entra ID → Aplicaciones empresariales → Pedidos360-API → Usuarios y grupos.',
  });
}
