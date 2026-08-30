# Levantá tu propio relay

**Estado:** guía operativa para CAPSULE 1.0
**Fecha:** 2026-08-29

No hay registro, lista blanca ni permiso que pedir. Un relay de CAPSULE es
cualquier host que responde `/v1/info`. Levantás el tuyo, lo apuntás a un relay
que ya conozcas, y a partir de ahí se presentan entre sí.

## 1. Qué es y qué no es un relay

Un relay guarda ciphertext y lo entrega a quien presente la capability
correcta. **No** puede leer el contenido, el nombre del archivo ni la nota: todo
eso viaja cifrado y la llave nunca sale del dispositivo de quien envía.

Lo que sí ve tu relay, y por lo tanto lo que asumís como operador:

- direcciones IP mientras dura cada conexión;
- horarios y volumen de cada transferencia;
- la clase de tamaño de cada cápsula (el tamaño exacto sólo si el remitente no
  usó relleno);
- cuántas veces se leyó una cápsula.

Operar un relay implica alojar datos que no podés inspeccionar. Leé
[el modelo de amenazas](./THREAT_MODEL.md), en particular la sección de abuso y
contenido ilícito, antes de exponerlo a Internet.

## 2. Arranque mínimo

```bash
git clone <este-repositorio> capsule && cd capsule
npm install
npm run build
CAPSULE_HOST=0.0.0.0 CAPSULE_STORAGE_DIR=/var/lib/capsule \
  node apps/relay/dist/main.js
```

Con Docker:

```bash
cd infra
CAPSULE_PUBLIC_URL=https://relay.example.org docker compose up -d
```

En el primer arranque el relay genera su identidad Ed25519 y la guarda en
`identity.json` dentro del directorio de datos, con permisos `0600`. Ese archivo
**es** la identidad de tu relay: si lo perdés, la red lo ve como un relay nuevo.
Hacé backup del directorio de datos o al menos de ese archivo.

## 3. Conectarte a la red

Dos variables alcanzan:

```bash
# La dirección por la que otros pueden alcanzarte. Sin esto podés descubrir
# relays, pero nadie puede anunciarte: sos sólo un consumidor del directorio.
CAPSULE_PUBLIC_URL=https://relay.example.org

# Relays que ya conocés. Basta uno.
CAPSULE_PEERS=https://relay-de-un-conocido.example
```

Opcionales:

```bash
CAPSULE_RELAY_NAME="relay del club de barrio"   # etiqueta visible en el directorio
CAPSULE_MAX_PEERS=200                            # tope del directorio local
CAPSULE_MAX_PEERS_PER_OPERATOR=4                 # tope por dominio aparente
CAPSULE_PEER_SYNC_INTERVAL_MS=300000             # cada cuánto saluda a sus peers
CAPSULE_ANNOUNCE_POW_BITS=18                     # trabajo exigido a quien se anuncia
CAPSULE_ALLOW_PRIVATE_PEERS=false                # true sólo en redes locales
```

`CAPSULE_ANNOUNCE_POW_BITS` es lo que le cuesta a un relay nuevo presentarse:
cada bit duplica el trabajo. En 18 bits un relay honesto tarda una fracción de
segundo por ronda de gossip, y llenar tu directorio de relays inventados cuesta
esa misma fracción **por cada uno**. Subilo si ves anuncios basura; bajalo a 0
sólo en una red cerrada.

`CAPSULE_ALLOW_PRIVATE_PEERS` **no** es una comodidad: es el interruptor que
permite que una dirección anunciada apunte de vuelta a tu propia red. Déjalo en
`false` en cualquier relay expuesto a Internet.

Cada ronda de gossip el relay:

1. saluda a los peers configurados y a los que ya conoce;
2. les manda un anuncio firmado, con su prueba de trabajo resuelta;
3. recibe la lista de relays que ellos conocen;
4. prueba cada dirección nueva con `GET /v1/info` y la guarda sólo si esa
   dirección responde con una identidad coherente con lo que anunció.

Ninguna dirección se guarda por confiar en quien la pasó, **ni siquiera cuando
viene firmada**: una firma prueba quién escribió el mensaje, no quién controla
la dirección que contiene. Por eso hasta un anuncio directo se verifica
consultando la dirección anunciada antes de creerle.

