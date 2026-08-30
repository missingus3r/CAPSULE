# CAPSULE — Modelo de amenazas

**Estado:** vigente para CAPSULE 1.1  
**Fecha:** 2026-08-29  
**Alcance:** protocolo v1, v2 y v3; aplicación web, CLI, SDK y relay de referencia

Las secciones 1 a 11 describen el modelo de v0.1 y siguen siendo la base. La
sección 12 cubre lo que cambió en v0.2 (anonimización parcial, cápsulas sin
vencimiento, red abierta), la 13 lo de v1.0 (reparto `k de n`, recuperación,
y los hallazgos de la revisión de seguridad con sus correcciones) y la 14 la
red de mezcla de 1.1.

## 1. Resumen ejecutivo

CAPSULE v0.1 está diseñado para que un relay pueda almacenar y entregar un
archivo temporal **sin conocer su contenido ni sus metadatos privados**. El
archivo se cifra en el cliente y la clave viaja en el fragmento del enlace, no
en las solicitudes HTTP al relay.

La promesa termina ahí: v0.1 **no es una red de anonimato**. El relay, proveedor
de Internet, CDN o un observador de red pueden inferir quién se conecta, cuándo,
cuánto transfiere y qué relay utiliza. Tampoco existe una forma técnica de
impedir que un destinatario copie el archivo ni de demostrar que un relay
malicioso borró todos sus backups.

Declaración segura para el producto:

> CAPSULE protege el contenido y detecta alteraciones mientras la clave permanezca
> secreta. El enlace concede acceso. La versión 0.1 no oculta identidades de red
> ni garantiza la desaparición de copias.

## 2. Sistema y límites de confianza

```text
              canal externo que transporta la capability URL
   Remitente ------------------------------------------------> Destinatario
      |                                                             |
      | cliente cifra localmente                         cliente descifra
      |                                                             |
      +---------------- HTTPS ------------+------------- HTTPS -----+
                                           |
                                      Relay no confiable
                                 ciphertext, TTL y capacidades
                                           |
                                  almacenamiento / backups / logs
```

Límites relevantes:

1. **Dispositivo del remitente.** Ve plaintext, nombre, nota, claves y todas las
   capacidades.
2. **Origen de la aplicación web.** Entrega JavaScript que luego puede leer el
   fragmento. Es parte de la base de confianza; un origen comprometido puede
   robar la capability aunque el relay nunca la reciba como URL.
3. **Canal remitente–relay.** Debe usar TLS en producción. El archivo conserva
   además cifrado de extremo a extremo.
4. **Relay y almacenamiento.** Se consideran honestos o maliciosos según la
   amenaza. Nunca se confían para confidencialidad o integridad; sí se depende de
   ellos para disponibilidad, aplicación del TTL y borrado.
5. **Canal usado para compartir el enlace.** Ve la capability completa. Si no es
   confidencial, cualquier observador de ese canal puede leer la cápsula.
6. **Dispositivo del destinatario.** Ve capability y plaintext. Después de la
   descarga queda fuera del control de CAPSULE.

La CLI reduce la dependencia de JavaScript servido dinámicamente, pero sigue
confiando en el binario, sus dependencias, el sistema operativo y su mecanismo
de distribución.

## 3. Activos

| Activo                               | Confidencialidad                             | Integridad                           | Disponibilidad/retención                 |
| ------------------------------------ | -------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| Contenido del archivo                | Alta                                         | Alta                                 | Hasta el TTL, sin garantía fuerte        |
| Nombre, MIME, nota y tamaño original | Nombre/MIME/nota: alta; tamaño: sólo parcial | Alta mediante manifiesto autenticado | Igual que la cápsula                     |
| `key` y `noncePrefix`                | Crítica                                      | Alta                                 | No recuperables                          |
| Capability URL y `readToken`         | Crítica                                      | Alta                                 | Válidos hasta borrar/vencer              |
| `writeToken`                         | Crítica durante la carga                     | Alta                                 | Puede desecharse al finalizar            |
| `deleteToken`                        | Crítica para el propietario                  | Alta                                 | No recuperable                           |
| Dirección IP y patrón de acceso      | Deseable, pero no protegido en v0.1          | No aplica                            | Puede aparecer en infraestructura y logs |
| Estado/TTL de la cápsula             | Parcialmente visible al relay                | Importante                           | Aplicado por el relay                    |
| Disponibilidad del relay             | No aplica                                    | Alta                                 | No garantizada en v0.1                   |

## 4. Información observable

### 4.1 El relay puede observar

- IP y características de conexión del cliente, salvo que éste use por su cuenta
  una red de privacidad compatible.
- Hora de creación, uploads, lecturas, borrado y vencimiento.
- Identificador, estado, número de chunks y bytes cifrados.
- TTL solicitado/efectivo y frecuencia de reintentos.
- Tokens bearer mientras procesa la solicitud. Debe conservar sólo sus hashes,
  pero un relay malicioso puede registrar los valores.
