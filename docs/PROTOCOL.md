# CAPSULE Protocol v1, v2 y v3

**Estado:** especificación estable para CAPSULE 1.0; §16 añadida en 1.1  
**Identificador de versión escrito por esta implementación:** `3`  
**Versiones legibles:** `1`, `2`, `3`  
**Fecha:** 2026-08-29

Las secciones 1 a 11 describen la versión 1, que sigue siendo legible sin
cambios. La sección 12 especifica la versión 2 (relleno por clases de tamaño,
cápsulas sin vencimiento, relays espejo y los endpoints de red del relay) y la
sección 13 la versión 3, que agrega erasure coding y fija las reglas de
direcciones. La sección 14 describe las capabilities protegidas y divididas,
que no son parte del formato de cápsula pero sí de la interoperabilidad.

**Vectores de prueba oficiales:**
[`packages/protocol/vectors/capsule-test-vectors.json`](../packages/protocol/vectors/capsule-test-vectors.json).
Una implementación que reproduzca esos bytes es compatible con ésta. Se
regeneran con `npm run vectors`; si un cambio los mueve, el protocolo cambió.

## 1. Objetivo y modelo

CAPSULE v1 transporta un archivo cifrado por chunks a través de un relay no
confiable. El relay administra disponibilidad temporal y capacidades de acceso,
pero no recibe la clave de contenido. El enlace compartido contiene todo lo
necesario para localizar, autorizar y descifrar la cápsula.

El protocolo separa tres capacidades:

- **write:** cargar chunks y finalizar una reserva;
- **read:** consultar y descargar una cápsula finalizada;
- **delete:** eliminar anticipadamente una cápsula.

Las capacidades son bearer tokens: poseer una equivale a tener su permiso. No
representan identidad y no deben confundirse con autenticación de una persona.

CAPSULE v1 proporciona confidencialidad y autenticidad del contenido si los
endpoints son seguros. No oculta IP, relay, tamaño, cantidad de chunks, TTL ni
patrones temporales. Véase [THREAT_MODEL.md](./THREAT_MODEL.md).

## 2. Convenciones

- Los enteros se expresan en decimal en JSON.
- Los timestamps usan RFC 3339/ISO 8601 en UTC, por ejemplo
  `2026-08-29T03:15:00.000Z`.
- `base64url(x)` es RFC 4648 URL-safe, sin caracteres `=` de padding.
- Los strings se codifican como UTF-8.
- `uint32be(i)` son cuatro bytes unsigned, big-endian.
- `CSPRNG(n)` devuelve `n` bytes de un generador criptográficamente seguro.
- Los campos desconocidos en JSON PUEDEN ignorarse. Los campos requeridos con
  tipo, rango o formato inválido DEBEN provocar rechazo.

## 3. Identificadores y secretos

Para una nueva cápsula se generan valores independientes:

| Valor         | Genera  |     Longitud mínima | Uso                                           |
| ------------- | ------- | ------------------: | --------------------------------------------- |
| `capsuleId`   | Relay   | 128 bits aleatorios | Identificador no secreto y no enumerable      |
| `writeToken`  | Relay   | 256 bits aleatorios | Carga y finalización                          |
| `readToken`   | Relay   | 256 bits aleatorios | Lectura                                       |
| `deleteToken` | Relay   | 256 bits aleatorios | Eliminación anticipada                        |
| `key`         | Cliente |            32 bytes | Clave AES-256-GCM                             |
| `noncePrefix` | Cliente |             8 bytes | Prefijo aleatorio de los nonces de la cápsula |

Todos se representan externamente con base64url sin padding. El relay DEBE
guardar un hash resistente a preimagen de cada token y NO el token en claro. El
`capsuleId` puede almacenarse en claro.

El cliente DEBE generar una nueva pareja `(key, noncePrefix)` para cada cápsula.
No debe reutilizarla, ni siquiera para subir otra versión del mismo archivo.

## 4. Formato criptográfico

### 4.1 Primitiva

- Algoritmo: AES-GCM.
- Clave: 256 bits.
- Nonce/IV: 96 bits.
- Tag de autenticación: 128 bits.
- Salida binaria: `ciphertext || tag`, como la devuelve Web Crypto.

No se aplica compresión dentro del protocolo v1. Una aplicación puede comprimir
el archivo antes de crear la cápsula, en cuyo caso el resultado comprimido es el
archivo transportado.

### 4.2 Espacio de índices

| Índice criptográfico | Contenido                     |
| -------------------: | ----------------------------- |
|                  `0` | Manifiesto/metadatos cifrados |
|    `1 .. chunkCount` | Chunks del archivo, en orden  |
|         `0xffffffff` | Reservado; no se usa en v1    |

`chunkCount` puede ser cero para un archivo vacío y no puede superar
`0xfffffffe`. La API HTTP usa índices de chunk **desde cero** en la ruta:
`/chunks/0` corresponde al índice criptográfico `1`.

### 4.3 Derivación del nonce

