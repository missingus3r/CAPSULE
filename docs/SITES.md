# Sitios `.capsule`

**Estado:** implementado y funcionando; sin auditoría externa
**Fecha:** 2026-08-30

## 1. Lo primero: qué protege y qué no

Un sitio `.capsule` es **público**. Cualquiera que consiga el registro puede
leer la página, y los registros circulan entre relays a propósito para que el
nombre resuelva en cualquier lado. Si algo tiene que ser privado, no se publica
como sitio: se manda como cápsula, con su enlace.

Lo que un sitio `.capsule` sí garantiza:

- **Nadie puede reemplazar tus páginas** salvo quien tenga tu clave, porque el
  nombre _es_ la clave.
- **Nadie puede entregarte una versión vieja** sin que el navegador lo note.
- **El visitante no le cuenta a nadie qué leyó**, porque la página no puede
  hacer ninguna petición de red.
- **El relay no sabe qué está guardando**: recibe una cápsula cifrada, con
  relleno a clase de tamaño y un nombre de archivo neutro.

Lo que no garantiza:

- **Que el sitio siga existiendo.** Vive en relays que alguien mantiene. Si
  vencen las cápsulas o desaparecen los relays, el nombre resuelve a nada.
- **Que publicar sea anónimo por sí solo.** El relay ve la dirección de quien
  sube, salvo que se use `--mix` o `--tor`.
- **Que nadie sepa que visitaste el sitio.** El relay al que le preguntás ve
  que preguntaste por ese nombre. Con `--mix` no; desde la extensión, todavía
  sí (ver §7).

## 2. El nombre

```
<52 caracteres base32>.capsule
```

Más precisamente: 35 bytes en base32 sin relleno, que son la clave pública
Ed25519 (32), dos bytes de suma de verificación y un byte de versión. Da 56
caracteres más `.capsule`.

```
6dijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule
```

Es feo y no se recuerda. Ese es el precio de que nadie tenga que emitirlo. Es
la misma decisión que tomó Tor con las direcciones onion v3, y por las mismas
razones: un nombre legible necesita un registro, un registro necesita un
registrador, y un registrador es alguien a quien presionar.

La suma de verificación no protege contra nada: sirve para que un nombre mal
tipeado falle en el navegador en vez de resolver a un sitio distinto.

- Codificación: alfabeto RFC 4648 en minúsculas, sin relleno. Los bits
  sobrantes del último carácter deben ser cero, así que un nombre tiene una
  sola escritura posible.
- Suma: `SHA-256("CAPSULE/site-name/v1" ‖ clave ‖ versión)[0..2]`.

## 3. El registro

Un registro dice «la versión N de este nombre es esta capacidad»:

```json
{
  "version": 1,
  "name": "<nombre>.capsule",
  "sequence": 7,
  "publishedAt": "2026-08-30T16:39:44.940Z",
  "capability": "capsule=eyJ2ZXJzaW9uIjoz...",
  "title": "Opcional, 120 caracteres",
  "signature": "<base64url, 64 bytes>"
}
```

Se firma este texto exacto, con los campos separados por saltos de línea y
ninguno pudiendo contenerlos:

```
CAPSULE/site-record/v1
<version>
<name>
<sequence>
<publishedAt>
<capability>
<title o vacío>
```

Reglas que aplican tanto el relay como el cliente:

- La firma se verifica contra la clave que está **dentro del nombre**. No hay
  otra fuente de verdad.
- `sequence` sólo puede subir. Un relay guarda el más alto que vio; un
  navegador guarda el más alto que aceptó.
- Un registro con fecha más de 10 minutos en el futuro se rechaza; uno de más
  de 90 días, también, para que un registro viejo no quede circulando para
  siempre.

## 4. El paquete

El sitio entero es una sola cápsula. El formato es deliberadamente aburrido:

```
"CAPSITE1"        8 bytes
largo del índice  uint32 big-endian
índice            JSON UTF-8
archivos          concatenados, en el orden del índice
```

El índice es `{ "v":1, "entries":[ {"path","type","offset","length"} ] }`.

**No hay descarga parcial y es a propósito.** Si el visitante pidiera archivo
por archivo, el relay aprendería qué páginas leyó. Bajar el sitio entero cuesta
más ancho de banda y compra que el patrón de lectura no exista.

Sobre esto se aplica todo lo que ya hace una cápsula: cifrado extremo a
extremo, relleno a clase de tamaño, espejos, reparto `k` de `n` y ruteo por la
red de mezcla. No hizo falta cambiar nada del formato v3.

## 5. Los relays

Tres endpoints, todos opcionales (`CAPSULE_SITES_ENABLED=false` los apaga):

