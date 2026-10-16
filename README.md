# back-pedidos360

Backend de los dominios **Pedidos** y **Catálogo** del sistema Pedidos360,
detrás de un AWS API Gateway (HTTP API) protegido con un **JWT Authorizer de
Microsoft Entra ID**.

**Una Lambda por método y ruta**: 10 funciones independientes, cada una con su
propio handler, sus propios logs y su propia configuración.

Las **notificaciones** son asíncronas: los eventos de un pedido se publican en
un topic de SNS que los reparte a tres colas SQS, cada una con su DLQ y su
Lambda consumidora (correo, bodega y boleta).

Frontend: [Cris2427/front-pedidos360](https://github.com/Cris2427/front-pedidos360)

> **DSY1107 · Desarrollo Cloud Native I** — Evaluaciones Parciales N°1 y N°3.
> Cristian Tapia · Camila Malhue

## Estructura

```
handlers/            una función Lambda por archivo
  catalog-get.mjs          GET    /api/catalog
  catalog-post.mjs         POST   /api/catalog
  catalog-put.mjs          PUT    /api/catalog/{id}
  catalog-stock-put.mjs    PUT    /api/catalog/{id}/stock
  catalog-delete.mjs       DELETE /api/catalog/{id}
  orders-get.mjs           GET    /api/orders
  orders-post.mjs          POST   /api/orders
  orders-put.mjs           PUT    /api/orders/{id}
  orders-status-patch.mjs  PATCH  /api/orders/{id}/status
  orders-delete.mjs        DELETE /api/orders/{id}
consumers/           una Lambda por cola, agrupadas por dominio
  notificar-email.mjs      q-email      notificaciones al cliente
  preparar-pedido.mjs      q-warehouse  orden de preparación para bodega
  generar-boleta.mjs       q-invoice    boleta con el IVA desglosado
lib/                 código compartido, sin duplicar
  config.mjs           lo único que lee variables de entorno
  auth.mjs             claims, scopes y App Roles del token
  http.mjs             respuestas, CORS y manejo de errores
  mensajeria.mjs       ACK, reintento o DLQ de cada mensaje
  reglas.mjs           máquina de estados, validaciones e IVA
  store.mjs            acceso a DynamoDB (y doble en memoria para pruebas)
infra/
  mensajeria.json             nombres de topic, colas, DLQ y filtros
  deploy-aws.ps1              despliega todo en AWS
  openapi-pedidos360.yaml     especificación de la API
test-local.mjs       99 pruebas de la API, el productor y los consumidores, sin AWS
```

Las 10 funciones comparten un mismo zip y se diferencian por su `handler`
(`handlers/catalog-get.handler`, etc.). Así cada ruta es una Lambda distinta en
AWS, pero el código común vive en un solo lugar.

## Doble control de acceso

| Capa | Qué valida | Dónde |
|---|---|---|
| JWT Authorizer del API Gateway | firma, `iss`, `aud`, `exp` y el **scope de la ruta** (ámbitos de autorización) | configuración del HTTP API |
| Cada Lambda | claims `scp` (scopes) y `roles` (App Roles) | [`lib/auth.mjs`](lib/auth.mjs) |

Si el token no sirve, el authorizer responde **401** y la Lambda ni se ejecuta.
Si el token es válido pero no trae el scope de esa ruta, el authorizer responde
**403** y la Lambda tampoco se ejecuta. Si trae el scope pero no el App Role,
la Lambda responde **403** diciendo exactamente qué rol falta.

La Lambda vuelve a revisar el scope aunque el gateway ya lo hizo: si alguien
borra un ámbito desde la consola, el endpoint sigue protegido.

> **Ojo con el claim `roles`**: el API Gateway entrega todos los claims como
> string, así que un claim de tipo array llega envuelto en corchetes
> (`"[Cliente]"`). Sin quitarlos, ninguna comprobación de rol coincide y todo
> responde 403 aunque el token sea correcto.

## Permisos por endpoint

| Método y ruta | Scope | App Role |
|---|---|---|
| `GET /api/catalog` | `catalog.read` | cualquiera |
| `POST /api/catalog` | `catalog.write` | `Admin` |
| `PUT /api/catalog/{id}` | `catalog.write` | `Admin` |
| `PUT /api/catalog/{id}/stock` | `catalog.write` | `Admin` |
| `DELETE /api/catalog/{id}` | `catalog.write` | `Admin` |
| `GET /api/orders` | `orders.read` | `Cliente` (los suyos) · `Operador` (todos) |
| `POST /api/orders` | `orders.write` | `Cliente` · `Operador` |
| `PUT /api/orders/{id}` | `orders.write` | `Cliente` (los suyos) · `Operador` |
| `DELETE /api/orders/{id}` | `orders.write` | `Cliente` (los suyos) · `Operador` |
| `PATCH /api/orders/{id}/status` | `orders.write` | `Operador` |

**El Admin no participa del CRUD de pedidos**: administra el catálogo y el
stock. El Cliente y el Operador tienen el CRUD; solo el Operador avanza los
estados.

## Reglas de negocio que aplica el servidor

- **No se puede despachar sin aceptar**: `CREADO → ACEPTADO → EN_PREPARACION →
  DESPACHADO → ENTREGADO`, con `CANCELADO` disponible solo desde `CREADO` y
  `ACEPTADO`. Cualquier otro salto responde **409**.
- **El stock decrece al ACEPTAR el pedido**, no al crearlo. Cancelar devuelve
  el stock solo si alcanzó a descontarse.
- Un pedido solo se **edita** en `CREADO` y solo se **elimina** en `CREADO` o
  `CANCELADO`: con stock comprometido hay que cancelarlo primero.
- El **total se recalcula** en el servidor: se ignora el que mande el cliente.
- A un `Cliente` se le fuerza el `clienteId` con la identidad de su token, y un
  pedido ajeno le responde **404** en vez de 403: así no se le revela que existe.

## Mensajería asíncrona

```
                                   ┌─ q-email      → notificar-email   (+ q-email-dlq)
evento ─→ SNS pedidos360-eventos ──┼─ q-warehouse  → preparar-pedido   (+ q-warehouse-dlq)
                                   └─ q-invoice    → generar-boleta    (+ q-invoice-dlq)
```

Los eventos los publica la API de pedidos, **después de guardar** en DynamoDB:
`orders-post` publica `PedidoCreado` y `orders-status-patch` publica el evento
de cada cambio de estado. Un cambio rechazado (403, 409) no publica nada.

Si SNS falla, el pedido **se guarda igual** y el error queda en el log: el
núcleo del negocio no puede depender de las notificaciones, que es justamente
lo que se busca al desacoplar.

Cada evento se publica **una vez** en el topic, con el atributo `tipo_evento`.
El topic entrega una copia a cada cola cuyo filtro calce (*fan-out*):

| Cola | Filtro | Equivale en RabbitMQ a |
|---|---|---|
| `q-email` | `{"tipo_evento": [{"prefix": "Pedido"}]}` | exchange **topic** (patrón) |
| `q-warehouse` | `{"tipo_evento": ["PedidoAceptado"]}` | exchange **direct** (exacto) |
| `q-invoice` | `{"tipo_evento": ["PedidoDespachado"]}` | exchange **direct** (exacto) |

`q-warehouse` es el `q.cmd.kitchen` del Caso 0 adaptado a nuestro rubro: en una
tienda de tecnología, lo que se prepara al aceptar un pedido es la orden de
bodega.

Topic y colas son **estándar**: entregan *al menos una vez*, así que todos los
consumidores son idempotentes.

### Una configuración, en un solo lugar

Los nombres del topic, las colas, las DLQ, los filtros, los reintentos y qué
Lambda consume cada cola están en [`infra/mensajeria.json`](infra/mensajeria.json).
El script de despliegue lo lee para crear la infraestructura y para pasarle a
cada Lambda sus variables de entorno, que solo se leen en
[`lib/config.mjs`](lib/config.mjs). Ningún consumidor escribe un nombre de cola.

### ACK, reintento o DLQ

Los consumidores solo contienen lógica de negocio. Todo lo de SQS está una sola
vez en [`lib/mensajeria.mjs`](lib/mensajeria.mjs), y cada mensaje termina en
una de tres decisiones que queda escrita en el log:

| Decisión | Cuándo | Qué pasa |
|---|---|---|
| **ACK** | se procesó bien | no se devuelve y SQS lo borra |
| **REINTENTO** | error recuperable (un servicio caído) | se devuelve en `batchItemFailures` y reaparece al vencer la visibilidad (30 s); al tercer intento SQS lo mueve a la DLQ |
| **DLQ** | error no recuperable (dato inválido) | se envía a la DLQ de inmediato, con el motivo como atributo, y se confirma: reintentar no lo arreglaría |

Si la propia DLQ no responde, el mensaje se reintenta en vez de perderse.
Los triggers tienen activado *Report batch item failures*: sin eso, Lambda
ignora `batchItemFailures` y borra el lote completo.

El tiempo de visibilidad de las colas (30 s) es mayor que el timeout de los
consumidores (5 s), para que un mensaje no reaparezca mientras se procesa. Las
DLQ guardan los mensajes 14 días, más que las colas principales, para alcanzar
a revisarlos y devolverlos con *redrive*.

### Idempotencia

Cada consumidor registra lo que hizo en `Pedidos360-Notificaciones` con una
escritura condicional (`attribute_not_exists`). Si el mismo mensaje llega dos
veces, la segunda no se registra. La clave depende de qué no debe repetirse:

| Consumidor | Clave | Garantiza |
|---|---|---|
| `notificar-email` | `email#<eventId>` | un correo por cada cambio de estado |
| `preparar-pedido` | `bodega#<pedidoId>` | una orden de preparación por pedido |
| `generar-boleta` | `boleta#<pedidoId>` | una boleta por pedido |

### Contrato del evento

```json
{
  "type": "PedidoAceptado",
  "eventId": "uuid, único por evento",
  "pedidoId": "o-005",
  "clienteId": "cliente@correo.cl",
  "items": [{ "productoId": "p-001", "nombre": "Notebook 14\"", "cantidad": 1 }],
  "total": 499990
}
```

Tipos: `PedidoCreado`, `PedidoAceptado`, `PedidoEnPreparacion`,
`PedidoDespachado`, `PedidoEntregado` y `PedidoCancelado`.

## Probar sin desplegar nada

```bash
node test-local.mjs
```

99 comprobaciones. Sobre las 10 funciones de la API: permisos por scope y por
rol, validaciones, ciclo de estados, reglas de stock, aislamiento entre
clientes, numeración correlativa de ids y las formas en que puede llegar el
claim `roles`. Sobre el productor: que cada cambio de estado publique su
evento, que un cambio rechazado no publique nada y que el pedido se guarde
aunque SNS no responda. Sobre los consumidores: las tres decisiones (ACK,
reintento, DLQ) y que cada una quede en el log, mensajes duplicados, lotes
donde falla solo un mensaje y la DLQ caída.

Usa el store, el topic y la DLQ en memoria, así que **no necesita credenciales de AWS ni
red**.

## Desplegar

```bash
powershell -File infra\deploy-aws.ps1 -WhatIf   # muestra qué haría, sin tocar nada
powershell -File infra\deploy-aws.ps1
```

Crea o actualiza en un solo paso: las tres tablas de DynamoDB, las 10
funciones de la API, el JWT authorizer, las integraciones, las 10 rutas con sus
ámbitos, el CORS y los permisos de invocación; y la mensajería: el topic, las
colas con sus DLQ, las suscripciones con filtro, las 3 Lambdas consumidoras y
sus triggers.

Es idempotente: crea lo que falta, corrige lo que no calza y deja igual lo que
ya está bien, aunque se haya hecho a mano desde la consola.

Revisa antes los parámetros del `param(...)`: región, id del API, tenant,
audiencia, rol de ejecución (`LabRole` en AWS Academy) y runtime
(`nodejs24.x`).

> En AWS Academy las credenciales caducan cada pocas horas. Si ves
> `ExpiredToken`, recárgalas desde **AWS Details → AWS CLI** del Learner Lab.

> **Corre el script al empezar cada sesión del Learner Lab.** Cuando termina
> una sesión, el `LabRole` pierde los permisos de SQS y Lambda apaga los
> triggers de los consumidores (en CloudTrail aparece como
> `LambdaESMDisabled`). Al volver no se encienden solos. Los mensajes no se
> pierden, esperan en la cola, pero nadie los procesa hasta que el script
> vuelve a encender los triggers.

## Variables de entorno de las Lambdas

Las pone el script de despliegue y solo se leen en [`lib/config.mjs`](lib/config.mjs).

| Variable | Default | Para qué |
|---|---|---|
| `ALLOWED_ORIGIN` | `http://localhost:5173` | origen que se devuelve en los headers CORS |
| `CATALOG_TABLE` | `Pedidos360-Catalog` | tabla de productos |
| `ORDERS_TABLE` | `Pedidos360-Orders` | tabla de pedidos |
| `NOTIFICACIONES_TABLE` | `Pedidos360-Notificaciones` | lo que registró cada consumidor |
| `DLQ_URL` | *(vacío)* | la DLQ de la cola que consume esa Lambda |
| `MAX_RECEIVE_COUNT` | `3` | intentos antes de que SQS mueva un mensaje a la DLQ |
| `SIMULAR_CAIDA` | `false` | `true` hace fallar al consumidor como si el servicio externo estuviera caído (demo de reintentos y *redrive*) |
| `STORE` | *(vacío)* | `memory` fuerza el store y la DLQ en memoria (solo pruebas) |

## Persistencia

Tres tablas de DynamoDB con clave de partición `id` (string) y facturación por
uso:

| Tabla | Contenido |
|---|---|
| `Pedidos360-Catalog` | `id`, `nombre`, `precio`, `stock` |
| `Pedidos360-Orders` | `id`, `clienteId`, `items`, `total`, `estado`, `creadoEn`, `stockDescontado` |
| `Pedidos360-Notificaciones` | `id`, `canal`, `tipo`, `pedidoId`, `clienteId`, `titulo`, `creadoEn` y el detalle de cada canal |

El acceso está aislado en [`lib/store.mjs`](lib/store.mjs), con dos
implementaciones de la misma interfaz: DynamoDB para las Lambdas desplegadas y
en memoria para las pruebas.

**Por qué no basta con guardar en memoria:** cada contenedor de Lambda tiene su
propia copia. Un pedido creado en uno responde `404` en otro, y todo se borra
cuando la función se enfría. Con varias Lambdas y varios navegadores, el error
aparece de inmediato.

Tres garantías que aporta la base de datos:

- El descuento de stock es **condicional** (`stock >= cantidad`) dentro de la
  misma operación atómica, así que dos pedidos simultáneos no pueden dejarlo
  negativo.
- El cambio de estado usa **bloqueo optimista**: solo se aplica si el pedido
  sigue en el estado que se leyó, así que dos operadores apretando "Aceptar" a
  la vez no descuentan el stock dos veces.
- Los **ids son correlativos** (`p-005`, `o-001`). DynamoDB no tiene
  auto-incremento, así que un documento `_seq` por tabla lleva la cuenta y se
  incrementa con `ADD`, que es atómico. Ese documento se filtra de los listados.