Para un índice criptográfico `i`:

```text
nonce(i) = noncePrefix[0..7] || uint32be(i)
```

Ejemplo, para el prefijo hexadecimal `0102030405060708` y el índice `2`:

```text
01 02 03 04 05 06 07 08 00 00 00 02
```

La unicidad del nonce es crítica para AES-GCM. Un cliente PUEDE reintentar el
mismo ciphertext ya calculado, pero NO DEBE cifrar bytes diferentes con la misma
tripla `(key, noncePrefix, index)`. Si cambian archivo, metadatos o TTL, debe
crear una cápsula con secretos nuevos.

### 4.4 Additional Authenticated Data

Para cada índice `i`, el AAD es exactamente:

```text
UTF8("CAPSULE/v1/chunk/" || decimal(i))
```

No contiene NUL, salto de línea ni espacios. Ejemplos:

```text
CAPSULE/v1/chunk/0
CAPSULE/v1/chunk/1
CAPSULE/v1/chunk/27
```

El AAD autentica versión, función e índice. Por lo tanto, mover un chunk a otra
posición o descifrarlo como manifiesto hace fallar el tag.

### 4.5 Operaciones

```text
encrypt(i, plaintext):
  return AES-256-GCM-ENC(
    key,
    nonce(i),
    plaintext,
    aad = UTF8("CAPSULE/v1/chunk/" || decimal(i)),
    tagLength = 128
  )

decrypt(i, ciphertextAndTag):
  return AES-256-GCM-DEC(... mismos parámetros ...)
  // Cualquier fallo de tag aborta la cápsula completa.
```

Cada bloque cifrado mide `plaintextLength + 16` bytes.

## 5. Manifiesto cifrado

El manifiesto es un objeto JSON UTF-8 cifrado con el índice criptográfico `0`.
No se exige un orden canónico de claves.

```json
{
  "version": 1,
  "filename": "foto.jpg",
  "mimeType": "image/jpeg",
  "byteLength": 2539041,
  "chunkSize": 1048576,
  "chunkCount": 3,
  "createdAt": "2026-08-29T03:00:00.000Z",
  "expiresAt": "2026-08-30T03:00:00.000Z",
  "note": "opcional"
}
```

| Campo        | Tipo   | Regla                                                      |
| ------------ | ------ | ---------------------------------------------------------- |
| `version`    | entero | Debe ser `1`                                               |
| `filename`   | string | No vacío; dato no confiable que el receptor debe sanitizar |
| `mimeType`   | string | No vacío; informativo y no confiable                       |
| `byteLength` | entero | `>= 0`; bytes del archivo original                         |
| `chunkSize`  | entero | `> 0`; tamaño objetivo del texto plano por chunk           |
| `chunkCount` | entero | `ceil(byteLength / chunkSize)`, con `0` para archivo vacío |
| `createdAt`  | string | Timestamp informativo del cliente                          |
| `expiresAt`  | string | Vencimiento solicitado/informativo                         |
| `note`       | string | Opcional                                                   |

El cliente receptor DEBE comprobar que:

1. `version` es compatible;
2. `chunkCount` concuerda con `byteLength` y `chunkSize`;
3. la suma de plaintext descifrado es exactamente `byteLength`;
4. todos los chunks `0 .. chunkCount - 1` de la API están presentes y
   autentican con los índices criptográficos `1 .. chunkCount`.

El `expiresAt` autoritativo es el fijado por el relay y devuelto por la API. El
valor cifrado puede diferir algunos segundos por latencia y no amplía el TTL.

## 6. Capability URL

### 6.1 Forma

```text
https://app.example/#capsule=<base64url(UTF8(JSON capability))>
```

El objeto decodificado es:

```json
{
  "version": 1,
  "relayUrl": "https://relay.example",
  "capsuleId": "base64url-id",
  "readToken": "base64url-read-token",
  "key": "base64url-32-byte-aes-key",
  "noncePrefix": "base64url-8-byte-prefix"
}
```

El orden de campos no es significativo. `relayUrl` debe ser un origen HTTP(S)
absoluto; en producción DEBE usar HTTPS. El cliente debe rechazar esquemas
distintos y DEBERÍA pedir confirmación antes de contactar un origen inesperado.

### 6.2 Propiedades y tratamiento

- El fragmento (`#...`) no forma parte de una solicitud HTTP estándar. La
  aplicación cliente sí puede leerlo mediante JavaScript.
- Toda la capability URL es secreta. Copiarla equivale a conceder lectura y
  descifrado.
- La aplicación NO DEBE mover el fragmento a query, path, analytics, crash
  reports ni almacenamiento sincronizado sin consentimiento explícito.
- Después de parsearlo, la UI DEBERÍA limpiar la barra de direcciones con
  `history.replaceState`, manteniendo la capacidad sólo durante el flujo.
- El navegador, historial, portapapeles, extensiones, capturas y canal de
  mensajería aún pueden filtrar el enlace.

La capacidad de propietario se conserva por separado:

```json
{
  "relayUrl": "https://relay.example",
  "capsuleId": "base64url-id",
  "deleteToken": "base64url-delete-token"
}
```

No se incluye `deleteToken` en el enlace de lectura.

## 7. Relay API v1

### 7.1 Reglas comunes

- Base: `{relayUrl}/v1`.
- Cuerpos JSON: `Content-Type: application/json; charset=utf-8`.
- Chunks: `application/octet-stream`.
- Capacidades: `Authorization: Bearer <token>`.
- Respuestas que dependan de una capacidad DEBEN incluir
  `Cache-Control: no-store`.
- El relay no debe redirigir endpoints autenticados. Los clientes DEBEN rechazar
  redirects para evitar entregar el bearer token a otro origen.
- En producción se requiere HTTPS. HTTP se admite sólo para loopback/desarrollo.
- Para no facilitar enumeración, ID inexistente, expirado o token inválido
  responden de manera pública equivalente, recomendada `404 not_found`.

Formato de error recomendado:

```json
{
  "code": "not_found",
  "message": "Capsule is unavailable"
}
```

`message` no debe contener rutas internas, tokens ni detalles criptográficos.

### 7.2 Crear una reserva

```http
POST /v1/capsules
Content-Type: application/json
```

```json
{
  "encryptedManifest": "base64url-ciphertext-and-tag",
  "chunkCount": 3,
  "totalCiphertextBytes": 2539089,
  "expiresInSeconds": 86400
}
```

`totalCiphertextBytes` es la suma de los chunks de archivo cifrados y excluye el
manifiesto. Para un archivo de `P` bytes dividido en `N` chunks:

```text
totalCiphertextBytes = P + 16 * N
```

El relay valida límites, reserva espacio, genera ID y tokens y responde `201`:

```json
{
  "capsuleId": "...",
  "readToken": "...",
  "writeToken": "...",
  "deleteToken": "...",
  "expiresAt": "2026-08-30T03:00:03.000Z"
}
```

Los cuatro valores sensibles de la respuesta se devuelven una única vez. La
reserva permanece en estado `uploading` y no puede leerse con `readToken`.

### 7.3 Subir un chunk

```http
PUT /v1/capsules/{capsuleId}/chunks/{apiIndex}
Authorization: Bearer {writeToken}
Content-Type: application/octet-stream

<ciphertext || 16-byte-tag>
```

- `apiIndex` va de `0` a `chunkCount - 1`.
- El índice criptográfico es `apiIndex + 1`.
- Un `PUT` idéntico es idempotente y devuelve `204`.
- Repetir el índice con bytes diferentes DEBE devolver `409 conflict`.
- Un chunk tiene al menos 16 bytes y no supera el máximo configurado.
- La suma almacenada no puede superar `totalCiphertextBytes`.

### 7.4 Consultar estado

```http
GET /v1/capsules/{capsuleId}/status
Authorization: Bearer {writeToken|readToken}
```

El `writeToken` puede consultar durante la carga; `readToken`, después de la
finalización.

```json
{
  "capsuleId": "...",
  "state": "uploading",
  "chunkCount": 3,
  "uploadedChunks": 2,
  "totalCiphertextBytes": 2539089,
  "uploadedCiphertextBytes": 2097184,
  "expiresAt": "2026-08-30T03:00:03.000Z"
}
```

`state` es `uploading` o `ready` en v1.

### 7.5 Finalizar

```http
POST /v1/capsules/{capsuleId}/finalize
Authorization: Bearer {writeToken}
```

El relay comprueba que existan exactamente los índices declarados y que la suma
coincida con `totalCiphertextBytes`. Si falta contenido, responde `409`. Si todo
coincide, cambia de forma atómica a `ready` y devuelve `200` con `RelayStatus`.
La finalización repetida por el mismo propietario DEBERÍA ser idempotente.

Después de finalizar no se permiten nuevos `PUT` ni cambios de manifiesto.

### 7.6 Descargar manifiesto

```http
GET /v1/capsules/{capsuleId}/manifest
Authorization: Bearer {readToken}
Accept: application/octet-stream
```

Devuelve `200`, `Content-Type: application/octet-stream` y el manifiesto cifrado
binario (`ciphertext || tag`). Sólo está disponible en estado `ready` y antes del
vencimiento.

### 7.7 Descargar un chunk

```http
GET /v1/capsules/{capsuleId}/chunks/{apiIndex}
Authorization: Bearer {readToken}
Accept: application/octet-stream
```

Devuelve los mismos bytes cargados. v1 no define rangos parciales dentro de un
chunk; el cliente reintenta el chunk completo.

### 7.8 Eliminar

```http
DELETE /v1/capsules/{capsuleId}
Authorization: Bearer {deleteToken}
```

Devuelve `204`. La operación es idempotente y no debe distinguir públicamente
entre ya eliminada, vencida o inexistente. El borrado se refiere al
almacenamiento primario bajo control del relay, no prueba eliminación de backups
o copias externas.

