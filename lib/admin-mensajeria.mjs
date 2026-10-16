// el equivalente al RabbitAdminService: crear y borrar colas, topics
// (exchanges) y suscripciones (bindings). las reglas viven en el servicio y el
// adaptador solo habla con aws, asi las reglas se prueban sin aws
import { config } from './config.mjs';
import { noEncontrado, conflicto } from './errores.mjs';

const SUFIJO_DLQ = '-dlq';
const nombreDeArn = (arn) => String(arn ?? '').split(':').pop();
const sinMensajes = { disponibles: 0, enProceso: 0 };

// ======================= servicio (reglas) =======================

export function crearServicio(infra) {
  const total = (c) => c.disponibles + c.enProceso + (c.retrasados ?? 0);
  const topicPorNombre = async (nombre) => (await infra.topics()).find((t) => t.nombre === nombre) ?? null;

  async function describirCola(c) {
    const dlq = c.dlq ? await infra.cola(c.dlq) : null;
    return {
      nombre: c.nombre,
      arn: c.arn,
      visibilidadSegundos: c.visibilidadSegundos,
      maxReceiveCount: c.maxReceiveCount,
      mensajes: { disponibles: c.disponibles, enProceso: c.enProceso },
      dlq: c.dlq
        ? { nombre: c.dlq, mensajes: dlq ? { disponibles: dlq.disponibles, enProceso: dlq.enProceso } : null }
        : null,
      consumidor: await infra.consumidorDe(c.arn),
    };
  }

  return {
    // las dlq se muestran dentro de su cola, no sueltas
    async listarColas() {
      const nombres = (await infra.colas()).filter((n) => !n.endsWith(SUFIJO_DLQ)).sort();
      const colas = [];
      for (const nombre of nombres) {
        const c = await infra.cola(nombre);
        if (c) colas.push(await describirCola(c));
      }
      return colas;
    },

    async crearCola({ nombre, maxReceiveCount, visibilidadSegundos }) {
      if (await infra.cola(nombre)) throw conflicto(`La cola '${nombre}' ya existe.`);

      // primero la dlq: la cola principal la necesita para su redrive policy
      const dlq = nombre + SUFIJO_DLQ;
      let arnDlq = (await infra.cola(dlq))?.arn;
      if (!arnDlq) ({ arn: arnDlq } = await infra.crearCola(dlq, { retencionDias: config.mensajeria.retencionDlqDias }));

      const { arn } = await infra.crearCola(nombre, { visibilidadSegundos, maxReceiveCount, arnDlq });
      return {
        nombre, arn, visibilidadSegundos, maxReceiveCount,
        mensajes: sinMensajes,
        dlq: { nombre: dlq, mensajes: sinMensajes },
        consumidor: null,
      };
    },

    // cada regla evita dejar algo roto o perder mensajes sin querer
    async eliminarCola(nombre) {
      const c = await infra.cola(nombre);
      if (!c) throw noEncontrado(`La cola '${nombre}' no existe.`);

      for (const otra of await infra.colas()) {
        if (otra === nombre) continue;
        if ((await infra.cola(otra))?.dlq === nombre) {
          throw conflicto(`'${nombre}' es la DLQ de '${otra}': se borra junto con esa cola.`);
        }
      }
      const consumidor = await infra.consumidorDe(c.arn);
      if (consumidor) throw conflicto(`La cola '${nombre}' la consume la Lambda '${consumidor}'; desconéctala primero.`);

      const binding = (await infra.suscripciones()).find((s) => s.endpoint === c.arn);
      if (binding) {
        throw conflicto(`La cola '${nombre}' está suscrita al topic '${nombreDeArn(binding.topicArn)}'; quita ese binding primero.`);
      }
      if (total(c) > 0) throw conflicto(`La cola '${nombre}' tiene ${total(c)} mensaje(s) sin procesar.`);

      // solo se borra la dlq propia: una compartida podria ser de otra cola
      const dlq = c.dlq === nombre + SUFIJO_DLQ ? await infra.cola(c.dlq) : null;
      if (dlq && total(dlq) > 0) {
        throw conflicto(`La DLQ '${dlq.nombre}' tiene ${total(dlq)} mensaje(s); revísalos antes de borrar.`);
      }

      await infra.borrarCola(nombre);
      if (dlq) await infra.borrarCola(dlq.nombre);
      return { eliminada: nombre, dlq: dlq?.nombre ?? null };
    },

    async listarTopics() {
      const subs = await infra.suscripciones();
      return (await infra.topics())
        .map((t) => ({ ...t, suscripciones: subs.filter((s) => s.topicArn === t.arn).length }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre));
    },

    async crearTopic({ nombre }) {
      if (await topicPorNombre(nombre)) throw conflicto(`El topic '${nombre}' ya existe.`);
      const arn = await infra.crearTopic(nombre);
      return { nombre, arn, suscripciones: 0 };
    },

    async eliminarTopic(nombre) {
      const t = await topicPorNombre(nombre);
      if (!t) throw noEncontrado(`El topic '${nombre}' no existe.`);
      const subs = (await infra.suscripciones()).filter((s) => s.topicArn === t.arn);
      if (subs.length > 0) {
        throw conflicto(`El topic '${nombre}' tiene ${subs.length} suscripción(es); quita esos bindings primero.`);
      }
      await infra.borrarTopic(t.arn);
      return { eliminado: nombre };
    },

    async listarBindings() {
      const bindings = [];
      for (const s of (await infra.suscripciones()).filter((x) => x.protocolo === 'sqs')) {
        const { filtro, entregaSinProcesar } = await infra.detalleSuscripcion(s.arn);
        bindings.push({
          id: s.id, topic: nombreDeArn(s.topicArn), cola: nombreDeArn(s.endpoint), filtro, entregaSinProcesar,
        });
      }
      return bindings.sort((a, b) => `${a.topic}${a.cola}`.localeCompare(`${b.topic}${b.cola}`));
    },

    async crearBinding({ topic, cola, filtro }) {
      const t = await topicPorNombre(topic);
      if (!t) throw noEncontrado(`El topic '${topic}' no existe.`);
      const c = await infra.cola(cola);
      if (!c) throw noEncontrado(`La cola '${cola}' no existe.`);
      if (cola.endsWith(SUFIJO_DLQ)) throw conflicto('Una DLQ solo recibe lo que falla: no se suscribe a un topic.');

      const ya = (await infra.suscripciones()).find((s) => s.topicArn === t.arn && s.endpoint === c.arn);
      if (ya) throw conflicto(`La cola '${cola}' ya está suscrita al topic '${topic}'.`);

      // sin este permiso el topic no puede escribir en la cola y los mensajes
      // se pierden sin ningun error a la vista
      await infra.permitirTopicEnCola(cola, t.arn);
      const arn = await infra.suscribir(t.arn, c.arn, filtro);
      return { id: nombreDeArn(arn), topic, cola, filtro, entregaSinProcesar: true };
    },

    async eliminarBinding(id) {
      const s = (await infra.suscripciones()).find((x) => x.id === id);
      if (!s) throw noEncontrado(`El binding '${id}' no existe.`);
      await infra.desuscribir(s.arn);
      return { eliminado: id };
    },
  };
}

