// backend/pedidos360-api/lib/http.mjs
// Respuestas HTTP y CORS, compartidas por todas las Lambdas.

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';

export const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

export const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

/**
 * El preflight NO debería llegar a la Lambda: OPTIONS viaja sin el header
 * Authorization, así que el JWT authorizer lo rechazaría con 401. El CORS se
 * configura en el API Gateway; esto es solo una red de seguridad.
 */
export function preflight(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  return method === 'OPTIONS' ? { statusCode: 204, headers, body: '' } : null;
}

/** Cuerpo JSON de la petición, ya decodificado. */
export function leerBody(event) {
  if (!event.body) return {};
  const texto = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString()
    : event.body;
  try {
    return JSON.parse(texto);
  } catch {
    return null; // cuerpo mal formado: el handler responde 400
  }
}

export const idDeRuta = (event) => event.pathParameters?.id;

/**
 * Envuelve un handler para que un error inesperado no devuelva una traza.
 * El detalle queda en CloudWatch.
 */
export function conManejoDeErrores(fn) {
  return async (event) => {
    const pre = preflight(event);
    if (pre) return pre;
    try {
      return await fn(event);
    } catch (error) {
      console.error('Error en Lambda:', error);
      // Lo más probable acá es un permiso de IAM faltante sobre DynamoDB.
      const detalle = error?.name ? ` (${error.name})` : '';
      return json(500, { error: `Error interno del servidor${detalle}` });
    }
  };
}
