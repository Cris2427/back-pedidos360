// npm run report: el servicio report.
//   - consume pedidos.eventos en el grupo report y guarda el estado de cada
//     pedido en PostgreSQL (esquema report)
//   - sirve la API de KPIs en http://localhost:3001/api/report
// Opciones:
//   npm run report -- --lento 50
//       tarda 50 ms por evento: para ver el lag en Kafka UI y repartir la
//       carga levantando más instancias (en otras terminales)
//   npm run report -- --grupo report-v2 --memoria --puerto 3002
//       replay: un grupo nuevo reconstruye los KPIs desde el primer evento,
//       en memoria, sin tocar la base. Debe llegar a los mismos números.
//       Con --memoria va una sola instancia: cada una tendría su propia
//       memoria y no conocería los pedidos que procesó la otra.
import { parseArgs } from 'node:util';
import { iniciarConsumidor, crearLog } from '../shared/consumidor.js';
import { crearKafka } from '../shared/kafka.js';
import { PEDIDOS } from '../shared/topics.js';
import { crearPool, prepararEsquema } from '../shared/db.js';
import { repositorioPostgres, repositorioMemoria } from './repositorio.js';
import { aplicarEvento } from './kpis.js';
import { crearApi } from './api.js';
import { verificadorDesdeEnv } from '../shared/auth.js';

const log = crearLog('report');

function leerOpciones() {
  try {
    const { values } = parseArgs({
      options: {
        grupo: { type: 'string', default: 'report' },
        memoria: { type: 'boolean', default: false },
        puerto: { type: 'string', default: '3001' },
        lento: { type: 'string', default: '0' },
      },
    });
    return { ...values, puerto: Number(values.puerto), lento: Number(values.lento) };
  } catch {
    throw new Error('opción desconocida. Se puede usar: --grupo NOMBRE, --memoria, --puerto N, --lento MS');
  }
}

// La memoria parte vacía, así que el grupo también debe partir desde el
// primer evento: se borran sus offsets guardados antes de unirse
async function olvidarOffsets(grupo) {
  const admin = crearKafka('report-replay').admin();
  await admin.connect();
  try {
    await admin.deleteGroups([grupo]);
    log(`offsets del grupo ${grupo} borrados: lee desde el primer evento`);
  } catch {
    // el grupo todavía no existía: ya parte desde el principio
  } finally {
    await admin.disconnect();
  }
}

async function main() {
  const opciones = leerOpciones();
  // primero el filtro JWT: si falta la configuración de Entra ID, falla
  // antes de tocar Kafka o la base de datos
  const verificar = verificadorDesdeEnv();  

  let repo;
  if (opciones.memoria) {
    repo = repositorioMemoria();
    await olvidarOffsets(opciones.grupo);
  } else {
    const pool = crearPool('report');
    await prepararEsquema(pool);
    repo = repositorioPostgres(pool);
  }

  // Si el puerto está ocupado es porque otra instancia ya sirve la API:
  // esta solo consume (así se pueden levantar varias para repartir la carga)
  const servidor = crearApi(repo, { origen: process.env.CORS_ORIGEN, verificar }).listen(opciones.puerto, () => {
    log(`API en http://localhost:${opciones.puerto}/api/report (${opciones.memoria ? 'memoria' : 'PostgreSQL'})`);
  });
  servidor.on('error', error => {
    if (error.code !== 'EADDRINUSE') throw error;
    log(`el puerto ${opciones.puerto} está ocupado: esta instancia solo consume`);
  });

  await iniciarConsumidor({
    servicio: 'report',
    groupId: opciones.grupo,
    topic: PEDIDOS,
    procesar: async evento => {
      if (opciones.lento) await new Promise(r => setTimeout(r, opciones.lento));
      return aplicarEvento(repo, evento);
    },
  });
}

main().catch(e => {
  console.error(`npm run report falló: ${e.message}`);
  process.exit(1);
});