El relay tampoco se conecta a una dirección que apunte a su propia red:
descarta loopback, enlaces locales, rangos privados, CGNAT y direcciones
reservadas, incluidas las formas escritas en IPv6 (`[::ffff:7f00:1]` es
`127.0.0.1`), y **resuelve** los nombres para rechazar los que apunten ahí.
Si arrancás el relay en una máquina que además aloja servicios internos,
aislarlo en red sigue siendo lo prudente.

Verificá desde otra máquina:

```bash
curl https://relay.example.org/v1/info
node apps/cli/dist/index.js relays --seed https://relay.example.org
```

## 4. Cápsulas sin vencimiento

Están **apagadas** por defecto, porque guardar archivos sin fecha de baja es una
decisión de costo y de responsabilidad que sólo puede tomar quien paga el disco.

```bash
CAPSULE_ALLOW_PERSISTENT_CAPSULES=true
CAPSULE_MAX_PERSISTENT_BYTES=10737418240              # 10 GiB de tope
CAPSULE_MAX_PERSISTENT_BYTES_PER_SENDER=1073741824    # 1 GiB por remitente
```

El tope por remitente evita que la primera persona que llegue se lleve todo el
espacio. Para distinguir remitentes sin llevar una lista de quiénes son, el
relay cuenta contra un hash con sal de la dirección, y la sal se descarta y se
regenera cada ventana: al rotar, los contadores se olvidan. Es a propósito.

Al habilitarlo:

- el relay acepta `expiresInSeconds: null` y lo publica en `/v1/config`, así los
  clientes ofrecen la opción sin tener que probar y fallar;
- la limpieza periódica nunca toca esas cápsulas;
- al llegar al tope, el relay responde `507 insufficient_storage` a las nuevas
  cápsulas sin vencimiento, sin afectar a las que tienen TTL;
- la única forma de borrarlas es la capability de retiro del remitente, o vos
  borrando el directorio a mano.

Decilo como es en tu política de servicio: no es “permanente”, es “hasta que la
borren o hasta que el relay deje de existir”.

## 5. Privacidad operativa

```bash
CAPSULE_IP_BLIND=true    # valor por defecto
```

Con esto el relay no escribe direcciones en los logs y el rate limiting usa un
hash con sal rotativa en vez de la IP. Reduce lo que **retenés**, no lo que
observás: el sistema operativo y el proxy siguen viendo la conexión.

Además:

- terminá TLS con HTTPS y no pongas la capability en query strings (el protocolo
  ya usa `Authorization`, mantenelo así);
- configurá tu proxy inverso para **no** loguear IPs ni el header
  `Authorization`;
- no agregues analítica de terceros delante del relay;
- si publicás un servicio onion, el `.onion` funciona sin cambios: es una URL
  HTTP más para el protocolo, y la CLI la alcanza con `--tor`.

## 6. Límites y abuso

```bash
CAPSULE_MAX_CAPSULE_BYTES=104857600
CAPSULE_MAX_CHUNK_COUNT=10000
CAPSULE_MAX_TTL_SECONDS=604800
CAPSULE_RATE_LIMIT_MAX=300
CAPSULE_CREATE_RATE_LIMIT_MAX=30
```

No podés moderar por contenido: no lo ves. Lo que sí podés hacer es acotar
tamaño, tiempo y frecuencia, publicar una política y una vía de contacto, y
borrar por `capsuleId` cuando recibas un reclamo fundado. Anotá esa decisión en
tu propia política antes de recibir el primer reclamo, no después.

## 7. Cápsulas repartidas

Si varios relays de la red aceptan cápsulas, quien envía puede **repartir** una
en vez de copiarla: con `k de n`, cada relay guarda un fragmento que por sí
solo no permite reconstruir nada, y hacen falta `k` operadores distintos para
leerla.

Para vos como operador eso significa dos cosas concretas: guardás alrededor de
`1/k` de cada cápsula en vez de una copia entera, y si te incautan el disco no
tenés el ciphertext completo de nada. No requiere configuración: es una
decisión de quien envía, y tu relay ve fragmentos opacos igual que veía
cápsulas opacas.

## 8. Tu relay es un nodo de mezcla

Por omisión, además de guardar cápsulas, tu relay reenvía paquetes de la red de
mezcla. Es lo que permite que el relay que guarda una cápsula no vea la
dirección de quien la sube.