- Correlación probable entre una carga y lecturas posteriores por tamaño y tiempo.

### 4.2 El relay no debería poder observar

- Clave AES ni prefijo de nonce.
- Plaintext del archivo.
- Nombre, MIME, nota y tamaño exacto original dentro del manifiesto, aunque puede
  aproximar el tamaño por ciphertext y overhead.
- Canal o identidad humana mediante la cual se compartió el enlace.

### 4.3 Otros observadores

- ISP, DNS, CDN y observadores de red pueden ver IPs, dominios, tiempos y
  volúmenes. TLS oculta paths, headers y cuerpos frente a observadores pasivos,
  pero no frente al endpoint TLS.
- El servicio de mensajería usado para compartir el enlace puede ver la
  capability completa y descifrar la cápsula.
- Historial/sincronización del navegador, portapapeles, extensiones, capturas,
  antivirus y malware local pueden capturar el enlace o plaintext.

## 5. Adversarios contemplados

| ID  | Adversario                           | Capacidades                                                                             |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| A1  | Relay curioso                        | Lee almacenamiento, metadatos operativos y requests; sigue el protocolo                 |
| A2  | Relay malicioso o comprometido       | Omite, reemplaza, reordena o conserva datos; registra tokens; miente sobre TTL y estado |
| A3  | Observador pasivo local o de red     | Observa conexiones, tiempos, volumen, DNS/IP y potencialmente tráfico sin TLS           |
| A4  | Atacante activo de red               | Bloquea, redirige o altera tráfico; no rompe TLS correctamente validado                 |
| A5  | Lector no autorizado                 | Obtiene ID, adivina tokens, enumera endpoints o encuentra un enlace filtrado            |
| A6  | Destinatario malicioso               | Posee la capability legítima, descarga, copia y redistribuye plaintext                  |
| A7  | Origen web/supply chain comprometido | Modifica JavaScript o binarios para extraer fragmentos, archivos o claves               |
| A8  | Dispositivo comprometido             | Lee memoria, disco, teclado, pantalla, portapapeles y archivos                          |
| A9  | Atacante de disponibilidad/abuso     | Agota ancho de banda, disco, CPU, descriptores o IDs mediante cargas/lecturas           |
| A10 | Observador global                    | Correlaciona ingreso y egreso a escala de red mediante tiempo y tamaño                  |

No se asume que un atacante pueda romper AES-256-GCM, SHA-256, un CSPRNG sano o
TLS moderno correctamente implementado. Si esa hipótesis cambia, la versión de
protocolo debe revisarse.

## 6. Garantías de v0.1

Estas garantías son condicionales a clientes correctos, entropía segura y secreto
de la capability:

1. **Confidencialidad del contenido en el relay.** Ciphertext almacenado sin
   `key` no revela de forma práctica plaintext, nombre, MIME ni nota.
2. **Integridad y autenticidad criptográfica.** Alterar un bit de manifiesto,
   chunk o tag provoca fallo de AES-GCM.
3. **Posición autenticada.** El nonce y AAD dependientes del índice detectan
   reordenamiento o sustitución entre posiciones.
4. **Aislamiento entre cápsulas.** Claves y prefijos independientes evitan que
   comprometer una cápsula descifre las demás.
5. **Acceso por capacidad no enumerable.** Con IDs/tokens aleatorios y límites de
   tasa, adivinar una capacidad de 256 bits no es viable.
6. **Clave ausente de la API normal del relay.** El formato usa fragmento URL, que
   el navegador no envía en requests HTTP estándar.
7. **Temporalidad con relay conforme.** Un relay honesto niega lecturas después
   del TTL y elimina su copia primaria según la política documentada.
8. **Revocación operativa.** El propietario puede pedir eliminación anticipada
   mediante una capability diferente de la de lectura.

La autenticación del contenido significa “producido por alguien que tenía la
clave”, no identifica civilmente al remitente ni proporciona firma o no repudio.

## 7. No-garantías explícitas

CAPSULE v0.1 no garantiza:

- **Anonimato, unlinkability o protección de metadata de red.** No hay onion
  routing, mixnet, padding ni tráfico de cobertura.
- **Resistencia a correlación.** Un observador puede vincular una carga de tamaño
  X con una descarga similar poco después.
- **Disponibilidad o resistencia a censura.** El relay puede caer, bloquear un
  país, eliminar datos o ser bloqueado.
- **Borrado verificable.** TTL y DELETE no prueban que desaparecieron backups,
  snapshots, logs, ciphertext retenido o copias del destinatario.
- **Control posterior a la descarga.** No existe DRM; el destinatario puede
  guardar, fotografiar o redistribuir.
- **Seguridad del endpoint.** Malware, extensiones, navegador, sistema operativo,
  JavaScript malicioso o una supply chain comprometida pueden robar plaintext y
  secretos.
- **Secreto del canal de compartición.** El enlace es la credencial. Un preview
  bot, historial de chat o tercero que lo vea puede abrirlo.
