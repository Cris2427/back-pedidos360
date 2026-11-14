// Pruebas del filtro JWT (npm test): 401 sin un token válido, 403 sin el
// scope o el App Role, y el permiso que pide cada API. Los tokens los firma
// pruebas/tokens.js con sus propias llaves, sin Entra ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from 'jose';
import { crearApp, ruta, cerrarApp } from '../shared/http.js';
import { verificar, conToken, TENANT, API } from './tokens.js';
import { crearApi as apiReport } from '../report/api.js';
import { repositorioMemoria as repoReport } from '../report/repositorio.js';
import { crearApi as apiAudit } from '../audit/api.js';
import { repositorioMemoria as repoAudit } from '../audit/repositorio.js';
import { crearApi as apiAdmin } from '../admin/api.js';

// Levanta una app en un puerto libre y devuelve cómo pedirle cosas
function levantar(t, app) {
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return (ruta, headers = {}) => fetch(`${base}${ruta}`, { headers });
}

// Una API mínima que pide orders.read y Admin, y responde quién llamó
function apiDePrueba() {
  const app = crearApp({ verificar, permiso: { scope: 'orders.read', roles: ['Admin'] } });
  app.get('/yo', ruta(req => req.usuario));
  return cerrarApp(app, 'prueba');
}

test('sin un token válido responde 401, con el motivo', async t => {
  const pedir = levantar(t, apiDePrueba());
  const hace1Hora = Math.floor(Date.now() / 1000) - 3600;
  const otraLlave = (await generateKeyPair('RS256')).privateKey;
  const secreto = new TextEncoder().encode('un secreto compartido cualquiera');

  const casos = [
    [{}, /falta el token/],
    [{ authorization: 'Basic dXN1YXJpbzpjbGF2ZQ==' }, /falta el token/],
    [{ authorization: 'Bearer esto.no.sirve' }, /mal formado|no es válido/],
    [await conToken({ llave: otraLlave }), /firma/],
    [await conToken({ alg: 'HS256', llave: secreto }), /RS256/],
    [await conToken({ exp: hace1Hora }), /venció/],
    [await conToken({ aud: 'otra-api' }), /Pedidos360-API/],
    [await conToken({ iss: 'https://login.microsoftonline.com/otro-tenant/v2.0' }), /tenant/],
  ];
  for (const [headers, motivo] of casos) {
    const r = await pedir('/yo', headers);
    assert.equal(r.status, 401, JSON.stringify(headers).slice(0, 80));
    assert.equal(r.headers.get('www-authenticate'), 'Bearer');
    assert.match((await r.json()).error, motivo);
  }
});

test('sin el scope o sin el App Role responde 403', async t => {
  const pedir = levantar(t, apiDePrueba());
  const sinScope = await pedir('/yo', await conToken({ scp: 'catalog.read' }));
  assert.equal(sinScope.status, 403);
  assert.match((await sinScope.json()).error, /scope orders.read/);

  const sinRol = await pedir('/yo', await conToken({ roles: ['Cliente'] }));
  assert.equal(sinRol.status, 403);
  assert.match((await sinRol.json()).error, /App Role Admin/);
});

test('con un token válido pasa y la API sabe quién llamó (formatos v2 y v1)', async t => {
  const pedir = levantar(t, apiDePrueba());
  const v2 = await pedir('/yo', await conToken());
  assert.equal(v2.status, 200);
  assert.deepEqual(await v2.json(), { id: 'prueba@pedidos360.cl', roles: ['Admin'], scopes: ['orders.read', 'messaging.manage'] });

  // v1: otro emisor y la audiencia con api:// adelante
  const v1 = await pedir('/yo', await conToken({ iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${API}` }));
  assert.equal(v1.status, 200);
});

test('cada API pide su rol y su scope', async t => {
  const report = levantar(t, apiReport(repoReport(), { verificar }));
  const audit = levantar(t, apiAudit(repoAudit(), { verificar }));
  const admin = levantar(t, apiAdmin({ cluster: async () => ({ brokers: [] }) }, { verificar }));
  const de = (rol, scp = 'orders.read') => conToken({ roles: [rol], scp });

  // Reportes: Operador y Admin
  assert.equal((await report('/api/report/resumen', await de('Operador'))).status, 200);
  assert.equal((await report('/api/report/resumen', await de('Admin'))).status, 200);
  assert.equal((await report('/api/report/resumen', await de('Cliente'))).status, 403);
  // Auditoría: solo Admin
  assert.equal((await audit('/api/audit/registros', await de('Admin'))).status, 200);
  assert.equal((await audit('/api/audit/registros', await de('Operador'))).status, 403);
  // Admin de Kafka: Admin con messaging.manage
  assert.equal((await admin('/api/admin/cluster', await de('Admin', 'messaging.manage'))).status, 200);
  assert.equal((await admin('/api/admin/cluster', await de('Admin', 'orders.read'))).status, 403);
  assert.equal((await admin('/api/admin/cluster', await de('Operador', 'messaging.manage'))).status, 403);
  // y sin token, ni siquiera se sabe si una ruta existe
  assert.equal((await admin('/api/admin/no-existe')).status, 401);
});

test('la consulta previa de CORS pasa sin token', async t => {
  const servidor = apiDePrueba().listen(0);
  t.after(() => servidor.close());
  const r = await fetch(`http://127.0.0.1:${servidor.address().port}/yo`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('una API sin verificador no arranca', () => {
  assert.throws(() => crearApp({ permiso: { scope: 'orders.read', roles: ['Admin'] } }), /filtro JWT/);
  assert.throws(() => apiReport(repoReport()), /filtro JWT/);
});