// el equivalente a los dto con @Valid: cada funcion recibe el cuerpo crudo y
// devuelve { dto } limpio o { error } con el motivo exacto, antes de tocar aws
import { config } from './config.mjs';

// las reglas de nombres son las de sqs y sns
const NOMBRE_VALIDO = /^[A-Za-z0-9_-]+$/;
const SUFIJO_DLQ = '-dlq';
const OPERADORES_FILTRO = ['prefix', 'suffix', 'anything-but', 'numeric', 'exists', 'equals-ignore-case'];

const rechazo = (error) => ({ error });

const esObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// un campo con otro nombre seria un error de tipeo que pasaria en silencio
function camposDesconocidos(body, permitidos) {
  const extra = Object.keys(body).filter((k) => !permitidos.includes(k));
  return extra.length ? rechazo(`Campos no reconocidos: ${extra.join(', ')}.`) : null;
}

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

export function validarNombre(nombre, { de, max }) {
  if (!nombre) return `Falta el nombre ${de}.`;
  if (nombre.endsWith('.fifo')) return 'Solo se usan recursos estándar: los nombres .fifo son de FIFO.';
  if (nombre.length > max) return `El nombre ${de} admite hasta ${max} caracteres.`;
  if (!NOMBRE_VALIDO.test(nombre)) {
    return `El nombre ${de} solo admite letras sin tilde, números, guiones y guiones bajos.`;
  }
  return null;
}

function entero(valor, { campo, min, max, porDefecto }) {
  const n = valor ?? porDefecto;
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: `"${campo}" debe ser un entero entre ${min} y ${max}.` };
  }
  return { valor: n };
}

export function validarNuevaCola(body) {
  if (!esObjeto(body)) return rechazo('El cuerpo debe ser un objeto JSON.');
  const extra = camposDesconocidos(body, ['nombre', 'maxReceiveCount', 'visibilidadSegundos']);
  if (extra) return extra;

  const nombre = texto(body.nombre);
  // la dlq se llama igual mas "-dlq" y sqs permite 80 caracteres en total
  const malo = validarNombre(nombre, { de: 'de la cola', max: 80 - SUFIJO_DLQ.length });
  if (malo) return rechazo(malo);
  if (nombre.endsWith(SUFIJO_DLQ)) {
    return rechazo(`No termines el nombre en "${SUFIJO_DLQ}": la DLQ se crea sola junto a la cola.`);
  }

  const reintentos = entero(body.maxReceiveCount, {
    campo: 'maxReceiveCount', min: 1, max: 1000, porDefecto: config.mensajeria.maxReceiveCount,
  });
  if (reintentos.error) return rechazo(reintentos.error);

  // sqs permite hasta 12 horas de visibilidad
  const visibilidad = entero(body.visibilidadSegundos, {
    campo: 'visibilidadSegundos', min: 0, max: 43200, porDefecto: config.mensajeria.visibilidadSegundos,
  });
  if (visibilidad.error) return rechazo(visibilidad.error);

  return {
    dto: { nombre, maxReceiveCount: reintentos.valor, visibilidadSegundos: visibilidad.valor },
  };
}

export function validarNuevoTopic(body) {
  if (!esObjeto(body)) return rechazo('El cuerpo debe ser un objeto JSON.');
  const extra = camposDesconocidos(body, ['nombre']);
  if (extra) return extra;

  const nombre = texto(body.nombre);
  const malo = validarNombre(nombre, { de: 'del topic', max: 256 });
  return malo ? rechazo(malo) : { dto: { nombre } };
}

// la forma que acepta sns: { atributo: [valor, valor, { operador: ... }] }
function validarFiltro(filtro) {
  if (!esObjeto(filtro)) return 'El filtro debe ser un objeto, por ejemplo { "tipo_evento": ["PedidoAceptado"] }.';
  const atributos = Object.keys(filtro);
  if (atributos.length === 0) return 'El filtro no puede estar vacío; si la cola debe recibir todo, omítelo.';
  if (atributos.length > 5) return 'El filtro admite hasta 5 atributos.';

  for (const atributo of atributos) {
    const valores = filtro[atributo];
    if (!Array.isArray(valores) || valores.length === 0) {
      return `El atributo "${atributo}" del filtro debe ser una lista con al menos un valor.`;
    }
    for (const v of valores) {
      if (typeof v === 'string' || typeof v === 'number') continue;
      const claves = esObjeto(v) ? Object.keys(v) : [];
      if (claves.length !== 1 || !OPERADORES_FILTRO.includes(claves[0])) {
        return `Valor inválido en "${atributo}": usa textos, números u operadores (${OPERADORES_FILTRO.join(', ')}).`;
      }
    }
  }
  return null;
}

export function validarNuevoBinding(body) {
  if (!esObjeto(body)) return rechazo('El cuerpo debe ser un objeto JSON.');
  const extra = camposDesconocidos(body, ['topic', 'cola', 'filtro']);
  if (extra) return extra;

  const topic = texto(body.topic);
  const cola = texto(body.cola);
  const malo = validarNombre(topic, { de: 'del topic', max: 256 }) ??
    validarNombre(cola, { de: 'de la cola', max: 80 });
  if (malo) return rechazo(malo);

  const filtro = body.filtro ?? null;
  if (filtro !== null) {
    const filtroMalo = validarFiltro(filtro);
    if (filtroMalo) return rechazo(filtroMalo);
  }

  return { dto: { topic, cola, filtro } };
}

// el id de un binding es el ultimo tramo del arn de la suscripcion
export const validarIdBinding = (id) =>
  /^[A-Za-z0-9-]{1,100}$/.test(String(id ?? '')) ? null : 'El id del binding no es válido.';
