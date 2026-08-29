# CAPSULE v0.1 — Modelo de amenazas

**Estado:** borrador de seguridad  
**Fecha:** 2026-08-29  
**Alcance:** protocolo v1, aplicación web, CLI y relay de referencia

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
