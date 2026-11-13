// API de solo lectura de audit: lo que consume la pantalla Auditoría del front.
//   GET /api/audit/pedidos/:pedidoId   el historial de un pedido
//   GET /api/audit/registros           búsqueda con filtros: usuario, que,
//                                      desde, hasta, limite
import { crearApp, ruta, cerrarApp } from '../shared/http.js';
import { historialDe, buscarRegistros } from './consultas.js';

export function crearApi(repo, opciones) {
  const app = crearApp(opciones);

  app.get('/api/audit/pedidos/:pedidoId', ruta(req => historialDe(repo, req.params.pedidoId)));
  app.get('/api/audit/registros', ruta(req => buscarRegistros(repo, req.query)));

  return cerrarApp(app, 'audit');
}