| Endpoint                | Qué hace                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /v1/sites/:name`   | Acepta un registro si verifica y su secuencia avanza. `202` si lo guardó, `200` si ya tenía uno igual o más nuevo, `400` si no verifica. |
| `GET /v1/sites/:name`   | Devuelve el registro, o `404`.                                                                                                           |
| `GET /v1/sites?limit=n` | Lista registros recientes, para el chismorreo entre relays.                                                                              |

Los relays se pasan registros entre sí en cada ronda de sincronización, con un
tope por ronda (`CAPSULE_SITE_GOSSIP_LIMIT`, 200 por omisión) y un tope total
(`CAPSULE_MAX_SITES`, 5000). Sin esto, un nombre sólo resolvería en los relays
a los que su autor lo anunció, y habría que decirle a cada visitante cuáles
son — que es un registro con pasos extra.

Un relay puede **callarse**, no mentir. Por eso el cliente le pregunta a varios
y se queda con la secuencia más alta que verifique: para que callarse sirva de
algo, tendrían que callarse todos.

## 6. La extensión

`http://<nombre>.capsule/` no resuelve por DNS y nunca va a hacerlo. La
extensión intercepta la navegación con una regla de `declarativeNetRequest`
antes de que el navegador resuelva nada, y la convierte en una página propia
con la dirección original en el **fragmento** — que no viaja a ningún servidor,
igual que en un enlace de cápsula.

Después:

1. Parsea el nombre. Si no parsea, se termina ahí: no hay búsqueda, ni
   «¿quisiste decir?».
2. Pregunta a los relays configurados y verifica cada respuesta.
3. Compara la secuencia con la más alta que este navegador aceptó para el
   nombre. Si es menor, muestra un error en vez de la página.
4. Baja la cápsula, la descifra y desempaqueta el paquete.
5. Reconstruye la página y la entrega a un marco aislado.

### 6.1 Cómo se reconstruye una página

El contenido de un sitio no es confiable: lo escribió quien tenga una clave y
llegó por relays que nadie avala. Así que el documento no se muestra, se
rehace:

- Cada referencia que resuelve dentro del paquete se convierte en un `data:`
  URL — hojas de estilo, imágenes, fuentes, `srcset`, `url()` dentro del CSS.
- Cada referencia que apunta afuera se elimina.
- Los enlaces internos apuntan a la propia página del visor, así que navegar
  actualiza la barra de direcciones y el historial funciona.
- Un enlace que sale de CAPSULE se convierte en una confirmación: se muestra a
  dónde va y hace falta un segundo clic.
- `<base>` y `<meta http-equiv="refresh">` se borran: el primero desharía todas
  las reescrituras y el segundo es una navegación que nadie pidió.
- Se inserta una política al principio del `<head>`:

```
default-src 'none'; img-src data:; media-src data:; font-src data:;
style-src 'unsafe-inline' data:; script-src 'none'; frame-src 'none';
connect-src 'none'; form-action 'none'; base-uri 'none'
```

### 6.2 Los scripts, y por qué están apagados

Por omisión el marco va con `sandbox="allow-top-navigation-by-user-activation"`
y **sin** `allow-scripts`. Sin scripts, lo único que puede navegar el marco es
un clic real sobre un enlace que escribió el reconstructor. Con eso la garantía
es absoluta: la página no puede hacer ni una petición de red.

Se pueden habilitar por sitio, con una advertencia visible. Un script sí puede
llevar el marco a una dirección externa, y eso revelaría la IP del visitante a
esa dirección. La política sigue impidiendo `fetch`, imágenes y fuentes
externas, pero una navegación no es una petición sujeta a CSP y no hay
directiva que la cubra desde que `navigate-to` quedó fuera del estándar.

Nunca se usa `allow-same-origin`. El marco vive en un origen opaco; si
compartiera el origen de la extensión, el sitio tendría acceso a `chrome.*`.

### 6.3 Permisos

La extensión pide `declarativeNetRequest` y `storage`, y **ningún** permiso de
host de entrada. El acceso a un relay se pide cuando alguien lo agrega en la
configuración, para ese origen y nada más, y se devuelve cuando lo quita. Una
extensión que puede leer cualquier sitio es una extensión que hay que confiar
mucho más de lo necesario.

## 7. Lo que falta

**El visitante todavía se expone al relay.** La extensión consulta relays
directamente desde el navegador. El relay ve una dirección IP preguntando por
un nombre. La CLI puede ir por la red de mezcla; la extensión no, porque
requiere Node. Es la carencia más importante de esta versión.

**No hay caché entre sesiones.** El paquete se guarda en
`chrome.storage.session`, que vive en memoria y se borra al cerrar el
navegador. Es lo correcto para la privacidad y significa volver a bajar el
sitio cada vez.

**Sólo Chromium.** La extensión es MV3 con `declarativeNetRequest`. Firefox
necesita un puerto; Safari, otro.

**El tamaño es un límite real.** Un sitio se baja entero. La CLI corta en 64
MiB y en la práctica un sitio útil está por debajo de unos pocos MiB.

**Nada de esto está auditado.** El reconstructor de páginas es un límite de
seguridad escrito a mano y probado con los casos que se nos ocurrieron.