### 7.9 Endpoints operativos

Una implementación DEBERÍA ofrecer:

```http
GET /healthz
GET /v1/config
```

`/healthz` informa sólo liveness. `/v1/config` puede anunciar versión, tamaños y
TTL permitidos, pero nunca rutas internas, uso total, IDs ni capacidades.

### 7.10 Estados HTTP

| Estado | Uso                                                                    |
| -----: | ---------------------------------------------------------------------- |
|  `200` | Lectura o transición con cuerpo                                        |
|  `201` | Reserva creada                                                         |
|  `204` | Escritura/borrado exitoso sin cuerpo                                   |
|  `400` | JSON, base64url, índice o parámetros malformados                       |
|  `404` | No disponible, inexistente, vencida o capacidad inválida               |
|  `409` | Índice ya ocupado con otros bytes, faltan chunks o estado incompatible |
|  `413` | Manifiesto, chunk o cápsula excede límite                              |
|  `415` | Content-Type no admitido                                               |
|  `422` | Parámetros bien formados pero inconsistentes                           |
|  `429` | Límite de tasa o cuota                                                 |
|  `500` | Error interno sin detalles sensibles                                   |

## 8. Secuencia completa

```text
Remitente                    Relay                        Destinatario
    |                           |                              |
    | genera key + prefix       |                              |
    | cifra manifest (i=0)      |                              |
    | POST /capsules ---------->|                              |
    |<-- id + read/write/delete |                              |
    | PUT chunk/0 (crypto i=1)->|                              |
    | ...                       |                              |
    | POST /finalize ---------->|                              |
    |<-- ready                  |                              |
    | comparte URL #capability ------------------------------>|
    |                           |<-- GET manifest + readToken  |
    |                           |--> encrypted manifest        |
    |                           |<-- GET chunks + readToken    |
    |                           |--> encrypted chunks          |
    |                           |        valida y descifra     |
```

## 9. Validaciones obligatorias del cliente

Un cliente conforme:

1. rechaza versiones desconocidas y longitudes de secretos incorrectas;
2. no inicia red para un fragmento inválido;
3. valida todos los tags GCM;
4. no usa plaintext parcial después de un fallo;
5. verifica recuento y tamaño final autenticados;
6. sanitiza `filename` y trata `mimeType` como no confiable;
7. no sigue redirects autenticados a otro origen;
8. borra referencias a claves y plaintext de memoria cuando sea razonablemente
   posible, sin prometer borrado físico de memoria administrada;
9. nunca registra la capability URL completa.

## 10. Compatibilidad y evolución

- La versión del fragmento y del manifiesto debe coincidir.
- Cualquier cambio de nonce, AAD, algoritmo, semántica de índices o campos
  requeridos exige una nueva versión de protocolo.
- Agregar campos JSON opcionales no cambia la versión si clientes antiguos pueden
  ignorarlos con seguridad.
- v1 no negocia algoritmos: la agilidad criptográfica se introduce mediante una
  versión nueva, no mediante parámetros controlados por el atacante.
- No existe downgrade automático. Un cliente v1 rechaza una cápsula de versión
  desconocida.

## 11. Notas de seguridad para implementadores

- No inventar primitivas ni reemplazar AES-GCM sin revisión criptográfica.
- No deduplicar ciphertext entre cápsulas ni derivar nonces desde el nombre.
- No incluir claves o tokens en URLs del relay. `Authorization` también puede ser
  registrado por proxies mal configurados, por lo que debe redactarse allí.
- La expiración es control de acceso y política operativa, no “autodestrucción”:
  un destinatario puede guardar el archivo y un relay malicioso puede retener
  ciphertext.
- El cifrado no vuelve seguro al archivo descargado. La aplicación no debe
  previsualizar ni ejecutar contenido activo sin aislamiento explícito.

## 12. Versión 2

La versión 2 no cambia la primitiva, el espacio de índices ni la derivación del
nonce. Cambia el AAD, agrega tres campos opcionales y agrega endpoints al relay.
Un lector debe usar la versión declarada en la capability para todo, incluido el
AAD; nunca debe asumir la versión propia.

### 12.1 Additional Authenticated Data ligado a la versión

```text
CAPSULE/v<version>/chunk/<index>
```

`<version>` es la versión de la cápsula (`1` o `2`), no la del lector. Una
cápsula v1 descifrada con AAD v2 falla la autenticación, y viceversa: el
downgrade de versión no es silencioso, es un error criptográfico.

### 12.2 Manifiesto: `expiresAt` nulo

`expiresAt` acepta `null` en v2. Significa que el remitente pidió una cápsula
sin vencimiento y el relay la aceptó. No significa “permanente”: sigue
existiendo mientras ese relay la conserve y la `deleteToken` la retira.

- En v1 `expiresAt` debe ser una fecha posterior a `createdAt`. `null` es
  inválido y debe rechazarse.
