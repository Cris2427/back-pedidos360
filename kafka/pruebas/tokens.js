// Tokens para las pruebas: un par de llaves RSA propio hace de Entra ID. El
// filtro JWT es el mismo que en los servicios; solo cambian las llaves
// públicas con que verifica la firma. No es un archivo de pruebas (no
// termina en .test.js): lo importan las pruebas de las APIs.
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { crearVerificador } from '../shared/auth.js';

export const TENANT = '00000000-0000-0000-0000-00000000aaaa';
export const API = '00000000-0000-0000-0000-00000000bbbb';
export const EMISOR_V2 = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publica = { ...(await exportJWK(publicKey)), kid: 'llave-prueba', alg: 'RS256', use: 'sig' };

export const verificar = crearVerificador({
  tenantId: TENANT,
  apiClientId: API,
  jwks: createLocalJWKSet({ keys: [publica] }),
});

// Un access token como los de Entra ID (formato v2). Por defecto, de un Admin
// con todos los scopes; cada prueba cambia lo que necesita.
export function token({
  roles = ['Admin'],
  scp = 'orders.read messaging.manage',
  iss = EMISOR_V2,
  aud = API,
  exp = '10m',
  llave = privateKey,
  alg = 'RS256',
} = {}) {
  return new SignJWT({ roles, scp, preferred_username: 'prueba@pedidos360.cl' })
    .setProtectedHeader({ alg, kid: 'llave-prueba' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(llave);
}

// Los headers de un request con token
export const conToken = async opciones => ({ authorization: `Bearer ${await token(opciones)}` });