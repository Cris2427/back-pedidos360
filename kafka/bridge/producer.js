// Publicador de eventos de pedidos: el productor del sistema.
//   npm run producer                     5.000 eventos repartidos en unos 60 segundos
//   npm run producer -- 200              200 eventos
//   npm run producer -- --segundos 0     sin pausas, lo más rápido posible
// Casos de error (publican solo ese caso y terminan):
//   npm run producer -- --salto          un pedido que pasa de CREADO a DESPACHADO
//   npm run producer -- --duplicado      el mismo evento dos veces
//   npm run producer -- --total-malo     un pedido con el total mal calculado
//   npm run producer -- --malo           un mensaje que no es JSON
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { crearKafka, CONFIG_PRODUCTOR, OPCIONES_ENVIO } from '../shared/kafka.js';
import { PEDIDOS } from '../shared/topics.js';
import { serializar } from '../shared/serializador.js';
import { generarEventos, resumen, nuevoCodigo, casoSalto, casoDuplicado, casoTotalMalo } from './simulador.js';

const LOTE = 100; // eventos por envío

const kafka = crearKafka('bridge-producer');
const producer = kafka.producer(CONFIG_PRODUCTOR);
const admin = kafka.admin();

// Identifica esta ejecución. Va en un header de cada mensaje: con él se sigue
// en los logs de los consumidores todo lo que publicó esta corrida.
const correlationId = crypto.randomUUID();

// Ctrl+C: termina el lote en curso, no manda más y se desconecta bien.
// Un segundo Ctrl+C lo corta de inmediato.
let detener = false;
process.once('SIGINT', () => {
  detener = true;
  console.log('\nDeteniendo: se termina el lote en curso...');
});

function leerOpciones() {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        segundos: { type: 'string', default: '60' },
        salto: { type: 'boolean' },
        duplicado: { type: 'boolean' },
        'total-malo': { type: 'boolean' },
        malo: { type: 'boolean' },
      },
    }));
  } catch {
    throw new Error('opción desconocida. Se puede usar: una cantidad, --segundos N, --salto, --duplicado, --total-malo o --malo');
  }
  const cantidad = Number(positionals[0] ?? 5000);
  const segundos = Number(values.segundos);
  if (!Number.isInteger(cantidad) || cantidad < 1) throw new Error('la cantidad debe ser un entero mayor que 0, por ejemplo: npm run producer -- 200');
  if (!(segundos >= 0)) throw new Error('--segundos debe ser 0 o más');
  return { ...values, cantidad, segundos };
}

// El mensaje que viaja por Kafka: la key (pedidoId, decide la partición), el
// value (el DTO serializado, que valida antes) y los headers.
function mensajeDe(evento) {
  return {
    key: evento.pedidoId,
    value: serializar(evento),
    headers: { correlationId, tipo: evento.tipo },
  };
}

// Los casos de error. --total-malo y --malo se saltan el serializador a
// propósito: simulan otro sistema que publica sin validar, que es justo lo
// que el consumidor tiene que aguantar.
function mensajesDeCaso(opciones) {
  const codigo = nuevoCodigo();
  if (opciones.salto) return casoSalto(codigo).map(mensajeDe);
  if (opciones.duplicado) return casoDuplicado(codigo).map(mensajeDe);
  if (opciones['total-malo']) {
    const evento = casoTotalMalo(codigo);
    return [{ key: evento.pedidoId, value: JSON.stringify(evento), headers: { correlationId, tipo: evento.tipo } }];
  }
  if (opciones.malo) return [{ key: `PED-MALO-${codigo}`, value: '{ esto no es JSON', headers: { correlationId } }];
  return null;
}

// Último offset de cada partición. Comparando antes y después se sabe
// cuántos mensajes recibió cada una.
async function offsets() {
  const particiones = await admin.fetchTopicOffsets(PEDIDOS);
  return Object.fromEntries(particiones.map(p => [p.partition, Number(p.high)]));
}

// Envía los mensajes en lotes, repartidos parejo en `segundos`
async function publicar(mensajes, segundos) {
  const lotes = [];
  for (let i = 0; i < mensajes.length; i += LOTE) lotes.push(mensajes.slice(i, i + LOTE));
  const intervalo = (segundos * 1000) / lotes.length; // ms entre el inicio de un lote y el siguiente
  const inicio = Date.now();
  let enviados = 0;
  for (const [i, lote] of lotes.entries()) {
    if (detener) break;
    const espera = inicio + i * intervalo - Date.now();
    if (espera > 0) await new Promise(r => setTimeout(r, espera));
    await producer.send({ topic: PEDIDOS, messages: lote, ...OPCIONES_ENVIO });
    enviados += lote.length;
    if ((i + 1) % 10 === 0 || i === lotes.length - 1) console.log(`  ${enviados} de ${mensajes.length}`);
  }
  return { enviados, ms: Math.max(Date.now() - inicio, 1) };
}

async function main() {
  const opciones = leerOpciones();
  await producer.connect();
  await admin.connect();
  try {
    const caso = mensajesDeCaso(opciones);
    if (caso) {
      await producer.send({ topic: PEDIDOS, messages: caso, ...OPCIONES_ENVIO });
      console.log(`Publicado: ${caso.length} mensaje(s) con key ${caso[0].key} (correlationId ${correlationId})`);
      return;
    }

    const eventos = generarEventos(opciones.cantidad);
    // se serializan todos antes de empezar: si uno es inválido, no se publica nada
    const mensajes = eventos.map(mensajeDe);
    const antes = await offsets();
    console.log(`Publicando ${mensajes.length} eventos en ${PEDIDOS} (correlationId ${correlationId})`);
    const { enviados, ms } = await publicar(mensajes, opciones.segundos);
    const despues = await offsets();

    console.log(`\nPublicados ${enviados} eventos en ${(ms / 1000).toFixed(1)} s (${Math.round(enviados / (ms / 1000))} por segundo)`);
    console.log('Mensajes por partición (key = pedidoId):');
    for (const p of Object.keys(despues)) console.log(`  partición ${p}: ${despues[p] - (antes[p] ?? 0)}`);
    const { pedidos, porEstado } = resumen(eventos.slice(0, enviados));
    console.log(`\n${pedidos} pedidos. Estado en que quedó cada uno (para comparar con report):`);
    console.table(porEstado);
  } finally {
    await producer.disconnect();
    await admin.disconnect();
  }
}

main().catch(e => {
  console.error(`npm run producer falló: ${e.message}`);
  process.exitCode = 1;
});