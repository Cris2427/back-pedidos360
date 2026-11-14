// npm run admin: el microservicio administrador de Kafka, con su API en
// http://localhost:3004/api/admin (las rutas están en admin/api.js).
// Usa un cliente admin para tópicos, grupos y configuración, y un productor
// para devolver a su tópico los mensajes que se reprocesan desde una DLT.
import { crearKafka, CONFIG_PRODUCTOR } from '../shared/kafka.js';
import { crearLog } from '../shared/consumidor.js';
import { crearServicio } from './servicio.js';
import { crearApi } from './api.js';

const PUERTO = 3004;
const log = crearLog('admin');

async function main() {
  const kafka = crearKafka(`admin-${process.pid}`);
  const admin = kafka.admin();
  const producer = kafka.producer(CONFIG_PRODUCTOR);
  await admin.connect();
  await producer.connect();

  const servicio = crearServicio({ kafka, admin, producer, log });
  const servidor = crearApi(servicio, { origen: process.env.CORS_ORIGEN }).listen(PUERTO, () => {
    log(`API en http://localhost:${PUERTO}/api/admin`);
  });
  // a diferencia de report y audit, el admin no consume: una segunda
  // instancia no tendría nada que hacer
  servidor.on('error', error => {
    console.error(`npm run admin falló: ${error.code === 'EADDRINUSE' ? `el puerto ${PUERTO} está ocupado (¿ya hay un admin corriendo?)` : error.message}`);
    process.exit(1);
  });

  const apagar = async () => {
    log('apagando...');
    servidor.close();
    await producer.disconnect();
    await admin.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', apagar);
  process.once('SIGTERM', apagar);
}

main().catch(e => {
  console.error(`npm run admin falló: ${e.message}`);
  process.exit(1);
});