- **Forward secrecy dentro de una cápsula.** Si la clave se filtra en el futuro,
  ciphertext grabado anteriormente puede descifrarse. La separación de claves
  sí limita el incidente a esa cápsula.
- **Negación plausible, firma, autoría o no repudio.** v1 no firma identidades.
- **Protección contra archivos maliciosos.** Cifrar y autenticar no vuelve seguro
  un ejecutable, documento activo o payload.
- **Recuperación.** Perder el enlace, la clave o `deleteToken` es irreversible.
- **Privacidad poscuántica integral.** v1 no formula esa promesa ni protege los
  endpoints y canales externos frente a ese adversario.
- **Cumplimiento legal automático.** El cifrado no sustituye políticas, contratos
  ni obligaciones aplicables al operador.

## 8. Análisis de amenazas y controles

| Amenaza                              | Control v0.1                                                                                | Riesgo residual                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Relay o ladrón de disco lee archivos | AES-256-GCM en cliente; clave fuera del relay                                               | Tamaño, tiempo y patrón siguen visibles; una capability filtrada descifra                |
| Relay altera o reordena ciphertext   | Tags GCM, nonce y AAD por índice; tamaño/recuento autenticados en manifiesto                | Puede omitir todo o negar servicio                                                       |
| Reutilización de nonce GCM           | CSPRNG; prefijo nuevo por cápsula; índice 0 exclusivo de manifiesto; no sobrescribir chunks | Un bug de cliente puede destruir la seguridad; requiere tests y revisión                 |
| Enumeración y fuerza bruta           | IDs ≥128 bits, tokens de 256 bits, errores uniformes y rate limiting                        | El relay conoce todos sus IDs; enlaces filtrados evitan la fuerza bruta                  |
| Intercepción de red                  | HTTPS obligatorio en producción más cifrado de contenido                                    | TLS no oculta IP/dominio/volumen; el endpoint TLS ve bearer tokens                       |
| Redirect roba bearer token           | Endpoints sin redirects; cliente debe rechazarlos                                           | Proxy/origen comprometido aún puede capturar requests                                    |
| Filtración por fragmento             | Fragmento no enviado por HTTP, CSP, sin terceros, `no-referrer`, limpiar barra              | Historial, clipboard, extensiones, preview bots y canal externo permanecen               |
| Código web malicioso                 | CSP, build fijado, dependencia mínima, auditoría futura; CLI como alternativa               | La web servida dinámicamente sigue siendo un punto de confianza fuerte                   |
| Token en logs                        | Redacción en aplicación, reverse proxy y errores; hashes en reposo                          | Un operador malicioso o configuración externa puede registrarlo                          |
| Path traversal/XSS por nombre o MIME | Metadatos autenticados pero tratados como no confiables; sanitizar nombre y forzar descarga | El usuario aún puede abrir un archivo peligroso localmente                               |
| Uso después del TTL                  | Validación antes de cada lectura y limpiador automático                                     | Reloj/relay malicioso, backups o descarga previa hacen imposible garantizar desaparición |
| Abuso de almacenamiento              | Tamaño/TTL máximos, reserva, cuotas, rate limiting y limpieza de incompletas                | Botnets y DDoS distribuido pueden superar una instancia única                            |
| Correlación de remitente y receptor  | Ningún control fuerte en v0.1; sólo puede usarse Tor/VPN externamente                       | Alto; es una no-garantía deliberada                                                      |
| Relay indisponible o censurado       | Errores claros y descarga por chunks                                                        | No hay replicación, P2P ni multi-relay en v0.1                                           |

## 9. Requisitos operativos de seguridad

Un despliegue de producción conforme debe:

- terminar TLS con configuración moderna y deshabilitar HTTP público;
- redactar `Authorization`, fragmentos y query strings en app, proxy, WAF,
  observabilidad y reportes de errores;
- no desplegar analytics ni scripts de terceros en la aplicación que procesa
  capabilities;
