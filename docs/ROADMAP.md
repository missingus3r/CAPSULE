# CAPSULE — Roadmap de producto y protocolo

**Estado:** propuesta por hitos, sin fechas comprometidas  
**Fecha:** 2026-08-29

## 1. Norte del proyecto

CAPSULE busca convertir el envío privado y temporal de archivos en una acción
tan simple como compartir un enlace, sin exigir cuenta, wallet ni configuración
de red. La arquitectura evolucionará por capas: primero un transporte cifrado
que pueda ejecutarse y probarse; después disponibilidad distribuida, transporte
directo/local y, sólo tras investigación específica, protección fuerte de
metadata.

La versión 0.1 no debe venderse como una red anónima. Su valor concreto es:

- cifrado y autenticación en el cliente;
- relay incapaz de leer contenido o metadatos privados;
- enlace-capacidad temporal;
- eliminación anticipada y operación sin cuentas;
- implementación pequeña, auditable e interoperable.

## 2. Principios de evolución

1. **Producto utilizable antes que red vacía.** Cada capa debe resolver un flujo
   completo para personas reales.
2. **No inventar criptografía.** Usar primitivas y protocolos revisados; cualquier
   construcción nueva requiere revisión especializada.
3. **Afirmaciones proporcionales a evidencia.** P2P no implica anonimato,
   multi-relay no implica unlinkability y TTL no implica autodestrucción.
4. **Sin token obligatorio.** Ningún usuario debe poseer criptoactivos para enviar
   o recibir. Los incentivos de operadores se evalúan después de medir costos.
5. **Compatibilidad versionada.** Una cápsula publicada conserva semántica; no se
   cambia silenciosamente nonce, AAD, fragmento o API.
6. **Privacidad por omisión.** Minimizar logs, dependencias, terceros, identidad y
   retención antes de agregar mecanismos complejos.
7. **Hitos por puertas de calidad.** No avanzar sólo porque “funciona en demo”.

## 3. Vista general

| Hito    | Resultado principal                                                     | Mejora                                              | No resuelve todavía                                 |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| v0.1 ✅ | Web + CLI + relay temporal interoperables                               | Confidencialidad de contenido, integridad y TTL     | Anonimato, alta disponibilidad, recuperación        |
| v0.1.x  | Endurecimiento y operación reproducible                                 | Menos fallos, abuso y filtraciones operativas       | Dependencia de un relay                             |
| v0.2 ✅ | Red abierta de relays, anonimización parcial y cápsulas sin vencimiento | Disponibilidad, menos metadata en archivo/tamaño/IP | Correlación global, anonimato de red en la web      |
| v0.3    | Transferencia P2P con fallback                                          | Menos almacenamiento central, rapidez local         | P2P revela IP a pares/infraestructura               |
| v0.4    | Cercanía: BLE y Wi-Fi local                                             | Intercambio sin Internet                            | Anonimato de proximidad y background móvil perfecto |
| v0.5    | Recovery opt-in                                                         | Menos pérdidas irreversibles                        | Recuperación sin ampliar superficie de ataque       |
| v0.6    | Transporte mix experimental                                             | Protección de metadata bajo un adversario definido  | Baja latencia gratuita o anonimato con red pequeña  |
| v1.0    | Protocolo estable y auditado                                            | Confianza verificable para terceros                 | Seguridad absoluta                                  |

Las etiquetas futuras son direccionales: pueden reordenarse si las pruebas
demuestran otra dependencia. Cada hito mantiene compatibilidad de lectura o
publica una versión de protocolo nueva.

## 4. v0.1 — Mínimo ejecutable

### 4.1 Entregables

#### Protocolo y SDK

- Formato CAPSULE v1 conforme a [PROTOCOL.md](./PROTOCOL.md).
- Clave aleatoria AES-256-GCM y prefijo de nonce por cápsula.
- Manifiesto cifrado en índice criptográfico 0 y chunks independientes desde 1.
- Capability URL en fragmento y owner capability separada.
- SDK con create/upload/finalize/download/delete y progreso.
- Pruebas de interoperabilidad, límites y alteración.

#### Relay

- API HTTP v1 con reservas, carga por chunks, finalización atómica, lectura y
  borrado.
- Almacenamiento local con permisos mínimos y tokens hasheados.
- TTL aplicado antes de leer y limpieza periódica del almacenamiento primario.
- Configuración por entorno para CORS, tamaños, cantidad de chunks y TTL.
- Límites de request, rate limiting básico y limpieza de reservas incompletas.
- Health check que no revele información de cápsulas.

#### Aplicación web

