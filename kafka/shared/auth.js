// Filtro JWT de las APIs de Kafka (report, audit y admin). Acepta el mismo
// access token de Entra ID que el front ya pide para Pedidos360-API en la
// EP4: las pantallas nuevas usan el login de siempre.
// En cada request revisa, en este orden:
//   1. que venga el header Authorization: Bearer <token>
//   2. la firma, con las llaves públicas de Entra ID (JWKS)
//   3. el emisor (iss): nuestro tenant
//   4. la audiencia (aud): Pedidos360-API
//   5. la vigencia (exp y nbf)                    si falla 1 a 5: 401
//   6. el scope (scp) que pide la API
//   7. el App Role (roles) que pide la API        si falla 6 o 7: 403
// 401 = no sé quién eres. 403 = sé quién eres, pero no puedes hacer esto.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class NoAutenticadoError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'NoAutenticadoError';
    this.status = 401;
  }
}

export class SinPermisoError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'SinPermisoError';
    this.status = 403;
  }
}

// No es culpa del token: no se pudo consultar a Entra ID
class VerificacionNoDisponibleError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'VerificacionNoDisponibleError';
    this.status = 503;
  }
}

// Crea la función que verifica un token y devuelve sus claims.
// Entra ID emite dos formatos de access token y se aceptan los dos, igual que
// el authorizer del API Gateway de la EP4:
//   v2: emisor login.microsoftonline.com/<tenant>/v2.0, audiencia <client id>
//   v1: emisor sts.windows.net/<tenant>/,           audiencia api://<client id>
// jwks: las llaves públicas; en las pruebas se pasan unas propias.
export function crearVerificador({ tenantId, apiClientId, jwks } = {}) {
  if (!tenantId || !apiClientId) {
    throw new Error('faltan ENTRA_TENANT_ID y ENTRA_API_CLIENT_ID en el .env (ver .env.example)');
  }
  // x descarga las llaves del tenant la primera vez y las guarda en
  // memoria. Si llega un token firmado con una llave que no conoce (Entra ID
  // las rota cada cierto tiempo), las vuelve a pedir.
  const llaves = jwks ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  const opciones = {
    // Entra ID firma con RS256. Fijarlo impide que un token diga que viene
    // sin firma o con otro algoritmo para saltarse la verificación.
    algorithms: ['RS256'],
    issuer: [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`],
    audience: [apiClientId, `api://${apiClientId}`],
    // diferencia de reloj aceptada entre este equipo y Entra ID, en segundos
    clockTolerance: 300,
  };
  return async token => (await jwtVerify(token, llaves, opciones)).payload;
}

// El verificador de los servicios, con los datos del .env
export const verificadorDesdeEnv = () => crearVerificador({
  tenantId: process.env.ENTRA_TENANT_ID,
  apiClientId: process.env.ENTRA_API_CLIENT_ID,
});

// Los errores de jose, en palabras: qué tiene de malo el token
const MOTIVOS = {
  ERR_JWT_EXPIRED: 'el token venció: vuelve a iniciar sesión',
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: 'la firma del token no es de Entra ID',
  ERR_JWKS_NO_MATCHING_KEY: 'la firma del token no es de Entra ID',
  ERR_JOSE_ALG_NOT_ALLOWED: 'el token no está firmado con RS256',
  ERR_JWS_INVALID: 'el token está mal formado',
  ERR_JWT_INVALID: 'el token está mal formado',
};
const CLAIMS = {
  iss: 'el token no lo emitió nuestro tenant de Entra ID',
  aud: 'el token no es para Pedidos360-API',
  nbf: 'el token todavía no es válido',
};

function traducir(error) {
  if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    return new NoAutenticadoError(CLAIMS[error.claim] ?? `el token no cumple ${error.claim}`);
  }
  if (MOTIVOS[error.code]) return new NoAutenticadoError(MOTIVOS[error.code]);
  // cualquier otro error de jose también es culpa del token, salvo los de la
  // descarga de las llaves (ERR_JOSE_GENERIC: Entra ID no respondió 200, por
  // ejemplo con un ENTRA_TENANT_ID que no existe)
  const delServidor = ['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'];
  if (error.code?.startsWith('ERR_J') && !delServidor.includes(error.code)) {
    return new NoAutenticadoError('el token no es válido');
  }
  // sin conexión con Entra ID o algo inesperado: no se rechaza al usuario
  // como si su token fuera malo
  console.error(`[auth] no se pudo verificar el token: ${error.code ?? ''} ${error.message}`);
  return new VerificacionNoDisponibleError('no se pudo verificar el token: Entra ID no responde');
}

// Quién es, qué App Roles tiene y qué scopes le dio el usuario al front
export function usuarioDe(claims) {
  return {
    id: claims.preferred_username ?? claims.upn ?? claims.unique_name ?? claims.oid ?? claims.sub,
    roles: Array.isArray(claims.roles) ? claims.roles : [],
    scopes: String(claims.scp ?? '').split(' ').filter(Boolean),
  };
}

// El middleware de Express. permiso: el scope y los App Roles que pide la API
// (basta con tener uno de los roles). Deja en req.usuario quién llamó.
export function proteger(verificar, { scope, roles }) {
  return async (req, res, next) => {
    try {
      const [, token] = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '') ?? [];
      if (!token) throw new NoAutenticadoError('falta el token: header Authorization: Bearer <token>');

      let claims;
      try {
        claims = await verificar(token);
      } catch (error) {
        throw traducir(error);
      }

      const usuario = usuarioDe(claims);
      if (!usuario.scopes.includes(scope)) {
        throw new SinPermisoError(`falta el scope ${scope} en el token (el front lo pide en VITE_API_SCOPE)`);
      }
      if (!roles.some(r => usuario.roles.includes(r))) {
        throw new SinPermisoError(`se necesita el App Role ${roles.join(' o ')} (Entra ID → Aplicaciones empresariales → Pedidos360-API → Usuarios y grupos)`);
      }
      req.usuario = usuario;
      next();
    } catch (error) {
      // el estándar pide avisar con qué esquema autenticarse
      if (error.status === 401) res.set('WWW-Authenticate', 'Bearer');
      next(error);
    }
  };
}