- enviar `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, CSP
  restrictiva y headers anti-sniffing apropiados;
- limitar tamaño de request antes de bufferizar, así como tasa, conexiones,
  reservas incompletas, bytes por cápsula y TTL;
- ejecutar el relay con usuario sin privilegios y acceso sólo a su directorio;
- separar backups de configuración de los datos efímeros y documentar si existen;
- sincronizar el reloj y monitorear fallos del proceso de expiración;
- evitar que métricas incluyan IDs completos o cardinalidad por capability;
- rotar credenciales de infraestructura sin pretender rotar las capabilities de
  usuario ya emitidas;
- disponer de un mecanismo administrativo para retirar ciphertext abusivo sin
  descifrarlo.

## 10. Abuso y contenido ilícito

El cifrado impide moderación basada en contenido dentro del relay. Esto protege
privacidad legítima y también puede ser abusado. v0.1 adopta controles sobre el
comportamiento observable, no inspección de plaintext:

- TTL y tamaño máximo pequeños;
- rate limiting y cuotas por origen, con política documentada;
- limpieza de reservas incompletas;
- canal de reporte que acepte `capsuleId` sin solicitar públicamente la clave;
- facultad del operador de retirar una cápsula identificada;
- retención mínima de logs, con excepción explícita y proporcional ante abuso;
- términos claros sin afirmar que la criptografía evita responsabilidad.

Bloquear por IP puede afectar a NAT, proxies y redes de privacidad. Cada control
antiabuso debe evaluar falsos positivos y no debe convertirse silenciosamente en
un mecanismo de tracking persistente.

## 11. Validación antes de publicar

### 11.1 Pruebas automáticas mínimas

- Round-trip cruzado entre web/SDK/CLI para límites de chunk.
- Alteración de ciphertext, tag, AAD e índice.
- Clave, prefijo y token incorrectos.
- Duplicación de índice con bytes distintos.
- Reserva incompleta y finalización prematura.
- TTL, carrera entre lectura y vencimiento, DELETE repetido.
- Igualdad externa de errores para ID inexistente, token inválido y vencida.
- Límites de cuerpo antes de asignar memoria significativa.
- Comprobación de que logs, URLs y fixtures no contienen secretos.
- Redirección autenticada rechazada.

### 11.2 Revisión humana mínima

- Flujo exacto de entropía y unicidad de nonce.
- Uso de Web Crypto y longitudes de tag.
- Configuración CORS/CSP/headers y ausencia de terceros.
- Sanitización de nombre, MIME y mensajes de error.
- Manejo de archivos, permisos, enlaces simbólicos y operaciones atómicas del
  almacenamiento del relay.
- Dependencias, lockfile, SBOM y alertas de vulnerabilidad.

### 11.3 Condición para cambiar las afirmaciones

No se debe describir CAPSULE como “anónimo”, “imposible de rastrear”,
“autodestructivo” o “sin confianza” hasta que una versión futura defina un
adversario concreto, implemente los controles necesarios y supere revisión
externa. Añadir P2P o varios relays por sí solo tampoco crea anonimato.

## 12. Cambios introducidos en v0.2

v0.2 agrega tres capacidades que modifican el modelo: anonimización parcial,
cápsulas sin vencimiento y una red abierta de relays. Ninguna convierte a
CAPSULE en una red anónima.

### 12.1 Anonimización: qué cubre y qué no

| Mecanismo                         | Qué deja de ver un observador                         | Qué sigue viendo                                              |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| Limpieza de metadatos del archivo | EXIF/GPS/serie de cámara, XMP, chunks de texto en PNG | El contenido del archivo para quien lo recibe; marcas de agua |
| Nombre y mime neutros             | El nombre real dentro del manifiesto cifrado          | Nada nuevo: el manifiesto ya iba cifrado                      |
| Relleno por clases de tamaño      | El tamaño exacto de la cápsula                        | La clase de tamaño y la cantidad de chunks                    |
| Jitter entre chunks               | El patrón exacto de subida                            | El inicio, el fin y el volumen total                          |
| SOCKS5/Tor en la CLI              | La IP del cliente, para el relay                      | La existencia de la conexión, para el proxy y el ISP local    |
| Relay sin IP (`CAPSULE_IP_BLIND`) | La IP en logs y en el estado de rate limiting         | La IP en el socket mientras dura la conexión, y en el proxy   |

Límites que deben decirse en voz alta:

- La limpieza de metadatos sólo entiende JPEG, PNG y WebP. Para PDF, Office,
  HEIC o video el archivo se envía **sin cambios** y el SDK lo reporta como no
  soportado. No debe presentarse como “limpio”.
- El relleno protege el tamaño, no el momento ni la frecuencia. Un observador
  que ve “una cápsula de clase 8 MiB a las 03:14” sigue teniendo un evento.
- `CAPSULE_IP_BLIND` reduce retención, no observación. El sistema operativo, el
  balanceador y el proveedor de red siguen viendo la conexión.
- Tor en la CLI protege frente al relay, no frente a un adversario que observe
  ambos extremos.
- La aplicación web no enruta por Tor. Decir lo contrario sería falso: el
  navegador usa la red del usuario.

### 12.2 Cápsulas sin vencimiento

El TTL era el principal control de retención. Al desactivarlo, cambian dos
cosas:

- **Exposición sostenida.** Un enlace filtrado ya no deja de funcionar solo.
  Quien tenga el enlace lee hasta que alguien use la `deleteToken`.
- **Pérdida irreversible de control.** Si se pierde la capability de retiro, no
  hay forma de borrar la cápsula: no hay cuentas ni soporte que pueda hacerlo.

Controles vigentes:

- Está desactivado por defecto. El operador debe habilitarlo con
  `CAPSULE_ALLOW_PERSISTENT_CAPSULES=true`.
- `CAPSULE_MAX_PERSISTENT_BYTES` acota cuánto puede ocupar el almacenamiento sin
  vencimiento; el relay responde `507 insufficient_storage` al llegar al tope.
- La limpieza periódica nunca toca una cápsula sin vencimiento.
- La interfaz lo dice explícitamente antes de crear la cápsula, y el relay lo
  publica en `/v1/config` para que el cliente no lo descubra al fallar.

Un relay que promete “para siempre” está prometiendo algo que no controla:
puede apagarse, perder el disco o ser incautado. La documentación y la UI dicen
“hasta que la borres”, no “permanente”.

### 12.3 Red abierta de relays

Que cualquiera pueda levantar un relay elimina un punto único de censura y
agrega superficie:

| Riesgo nuevo                                    | Control aplicado                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Un peer inventa relays que no existen           | Toda dirección aprendida se prueba contra `GET /v1/info` y sólo se guarda si la identidad coincide      |
| Un atacante suplanta la identidad de un relay   | `relayId` es el digest de la clave pública; el anuncio va firmado con Ed25519 y con ventana ±5 min      |
| Envenenamiento del directorio (Sybil)           | Límite `CAPSULE_MAX_PEERS`, expulsión tras fallos repetidos, y ninguna decisión automática de confianza |
| SSRF desde el propio relay al probar peers      | Se rechazan loopback, enlaces locales, rangos privados y CGNAT salvo `CAPSULE_ALLOW_PRIVATE_PEERS`      |
| Réplica que amplía la superficie de observación | El espejo es explícito y opcional; cada copia adicional es un operador más que ve tamaño y horario      |
| Un relay retiene una copia tras el borrado      | El borrado es best-effort y se reporta relay por relay; nunca se afirma que la copia desapareció        |

Lo que la red **no** resuelve: correlación entre relays, diversidad
jurisdiccional real, ni la reputación de un operador. Un directorio grande no es
evidencia de independencia. Elegir un espejo sigue siendo confiar en un tercero
con el tamaño y el horario de la transferencia.

## 13. Cambios introducidos en v1.0

v1.0 congela el protocolo y agrega tres capacidades sobre v0.2: reparto por
erasure coding, recuperación opcional de capabilities, y un endurecimiento de
la red que salió de una revisión de seguridad del propio código.

### 13.1 Reparto `k de n`: qué cambia en el modelo

Con réplica completa, **cada** relay tiene la cápsula entera: quien logre
comprometer o presionar a uno solo tiene todo el ciphertext, y sólo le falta la
llave del enlace. Con reparto `k de n`, un relay tiene un shard que por sí solo
no permite reconstruir un byte, y hacen falta `k` operadores distintos.

| Situación                           | Réplica completa           | Reparto `k de n`               |
| ----------------------------------- | -------------------------- | ------------------------------ |
| Un relay incautado                  | Tiene todo el ciphertext   | Tiene un shard inservible solo |
| `k - 1` relays coludidos            | Tienen todo                | No reconstruyen nada           |
| `n - k + 1` relays caídos           | Sirve cualquiera que quede | La cápsula no se puede leer    |
| Costo de almacenamiento             | `n` veces                  | `n/k` veces                    |
| Operadores que ven tamaño y horario | `n`                        | `n` (igual)                    |

Lo que **no** cambia: los `n` relays siguen viendo que hubo una transferencia,
cuándo y de qué clase de tamaño. Repartir protege el contenido frente a un
subconjunto de operadores, no protege la metadata frente a ninguno.

Un relay que entrega shards alterados no puede corromper la cápsula: la
reconstrucción produce ruido y el tag AES-GCM lo rechaza, y el lector prueba
otra combinación de `k` shards. Sí puede negar el servicio, que es la
contrapartida honesta de exigir `k` de `n`.

### 13.2 Recuperación: una puerta más, por elección

Proteger una capability con una frase de acceso, o repartirla en partes,
**agrega un camino al secreto**. Eso es deseable cuando la alternativa es
perder una cápsula sin vencimiento para siempre, y es un riesgo cuando la frase
es débil o las partes terminan todas en el mismo cajón.

- La frase se deriva con PBKDF2-HMAC-SHA-256 a 600 000 iteraciones. Es el único
  KDF de contraseñas disponible en Web Crypto en todas las plataformas donde
  corre CAPSULE. **Frente a un atacante con GPU es más débil que Argon2id**: una
  frase corta se rompe. El formato lleva un identificador de KDF para poder
  agregar una función memory-hard después sin romper lo ya guardado.
- Las partes Shamir no llevan ningún digest del secreto, precisamente para que
  tener una parte no permita verificar conjeturas offline. Menos de `k` partes
  no revelan nada, y eso es una propiedad de la construcción, no una suposición
  sobre el atacante.
- El relay no participa en ninguna de las dos formas y no se entera de que
  existen.

### 13.3 Hallazgos de la revisión de seguridad de v1.0

Se revisó el código nuevo con foco en criptografía, autorización, parsers
binarios y superficie de red. Se encontraron dos problemas explotables y tres
apuntes menores. Todos están corregidos; se documentan porque el hallazgo y la
corrección son parte del historial de seguridad.

**1. El filtro de direcciones del relay era esquivable (medio).** La lista
negra comparaba cadenas, así que `127.0.0.1` quedaba bloqueado pero
`[::ffff:7f00:1]` —la misma dirección escrita en IPv6— pasaba y alcanzaba el
mismo socket. Verificado en ejecución. Como anunciarse no requiere permiso,
cualquiera podía hacer que un relay público consultara servicios internos de su
operador, y que republicara esa dirección a toda la red.

_Corrección:_ se reemplazó por un analizador de direcciones que normaliza toda
forma equivalente (IPv4 en decimal, IPv6 comprimido, IPv4 embebida en IPv6,
NAT64) y bloquea los rangos privados, de loopback, link-local, CGNAT,
multicast, reservados y de documentación, más los nombres locales. El relay
además **resuelve** los nombres y rechaza los que apuntan a esas direcciones.

**2. El descubrimiento del cliente no tenía ese filtro, y la CSP lo permitía
(medio).** La lista de peers de un relay la escribe ese relay. Un relay hostil
podía devolver direcciones de loopback y el navegador de quien abriera la
aplicación las consultaba, convirtiéndolo en un escáner de puertos de su propia
máquina. La CSP de v0.2 había sido ampliada a `http://localhost:*` y
`http://127.0.0.1:*`, que es exactamente lo que hacía falta para lograrlo.