- Flujo de crear: archivo, TTL, nota opcional, progreso, enlace y capability de
  propietario.
- Flujo de recibir: validar fragmento, descargar, autenticar, guardar.
- Interfaz por teclado, foco visible y errores accionables.
- Sin analytics, publicidad ni scripts de terceros en la vista sensible.
- Aviso visible: “quien posee el enlace puede leer; v0.1 no oculta tu IP”.

#### CLI

- `create`, `download` y `delete` con códigos de salida estables.
- Progreso en terminal y salida JSON opcional para scripting.
- Protección contra impresión accidental de secretos en modo verboso.

#### Operación y documentación

- Ejecución local reproducible y configuración de ejemplo.
- Guía de despliegue HTTPS y redacción de logs/proxy.
- SRS, protocolo, modelo de amenazas y este roadmap sincronizados.
- Política de vulnerabilidades y contacto de seguridad antes de una instancia
  pública.

### 4.2 Puerta de salida v0.1

v0.1 se publica sólo si:

- web, CLI y SDK intercambian archivos de 0 bytes, límites de chunk y al menos
  10 MiB con hash final idéntico;
- alterar manifest, chunk, tag o índice siempre falla de forma cerrada;
- no aparecen claves ni capabilities completas en logs, URLs del relay, errores
  o artefactos de prueba;
- una cápsula incompleta nunca es legible;
- expiración y DELETE poseen pruebas de carrera y limpieza;
- límites se aplican antes de consumir memoria/disco no acotados;
- los headers web, CORS, CSP y redirects han sido revisados;
- la UI no usa “anónimo”, “irrastreable” o “autodestructivo”.

## 5. v0.1.x — Endurecimiento

Objetivo: operar v0.1 de forma honesta antes de distribuir la arquitectura.

- Upload y descarga reanudables por inventario de chunks.
- Idempotencia definida para reintentos de chunk/finalize sin permitir
  sobrescritura con bytes distintos.
- Errores externos uniformes para reducir enumeración de IDs válidos.
- Cuotas por instancia y defensa contra reservas abandonadas.
- Métricas agregadas sin IDs, tokens, IP persistente ni alta cardinalidad.
- Backends de almacenamiento intercambiables y pruebas de crash/recuperación.
- Builds firmados de CLI, checksums y SBOM.
- Fuzzing del fragmento, manifiesto, JSON de relay y máquinas de estado.
- Compatibilidad cruzada en Windows, macOS, Linux y navegadores objetivo.
- Revisión de dependencias, superficie de supply chain y política de upgrades.

**Puerta:** una instancia de prueba debe funcionar durante un período sostenido,
con fallos de limpieza y uso de disco observables, sin conservar secretos en
telemetría.

## 6. v0.2 — Red abierta, anonimización parcial y permanencia opcional

**Estado: implementado.** Objetivo: que una caída o censura de un único relay no
destruya la cápsula, que el remitente pueda decidir cuánto revela, y que quien
quiera aportar infraestructura pueda hacerlo sin pedir permiso.

### 6.0 Entregado

**Red abierta de relays**

- Identidad Ed25519 por relay, generada al arrancar y persistida en
  `identity.json`; `relayId` = digest de la clave pública.
- `GET /v1/info`, `GET /v1/peers` y `POST /v1/peers/announce` con anuncios
  firmados y ventana temporal de ±5 minutos.
- Gossip periódico: saludo a peers configurados y conocidos, verificación de
  cada dirección aprendida contra `/v1/info`, expulsión tras fallos repetidos y
  tope `CAPSULE_MAX_PEERS`.
- Defensa SSRF: se rechazan loopback, enlaces locales, rangos privados y CGNAT
  salvo habilitación explícita para redes locales.
- Descubrimiento del lado cliente (`discoverRelays`, `selectRelays`), replicación
  opcional con `mirrors` en la capability, failover de lectura y borrado dirigido
  a todos los relays con reporte honesto de los que no confirmaron.

**Anonimización**

- Limpieza de metadatos del archivo antes de cifrar: JPEG (APPn y comentarios),
  PNG (`tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`) y WebP (`EXIF`/`XMP` más los flags de
  `VP8X`). Los formatos no soportados se reportan como tales.
- Nombre y mime neutros en el manifiesto.
- Relleno por clases de tamaño en pasos de un cuarto de octava con piso de
  64 KiB; todos los chunks quedan del mismo tamaño y el receptor descarga
  también el relleno.
- Jitter opcional entre chunks.
- Transporte SOCKS5/Tor en la CLI (`--proxy`, `--tor`), con resolución de nombre
  en el proxy y soporte de `.onion`.