- Un relay sólo acepta `expiresInSeconds: null` si su operador lo habilitó.
  Si no, responde `400 persistent_capsules_disabled`.
- El relay expone `persistentCapsules` en `/v1/config` y `/v1/info` para que el
  cliente lo sepa antes de cifrar.

### 12.3 Manifiesto: `paddedLength`

`paddedLength` es opcional y sólo existe en v2. Cuando está presente:

- `paddedLength >= byteLength`;
- `paddedLength % chunkSize === 0`;
- `chunkCount === paddedLength / chunkSize`.

Los bytes entre `byteLength` y `paddedLength` son ceros, se cifran y se
autentican igual que el resto, y el receptor los descarta después de descifrar.
Todos los chunks quedan del mismo tamaño, de modo que el relay observa una
clase de tamaño y una cantidad de chunks, no el tamaño del archivo.

La clase de tamaño se calcula en pasos de un cuarto de octava con un piso de
64 KiB, y luego se redondea a un múltiplo entero de `chunkSize`:

```text
clase(n)   = ceil(max(n, 65536) / (2^floor(log2(max(n, 65536))) / 4)) * paso
padded(n)  = ceil(clase(n) / chunkSize) * chunkSize
```

El receptor **debe** descargar los `chunkCount` chunks aunque sepa que los
últimos son relleno: descargar sólo los chunks útiles le devuelve al relay el
tamaño real.

### 12.4 Capability con relays espejo

`CapsuleShareCapability` acepta `mirrors`, y `CapsuleOwnerCapability` acepta la
lista equivalente con `deleteToken`:

```json
{
  "version": 2,
  "relayUrl": "https://relay-a.example",
  "capsuleId": "…",
  "readToken": "…",
  "key": "…",
  "noncePrefix": "…",
  "mirrors": [
    {
      "relayUrl": "https://relay-b.example",
      "capsuleId": "…",
      "readToken": "…"
    }
  ]
}
```

- Máximo 8 espejos; el fragmento se limita a 8192 caracteres.
- Cada espejo guarda el mismo ciphertext bajo su propio `capsuleId` y sus
  propios tokens: un relay no puede leer ni borrar la copia de otro.
- La lectura intenta el relay primario y luego los espejos en orden. Un fallo de
  autenticación **no** se reintenta en otro relay: el ciphertext está mal, no el
  relay.
- El borrado se dirige a todos y reporta honestamente cuáles no confirmaron.
- Una capability v1 con `mirrors` es inválida.

### 12.5 Relay API: red abierta

Un relay es cualquier host que responde `/v1/info`. No hay registro ni
autoridad; la identidad es una clave Ed25519 que el relay genera al arrancar y
guarda en `identity.json` dentro de su directorio de datos.

`relayId = base64url(SHA-256(clave pública cruda))`

#### `GET /v1/info`

```json
{
  "version": 1,
  "software": "capsule-relay/0.2.0",
  "protocolVersions": [1, 2],
  "relayId": "…",
  "publicKey": "…",
  "url": "https://relay.example",
  "nickname": "relay del club",
  "persistentCapsules": true,
  "limits": {
    "maxCapsuleBytes": 0,
    "maxChunkBytes": 0,
    "maxManifestBytes": 0,
    "maxChunkCount": 0
  },
  "defaultTtlSeconds": 86400,
  "maxTtlSeconds": 604800,
  "peerCount": 12
}
```

#### `GET /v1/peers`

Devuelve `self` y la lista de relays conocidos (`url`, `relayId`, `publicKey`,
`nickname`, `lastSeenAt`). No expone nada sobre cápsulas.

#### `POST /v1/peers/announce`

```json
{
  "url": "https://relay-nuevo.example",
  "relayId": "…",
  "publicKey": "…",
  "announcedAt": "2026-08-29T12:00:00.000Z",
  "signature": "…"
}
```

La firma Ed25519 cubre exactamente:

```text
CAPSULE/relay-announce/v1
<url>
<relayId>
<announcedAt>
```

El receptor acepta el anuncio sólo si `relayId` es el digest de `publicKey`, la
firma verifica, `announcedAt` está dentro de ±5 minutos y la URL es un origen
HTTP(S) enrutable. Responde `202` con su propio `self` y sus peers.

Una dirección aprendida de un tercero **no** se guarda por confiar en quien la
pasó: se prueba con `GET /v1/info` y sólo se guarda si esa dirección responde
con una identidad consistente. Esto evita que un peer invente relays; no
convierte a un relay en confiable.

### 12.6 Compatibilidad

- Una cápsula v1 publicada sigue siendo legible por un cliente v2 sin cambios.
- Un cliente v1 rechaza una cápsula v2: la versión del fragmento no coincide.
- Un relay v0.1 acepta cápsulas v2 con TTL, porque el ciphertext le es opaco;
  rechazará `expiresInSeconds: null` por no conocer el campo.

## 13. Versión 3