_Corrección:_ el SDK aplica el mismo filtro de direcciones a los peers
descubiertos y a la dirección que un relay declara para sí mismo; seguir
direcciones privadas es ahora una opción explícita (`allowPrivateRelays`) que
la aplicación sólo activa cuando su propio relay ya es local. La CSP de
producción volvió a `connect-src 'self' https:`; el servidor de desarrollo
agrega loopback y el build no.

**3. La firma del anuncio no cubría el nombre del relay (bajo).** Se resolvió
sacando el nombre del anuncio: el anuncio afirma sólo "soy `relayId` en `url`",
y todo lo demás se lee de esa dirección.

**4. Un anuncio válido no probaba el control de la dirección anunciada
(bajo).** Una firma prueba quién escribió el mensaje, no quién controla la
dirección que contiene, así que un directorio podía llenarse de direcciones
ajenas. Ahora el receptor consulta la dirección antes de creerle y sólo la
guarda si responde con la misma identidad.

**5. Reanudar con otro archivo del mismo tamaño podía reutilizar un nonce
(bajo en la revisión, corregido igual).** Con varios relays en distinto punto
de avance, dos textos claros distintos podían quedar cifrados bajo la misma
pareja `(clave, nonce)`, lo que rompe AES-GCM. Ahora el ticket de reanudación
lleva un compromiso con el contenido del archivo y se rechaza cualquier otro
antes de enviar un solo byte; además, un chunk se reenvía a **todos** los
relays en cuanto a alguno le falta, de modo que quien ya lo tenía verifica que
los bytes coinciden.

