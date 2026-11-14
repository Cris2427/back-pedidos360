// API del microservicio administrador de Kafka, en /api/admin. Es lo que usa
// la pantalla de administración del front y lo que se prueba desde PowerShell.
//   GET    /cluster                         brokers y controlador
//   GET    /topicos                         todos los tópicos (sin los internos)
//   POST   /topicos                         crea uno
//   GET    /topicos/:nombre                 configuración, particiones, líderes, ISR y grupos
//   PATCH  /topicos/:nombre/configuracion   cambia retención, limpieza o min ISR
//   POST   /topicos/:nombre/particiones     agrega particiones
//   DELETE /topicos/:nombre                 lo borra
//   GET    /grupos                          los grupos de consumidores, con su lag
//   GET    /grupos/:grupo                   instancias, particiones y offsets
//   POST   /grupos/:grupo/offsets           mueve los offsets (replay)
//   DELETE /grupos/:grupo                   lo borra
//   GET    /dlt/:servicio                   lo que report o audit no pudo procesar
//   POST   /dlt/:servicio/reprocesar        lo devuelve a su tópico de origen
// Errores: 400 si se pide mal, 404 si no existe y 409 si chocaría con el
// estado del clúster.
import { crearApp, ruta, cerrarApp } from '../shared/http.js';

export function crearApi(servicio, opciones) {
  const app = crearApp(opciones);
  const base = '/api/admin';

  app.get(`${base}/cluster`, ruta(req => servicio.cluster(req.query)));

  app.get(`${base}/topicos`, ruta(req => servicio.listarTopicos(req.query)));
  app.post(`${base}/topicos`, ruta(req => servicio.crearTopico(req.body), 201));
  app.get(`${base}/topicos/:nombre`, ruta(req => servicio.detalleTopico(req.params.nombre)));
  app.patch(`${base}/topicos/:nombre/configuracion`, ruta(req => servicio.modificarConfiguracion(req.params.nombre, req.body)));
  app.post(`${base}/topicos/:nombre/particiones`, ruta(req => servicio.agregarParticiones(req.params.nombre, req.body)));
  app.delete(`${base}/topicos/:nombre`, ruta(req => servicio.borrarTopico(req.params.nombre)));

  app.get(`${base}/grupos`, ruta(req => servicio.listarGrupos(req.query)));
  app.get(`${base}/grupos/:grupo`, ruta(req => servicio.detalleGrupo(req.params.grupo)));
  app.post(`${base}/grupos/:grupo/offsets`, ruta(req => servicio.reiniciarOffsets(req.params.grupo, req.body)));
  app.delete(`${base}/grupos/:grupo`, ruta(req => servicio.borrarGrupo(req.params.grupo)));

  app.get(`${base}/dlt/:servicio`, ruta(req => servicio.verDlt(req.params.servicio, req.query)));
  app.post(`${base}/dlt/:servicio/reprocesar`, ruta(req => servicio.reprocesarDlt(req.params.servicio, req.body)));

  return cerrarApp(app, 'admin');
}