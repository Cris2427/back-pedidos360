// backend/pedidos360-api/store.mjs
//
// Capa de acceso a datos (el "repositorio" del encargo). Dos implementaciones
// con la misma interfaz:
//
//   crearStoreDynamo()   -> DynamoDB. Es la que usa la Lambda desplegada.
//   crearStoreMemoria()  -> en memoria. SOLO para las pruebas locales, que así
//                           corren sin credenciales ni red.
//
// Se elige con la variable de entorno STORE ('memory' para las pruebas).
//
// Por qué existe esta capa: guardar el estado en memoria del contenedor no
// funciona en Lambda. Cada contenedor tiene su propia copia, así que un pedido
// creado en uno responde 404 en otro, y todo se borra al enfriarse la función.
//
// El SDK de AWS se importa de forma PEREZOSA: viene incluido en el runtime de
// Lambda, pero no está instalado en este repo, así que un import estático
// rompería las pruebas locales.

export const CATALOG_TABLE = process.env.CATALOG_TABLE ?? 'Pedidos360-Catalog';
export const ORDERS_TABLE = process.env.ORDERS_TABLE ?? 'Pedidos360-Orders';

/** Productos con los que se siembra el catálogo si la tabla está vacía. */
export const CATALOGO_INICIAL = [
  { id: 'p-001', nombre: 'Notebook 14"', precio: 499990, stock: 8 },
  { id: 'p-002', nombre: 'Mouse inalámbrico', precio: 14990, stock: 40 },
  { id: 'p-003', nombre: 'Teclado mecánico', precio: 59990, stock: 12 },
];

/**
 * Id del documento que lleva el correlativo dentro de cada tabla. Empieza con
 * "_" para distinguirlo a simple vista de un producto o un pedido, y se filtra
 * de los listados: es metadata, no un dato del dominio.
 */
export const CONTADOR = '_seq';

/**
 * Extrae el número de un id con formato prefijo-NNN; 0 si no lo tiene.
 *
 * Sin expresión regular construida con template literal: ahí `\\d` se colapsa a
 * `d` (JavaScript trata los escapes desconocidos como el carácter pelado) y el
 * patrón deja de coincidir en silencio.
 */
const numeroDeId = (id, prefijo) => {
  const texto = String(id ?? '');
  const inicio = prefijo + '-';
  if (!texto.startsWith(inicio)) return 0;
  const resto = texto.slice(inicio.length);
  return /^[0-9]+$/.test(resto) ? Number(resto) : 0;
};

const formatearId = (prefijo, numero) => `${prefijo}-${String(numero).padStart(3, '0')}`;

const esCondicionFallida = (error) =>
  error?.name === 'ConditionalCheckFailedException' ||
  String(error?.__type ?? '').includes('ConditionalCheckFailedException');