// ======================= adaptador aws =======================

function crearInfraAws() {
  // mismo truco que el store: el sdk viene en lambda pero no en el repo
  let sdk = null;
  const cargar = () =>
    (sdk ??= Promise.all([
      import('@aws-sdk/client-sqs'),
      import('@aws-sdk/client-sns'),
      import('@aws-sdk/client-lambda'),
    ]).then(([sqsLib, snsLib, lambdaLib]) => ({
      sqs: new sqsLib.SQSClient({}), sqsLib,
      sns: new snsLib.SNSClient({}), snsLib,
      lambda: new lambdaLib.LambdaClient({}), lambdaLib,
    })));

  const esColaInexistente = (e) => /NonExistentQueue|QueueDoesNotExist/.test(`${e?.name} ${e?.Code}`);

  // https://sqs.us-east-1.amazonaws.com/<cuenta>/<nombre> -> arn de la cola
  const arnDesdeUrl = (url) => {
    const { hostname, pathname } = new URL(url);
    const [, cuenta, nombre] = pathname.split('/');
    return `arn:aws:sqs:${hostname.split('.')[1]}:${cuenta}:${nombre}`;
  };

  // una cola recien creada puede tardar en aparecer en GetQueueUrl
  const urls = new Map();
  async function urlDe(nombre) {
    if (urls.has(nombre)) return urls.get(nombre);
    const { sqs, sqsLib } = await cargar();
    try {
      return (await sqs.send(new sqsLib.GetQueueUrlCommand({ QueueName: nombre }))).QueueUrl;
    } catch (e) {
      if (esColaInexistente(e)) return null;
      throw e;
    }
  }

  async function paginar(pedir, campo) {
    const todo = [];
    let NextToken;
    do {
      const r = await pedir(NextToken);
      todo.push(...(r[campo] ?? []));
      NextToken = r.NextToken;
    } while (NextToken);
    return todo;
  }

  const infra = {
    async colas() {
      const { sqs, sqsLib } = await cargar();
      const lista = await paginar(
        (NextToken) => sqs.send(new sqsLib.ListQueuesCommand({ NextToken, MaxResults: 1000 })),
        'QueueUrls',
      );
      return lista.map((u) => u.split('/').pop());
    },

    async cola(nombre) {
      const url = await urlDe(nombre);
      if (!url) return null;
      const { sqs, sqsLib } = await cargar();
      let a;
      try {
        ({ Attributes: a = {} } = await sqs.send(
          new sqsLib.GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }),
        ));
      } catch (e) {
        if (esColaInexistente(e)) return null;
        throw e;
      }
      const redrive = a.RedrivePolicy ? JSON.parse(a.RedrivePolicy) : null;
      return {
        nombre,
        url,
        arn: a.QueueArn,
        politica: a.Policy ?? null,
        visibilidadSegundos: Number(a.VisibilityTimeout),
        maxReceiveCount: redrive ? Number(redrive.maxReceiveCount) : null,
        dlq: redrive ? nombreDeArn(redrive.deadLetterTargetArn) : null,
        disponibles: Number(a.ApproximateNumberOfMessages ?? 0),
        enProceso: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
        retrasados: Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
      };
    },

    async crearCola(nombre, { visibilidadSegundos, maxReceiveCount, arnDlq, retencionDias }) {
      const { sqs, sqsLib } = await cargar();
      const Attributes = {};
      if (visibilidadSegundos !== undefined) Attributes.VisibilityTimeout = String(visibilidadSegundos);
      if (retencionDias !== undefined) Attributes.MessageRetentionPeriod = String(retencionDias * 86400);
      if (arnDlq) Attributes.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: arnDlq, maxReceiveCount });
      const { QueueUrl } = await sqs.send(new sqsLib.CreateQueueCommand({ QueueName: nombre, Attributes }));
      urls.set(nombre, QueueUrl);
      return { arn: arnDesdeUrl(QueueUrl) };
    },

    async borrarCola(nombre) {
      const url = await urlDe(nombre);
      if (!url) return;
      const { sqs, sqsLib } = await cargar();
      await sqs.send(new sqsLib.DeleteQueueCommand({ QueueUrl: url }));
      urls.delete(nombre);
    },

    async consumidorDe(arnCola) {
      const { lambda, lambdaLib } = await cargar();
      const { EventSourceMappings = [] } = await lambda.send(
        new lambdaLib.ListEventSourceMappingsCommand({ EventSourceArn: arnCola }),
      );
      return EventSourceMappings[0] ? nombreDeArn(EventSourceMappings[0].FunctionArn) : null;
    },

    async topics() {
      const { sns, snsLib } = await cargar();
      const lista = await paginar((NextToken) => sns.send(new snsLib.ListTopicsCommand({ NextToken })), 'Topics');
      return lista.map((t) => ({ nombre: nombreDeArn(t.TopicArn), arn: t.TopicArn }));
    },

    async crearTopic(nombre) {
      const { sns, snsLib } = await cargar();
      return (await sns.send(new snsLib.CreateTopicCommand({ Name: nombre }))).TopicArn;
    },

    async borrarTopic(arn) {
      const { sns, snsLib } = await cargar();
      await sns.send(new snsLib.DeleteTopicCommand({ TopicArn: arn }));
    },

    // solo las confirmadas: las pendientes no tienen arn todavia
    async suscripciones() {
      const { sns, snsLib } = await cargar();
      const lista = await paginar(
        (NextToken) => sns.send(new snsLib.ListSubscriptionsCommand({ NextToken })),
        'Subscriptions',
      );
      return lista
        .filter((s) => String(s.SubscriptionArn).startsWith('arn:'))
        .map((s) => ({
          id: nombreDeArn(s.SubscriptionArn),
          arn: s.SubscriptionArn,
          topicArn: s.TopicArn,
          protocolo: s.Protocol,
          endpoint: s.Endpoint,
        }));
    },

    async detalleSuscripcion(arn) {
      const { sns, snsLib } = await cargar();
      const { Attributes: a = {} } = await sns.send(
        new snsLib.GetSubscriptionAttributesCommand({ SubscriptionArn: arn }),
      );
      return {
        filtro: a.FilterPolicy ? JSON.parse(a.FilterPolicy) : null,
        entregaSinProcesar: a.RawMessageDelivery === 'true',
      };
    },

    // se suma a la politica que ya tenga la cola, sin borrar lo demas
    async permitirTopicEnCola(nombreCola, arnTopic) {
      const c = await infra.cola(nombreCola);
      const politica = c.politica ? JSON.parse(c.politica) : { Version: '2012-10-17', Statement: [] };
      const declaraciones = [].concat(politica.Statement ?? []);
      if (JSON.stringify(declaraciones).includes(arnTopic)) return;
      declaraciones.push({
        Sid: `topic-${nombreDeArn(arnTopic)}`,
        Effect: 'Allow',
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: c.arn,
        Condition: { ArnEquals: { 'aws:SourceArn': arnTopic } },
      });
      const { sqs, sqsLib } = await cargar();
      await sqs.send(
        new sqsLib.SetQueueAttributesCommand({
          QueueUrl: c.url,
          Attributes: { Policy: JSON.stringify({ ...politica, Statement: declaraciones }) },
        }),
      );
    },

    async suscribir(arnTopic, arnCola, filtro) {
      const { sns, snsLib } = await cargar();
      const Attributes = { RawMessageDelivery: 'true' };
      if (filtro) {
        Attributes.FilterPolicy = JSON.stringify(filtro);
        Attributes.FilterPolicyScope = 'MessageAttributes';
      }
      const { SubscriptionArn } = await sns.send(
        new snsLib.SubscribeCommand({
          TopicArn: arnTopic, Protocol: 'sqs', Endpoint: arnCola, Attributes, ReturnSubscriptionArn: true,
        }),
      );
      return SubscriptionArn;
    },

    async desuscribir(arn) {
      const { sns, snsLib } = await cargar();
      await sns.send(new snsLib.UnsubscribeCommand({ SubscriptionArn: arn }));
    },
  };
  return infra;
}

