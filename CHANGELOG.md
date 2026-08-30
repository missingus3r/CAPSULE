# Changelog

Todas las versiones publicadas de CAPSULE, con lo que cambió y —cuando
corresponde— lo que dejó de ser cierto. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es/1.1.0/).

## [1.1.0] — 2026-08-30

CAPSULE tiene su propia red de mezcla. El formato de cápsula, la API del relay
y las capabilities no cambian: una cápsula enviada por la red es idéntica a una
enviada directo.

**Antes de nada:** el anonimato de una red viene del tamaño del conjunto en el
que te escondés, no de su código. Con pocos nodos y un solo operador esto no es
una red anónima, y la herramienta lo dice en cada envío en vez de sugerir lo
contrario. El diseño completo y sus límites están en
[docs/MIXNET.md](docs/MIXNET.md).

### Agregado

**La red de mezcla**

- Paquetes Sphinx de tamaño único (65 920 bytes), con cabecera enmascarada en
  cada salto, relleno que impide deducir la posición en el camino, y cuerpo
  cifrado con LIONESS: cambiar un bit aleatoriza el paquete entero, que es lo
  que anula el ataque de marcado.
- Retardos por salto tomados de una distribución exponencial. Esto es lo que
  Tor no puede hacer —quien espera una página web no espera— y es lo que rompe
  la correlación temporal de punta a punta.
- Bloques de respuesta de un solo uso: el relay contesta sin saber a quién.
- Buzones en un relay proveedor, para clientes que no pueden recibir
  conexiones.
- Tráfico de cobertura: cada nodo se envía paquetes a sí mismo por caminos
  aleatorios, indistinguibles de los reales.
- Protección contra repetición por etiqueta derivada del secreto compartido.
- **Sin nodos de salida**: el destino es el propio relay que guarda la cápsula,
  así que ninguna parte ve la petición en claro sin ser su destinataria.
- Cada relay es un nodo de mezcla por omisión, con su clave Curve25519 propia
  publicada en `/v1/info` y propagada por el gossip existente.

**En la CLI**

- `--mix` en `send`, `receive` y `delete`, con `--mix-hops`, `--mix-delay` y
  `--mix-provider`.
- Se combina con `--tor`: Tor oculta CAPSULE de tu proveedor de Internet, la
  mezcla te oculta de los relays.
- Antes de cada envío imprime cuántos nodos y cuántos operadores aparentes hay,
  y qué significa ese número.

**En el SDK**

- `RelayTransport`, la interfaz que una transferencia necesita de un relay. El
  cliente directo y el de la red la implementan igual, así que subir y bajar
  funcionan sin saber por dónde viajan.

### Corregido

- **Un relay dejaba de propagar el directorio en cuanto conocía un vecino**, y
  quedaba con vista parcial hasta el siguiente ciclo de gossip. Con la red de
  mezcla eso deja de ser un detalle: un nodo que no conoce al nodo que nombra
  un paquete no tiene más opción que descartarlo. Ahora sigue propagando hasta
  que el directorio deja de crecer.
- **El tráfico de mezcla y el sondeo de buzones se contaban contra el límite de
  peticiones de la API**, que los agotaba justo cuando la red funcionaba. Ahora
  tienen su propio límite, y lo que acota la mezcla es el tamaño de la cola.
- Un relay que se apaga cancela los sondeos en curso en vez de esperar a que
  venzan por tiempo.

### Sigue sin resolverse

- La aplicación web no usa la red: necesita X25519 en Web Crypto.
- No hay nodos guardián; el primer salto se reelige en cada petición, y esa
  decisión merece el análisis que Tor sí hizo.
- Un ataque n−1 activo sigue abierto, como en la literatura.
- No hay resistencia a censura: ni puentes ni transportes conectables.
- Esta composición no tiene revisión criptográfica externa.

## [1.0.0] — 2026-08-29

Primera versión estable: el formato de cápsula, la API del relay y las
capabilities quedan congelados y publicados con vectores de prueba. Las
cápsulas v1 y v2 se siguen leyendo sin cambios.

### Agregado

**Anonimización del contenido**

- Limpieza de metadatos embebidos antes de cifrar, con soporte para JPEG
  (APPn y comentarios), PNG (`tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`), WebP
  (`EXIF`/`XMP` y los flags de `VP8X`), GIF (comentarios y extensiones de
  aplicación, conservando el bucle NETSCAPE2.0), MP4/MOV/HEIC/AVIF (cajas
  `udta`, `uuid` y `meta` sobrescritas en el lugar) y contenedores ZIP
  (Office/ODF/EPUB: propiedades del documento vaciadas y marcas de tiempo
  normalizadas).
- En PDF se blanquean los paquetes XMP sin mover un solo byte; el diccionario
  `/Info` se **reporta** como no removible en vez de fingir que se limpió.
- Nombre de archivo y tipo MIME neutros en el manifiesto.
- Relleno por clases de tamaño: el relay ve una categoría, no el tamaño real.
- Jitter opcional entre chunks.

**Anonimización del transporte**

- Cliente SOCKS5 propio en la CLI (`--proxy`, `--tor`), sin dependencias
  nuevas, con resolución de nombre en el proxy y soporte de `.onion`.
- El relay opera sin retener direcciones: nada de IPs en logs y rate limiting
  por hash con sal rotativa (`CAPSULE_IP_BLIND`, activado por omisión).

**Cápsulas sin vencimiento**

