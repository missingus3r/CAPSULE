# CAPSULE — Especificación de requisitos v0.1

**Estado:** borrador implementable  
**Versión del documento:** 0.1  
**Versión objetivo del producto:** 0.1  
**Fecha:** 2026-08-29

## 1. Propósito

CAPSULE permite enviar un archivo mediante un enlace temporal sin entregar el
contenido en claro al relay que lo almacena. El cliente cifra el archivo y sus
metadatos antes de subirlos. Quien posee el enlace obtiene la capacidad de leer
y descifrar la cápsula; quien conserva la capacidad de propietario puede pedir
su eliminación anticipada.

La versión 0.1 ofrece **privacidad del contenido, integridad criptográfica y
temporalidad de acceso**. No ofrece anonimato fuerte, imposibilidad de análisis
de tráfico, borrado verificable de todas las copias ni protección frente a un
dispositivo comprometido o un destinatario malicioso.

Los términos normativos **DEBE**, **NO DEBE**, **DEBERÍA** y **PUEDE** se
interpretan como requisitos obligatorios, prohibiciones, recomendaciones y
opciones, respectivamente.

## 2. Alcance de v0.1

### 2.1 Incluido

- Aplicación web para crear y abrir cápsulas.
- Cliente de línea de comandos para automatización y diagnóstico.
- Relay HTTP que almacena exclusivamente metadatos y chunks cifrados.
- Biblioteca de protocolo compartida y SDK de cliente.
- Cifrado local por chunks mediante AES-256-GCM.
- Enlaces de lectura basados en capacidades, sin cuentas.
- TTL configurable, con 24 horas por defecto y 7 días como máximo inicial.
- Eliminación anticipada mediante una capacidad distinta de la de lectura.
- Límites operativos configurables; valores iniciales de 100 MiB por cápsula y
  1 MiB de texto plano por chunk.

### 2.2 Fuera de alcance

- Cuentas, perfiles, directorios de usuarios o recuperación por correo.
- Edición de una cápsula ya finalizada.
- Chat, sincronización de carpetas o colaboración en tiempo real.
- Transferencia P2P, Bluetooth, Wi-Fi Direct o funcionamiento sin Internet.
- Replicación automática entre relays o tolerancia a la caída del relay.
- Mix routing, onion routing, ocultamiento de IP o resistencia a un observador
  global.
- Ocultamiento del tamaño, cantidad de chunks, horario o patrón de acceso.
- Recuperación de una clave perdida, custodia de claves o escrow.
- Garantía de borrado en backups, logs, cachés o copias del destinatario.
- Escaneo de malware dentro del relay: el relay no posee la clave.

## 3. Actores

| Actor                     | Objetivo                                         | Capacidades y límites                                                                                                        |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Remitente                 | Crear una cápsula y compartirla                  | Controla el archivo original, el TTL y el enlace; debe conservar por separado la capacidad de eliminación si desea revocarla |
| Destinatario              | Abrir y guardar una cápsula                      | Puede hacerlo mientras el relay la conserve y el enlace sea válido; puede copiar el contenido indefinidamente                |
| Operador del relay        | Prestar almacenamiento temporal                  | Configura límites y retención; observa metadatos de red y almacenamiento, pero no debe recibir la clave de contenido         |
| Integrador/usuario de CLI | Automatizar envíos y descargas                   | Usa el mismo protocolo y no obtiene privilegios adicionales                                                                  |
| Adversario                | Leer, alterar, enumerar o impedir transferencias | Se detalla en [THREAT_MODEL.md](./THREAT_MODEL.md); no se asume que el relay sea honesto para confidencialidad o integridad  |

## 4. Supuestos y dependencias

- El remitente y el destinatario ejecutan un cliente CAPSULE no comprometido.
- La entropía del sistema y `crypto.getRandomValues`/Web Crypto son confiables.
- En producción, la aplicación y el relay se sirven mediante HTTPS válido. Se
  permite HTTP únicamente en `localhost` para desarrollo.
- El canal externo usado para compartir el enlace es responsabilidad del
  usuario. Si ese canal filtra el enlace, también filtra la capacidad de lectura.
- El reloj del relay es autoritativo para aplicar el TTL. El tiempo incluido en
  los metadatos cifrados es informativo y se valida contra el del relay.
- El relay puede negar servicio, descartar o retener ciphertext. La criptografía
  impide que fabrique contenido válido, pero no puede obligarlo a servir o borrar.

## 5. Historias de usuario