- Relay sin retención de IP por defecto: sin direcciones en logs y rate limiting
  por hash con sal rotativa.

**Cápsulas sin vencimiento**

- `expiresAt: null` en el manifiesto v2 y `expiresInSeconds: null` en la API.
- Desactivado por defecto; el operador lo habilita y fija una cuota
  (`CAPSULE_MAX_PERSISTENT_BYTES`), con `507` al agotarla.
- La limpieza periódica nunca las toca; sólo la capability de retiro las borra.

### 6.1 Diseño pendiente de validar

- Capability con una lista autenticada de relays y tokens independientes.
- Política configurable:
  - **réplica completa** (implementada), simple pero costosa y correlacionable; o
  - **fragmentación/erasure coding `k-of-n`** (pendiente), más eficiente pero
    compleja.
- Descarga concurrente acotada, fallback y reconstrucción determinista.
- Consenso del cliente sobre TTL y estado; ningún relay amplía la retención
  prometida por los demás.
- Borrado best-effort dirigido a todos los relays, con reporte honesto de los que
  no confirmaron.
- Selección de operadores independientes y discovery firmado/versionado.

### 6.2 Riesgos nuevos

- Más relays observan horarios y tamaño, aumentando superficie de metadata.
- Un manifiesto con endpoints puede facilitar correlación.
- Operadores coludidos pueden retener fragmentos o bloquear reconstrucción.
- Erasure coding no es cifrado; los fragmentos permanecen dentro de la envoltura
  cifrada y no sustituyen AES-GCM.

**Afirmación permitida:** “tolera la indisponibilidad configurada de relays”.  
**Afirmación no permitida:** “es anónimo porque usa varios servidores”.

## 7. v0.3 — Transferencia P2P

Objetivo: permitir entrega directa cuando ambos dispositivos están disponibles,
manteniendo relay como fallback temporal.

- Negociación de sesión autenticada por una capability efímera.
- Transporte inicial candidato: WebRTC DataChannel o QUIC/libp2p, evaluado por
  portabilidad y superficie de identificación.
- ICE/STUN/TURN documentado; el usuario debe saber cuándo se revela IP al par o a
  infraestructura de señalización.
- Reanudación, control de congestión y verificación por chunk idénticos al flujo
  relay.
- Modo “directo sólo” y modo “relay fallback” claramente separados.
- Señalización mínima, sin directorio global de usuarios.

**Puerta:** interoperabilidad web/escritorio, comportamiento correcto bajo NAT y
cortes, y una pantalla que explique la exposición de IP antes de P2P.

## 8. v0.4 — BLE y Wi-Fi local

Objetivo: compartir cápsulas cercanas sin depender de Internet, especialmente en
móviles y redes inestables.

- Emparejamiento mediante QR/NFC/código corto autenticado.
- Descubrimiento BLE con identificadores efímeros y rotatorios.
- Transporte de datos por Wi-Fi local/Wi-Fi Direct cuando esté disponible; BLE
  se usa preferentemente para discovery y control, no para archivos grandes.
- Store-and-forward opcional con TTL local y límites de batería/espacio.
- Protección contra replay, dispositivo equivocado y downgrade de transporte.
- Estrategia explícita para restricciones de background en Android/iOS.

**No-garantías:** dispositivos cercanos pueden observar radio, presencia y
patrones; permisos y APIs del sistema operativo siguen siendo puntos de confianza.

## 9. v0.5 — Recovery opt-in

En v0.1 una clave perdida no puede recuperarse. Añadir recuperación siempre crea
otra ruta de acceso; por eso debe ser opcional, visible y separada del relay de
contenido.

Candidatos a prototipar:

- código de recuperación offline generado por el cliente;
- división de secreto `k-of-n` entre dispositivos o contactos elegidos;
- exportación cifrada con passphrase y KDF resistente a fuerza bruta, por ejemplo
  Argon2id con parámetros versionados;
- sincronización E2EE entre dispositivos ya autorizados;
- recuperación independiente de `deleteToken`, sin conceder lectura cuando no
  sea necesario.

No se incorporará escrow central por defecto ni “restablecer por email” que
entregue al servidor poder unilateral de descifrado.

**Puerta:** análisis formal de compromisos, UI que muestre quién puede recuperar,
pruebas de pérdida/rotación y revisión criptográfica del esquema seleccionado.

## 10. v0.6 — Mix routing experimental

Objetivo: investigar protección de metadata frente a un adversario definido, no
agregar una cadena cosmética de proxies.

Trabajo previo obligatorio:

