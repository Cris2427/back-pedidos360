// Lo común de las APIs HTTP (report, audit y admin), en un solo lugar:
//   crearApp()       Express con CORS para el front local y cuerpos JSON
//   ruta(fn)         responde como JSON lo que devuelve fn; si falla, pasa el error
//   cerrarApp(app)   404 para lo que no existe y el manejador de errores
// y los errores que la API responde con su status: 400, 404 y 409.
import express from 'express';
import cors from 'cors';

// Un parámetro mal enviado: 400
export class ParametroInvalidoError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ParametroInvalidoError';
    this.status = 400;
  }
}

// Lo que se pidió no existe: 404
export class NoEncontradoError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'NoEncontradoError';
    this.status = 404;
  }
}

// La operación chocaría con el estado actual (por ejemplo, borrar algo que
// está en uso): 409
export class ConflictoError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ConflictoError';
    this.status = 409;
  }
}

export function crearApp({ origen = 'http://localhost:5173' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // el navegador solo deja llamar a estas APIs desde el front local
  app.use(cors({ origin: origen }));
  app.use(express.json());
  return app;
}

// Envuelve cada ruta: responde lo que devuelve fn como JSON, y si fn falla
// (también si es async) le pasa el error al manejador de errores
export const ruta = fn => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req))
    .then(datos => res.json(datos))
    .catch(next);
};

// Va después de todas las rutas
export function cerrarApp(app, servicio) {
  app.use((req, res) => res.status(404).json({ error: `no existe ${req.method} ${req.path}` }));

  // Los 4 parámetros (aunque next no se use) le dicen a Express que este es
  // el manejador de errores. Un error con status se responde tal cual;
  // cualquier otro es un 500 sin el detalle interno.
  app.use((error, req, res, next) => {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(`[${servicio}] error en ${req.method} ${req.path}: ${error.message}`);
    res.status(500).json({ error: 'error interno' });
  });
  return app;
}