| ID    | Historia                                                                                                                                                              | Prioridad   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| HU-01 | Como remitente, quiero elegir un archivo y un vencimiento para obtener un enlace que pueda compartir sin que el relay lea el contenido.                               | Obligatoria |
| HU-02 | Como remitente, quiero ver el progreso y recibir un error claro si la carga no puede completarse.                                                                     | Obligatoria |
| HU-03 | Como remitente, quiero conservar una capacidad privada para eliminar la cápsula antes de su vencimiento.                                                              | Obligatoria |
| HU-04 | Como destinatario, quiero abrir el enlace, verificar criptográficamente la cápsula y descargar el archivo con su nombre y tipo originales.                            | Obligatoria |
| HU-05 | Como destinatario, quiero que una clave incorrecta, un chunk alterado o una descarga incompleta falle de forma cerrada, sin producir un archivo aparentemente válido. | Obligatoria |
| HU-06 | Como usuario técnico, quiero crear, descargar y eliminar cápsulas desde CLI con resultados aptos para scripting.                                                      | Obligatoria |
| HU-07 | Como operador, quiero limitar tamaño, chunk, TTL y origen CORS sin recompilar.                                                                                        | Obligatoria |
| HU-08 | Como operador, quiero eliminar automáticamente cápsulas vencidas y evitar que las capacidades aparezcan en logs.                                                      | Obligatoria |
| HU-09 | Como usuario, quiero una explicación honesta y visible de que el enlace es un secreto y de que CAPSULE v0.1 no oculta mi IP.                                          | Obligatoria |

## 6. Requisitos funcionales

### 6.1 Creación y cifrado

- **RF-001 — Selección.** El cliente DEBE aceptar un archivo, un TTL permitido y
  una nota opcional. DEBE rechazar localmente archivos o TTL que excedan los
  límites anunciados por el relay.
- **RF-002 — Secretos.** Para cada cápsula, el cliente DEBE generar con un CSPRNG
  una clave AES de 32 bytes y un prefijo de nonce de 8 bytes. No DEBE reutilizar
  la combinación clave/prefijo en otra cápsula.
- **RF-003 — Chunks.** El cliente DEBE dividir el archivo en chunks independientes
  y cifrarlos según [PROTOCOL.md](./PROTOCOL.md). Los chunks de archivo se
  numeran desde 1. El
  índice 0 queda reservado para los metadatos cifrados.
- **RF-004 — Metadatos.** Nombre, MIME, tamaño, cantidad de chunks, timestamps y
  nota opcional DEBEN cifrarse. El relay NO DEBE requerir esos valores en claro,
  salvo la información operativa mínima: cantidad de chunks, bytes cifrados y
  vencimiento solicitado.
- **RF-005 — Reserva.** El relay DEBE crear una reserva no finalizada y devolver
  identificador de cápsula, capacidades aleatorias de escritura (`write`),
  lectura y borrado, y vencimiento efectivo.
- **RF-006 — Carga.** El cliente DEBE subir el bloque de metadatos cifrado y cada
  chunk cifrado. Un reintento byte a byte del mismo ciphertext DEBE ser
  idempotente. El cliente NO DEBE volver a cifrar contenido distinto con el mismo
  índice, clave y prefijo de nonce.
- **RF-007 — Finalización.** El relay DEBE publicar la cápsula para lectura sólo
  después de recibir los metadatos y todos los chunks declarados. Una cápsula no
  finalizada DEBE expirar y limpiarse automáticamente en un plazo operativo
  configurable y corto.
- **RF-008 — Enlace.** El cliente DEBE producir un enlace con la capacidad de
  lectura y los secretos criptográficos exclusivamente en el fragmento URL
  (`#capsule=...`). La capacidad de escritura y la de borrado NO DEBEN formar
  parte del enlace compartido.
- **RF-009 — Propietario.** El cliente DEBE mostrar o guardar separadamente la
  capacidad de borrado y advertir que no puede recuperarse si se pierde.

### 6.2 Lectura y descarga

- **RF-010 — Parseo seguro.** El cliente DEBE validar versión, tipos, longitudes y
  URL del relay antes de iniciar una descarga. Valores inválidos DEBEN fallar sin
  realizar solicitudes adicionales.
- **RF-011 — Autorización.** El relay DEBE exigir la capacidad de lectura para el
  manifiesto y cada objeto. Una capacidad inválida, una cápsula inexistente y una
  cápsula vencida DEBERÍAN ser indistinguibles en la respuesta pública.
- **RF-012 — Descifrado.** El cliente DEBE autenticar y descifrar primero los
  metadatos y luego cada chunk con su índice. No DEBE entregar un resultado como
  exitoso si falta un chunk, sobra uno, falla un tag o el tamaño reconstruido no
  coincide.