// ======================= adaptador en memoria =======================

// solo para las pruebas: misma interfaz, sin aws
function crearInfraMemoria() {
  const colas = new Map();
  const topics = new Map();
  const subs = [];
  let n = 0;
  const arnCola = (nombre) => `arn:aws:sqs:local:000000000000:${nombre}`;

  return {
    async colas() {
      return [...colas.keys()];
    },
    async cola(nombre) {
      const c = colas.get(nombre);
      return c ? { nombre, arn: arnCola(nombre), retrasados: 0, ...c } : null;
    },
    async crearCola(nombre, { visibilidadSegundos = 30, maxReceiveCount = null, arnDlq = null }) {
      colas.set(nombre, {
        visibilidadSegundos, maxReceiveCount, dlq: arnDlq ? nombreDeArn(arnDlq) : null,
        disponibles: 0, enProceso: 0, consumidor: null,
      });
      return { arn: arnCola(nombre) };
    },
    async borrarCola(nombre) {
      colas.delete(nombre);
    },
    async consumidorDe(arn) {
      return colas.get(nombreDeArn(arn))?.consumidor ?? null;
    },
    async topics() {
      return [...topics].map(([nombre, arn]) => ({ nombre, arn }));
    },
    async crearTopic(nombre) {
      const arn = `arn:aws:sns:local:000000000000:${nombre}`;
      topics.set(nombre, arn);
      return arn;
    },
    async borrarTopic(arn) {
      topics.delete(nombreDeArn(arn));
    },
    async suscripciones() {
      return subs.map(({ id, arn, topicArn, protocolo, endpoint }) => ({ id, arn, topicArn, protocolo, endpoint }));
    },
    async detalleSuscripcion(arn) {
      const s = subs.find((x) => x.arn === arn);
      return { filtro: s.filtro, entregaSinProcesar: true };
    },
    async permitirTopicEnCola() {},
    async suscribir(topicArn, endpoint, filtro) {
      const id = `sub-${++n}`;
      const arn = `${topicArn}:${id}`;
      subs.push({ id, arn, topicArn, protocolo: 'sqs', endpoint, filtro });
      return arn;
    },
    async desuscribir(arn) {
      const i = subs.findIndex((s) => s.arn === arn);
      if (i >= 0) subs.splice(i, 1);
    },
    // para armar en las pruebas los casos que en aws dependen de otros servicios
    simular: {
      encolar: (nombre, cantidad) => { colas.get(nombre).disponibles += cantidad; },
      vaciar: (nombre) => { colas.get(nombre).disponibles = 0; },
      conectarConsumidor: (nombre, funcion) => { colas.get(nombre).consumidor = funcion; },
    },
  };
}

// una instancia por proceso, igual que el store
let instancia = null;

export function crearAdminMensajeria() {
  if (!instancia) {
    const infra = process.env.STORE === 'memory' ? crearInfraMemoria() : crearInfraAws();
    instancia = { ...crearServicio(infra), simular: infra.simular };
  }
  return instancia;
}