- `expiresAt: null` en el manifiesto y `expiresInSeconds: null` en la API.
- Desactivado por omisión; el operador lo habilita y fija una cuota global y
  otra por remitente.

**Red abierta de relays**

- Identidad Ed25519 por relay, generada al arrancar y persistida.
- `GET /v1/info`, `GET /v1/peers` y `POST /v1/peers/announce` con anuncios
  firmados y prueba de trabajo configurable.
- Gossip con reintentos de arranque, verificación de cada dirección aprendida
  contra `/v1/info`, tope por operador aparente y defensa SSRF.
- Descubrimiento del lado cliente con semillas fijables (`url#relayId`) y
  selección que prefiere operadores distintos.

**Réplica y disponibilidad**

- Espejos completos en varios relays, con failover de lectura y borrado
  dirigido a todos con reporte honesto.
- Erasure coding `k de n` opcional: ningún relay guarda lo suficiente para
  reconstruir la cápsula, y cuesta `n/k` en vez de `n`. Un relay que sirve
  shards corruptos no rompe la descarga: se prueba otra combinación.

**Recuperación (opt-in)**

- Capabilities protegidas con frase de acceso (PBKDF2-SHA-256 + AES-GCM).
- División Shamir `k de n` de una capability entre personas o dispositivos.

**Operación**

- Subidas reanudables mediante un ticket, y reintentos con backoff.
- Vectores de conformidad publicados en
  `packages/protocol/vectors/capsule-test-vectors.json`.
- Fuzzing de todos los parsers y de la superficie HTTP del relay.
- `npm run release`: checksums SHA-256 y SBOM CycloneDX.

### Cambiado

- Versión de protocolo **3**. El AAD queda ligado a la versión de la cápsula,
  de modo que un downgrade falla la autenticación en vez de pasar inadvertido.
- Un relay con `CAPSULE_PUBLIC_URL` acepta CORS de cualquier origen por
  omisión: sin eso no puede servir aplicaciones web que no hospede él mismo.
  Las capabilities son bearer tokens explícitos, nunca cookies, así que una
  política permisiva no otorga autoridad ambiental.
- La CSP de la aplicación web permite `https:` en `connect-src`, necesario para
  hablar con relays descubiertos en la red. El servidor de desarrollo agrega
  loopback; el build de producción no.

### Corregido

- Un relay que arrancaba antes que su semilla quedaba aislado hasta el
  siguiente intervalo de gossip (5 minutos por omisión). Ahora reintenta el
  arranque con backoff corto.

### Seguridad

Hallazgos de la revisión de seguridad de esta versión, todos corregidos antes
de publicarla. El detalle y el razonamiento están en
[el modelo de amenazas](docs/THREAT_MODEL.md) §13.3.

- **Filtro de direcciones del relay esquivable (medio).** La lista negra
  comparaba cadenas: `127.0.0.1` quedaba bloqueado y `[::ffff:7f00:1]` —la
  misma dirección en IPv6— pasaba. Cualquiera podía hacer que un relay público
  consultara servicios internos de su operador y republicara esa dirección a
  toda la red. Se reemplazó por un analizador que normaliza toda forma
  equivalente y bloquea los rangos privados, loopback, link-local, CGNAT,
  multicast, reservados y de documentación; además el relay resuelve los
  nombres y rechaza los que apuntan ahí.
- **El descubrimiento del cliente no tenía ese filtro, y la CSP lo permitía
  (medio).** Un relay hostil podía devolver direcciones de loopback en su lista
  de peers y el navegador de quien abriera la aplicación las consultaba. El SDK
  aplica ahora el mismo filtro; seguir direcciones privadas es una opción
  explícita que la aplicación sólo activa cuando su propio relay ya es local.
  La CSP de producción volvió a `connect-src 'self' https:`.
- **La firma del anuncio no cubría el nombre del relay (bajo).** Se sacó el
  nombre del anuncio: ahora afirma sólo "soy este relay en esta dirección", y
  todo lo demás se lee de esa dirección.
- **Un anuncio válido no probaba el control de la dirección anunciada (bajo).**
  El receptor consulta ahora la dirección antes de creerle.
- **Reanudar con otro archivo del mismo tamaño podía reutilizar un nonce
  (bajo).** El ticket lleva un compromiso con el contenido y se rechaza
  cualquier otro archivo; además un chunk se reenvía a todos los relays en
  cuanto a alguno le falta, de modo que quien ya lo tenía verifica los bytes.

Revisado sin hallazgos: la aritmética GF(256), Reed-Solomon y Shamir, el
espacio de nonces, el ligado del AAD a la versión, los parámetros de PBKDF2, la
validación TLS a través del proxy SOCKS5, la autorización y el manejo de rutas
del relay, los siete parsers binarios y la ausencia de secretos en logs.

### Sigue sin resolverse

Estas no son omisiones: son límites conocidos y documentados en
[el modelo de amenazas](docs/THREAT_MODEL.md).

- La aplicación web no enruta por Tor; sólo la CLI puede.
- El horario y el volumen de una transferencia siguen siendo observables.
- No hay transporte P2P ni por proximidad.
- No hay mix routing ni resistencia a un observador global.
- El diccionario `/Info` de un PDF y los metadatos de TIFF/HEIF exóticos no se
  limpian.

## [0.1.0] — 2026-08-29

- Primera versión ejecutable: web, CLI, SDK y relay temporal interoperables,
  con cifrado AES-256-GCM en el cliente, enlaces-capacidad y TTL.