- **RF-013 — Archivo.** Después de validar la cápsula completa, el cliente DEBE
  permitir guardar el archivo con un nombre sanitizado. El MIME se trata como
  dato no confiable y no DEBE provocar ejecución automática.
- **RF-014 — Errores.** La UI y la CLI DEBEN distinguir al menos: enlace inválido,
  no disponible/vencida, autenticación criptográfica fallida, límite excedido,
  error de red y error interno. No DEBEN revelar secretos en mensajes.

### 6.3 Vencimiento y eliminación

- **RF-015 — TTL.** El relay DEBE fijar `expiresAt` usando su reloj, dentro del
  máximo configurado. Pasado ese instante, DEBE negar nuevas lecturas.
- **RF-016 — Limpieza.** Un proceso automático DEBE eliminar del almacenamiento
  primario las cápsulas vencidas. El objetivo de v0.1 es iniciar la limpieza en
  no más de 60 segundos desde el vencimiento en una instancia saludable.
- **RF-017 — Eliminación anticipada.** La capacidad de borrado DEBE permitir
  eliminar una cápsula antes del TTL. La operación DEBE ser idempotente.
- **RF-018 — Respuestas uniformes.** El relay NO DEBE confirmar públicamente si
  un identificador existe cuando falta una capacidad válida.

### 6.4 Operación y compatibilidad

- **RF-019 — Configuración.** Host, puerto, directorio de almacenamiento,
  origen CORS, tamaño máximo, tamaño máximo de chunk, TTL por defecto y
  TTL máximo DEBEN poder configurarse por entorno.
- **RF-020 — Descubrimiento de límites.** El relay DEBE exponer un endpoint de
  configuración pública sin secretos para que los clientes conozcan versión y
  límites antes de reservar.
- **RF-021 — Salud.** El relay DEBE exponer una comprobación de liveness que no
  enumere cápsulas ni revele rutas internas.
- **RF-022 — CLI.** La CLI DEBE admitir operaciones `create`, `download` y
  `delete`; un error DEBE producir código de salida distinto de cero. Un modo
  estructurado DEBERÍA emitir JSON sin mezclarlo con mensajes humanos.
- **RF-023 — Interoperabilidad.** Web, CLI y SDK DEBEN producir cápsulas v1
  mutuamente compatibles a partir de la misma biblioteca de protocolo.

## 7. Requisitos no funcionales

### 7.1 Seguridad y privacidad

- **RNF-SEC-01.** Todo contenido y metadato privado DEBE cifrarse en el cliente con
  AES-256-GCM y tag de 128 bits.
- **RNF-SEC-02.** Claves, prefijos de nonce y capacidades NO DEBEN aparecer en
  query strings, rutas, telemetría, logs, nombres de archivo del servidor ni
  mensajes de error.
- **RNF-SEC-03.** El relay DEBE almacenar hashes resistentes a preimagen de los
  tokens, no sus valores en claro.
- **RNF-SEC-04.** Las comparaciones de tokens DEBEN evitar diferencias de tiempo
  observables una vez normalizadas sus longitudes.
- **RNF-SEC-05.** La aplicación web NO DEBE cargar analytics, publicidad ni
  scripts de terceros en la vista que procesa el fragmento. DEBE usar una CSP
  restrictiva y `Referrer-Policy: no-referrer` en producción.
- **RNF-SEC-06.** El relay DEBE aplicar límites de cuerpo, cantidad de reservas,
  tasa y almacenamiento antes de comprometer recursos significativos.
- **RNF-SEC-07.** Ninguna salida de UI DEBE denominar v0.1 “anónima”. Debe indicar
  que el relay y la red pueden observar IP, horario, tamaño y patrón de acceso.

### 7.2 Rendimiento y recursos

- **RNF-PERF-01.** El cifrado, carga, descarga y descifrado DEBERÍAN procesar
  chunks secuencialmente o con concurrencia acotada, sin exigir conservar dos
  copias completas adicionales del archivo en memoria.
- **RNF-PERF-02.** Cada chunk cifrado agrega exactamente 16 bytes de tag GCM; los
  clientes DEBEN considerar ese overhead al validar límites del relay.
- **RNF-PERF-03.** Una instalación de referencia DEBE completar el round-trip de
  un archivo de 10 MiB en localhost sin exceder los límites configurados y sin
  corrupción, independientemente del tiempo absoluto del hardware.

### 7.3 Disponibilidad y consistencia

- **RNF-AVL-01.** Una cápsula finalizada es inmutable. No existen escrituras
  parciales visibles ni actualización in-place.
- **RNF-AVL-02.** La caída del proceso no DEBE convertir una reserva incompleta en
  cápsula finalizada ni omitir su limpieza posterior.
