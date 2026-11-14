// API de solo lectura de audit: lo que consume la pantalla Auditoría del front.
//   GET /api/audit/pedidos/:pedidoId   el historial de un pedido
//   GET /api/audit/registros           búsqueda con filtros: usuario, que,
//                                      desde, hasta, limite
import { crearApp, ruta, cerrarApp } from '../shared/http.js';
import { historialDe, buscarRegistros } from './consultas.js';

// Auditoría: solo Admin, con el scope orders.read de la EP4
export const PERMISO = { scope: 'orders.read', roles: ['Admin'] };

// opciones: { origen, verificar } (ver shared/http.js)
export function crearApi(repo, opciones) {
  const app = crearApp({ ...opciones, permiso: PERMISO });

  app.get('/api/audit/pedidos/:pedidoId', ruta(req => historialDe(repo, req.params.pedidoId)));
  app.get('/api/audit/registros', ruta(req => buscarRegistros(repo, req.query)));

  return cerrarApp(app, 'audit');
}