// --------------------------------------------------------------------------
// DynamoDB
// --------------------------------------------------------------------------
export function crearStoreDynamo() {
  // Se carga una sola vez por contenedor; el cliente reaprovecha la conexión.
  let sdk = null;
  const cargar = () => {
    sdk ??= (async () => {
      const [{ DynamoDBClient }, lib] = await Promise.all([
        import('@aws-sdk/client-dynamodb'),
        import('@aws-sdk/lib-dynamodb'),
      ]);
      const doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
      return { doc, lib };
    })();
    return sdk;
  };

  // Todos los nombres de atributo van por #alias: varios ("total", "items")
  // son palabras reservadas de DynamoDB y romperían la expresión.
  return {
    tipo: 'dynamodb',

    /**
     * Correlativo por tabla: p-004, o-007...
     *
     * `ADD` es ATÓMICO: incrementa y devuelve el nuevo valor en una sola
     * operación, así que dos Lambdas simultáneas nunca obtienen el mismo
     * número. Un leer-modificar-escribir sí las dejaría empatadas.
     */
    async siguienteId(prefijo) {
      const { doc, lib } = await cargar();
      const tabla = prefijo === 'p' ? CATALOG_TABLE : ORDERS_TABLE;

      const { Attributes } = await doc.send(
        new lib.UpdateCommand({
          TableName: tabla,
          Key: { id: CONTADOR },
          UpdateExpression: 'ADD #n :uno',
          ExpressionAttributeNames: { '#n': 'numero' },
          ExpressionAttributeValues: { ':uno': 1 },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      let numero = Number(Attributes?.numero ?? 1);

      // Si es la primera vez que se usa el contador en una tabla que YA tenía
      // datos (los productos sembrados p-001..p-003), devolvería p-001 y
      // chocaría. Lo alineamos con el mayor id existente. Pasa una sola vez
      // en la vida de la tabla.
      if (numero === 1) {
        const { Items = [] } = await doc.send(
          new lib.ScanCommand({
            TableName: tabla,
            ProjectionExpression: '#id',
            ExpressionAttributeNames: { '#id': 'id' },
          }),
        );
        const mayor = Items.reduce((max, it) => Math.max(max, numeroDeId(it.id, prefijo)), 0);
        if (mayor >= numero) {
          numero = mayor + 1;
          await doc.send(
            new lib.UpdateCommand({
              TableName: tabla,
              Key: { id: CONTADOR },
              UpdateExpression: 'SET #n = :v',
              ExpressionAttributeNames: { '#n': 'numero' },
              ExpressionAttributeValues: { ':v': numero },
            }),
          );
        }
      }

      return formatearId(prefijo, numero);
    },

    async listarProductos() {
      const { doc, lib } = await cargar();
      const { Items = [] } = await doc.send(new lib.ScanCommand({ TableName: CATALOG_TABLE }));
      return Items.filter((p) => p.id !== CONTADOR).sort((a, b) =>
        String(a.id).localeCompare(String(b.id)),
      );
    },

    async obtenerProducto(id) {
      const { doc, lib } = await cargar();
      const { Item } = await doc.send(
        new lib.GetCommand({ TableName: CATALOG_TABLE, Key: { id } }),
      );
      return Item ?? null;
    },

    async guardarProducto(producto) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.PutCommand({ TableName: CATALOG_TABLE, Item: producto }));
      return producto;
    },

    /** Fija el stock a un valor absoluto (ajuste manual del Admin). */
    async fijarStock(id, stock) {
      const { doc, lib } = await cargar();
      const { Attributes } = await doc.send(
        new lib.UpdateCommand({
          TableName: CATALOG_TABLE,
          Key: { id },
          UpdateExpression: 'SET #stock = :stock',
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: { '#stock': 'stock', '#id': 'id' },
          ExpressionAttributeValues: { ':stock': stock },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes;
    },

    /**
     * Descuenta stock SOLO si alcanza, en la misma operación atómica.
     * Devuelve false si no alcanzaba: así dos pedidos simultáneos no pueden
     * dejar el stock negativo (con un leer-modificar-escribir sí podrían).
     */
    async descontarStock(id, cantidad) {
      const { doc, lib } = await cargar();
      try {
        await doc.send(
          new lib.UpdateCommand({
            TableName: CATALOG_TABLE,
            Key: { id },
            UpdateExpression: 'SET #stock = #stock - :q',
            ConditionExpression: 'attribute_exists(#id) AND #stock >= :q',
            ExpressionAttributeNames: { '#stock': 'stock', '#id': 'id' },
            ExpressionAttributeValues: { ':q': cantidad },
          }),
        );
        return true;
      } catch (error) {
        if (esCondicionFallida(error)) return false;
        throw error;
      }
    },

    /** Devuelve stock al catálogo (cancelación de un pedido ya aceptado). */
    async devolverStock(id, cantidad) {
      const { doc, lib } = await cargar();
      try {
        await doc.send(
          new lib.UpdateCommand({
            TableName: CATALOG_TABLE,
            Key: { id },
            UpdateExpression: 'SET #stock = #stock + :q',
            ConditionExpression: 'attribute_exists(#id)',
            ExpressionAttributeNames: { '#stock': 'stock', '#id': 'id' },
            ExpressionAttributeValues: { ':q': cantidad },
          }),
        );
        return true;
      } catch (error) {
        if (esCondicionFallida(error)) return false;
        throw error;
      }
    },

    async borrarProducto(id) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.DeleteCommand({ TableName: CATALOG_TABLE, Key: { id } }));
      return true;
    },

    async listarPedidos() {
      const { doc, lib } = await cargar();
      const { Items = [] } = await doc.send(new lib.ScanCommand({ TableName: ORDERS_TABLE }));
      return Items.filter((o) => o.id !== CONTADOR).sort((a, b) =>
        String(b.creadoEn ?? '').localeCompare(String(a.creadoEn ?? '')),
      );
    },

    async obtenerPedido(id) {
      const { doc, lib } = await cargar();
      const { Item } = await doc.send(new lib.GetCommand({ TableName: ORDERS_TABLE, Key: { id } }));
      return Item ?? null;
    },

    async guardarPedido(pedido) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.PutCommand({ TableName: ORDERS_TABLE, Item: pedido }));
      return pedido;
    },

    /**
     * Cambia el estado solo si el pedido sigue en `estadoEsperado`. Es un
     * bloqueo optimista: si dos operadores aprietan "Aceptar" a la vez, el
     * segundo falla en vez de descontar el stock dos veces.
     */
    async cambiarEstado(id, estadoEsperado, nuevoEstado, extra = {}) {
      const { doc, lib } = await cargar();
      try {
        const { Attributes } = await doc.send(
          new lib.UpdateCommand({
            TableName: ORDERS_TABLE,
            Key: { id },
            UpdateExpression:
              'SET #estado = :nuevo, #actualizadoEn = :ts, #actualizadoPor = :por, #descontado = :descontado',
            ConditionExpression: '#estado = :esperado',
            ExpressionAttributeNames: {
              '#estado': 'estado',
              '#actualizadoEn': 'actualizadoEn',
              '#actualizadoPor': 'actualizadoPor',
              '#descontado': 'stockDescontado',
            },
            ExpressionAttributeValues: {
              ':nuevo': nuevoEstado,
              ':esperado': estadoEsperado,
              ':ts': new Date().toISOString(),
              ':por': extra.actualizadoPor ?? 'desconocido',
              ':descontado': extra.stockDescontado === true,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes;
      } catch (error) {
        if (esCondicionFallida(error)) return null;
        throw error;
      }
    },

    async borrarPedido(id) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.DeleteCommand({ TableName: ORDERS_TABLE, Key: { id } }));
      return true;
    },

    /** Siembra el catálogo inicial si la tabla está vacía. Idempotente. */
    async sembrarSiEstaVacio() {
      const { doc, lib } = await cargar();
      const { Count } = await doc.send(
        new lib.ScanCommand({ TableName: CATALOG_TABLE, Select: 'COUNT', Limit: 1 }),
      );
      if (Count > 0) return 0;
      for (const producto of CATALOGO_INICIAL) {
        await doc.send(new lib.PutCommand({ TableName: CATALOG_TABLE, Item: producto }));
      }
      return CATALOGO_INICIAL.length;
    },
  };
}

// --------------------------------------------------------------------------
// En memoria (solo pruebas)
// --------------------------------------------------------------------------
export function crearStoreMemoria() {
  const productos = CATALOGO_INICIAL.map((p) => ({ ...p }));
  const pedidos = [];
  const copia = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);

  // Arranca en el mayor id sembrado, igual que hace el contador de DynamoDB.
  const contadores = {
    p: productos.reduce((max, p) => Math.max(max, numeroDeId(p.id, 'p')), 0),
    o: 0,
  };

  return {
    tipo: 'memoria',

    async siguienteId(prefijo) {
      contadores[prefijo] = (contadores[prefijo] ?? 0) + 1;
      return formatearId(prefijo, contadores[prefijo]);
    },

    async listarProductos() {
      return copia(productos);
    },
    async obtenerProducto(id) {
      return copia(productos.find((p) => p.id === id) ?? null);
    },
    async guardarProducto(producto) {
      const i = productos.findIndex((p) => p.id === producto.id);
      if (i >= 0) productos[i] = { ...producto };
      else productos.push({ ...producto });
      return copia(producto);
    },
    async fijarStock(id, stock) {
      const p = productos.find((x) => x.id === id);
      if (!p) return null;
      p.stock = stock;
      return copia(p);
    },
    async descontarStock(id, cantidad) {
      const p = productos.find((x) => x.id === id);
      if (!p || p.stock < cantidad) return false;
      p.stock -= cantidad;
      return true;
    },
    async devolverStock(id, cantidad) {
      const p = productos.find((x) => x.id === id);
      if (!p) return false;
      p.stock += cantidad;
      return true;
    },

    async borrarProducto(id) {
      const i = productos.findIndex((p) => p.id === id);
      if (i >= 0) productos.splice(i, 1);
      return i >= 0;
    },

    async listarPedidos() {
      return copia(pedidos);
    },
    async obtenerPedido(id) {
      return copia(pedidos.find((o) => o.id === id) ?? null);
    },
    async guardarPedido(pedido) {
      pedidos.push({ ...pedido });
      return copia(pedido);
    },
    async cambiarEstado(id, estadoEsperado, nuevoEstado, extra = {}) {
      const pedido = pedidos.find((o) => o.id === id);
      if (!pedido || pedido.estado !== estadoEsperado) return null;
      pedido.estado = nuevoEstado;
      pedido.actualizadoEn = new Date().toISOString();
      pedido.actualizadoPor = extra.actualizadoPor ?? 'desconocido';
      pedido.stockDescontado = extra.stockDescontado === true;
      return copia(pedido);
    },
    async borrarPedido(id) {
      const i = pedidos.findIndex((o) => o.id === id);
      if (i >= 0) pedidos.splice(i, 1);
      return i >= 0;
    },
    async sembrarSiEstaVacio() {
      return 0;
    },
  };
}

// Una sola instancia por proceso. En AWS cada Lambda es su propio proceso, así
// que no comparten nada (lo compartido es DynamoDB); en las pruebas locales
// esto hace que los 10 handlers vean el mismo store en memoria.
let instancia = null;

export function crearStore() {
  instancia ??= process.env.STORE === 'memory' ? crearStoreMemoria() : crearStoreDynamo();
  return instancia;
}