- **RNF-AVL-03.** v0.1 no promete alta disponibilidad. La UI DEBE comunicar que
  el enlace depende del relay elegido.

### 7.4 Portabilidad, accesibilidad y mantenibilidad

- **RNF-PORT-01.** El relay y la CLI DEBEN ejecutar en Node.js 22 o superior en
  Windows, macOS y Linux cuando el sistema de archivos lo permita.
- **RNF-PORT-02.** La web DEBE funcionar en versiones actuales de navegadores con
  Web Crypto; si la API requerida no está disponible, DEBE fallar con una
  explicación antes de leer el archivo.
- **RNF-A11Y-01.** Los flujos principales DEBEN ser utilizables con teclado,
  etiquetas accesibles, foco visible y mensajes que no dependan sólo del color.
- **RNF-MNT-01.** La lógica criptográfica DEBE residir en la biblioteca de
  protocolo, no duplicarse en cada cliente.
- **RNF-MNT-02.** Cambiar el formato criptográfico o semántica de endpoints
  requiere una nueva versión; un cliente DEBE rechazar versiones desconocidas.

## 8. Criterios de aceptación de v0.1

| ID    | Dado / cuando / entonces                                                                                                                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA-01 | Dado un archivo de 0 bytes, uno de 1 byte, uno exactamente del tamaño de chunk y uno de tamaño de chunk + 1, cuando se crean con web o CLI y se descargan con el otro cliente, entonces los bytes y metadatos reconstruidos coinciden.               |
| CA-02 | Dado un archivo de 10 MiB, cuando se completa el flujo en localhost, entonces el hash SHA-256 antes y después es idéntico.                                                                                                                           |
| CA-03 | Dado un chunk, cuando se altera un bit del ciphertext, del tag o se solicita descifrarlo con otro índice, entonces el cliente falla por autenticación y no publica el archivo.                                                                       |
| CA-04 | Dado un enlace compartido, cuando se inspeccionan las solicitudes HTTP del navegador, entonces `key`, `noncePrefix` y `readToken` no aparecen en ruta, query, headers no destinados a autorización ni cuerpo; el fragmento no llega al servidor web. |
| CA-05 | Dado el almacenamiento del relay, cuando se inspecciona una cápsula, entonces no contiene nombre, MIME, nota, clave ni tokens en claro.                                                                                                              |
| CA-06 | Dada una reserva incompleta, cuando se intenta leer, entonces responde como no disponible; después de su plazo de reserva se elimina.                                                                                                                |
| CA-07 | Dada una cápsula finalizada, cuando vence, entonces toda lectura posterior se rechaza y la limpieza del almacenamiento primario comienza dentro de 60 segundos en una instancia saludable.                                                           |
| CA-08 | Dada una cápsula vigente, cuando se elimina con la capacidad de propietario, entonces una lectura posterior falla; repetir el borrado no expone si existía.                                                                                          |
| CA-09 | Dados un ID válido y un token inválido, cuando se consulta cualquier objeto, entonces la respuesta pública no revela más información que para un ID inexistente.                                                                                     |
| CA-10 | Dado un archivo o TTL por encima de los límites anunciados, cuando el usuario intenta crearlo, entonces el cliente lo rechaza antes de cargar contenido y el relay también lo rechaza si el cliente omite la validación.                             |
| CA-11 | Dado un enlace malformado o de versión desconocida, cuando se abre, entonces no se inicia ninguna descarga y se muestra un error seguro.                                                                                                             |
| CA-12 | Dado cualquier flujo exitoso o fallido de la suite, cuando se revisan logs del relay y CLI, entonces no aparecen claves ni capacidades completas.                                                                                                    |
| CA-13 | Dada la documentación y la UI, cuando se busca la descripción de privacidad, entonces se declara explícitamente que v0.1 no proporciona anonimato fuerte ni borrado verificable de copias.                                                           |

## 9. Definición de terminado

v0.1 se considera terminada cuando:

1. Todos los requisitos obligatorios y CA-01 a CA-13 tienen pruebas automáticas
   o evidencia reproducible.
2. Web, CLI y SDK interoperan contra una instancia limpia del relay.
3. Los flujos negativos de autenticación, TTL, borrado y límites están cubiertos.
4. [PROTOCOL.md](./PROTOCOL.md) describe exactamente los bytes y endpoints
   desplegados.
5. No quedan secretos en fixtures, logs de prueba ni artefactos de build.
6. Las limitaciones de [THREAT_MODEL.md](./THREAT_MODEL.md) son visibles para el
   usuario antes de compartir un enlace.