**Revisado y sin hallazgos:** la aritmética GF(256), Reed-Solomon y Shamir
(verificados exhaustivamente por ejecución), el espacio de nonces AES-GCM, el
ligado del AAD a la versión, los parámetros de PBKDF2, la validación de TLS a
través del proxy SOCKS5, la autorización y el manejo de rutas en el relay, los
siete parsers binarios (28 000 entradas de fuzzing sin excepciones ni cuelgues)
y la ausencia de secretos en logs.

### 13.4 Riesgos residuales conocidos

Se listan porque siguen ahí, no porque sean aceptables para siempre.

- **Reasignación de DNS.** El relay resuelve un nombre y verifica las
  direcciones antes de conectarse, pero la plataforma no permite fijar la
  conexión a la dirección verificada. Entre la comprobación y la petición, un
  nombre puede pasar a resolver a otra dirección. Cerrarlo requiere un
  conector propio; hasta entonces, un operador que aloje servicios internos
  sensibles debería aislar el relay en red.
- **PDF `/Info`.** Se blanquean los paquetes XMP sin mover un byte, pero el
  diccionario `/Info` puede vivir dentro de un flujo de objetos comprimido y no
  se toca. La interfaz lo dice explícitamente en vez de dar el archivo por
  limpio.
- **Formatos no soportados.** TIFF, HEIF exóticos y contenedores propietarios
  se envían sin cambios, y así se reporta.
- **La aplicación web no enruta por Tor.** Sólo la CLI puede. Decir lo
  contrario sería falso: el navegador usa la red de quien lo abre.
- **Horario y volumen.** Siguen siendo observables por cada relay involucrado.
  El relleno protege el tamaño; nada protege todavía el momento.
- **Diversidad de operadores.** El tope por operador aparente y la prueba de
  trabajo encarecen el Sybil, no lo impiden. Un directorio grande no es
  evidencia de independencia jurisdiccional ni operativa.

## 14. La red de mezcla (1.1)

