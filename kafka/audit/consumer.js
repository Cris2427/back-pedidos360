// npm run audit: el servicio audit.
// Lee pedidos.eventos en su propio grupo (audit), con sus propios offsets:
// no le quita mensajes a report, los dos leen todo. Por cada evento publica
// un registro legible en audit.timeline (ver auditoria.js).
// No guarda nada: los registros los guarda el lector del timeline.
import { iniciarConsumidor } from '../shared/consumidor.js';
import { PEDIDOS } from '../shared/topics.js';
import { publicarRegistro } from './auditoria.js';

iniciarConsumidor({ servicio: 'audit', topic: PEDIDOS, procesar: publicarRegistro })
  .catch(e => {
    console.error(`npm run audit falló: ${e.message}`);
    process.exit(1);
  });