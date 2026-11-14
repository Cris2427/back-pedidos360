// npm run timeline: la segunda mitad de audit.
//   - lee audit.timeline en el grupo audit-timeline y guarda cada registro
//     en PostgreSQL (audit.registros)
//   - sirve la API de auditoría en http://localhost:3003/api/audit
// Lo que no pueda guardar va a la DLT de audit (pedidos.eventos.audit.dlt):
// una DLT por servicio, y sus headers dicen de qué tópico y grupo venía.
import { iniciarConsumidor, crearLog } from '../shared/consumidor.js';
import { TIMELINE } from '../shared/topics.js';
import { crearPool, prepararEsquema } from '../shared/db.js';
import { deserializarRegistro } from './registro.js';
import { repositorioPostgres } from './repositorio.js';
import { crearApi } from './api.js';
import { verificadorDesdeEnv } from '../shared/auth.js';

const PUERTO = 3003;
const log = crearLog('audit');

async function main() {
  // primero el filtro JWT: si falta la configuración de Entra ID, falla
  // antes de tocar Kafka o la base de datos
  const verificar = verificadorDesdeEnv();
  const pool = crearPool('audit-timeline');
  await prepararEsquema(pool);
  const repo = repositorioPostgres(pool);

  // Igual que en report: si el puerto está ocupado, otra instancia ya sirve
  // la API y esta solo consume
  const servidor = crearApi(repo, { origen: process.env.CORS_ORIGEN, verificar }).listen(PUERTO, () => {
    log(`API en http://localhost:${PUERTO}/api/audit`);
  });
  servidor.on('error', error => {
    if (error.code !== 'EADDRINUSE') throw error;
    log(`el puerto ${PUERTO} está ocupado: esta instancia solo consume`);
  });

  await iniciarConsumidor({
    servicio: 'audit',
    groupId: 'audit-timeline',
    topic: TIMELINE,
    // los mensajes de este tópico son registros, no eventos de pedido
    deserializar: deserializarRegistro,
    procesar: registro => repo.guardar(registro),
  });
}

main().catch(e => {
  console.error(`npm run timeline falló: ${e.message}`);
  process.exit(1);
}); 