CAPSULE tiene su propia red de mezcla. Esta sección dice qué cambia en el
modelo de amenazas; el diseño está en [MIXNET.md](./MIXNET.md).

### 14.1 Lo que cambia

Hasta 1.0, el relay que guardaba una cápsula veía la dirección de quien la
subía y de quien la bajaba. En la CLI se podía tapar con Tor. Ahora el tráfico
puede ir por una red de nodos que son los propios relays.

| Observador             | Sin la red                      | Con la red                                     |
| ---------------------- | ------------------------------- | ---------------------------------------------- |
| Relay que almacena     | IP del cliente, horario, tamaño | Sólo la operación y el nodo anterior           |
| Primer nodo del camino | —                               | IP del cliente, y nada más                     |
| Nodos intermedios      | —                               | Dos direcciones de nodos; ni origen ni destino |
| Proveedor del buzón    | —                               | Que una dirección consulta un buzón            |
| Proveedor de Internet  | Que hablás con un relay         | Que hablás con un relay                        |
| Observador global      | Todo lo anterior                | Análisis estadístico, mucho más caro           |

Lo que **no** cambia: quien tenga el enlace sigue pudiendo leer la cápsula, el
contenido sigue estando cifrado extremo a extremo con la llave del fragmento, y
el proveedor de Internet sigue viendo que hay una conexión.

### 14.2 Garantías nuevas, y de dónde salen

- **Ningún nodo intermedio sabe dónde está en el camino.** La cabecera mide
  siempre lo mismo y el bloque consumido se reemplaza por relleno
  pseudoaleatorio que el remitente calculó. Es una propiedad del formato.
- **Un paquete no se puede seguir de un enlace al siguiente.** El punto efímero
  se transforma en cada salto y el cuerpo se descifra una capa, así que los
  bytes cambian por completo. Verificado en las pruebas.
- **Un nodo no puede marcar un paquete.** El cuerpo es una permutación de
  bloque ancho: un bit cambiado aleatoriza los 64 KiB y el destino lo rechaza.
  Verificado en las pruebas.
- **Un paquete repetido se descarta.** Cada salto guarda una etiqueta derivada
  del secreto compartido durante una ventana. Sin esto, reenviar un paquete y
  mirar qué sale dos veces enlaza las dos puntas.
- **Un nodo no revela por qué descartó.** Toda respuesta es `202`.
- **No hay nodo de salida.** El destino es el relay que guarda la cápsula, así
  que ninguna parte ve la petición en claro sin ser además su destinatario.

### 14.3 Riesgos nuevos

**El proveedor del buzón sabe que existís.** Ve una dirección consultando un
buzón. No ve qué pediste ni a quién. Es inherente a un cliente que no puede
recibir conexiones. Mitigación: elegir el proveedor a conciencia, o poner Tor
por debajo con `--tor --mix`.

**El primer nodo ve tu dirección.** Como el guardián en Tor, y por la misma
razón. A diferencia de Tor, acá **no hay nodos guardián**: el primer salto se
elige de nuevo en cada petición, lo que reparte la exposición entre más nodos
pero también aumenta la probabilidad de tocar uno hostil alguna vez. Es un
compromiso conocido y está sin resolver; Tor eligió al revés después de años de
análisis, y esa decisión merece revisarse acá.

**Retener paquetes es un arma.** Un nodo puede demorar u omitir el reenvío. El
cliente lo ve como un tiempo de espera agotado, no como un ataque, y reintenta
por otro camino. Un nodo que lo hace selectivamente puede sesgar qué caminos
funcionan.

**El tráfico de cobertura cuesta.** Un bucle es un paquete de 65 920 bytes por
cada salto que atraviesa. Un operador que lo apague ahorra tráfico y deja su
enlace legible; un operador que lo suba paga ancho de banda por todos.

**Un ataque n−1 sigue abierto.** Un adversario que controle los nodos vecinos y
pueda suprimir el tráfico ajeno aísla un paquete y lo sigue. Los bucles y la
elección aleatoria de camino lo encarecen; no lo resuelven, y es un problema
abierto en la literatura, no una omisión de esta implementación.

**El conjunto de anonimato es el que sea.** Repetido acá porque es el riesgo
que domina a todos los demás. Con pocos nodos y un solo operador, todo lo
anterior es maquinaria alrededor de una sola parte que ve las dos puntas. La
CLI lo dice antes de cada envío y el documento de diseño lo dice primero.

### 14.4 Fuera del modelo

- **Observador global pasivo.** Con suficiente tráfico y tiempo, el análisis
  estadístico de flujos funciona contra cualquier red de este tamaño.
- **Confirmación con tráfico activo.** Un adversario que pueda inyectar y
  bloquear a voluntad en varios enlaces.
- **Compromiso del extremo.** Si el dispositivo está comprometido, nada de esto
  importa.
- **Censura.** No hay puentes ni transportes conectables. Bloquear los relays
  conocidos bloquea la red.

### 14.5 Lo que hace falta antes de llamarla anónima

En orden, y ninguno es opcional:

1. **Operadores independientes**, en jurisdicciones distintas, que no se
   conozcan entre sí. Sin esto lo demás es decoración.
2. **Usuarios suficientes** para que un mensaje se esconda entre otros. Un
   conjunto de anonimato chico es un conjunto de sospechosos chico.
3. **Mediciones publicadas**: latencia real, volumen de cobertura, tamaño
   efectivo del conjunto, resistencia medida a correlación.
4. **Revisión criptográfica externa** de esta composición, no sólo de las
   construcciones que la componen.
5. **Una decisión fundada sobre nodos guardián**, con el análisis que la
   respalde.

Hasta que esos cinco puntos existan, la palabra correcta es "red de mezcla", no
"red anónima", y la interfaz lo dice así.

## 15. Sitios `.capsule` (1.2)

El diseño está en [SITES.md](./SITES.md). Acá va sólo lo que cambia en el modelo
de amenazas.

### 15.1 Lo primero: qué es público

Un sitio `.capsule` **es contenido público**. La capacidad de lectura está
adentro del registro y el registro se reparte entre relays a propósito. No es
una filtración: es lo que significa publicar. Un relay, un visitante y
cualquiera que pase por ahí pueden leer el sitio.

Lo que la capa de nombres protege no es la confidencialidad sino la
**integridad y la continuidad**: que las páginas sean las que su autor firmó y
que nadie pueda entregar una versión anterior sin que se note.

### 15.2 Garantías nuevas, y de dónde salen

- **Sólo el titular de la clave puede publicar bajo un nombre.** El nombre _es_
  la clave pública, así que verificar no requiere confiar en quien entregó el
  registro. Propiedad del formato.
- **Un relay no puede modificar un registro.** Cambiar cualquier campo invalida
  la firma. Verificado en las pruebas.
- **Un relay no puede revertir un sitio a una versión anterior sin que se note.**
  El cliente guarda la secuencia más alta que aceptó por nombre y rechaza una
  menor. Verificado en las pruebas.
- **Callar tiene poco valor.** El cliente pregunta a varios relays y se queda con
  la secuencia más alta que verifique; suprimir una actualización requiere que
  callen todos los relays a los que el visitante pregunta.
- **El relay no sabe qué guarda.** El sitio va como cápsula cifrada, con relleno
  a clase de tamaño y nombre de archivo neutro. El registro no dice qué hay
  adentro más allá de un título opcional que el autor eligió.
- **El relay no sabe qué página se leyó.** El paquete se baja entero. No hay
  petición por archivo que revelar.
- **La página no puede contactar a nadie.** Con los scripts apagados —el modo
  por omisión— la política del documento y el aislamiento del marco impiden toda
  petición de red. Verificado en las pruebas.

### 15.3 Riesgos nuevos

**La clave del sitio es un punto único de falla.** Quien la copie puede
reemplazar las páginas; quien la pierda pierde el nombre. No hay recuperación
porque no hay a quién pedírsela. Es la misma propiedad que una dirección onion y
tiene el mismo costo.

**El relay ve quién pregunta.** La extensión consulta relays directamente desde
el navegador, así que un relay ve una dirección IP preguntando por un nombre —y,
si es el que guarda la cápsula, bajándola. Es la carencia más importante de esta
versión. La CLI puede ir por la red de mezcla; la extensión todavía no.

**El registro es un anuncio.** Publicar un sitio le dice a los relays que ese
nombre existe y cuándo se actualizó. El patrón de actualizaciones de un nombre
es observable por cualquiera que consulte `GET /v1/sites`.

**Los scripts, si se habilitan, pueden sacar al visitante.** Un script puede
navegar el marco a una dirección externa, lo que revelaría la IP del visitante a
esa dirección. La política sigue bloqueando `fetch`, imágenes y fuentes
externas, pero una navegación no es una petición sujeta a CSP y no hay directiva
que la cubra desde que `navigate-to` quedó fuera del estándar. Por eso están
apagados por omisión y la advertencia es visible al encenderlos.

**Un sitio que vence desaparece.** Si la cápsula vence o los relays que la
guardan se van, el nombre resuelve a un registro que apunta a nada. El registro
sigue verificando; el contenido no está.

**El reconstructor de páginas es un límite de seguridad escrito a mano.** Está
probado con los casos que se nos ocurrieron —`<base>`, `meta refresh`, `srcset`,
`url()` anidado, rutas que suben de directorio— y no está auditado. Un error ahí
es un escape del aislamiento.

### 15.4 Fuera del modelo

- **Disponibilidad.** Nadie garantiza que un sitio siga arriba.
- **Censura de un nombre.** Los relays pueden negarse a guardar un registro. Con
  suficientes relays cooperando, un nombre deja de resolver.
- **Reputación.** Un nombre no dice nada sobre quién está atrás. Verificar que
  una página no cambió no es verificar que sea de quien creés.
- **Anonimato del publicador.** El relay ve quién sube, salvo `--mix` o `--tor`.