```bash
CAPSULE_MIX_ENABLED=true              # por omisión
CAPSULE_MIX_COVER_INTERVAL_MS=30000   # cada cuánto emitís un bucle de relleno
CAPSULE_MIX_MAX_DELAY_MS=300000       # tope al retardo que puede pedirte un remitente
CAPSULE_MIX_MAX_QUEUED=2048           # paquetes que podés estar reteniendo
CAPSULE_MIX_RATE_LIMIT_MAX=12000      # el tráfico de mezcla no es tráfico de API
```

Lo que tu nodo ve: la dirección del nodo anterior y la del siguiente. Nada más.
No ve el contenido, ni la longitud del camino, ni su posición en él, ni puede
relacionar el paquete que entró con el que salió.

Dos cosas que conviene saber antes de dejarlo prendido:

- **Cuesta ancho de banda.** Cada paquete mide 65 920 bytes y atraviesa varios
  nodos. El tráfico de cobertura suma aunque nadie esté enviando nada: esa es
  su función. Si te resulta caro, subí `CAPSULE_MIX_COVER_INTERVAL_MS` antes de
  apagarlo del todo, porque un enlace sin cobertura le dice a quien mira
  exactamente cuándo hay tráfico real.
- **Podés ser el proveedor de alguien.** Si un cliente te elige para su buzón,
  vas a ver una dirección consultándolo periódicamente. Sabés que esa persona
  usa la red; no sabés qué pidió ni a quién.

Leé [MIXNET.md](./MIXNET.md) antes de anunciar tu nodo como parte de una red
anónima. Con pocos operadores no lo es, y decirlo de más es peor que no tenerla.

## 9. Tu relay guarda nombres `.capsule`

Un sitio `.capsule` es una cápsula corriente más un **registro firmado** que dice
qué cápsula es la versión actual de un nombre. Tu relay guarda esos registros y
se los pasa a otros relays.

```bash
CAPSULE_SITES_ENABLED=true      # por omisión
CAPSULE_MAX_SITES=5000          # registros antes de tirar el más viejo
CAPSULE_SITE_GOSSIP_LIMIT=200   # registros que pedís a un par por ronda
```

### 10.1 Qué ves y qué no

**Ves** el nombre, el número de versión, la fecha y el título si el autor puso
uno. Los registros son públicos por diseño: para eso circulan.

**No ves** el contenido. La capacidad está dentro del registro y sirve para bajar
la cápsula, pero la cápsula está cifrada extremo a extremo y tu relay no tiene la
clave salvo que además decidas bajarla y descifrarla como haría cualquier
visitante. Como todo sitio, es público; no hay nada especial en que vos también
puedas leerlo.

**No podés** falsificar ni alterar un registro: la firma se verifica contra la
clave que está dentro del nombre y no la tenés. Tampoco podés revertir un sitio
sin que se note: los navegadores recuerdan la versión más alta que aceptaron.

### 10.2 Lo único que podés hacer es callarte

Podés negarte a guardar registros, o servir uno viejo. Por eso los clientes
preguntan a varios relays y se quedan con la versión más alta que verifique. Un
relay que calla es indistinguible de uno caído, y suprimir una actualización
requiere que callen todos los relays a los que el visitante pregunta.

### 10.3 Si no querés participar

`CAPSULE_SITES_ENABLED=false` apaga los tres endpoints y el chismorreo de
registros. Tu relay sigue guardando cápsulas y siendo nodo de mezcla. Es una
decisión razonable: alojar nombres es alojar contenido publicado, con lo que eso
implica en tu jurisdicción. La sección 6 de este documento sobre abuso y
contenido ilícito aplica igual.

## 10. Checklist antes de anunciarte

- [ ] HTTPS válido y `CAPSULE_PUBLIC_URL` con el origen real.
- [ ] `identity.json` respaldado y con permisos `0600`.
- [ ] Volumen de datos con espacio monitoreado.
- [ ] `CAPSULE_IP_BLIND=true` y proxy inverso sin logs de IP.
- [ ] Límites de tamaño y TTL acordes a tu disco.
- [ ] Decisión explícita sobre cápsulas sin vencimiento.
- [ ] Política de abuso y contacto publicados.
- [ ] `CAPSULE_ALLOW_PRIVATE_PEERS=false` (es el freno anti-SSRF).
- [ ] `curl /v1/info` y `/v1/peers` responden desde fuera de tu red.
- [ ] Decidido si dejás el nodo de mezcla prendido y con cuánta cobertura.
- [ ] Decidido si alojás nombres `.capsule` (`CAPSULE_SITES_ENABLED`).