La versión 3 mantiene la primitiva, el espacio de índices, la derivación del
nonce y el manifiesto de la versión 2. Agrega una sola cosa al formato —
erasure coding en la capability— y fija dos reglas que antes eran implícitas.

### 13.1 Erasure coding `k de n`

Con `sharding` presente, cada relay listado en la capability guarda **un shard
por chunk** en vez de una copia completa. Menos de `k` relays no pueden
reconstruir un solo byte del ciphertext; cualquier `k` sí.

```json
{
  "version": 3,
  "relayUrl": "https://relay-a.example",
  "capsuleId": "…",
  "readToken": "…",
  "key": "…",
  "noncePrefix": "…",
  "mirrors": [
    {
      "relayUrl": "https://relay-b.example",
      "capsuleId": "…",
      "readToken": "…"
    },
    {
      "relayUrl": "https://relay-c.example",
      "capsuleId": "…",
      "readToken": "…"
    }
  ],
  "sharding": { "k": 2, "n": 3, "blockBytes": 32784, "shardBytes": 16392 }
}
```

Reglas obligatorias:

- `2 <= k < n <= 16` y `n === mirrors.length + 1`. **El orden importa**: el
  relay primario es el shard 0 y cada espejo es el shard `i + 1`.
- `blockBytes === chunkSize + 16`, es decir el ciphertext completo de un chunk.
- `shardBytes === ceil(blockBytes / k)`.
- El relleno es obligatorio (`paddedLength` presente), porque todos los chunks
  deben medir lo mismo para que un shard tenga un tamaño único.
- El manifiesto **no** se reparte: se replica completo en los `n` relays, así
  cualquiera de ellos puede entregarlo.
- El `totalCiphertextBytes` declarado a cada relay es `chunkCount * shardBytes`.

**Codificación.** Reed-Solomon sistemático sobre GF(2^8) con el polinomio
`0x11d`. Las primeras `k` filas de la matriz generadora son la identidad; las
`n - k` restantes son una matriz de Cauchy `C[i][j] = 1 / (x_i ⊕ y_j)` con
`x_i = k + i` e `y_j = j`. Toda submatriz cuadrada de una matriz de Cauchy es
invertible, que es lo que hace cierto "cualquier `k`" y no "casi siempre `k`".

El bloque se parte en `k` shards de `shardBytes`, rellenando el último con
ceros hasta `k * shardBytes`.

**Reconstrucción.** Se toman `k` shards disponibles, se invierte la submatriz
correspondiente a sus índices y se recuperan los shards de datos. Los shards
**no** están autenticados individualmente: un relay que entrega un shard
alterado produce ruido, y quien lo detecta es el tag AES-GCM del chunk. Por eso
un lector **debe** reintentar con otra combinación de `k` shards ante un fallo
de autenticación antes de dar la cápsula por perdida; así un relay mentiroso se
aísla en vez de romper la descarga.

### 13.2 Direcciones de relay admisibles

Un relay aprende direcciones de otros relays y un cliente las aprende de los
relays; ambos después se conectan. Una dirección sólo es admisible si es un
origen HTTP(S) canónico, sin credenciales, ruta, query ni fragmento, y su host
**no** es ninguna de estas cosas, escrita de cualquier forma:

- IPv4 en `0.0.0.0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`,
  `192.168/16`, `100.64/10`, `192.0.0.0/24`, `192.0.2.0/24`, `198.18/15`,
  `198.51.100/24`, `203.0.113/24`, `224/4` o `240/4`;
- IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8` o `2001:db8::/32`;
- **una IPv4 de esa lista embebida en IPv6**: `::ffff:7f00:1` es `127.0.0.1`,
  y también lo son `::ffff:127.0.0.1`, `::127.0.0.1` y `64:ff9b::7f00:1`;
- `localhost`, un nombre de una sola etiqueta, o un nombre terminado en
  `.local`, `.localhost`, `.internal`, `.home.arpa` o `.arpa`.

Un nombre que resuelve a una de esas direcciones sólo puede detectarse
resolviéndolo: **el relay debe resolver el nombre y rechazarlo si alguna
dirección resultante no es admisible**, antes de conectarse. Un cliente en un
navegador no puede resolver, y por lo tanto no debe seguir direcciones privadas
salvo que el operador lo habilite explícitamente para una red local.

### 13.3 Anuncios entre relays

El mensaje firmado incorpora un nonce de prueba de trabajo:

```text
CAPSULE/relay-announce/v2
<url>
<relayId>
<announcedAt>
<nonce>
```

(los campos van separados por saltos de línea, en ese orden, sin espacios)

- El anuncio contiene exactamente `url`, `relayId`, `publicKey`, `announcedAt`,
  `nonce` y `signature`. **Nada más**: cualquier otro dato sobre el relay —su
  nombre, sus límites— se lee de `/v1/info` en la dirección anunciada, no del
  anuncio, así no hay nada que valga la pena falsificar.
- La prueba de trabajo son los bits en cero iniciales de `SHA-256(mensaje)`. El
  receptor exige al menos los que tenga configurados.
- El receptor **debe** consultar `GET <url>/v1/info` y aceptar el anuncio sólo
  si esa dirección responde con un `relayId` igual al anunciado y coherente con
  su clave pública. Una firma válida prueba quién escribió el mensaje, no quién
  controla la dirección que contiene.

## 14. Capabilities protegidas y divididas

Ninguna de estas dos formas toca el formato de cápsula: envuelven la cadena de
una capability. Se especifican acá porque son interoperables.

### 14.1 Protegida con frase de acceso

```text
capsule-recovery:<base64url(JSON)>
```

```json
{
  "version": 1,
  "kdf": "pbkdf2-sha256",
  "iterations": 600000,
  "salt": "<base64url, 16 bytes>",
  "nonce": "<base64url, 12 bytes>",
  "ciphertext": "<base64url>",
  "label": "opcional, no secreto"
}
```

- Clave: PBKDF2-HMAC-SHA-256 sobre la frase normalizada en NFKC, con el `salt`
  y las `iterations` del documento, hacia una clave AES-256-GCM.
- AAD: `CAPSULE/recovery/v1/<kdf>/<iterations>/<salt>`. Liga los parámetros al
  ciphertext, de modo que bajar `iterations` en un blob guardado no lo abre.
- Mínimo aceptable: 100 000 iteraciones. PBKDF2 es lo único que Web Crypto
  ofrece en todas partes; es más débil que Argon2id frente a una GPU, y el
  campo `kdf` existe para agregar una función memory-hard sin romper lo ya
  publicado.

### 14.2 Dividida en partes

```text
capsule-share:<base64url(bytes)>
```

| Offset | Bytes | Contenido                  |
| ------ | ----- | -------------------------- |
| 0      | 1     | versión de formato (`1`)   |
| 1      | 1     | umbral `k` (2..16)         |
| 2      | 1     | índice de la parte (1..16) |
| 3      | 8     | identificador del reparto  |
| 11     | resto | evaluación del polinomio   |

Shamir sobre GF(2^8): por cada byte del secreto se toma un polinomio de grado
`k - 1` cuyo término independiente es ese byte y cuyos demás coeficientes
vienen del CSPRNG; la parte `i` es el polinomio evaluado en `i`. La combinación
es interpolación de Lagrange en cero.

El identificador de reparto detecta la mezcla de partes de dos repartos
distintos. **No** hay digest del secreto en la parte: publicarlo permitiría, a
quien tenga una sola parte, verificar conjeturas sin conocer las demás.

## 15. Estabilidad de la versión 1.0

- El formato de cápsula v1, v2 y v3, la API `/v1` del relay y la codificación
  de capabilities quedan congelados. Un cambio incompatible exige una versión
  de protocolo nueva y una entrada en el registro de cambios.
- Los vectores de
  [`capsule-test-vectors.json`](../packages/protocol/vectors/capsule-test-vectors.json)
  son la referencia normativa. Se regeneran con `npm run vectors` y un cambio
  en ellos es, por definición, un cambio de protocolo.
- Agregar un campo JSON opcional que un lector viejo pueda ignorar sin riesgo
  no cambia la versión. `sharding` no calificó: un lector que lo ignore leería
  shards como si fueran chunks, así que exigió versión nueva.
- No hay negociación de algoritmos y no hay downgrade automático. Un lector
  rechaza una versión que no conoce.

## 16. Formato de paquete de la red de mezcla

Esta sección especifica el paquete que viaja entre nodos de mezcla. No forma
parte del formato de cápsula: una cápsula v3 es idéntica se haya enviado
directo o por la red. El diseño y sus límites están en
[MIXNET.md](./MIXNET.md).

### 16.1 Constantes

| Nombre           | Valor  | Nota                                                    |
| ---------------- | ------ | ------------------------------------------------------- |
| `MAX_HOPS`       | 5      | Todo paquete reserva espacio para esta cantidad         |
| `NODE_ID_BYTES`  | 16     | `HKDF(clave pública, "node-id")`                        |
| Bloque de ruteo  | 64 B   | 32 de ruteo + 32 del MAC del salto siguiente            |
| `BETA_BYTES`     | 320    | `MAX_HOPS × 64`                                         |
| `HEADER_BYTES`   | 384    | `α(32) ‖ β(320) ‖ γ(32)`                                |
| `PAYLOAD_BYTES`  | 65 536 | Idéntico para todo paquete                              |
| `PACKET_BYTES`   | 65 920 | Cabecera más cuerpo                                     |
| `MIX_CHUNK_SIZE` | 64 512 | Texto plano de un chunk, para que quepa uno por paquete |

Grupo: Curve25519, mediante X25519 usado como multiplicación escalar de puntos.
Derivación: `HKDF-SHA-256` con la etiqueta `capsule/mix/v1/<uso>`, donde `<uso>`
es una de `blind`, `mac`, `stream`, `payload`, `replay-tag`, `node-id`,
`lioness`, `lioness-stream`.

### 16.2 Bloque de ruteo

64 bytes por salto:

| Offset | Bytes | Contenido                                                     |
| ------ | ----- | ------------------------------------------------------------- |
| 0      | 1     | Comando: `1` reenviar, `2` entregar, `3` buzón, `4` descartar |
| 1      | 4     | Retardo en milisegundos, big-endian                           |
| 5      | 16    | Identificador del siguiente salto, del destino o del buzón    |
| 21     | 11    | Reservado                                                     |
| 32     | 32    | MAC del salto siguiente                                       |

### 16.3 Construcción de la cabecera

Con camino `n_0 … n_{k-1}` y escalar efímero `x`:

1. `α_0 = x·G`.
2. Para cada salto `i`: el secreto es `Y_i` multiplicado por `x` y luego por
   cada factor de enmascaramiento anterior `b_0 … b_{i-1}`, donde
   `b_j = HKDF(s_j, "blind")`. El salto llega al mismo valor calculando
   `x_i · α_i`.
3. `α_{i+1} = b_i · α_i`.
4. Relleno: para `i` de `0` a `k-2`, se hace crecer la cadena un bloque y se
   la XOR-ea con los últimos bytes del flujo `AES-256-CTR` derivado de
   `HKDF(s_i, "stream")` sobre `BETA_BYTES + 64` bytes. El resultado mide
   `(k-1)·64`.
5. Último salto: bloque de destino, relleno aleatorio hasta
   `BETA_BYTES − (k-1)·64`, XOR con su flujo, y a continuación el relleno del
   punto 4.
6. Hacia atrás, para `i` de `k-2` a `0`:
   `β_i = (bloque_i ‖ β_{i+1}[0 … BETA_BYTES−64]) ⊕ flujo_i`, y
   `γ_i = HMAC-SHA-256(HKDF(s_i, "mac"), β_i)`.

### 16.4 Procesamiento en un salto

1. `s = x_i · α`; si `γ ≠ HMAC(HKDF(s,"mac"), β)`, descartar sin responder.
2. Rechazar si `HKDF(s, "replay-tag")` ya se vio dentro de la ventana.
3. `(β ‖ 0^64) ⊕ flujo` da el bloque de este salto y la β siguiente.
4. `α' = HKDF(s,"blind") · α`.
5. Cuerpo: `LIONESS_descifrar(HKDF(s,"payload"), δ)`.
6. Esperar el retardo, acotado por el máximo del nodo, y actuar según el
   comando.