1. Definir si se busca resistir al relay, ISP local, varios relays coludidos o un
   observador global pasivo.
2. Medir latencia, ancho de banda y batería aceptables en redes móviles de LATAM.
3. Seleccionar una construcción publicada —por ejemplo paquetes tipo Sphinx y
   una mixnet con batching/delays— en vez de diseñar criptografía ad hoc.
4. Diseñar directorio, rotación y admisión de nodos con defensa Sybil.
5. Evaluar padding por clases de tamaño, fragmentación, delays, reordenamiento y
   tráfico de cobertura.
6. Resolver bootstrap censurable y actualización de listas sin una autoridad
   única silenciosa.
7. Publicar simulaciones y un testnet antes de integrar el modo en la aplicación
   estable.

El cliente podrá elegir automáticamente una vía rápida para transferencias
ordinarias y una vía mix para alto riesgo, mostrando costo y garantía. Esta
selección no debe ocultar que un anonimato set pequeño ofrece poca protección.

**Puerta:** threat model específico, mediciones públicas, revisión académica o
externa, diversidad real de operadores y ausencia de afirmaciones de anonimato
basadas sólo en el número de saltos.

## 11. v1.0 — Estabilidad y auditoría externa

v1.0 no significa “sin bugs”; significa contrato estable, evidencia reproducible
y proceso de respuesta maduro.

### 11.1 Congelamiento previo

- Especificación byte a byte y API candidatas a estabilidad.
- Vectores de prueba oficiales y suite de conformidad para terceros.
- Política de compatibilidad, migración y fin de vida de versiones.
- Threat model actualizado para cada transporte habilitado por defecto.
- Reproducible builds, artefactos firmados, lockfiles y SBOM.

### 11.2 Revisiones independientes

- Auditoría criptográfica de protocolo, nonces, capacidades y recovery.
- Pentest de web, CLI, relay, CORS/CSP, storage y despliegue.
- Revisión de privacidad/metadata con captura de tráfico.
- Fuzzing y análisis estático/dinámico continuos.
- Revisión móvil para keystore, background, BLE/Wi-Fi y backups del SO.

Hallazgos críticos y altos deben corregirse y revalidarse antes de v1.0. El
informe público puede redactar detalles explotables durante el embargo, pero debe
publicar alcance, metodología, fecha y estado de remediación.

### 11.3 Operación posterior

- `security.txt`, canal coordinado de divulgación y SLA de triage.
- Historial público de incidentes y advisories por versión.
- Rotación/revocación de claves de distribución.
- Programa de bug bounty cuando exista capacidad de respuesta.
- Auditorías repetidas después de cambios de protocolo, no como sello permanente.

## 12. Métricas de decisión

Las métricas sirven para decidir arquitectura, no para afirmar seguridad por
popularidad.

| Área                 | Medida útil                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Fiabilidad           | Porcentaje de round-trips completos por tamaño/red y causa de fallo                                    |
| Integridad           | Cero archivos publicados después de una autenticación parcial/fallida                                  |
| Temporalidad         | Retraso p50/p95 entre vencimiento y eliminación primaria                                               |
| Privacidad operativa | Cero secretos en logs/telemetría; inventario de metadata retenida                                      |
| Recursos             | CPU, memoria, bytes extra y batería por MiB                                                            |
| Multi-relay          | Éxito de reconstrucción ante `n-k` fallos y costo de almacenamiento                                    |
| P2P/local            | Éxito bajo NAT, tiempo de conexión, exposición de IP y gasto de batería                                |
| Mix                  | Latencia, padding, cover traffic, tamaño efectivo del anonymity set y resistencia medida a correlación |
| Recovery             | Tasa de recuperación legítima, errores de usuario y nuevos caminos de compromiso                       |

No se usará “número de nodos” como sustituto de diversidad jurisdiccional,
independencia operativa, uso real o resistencia a Sybil.

## 13. Decisiones que requieren evidencia antes de adoptarse

- Blockchain o token de red.
- Algoritmo criptográfico propio.
- DHT público que exponga IDs o facilite enumeración.
- Preview server-side de archivos cifrados.
- CDN/analytics de terceros en la aplicación sensible.
- Identidad global, número de teléfono o grafo social centralizado.
- Recovery custodial habilitado por defecto.
- Etiquetas de marketing como “anónimo”, “sin rastros” o “autodestructivo”.

La ruta preferida es mantener un núcleo pequeño y componible: transporte cifrado
usable primero; distribución y cercanía después; anonimato sólo cuando su modelo,
costo y evidencia sean honestos.
