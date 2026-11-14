// Lo común de las APIs HTTP (report, audit y admin), en un solo lugar:
//   crearApp()       Express con CORS para el front local, el filtro JWT y
//                    cuerpos JSON
//   ruta(fn)         responde como JSON lo que devuelve fn; si falla, pasa el error
//   cerrarApp(app)   404 para lo que no existe y el manejador de errores
// y los errores que la API responde con su status: 400, 404 y 409 (los 401 y
// 403 están en auth.js).
import express from 'express';
import cors from 'cors';
import { proteger } from './auth.js';

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

// verificar: el verificador de tokens (auth.js). permiso: el scope y los App
// Roles que pide la API. Los dos son obligatorios: una API sin filtro JWT no
// arranca, en vez de quedar abierta sin que nadie se dé cuenta.
export function crearApp({ origen = 'http://localhost:5173', verificar, permiso } = {}) {
  if (!verificar || !permiso) throw new Error('crearApp necesita verificar y permiso: ninguna API queda sin filtro JWT');
  const app = express();
  app.disable('x-powered-by');
  // el navegador solo deja llamar a estas APIs desde el front local. CORS va
  // antes del filtro: la consulta previa del navegador (OPTIONS) no lleva token
  app.use(cors({ origin: origen }));
  // el filtro va antes de leer el cuerpo: sin token válido no se procesa nada
  app.use(proteger(verificar, permiso));
  app.use(express.json());
  return app;
}

// Envuelve cada ruta: responde lo que devuelve fn como JSON (con status 200,
// o 201 cuando la ruta crea algo), y si fn falla (también si es async) le
// pasa el error al manejador de errores
export const ruta = (fn, status = 200) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req))
    .then(datos => res.status(status).json(datos))
    .catch(next);
};

// Va después de todas las rutas
export function cerrarApp(app, servicio) {
  app.use((req, res) => res.status(404).json({ error: `no existe ${req.method} ${req.path}` }));

  // Los 4 parámetros (aunque next no se use) le dicen a Express que este es
  // el manejador de errores. Un error con status se responde tal cual;
  // cualquier otro es un 500 sin el detalle interno.
  app.use((error, req, res, next) => {
    // un cuerpo que no es JSON: Express lo rechaza antes de llegar a la ruta
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'el cuerpo no es un JSON válido' });
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(`[${servicio}] error en ${req.method} ${req.path}: ${error.message}`);
    res.status(500).json({ error: 'error interno' });
  });
  return app;
}