Un nodo responde siempre igual —`202`— haya reenviado, entregado o descartado.
Un código distinto sería un oráculo sobre el contenido del paquete.

### 16.5 Cuerpo

`LIONESS` (Anderson y Biham) con `AES-256-CTR` como cifrado de flujo y
`HMAC-SHA-256` como función de hash, cuatro rondas, mitad izquierda de 32
bytes. Es una permutación sobre el bloque entero: cambiar un bit aleatoriza los
65 536 bytes. Eso es lo que impide marcar un paquete para reconocerlo después.

Texto plano dentro del cuerpo: `"CAPSULEMIX1"` (11 B), longitud `uint32`
big-endian, mensaje, y relleno aleatorio hasta `PAYLOAD_BYTES`. Un destino que
no encuentra esa marca descarta el paquete: fue alterado en el camino.

### 16.6 Mensaje entregado

Petición:

| Offset | Bytes | Contenido                                                                                                    |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------ |
| 0      | 1     | Versión (`1`)                                                                                                |
| 1      | 1     | Operación: `1` crear, `2` subir chunk, `3` finalizar, `4` manifiesto, `5` leer chunk, `6` estado, `7` borrar |
| 2      | 432   | Bloque de respuesta                                                                                          |
| 434    | 1+n   | Identificador de cápsula, con largo previo                                                                   |
| …      | 1+n   | Token, con largo previo                                                                                      |
| …      | 4     | Índice de chunk, big-endian                                                                                  |
| …      | 4     | Largo de los datos, big-endian                                                                               |
| …      | n     | Datos                                                                                                        |

Respuesta: versión (1 B), éxito (1 B), largo `uint32` (4 B), datos.

Bloque de respuesta (432 B): identificador del primer salto (16), `α` (32),
`β` (320), `γ` (32), clave de sellado (32).

### 16.7 API HTTP del nodo

- `POST /v1/mix` con `Content-Type: application/capsule-mix` y exactamente
  `PACKET_BYTES` bytes. Responde `202` siempre.
- `GET /v1/mix/mailbox/<token hexadecimal de 32 caracteres>` devuelve
  `{ version, messages: [base64url] }` y vacía el buzón.
- `GET /v1/info` incluye `mixEnabled` y, cuando corresponde, `mixPublicKey`.

Estos dos endpoints llevan su propio límite de peticiones: el tráfico de mezcla
y el sondeo de un buzón no se parecen al tráfico de API, y contarlos juntos
deja a la red sin servicio justo cuando está funcionando.
