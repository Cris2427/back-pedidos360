// API de solo lectura de report: lo que consume la pantalla Reportes del front.
// Recibe el repositorio, así las pruebas la levantan con el de memoria.
import { crearApp, ruta, cerrarApp } from '../shared/http.js';
import * as kpis from './kpis.js';

// Reportes: los ven Operador y Admin, con el scope orders.read de la EP4
export const PERMISO = { scope: 'orders.read', roles: ['Operador', 'Admin'] };

// opciones: { origen, verificar } (ver shared/http.js)
export function crearApi(repo, opciones) {
  const app = crearApp({ ...opciones, permiso: PERMISO });

  app.get('/api/report/ventas-por-hora', ruta(() => kpis.ventasPorHora(repo)));
  app.get('/api/report/top-productos', ruta(req => kpis.topProductos(repo, req.query.limite ?? 5)));
  app.get('/api/report/pedidos-activos', ruta(() => kpis.pedidosActivos(repo)));
  app.get('/api/report/lead-time', ruta(() => kpis.leadTime(repo)));
  app.get('/api/report/resumen', ruta(() => kpis.resumen(repo)));

  return cerrarApp(app, 'report');
}