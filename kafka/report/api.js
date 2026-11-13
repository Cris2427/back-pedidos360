// API de solo lectura de report: lo que consume la pantalla Reportes del front.
// Recibe el repositorio, así las pruebas la levantan con el de memoria.
import express from 'express';
import cors from 'cors';
import * as kpis from './kpis.js';

export function crearApi(repo, { origen = 'http://localhost:5173' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // el navegador solo deja llamar a esta API desde el front local
  app.use(cors({ origin: origen }));

  // Envuelve cada ruta: responde lo que devuelve fn como JSON, y si fn falla
  // (también si es async) le pasa el error al manejador de errores de abajo
  const ruta = fn => (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req))
      .then(datos => res.json(datos))
      .catch(next);
  };

  app.get('/api/report/ventas-por-hora', ruta(() => kpis.ventasPorHora(repo)));
  app.get('/api/report/top-productos', ruta(req => kpis.topProductos(repo, req.query.limite ?? 5)));
  app.get('/api/report/pedidos-activos', ruta(() => kpis.pedidosActivos(repo)));
  app.get('/api/report/lead-time', ruta(() => kpis.leadTime(repo)));
  app.get('/api/report/resumen', ruta(() => kpis.resumen(repo)));

  app.use((req, res) => res.status(404).json({ error: `no existe ${req.method} ${req.path}` }));

  // Los 4 parámetros (aunque next no se use) le dicen a Express que este es
  // el manejador de errores. Un error con status (como ParametroInvalidoError)
  // se responde tal cual; cualquier otro es un 500 sin el detalle interno.
  app.use((error, req, res, next) => {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(`[report] error en ${req.method} ${req.path}: ${error.message}`);
    res.status(500).json({ error: 'error interno' });
  });

  return app;
}