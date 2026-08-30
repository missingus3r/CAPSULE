# CAPSULE frente al mapa de redes

**Estado:** verificación honesta, sin auditoría externa
**Fecha:** 2026-08-30

Este documento revisa, una por una, la limitación importante de cada red del
mapa y dice si CAPSULE la resuelve, la resuelve en parte o no la resuelve. Da
diez «sí», cinco «parcial» y cuatro «no». Los cuatro «no» son los que importan
y están explicados al final: un sistema que dice cubrir todo no cubre nada.

Antes de la tabla, dos advertencias que valen para todo lo que sigue:

1. **CAPSULE es nuevo y su red es chica.** Varias de las ventajas de abajo son
   propiedades del diseño, no de la red desplegada. Un diseño resistente a la
   correlación con cuatro nodos y un solo operador no es resistente a nada. Ver
   [MIXNET.md](./MIXNET.md) §1.
2. **Nada de esto está auditado externamente.** Las afirmaciones se apoyan en
   el código, las pruebas y el modelo de amenazas de este repositorio.

## La tabla

| Red                     | Su limitación importante                                                        | CAPSULE   | Por qué                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tor**                 | Lenta, sólo TCP, vulnerable a correlación si alguien observa las dos puntas     | Parcial   | Los retardos por salto y el tráfico de cobertura atacan la correlación, que es lo que Tor decidió no hacer. A cambio no somos un transporte TCP general: movemos archivos y sitios, no conexiones. |
| **I2P**                 | Instalación y experiencia técnica; no está orientada a la internet convencional | Sí        | Un sitio `.capsule` se abre en Chrome con una extensión y un `npm install`. No hay que aprender un modelo de red para leer una página.                                                             |
| **Nym**                 | Más protección significa mucha más latencia; demasiado lenta para el día a día  | Parcial   | El costo es el mismo, pero se elige por operación: `--mix` cuando importa, directo cuando no. La CLI dice cuánto anonimato hay antes de cada envío en vez de venderlo entero.                      |
| **Lokinet**             | Conjunto de anonimato menor que Tor y dependencia de una red con token          | Parcial   | No hay token, ni staking, ni economía que capturar: un relay es un proceso Node. El conjunto de anonimato de CAPSULE hoy es **peor** que el de Lokinet.                                            |
| **Hyphanet (Freenet)**  | El contenido es difícil de retirar; rendimiento y usabilidad envejecidos        | Sí        | Toda cápsula tiene un token de borrado y, si se quiere, un vencimiento. Publicar no es una decisión irreversible.                                                                                  |
| **GNUnet**              | Orientada a la investigación                                                    | Sí        | Este repositorio existe para que alguien mande un archivo hoy. Las primitivas son conocidas; lo nuevo es la composición y el producto.                                                             |
| **SimpleX**             | Depende de relays; no hay red física fuera de línea                             | No        | CAPSULE también depende de relays. Sin relays no hay red.                                                                                                                                          |
| **Session**             | Identificador persistente, red y token propios, complejidad                     | Sí        | No hay cuentas ni identificadores. Un remitente no existe para el relay más allá del rato que dura una subida. No hay token.                                                                       |
| **Briar**               | En mantenimiento; batería, ejecución en segundo plano, usabilidad               | No        | No hacemos malla ni transporte fuera de línea. Briar resuelve un problema que CAPSULE no toca.                                                                                                     |
| **Bitchat**             | El protocolo todavía no logra presencia no enlazable                            | No aplica | No hay presencia: nadie está "en línea" en CAPSULE.                                                                                                                                                |
| **Nostr**               | Seudónima, no anónima; spam; gestión de claves; borrado inconsistente           | Sí        | No hay identidad que seguir en una cápsula. El borrado es una capacidad, no un pedido a los servidores. Un sitio sí tiene clave, y esa clave es el nombre.                                         |
| **Matrix**              | Los servidores replican cuentas, metadatos e historial; no es anónima           | Sí        | Un relay guarda bytes cifrados, un vencimiento y nada más. Sin cuentas, sin historial, sin lista de contactos.                                                                                     |
| **Waku**                | Equilibrio difícil entre privacidad, ancho de banda, disponibilidad y latencia  | Parcial   | El mismo equilibrio, pero explícito: relleno a clase de tamaño, `k` de `n`, retardos, cobertura. Cada perilla está documentada con su costo.                                                       |
| **IPFS**                | No es privada: PeerIDs, CIDs, proveedores y consultas pueden ser públicos       | Sí        | No hay CID global ni tabla de proveedores. Un identificador de cápsula sin su token no sirve para nada, y el contenido nunca sale en claro del navegador.                                          |
| **Hypercore / Pear**    | Los pares ven IPs; alguien tiene que quedarse en línea                          | Sí        | Los relays guardan el contenido, así que el autor puede apagar la máquina. Con `--mix`, el relay que guarda no ve la dirección del cliente.                                                        |
| **Yggdrasil**           | Cifrado no es anonimato                                                         | Sí        | Estamos de acuerdo, y por eso el cifrado y el anonimato son capas separadas y la interfaz dice cuál está activa.                                                                                   |
| **Reticulum**           | Ecosistema chico, puesta en marcha complicada                                   | Parcial   | La puesta en marcha es más simple (`npm install`, un comando). El ecosistema es más chico todavía.                                                                                                 |
| **Meshtastic**          | Necesita hardware y tiene poco ancho de banda                                   | No        | No hay radio. Meshtastic funciona donde no hay internet; CAPSULE no.                                                                                                                               |
| **Veilid**              | Es un framework: hace falta una aplicación                                      | Sí        | CAPSULE es la aplicación: CLI, web y extensión, no una biblioteca esperando que alguien construya algo encima.                                                                                     |
| **Iroh / libp2p**       | Son kits de herramientas, no redes con usuarios finales                         | Sí        | Mismo argumento. Hay comandos que una persona ejecuta.                                                                                                                                             |
| **Bitcoin / Lightning** | Trazabilidad y complejidad de custodia                                          | No aplica | No hay pagos ni economía en CAPSULE.                                                                                                                                                               |

**Cuenta:** 10 «sí», 5 «parcial», 4 «no», 2 «no aplica».

## Lo que CAPSULE no cubre

Estas cuatro carencias son las que importan, y ninguna se resuelve escribiendo
más código de este mismo tipo.

**No hay transporte fuera de línea.** Briar, Meshtastic, Bitchat y Reticulum
funcionan por Bluetooth, LoRa o radio cuando internet no existe o está cortada.
CAPSULE necesita IP. En un apagón de red, CAPSULE no sirve y ellos sí.

**No hay resistencia a la censura.** No hay puentes, ni transportes conectables,
ni ofuscación del protocolo. Bloquear los relays conocidos bloquea la red. Tor
dedicó una década a este problema y CAPSULE todavía no lo tocó.

**No es un transporte de propósito general.** Tor, I2P, Lokinet y Yggdrasil
llevan cualquier conexión TCP o IP. CAPSULE lleva archivos y sitios estáticos.
Eso es una elección — el formato de cápsula depende de que el contenido se
conozca entero de antemano — pero es una elección que cierra puertas.

**El conjunto de anonimato es el más chico de toda la tabla.** Tor tiene
millones de usuarios; CAPSULE tiene los relays que alguien haya levantado hoy.
Todas las propiedades de la red de mezcla son ciertas y ninguna importa mucho
mientras la red sea de este tamaño. Es el riesgo que domina a los demás y está
primero en [MIXNET.md](./MIXNET.md) por esa razón.

## Lo que CAPSULE agrega y no estaba en la tabla

Tres cosas que no son «resolver la limitación de otro» sino trabajo que ningún
sistema de la lista hace tal cual:

**Un sitio que no puede pedir nada a la red.** La extensión reconstruye cada
página con todo lo que necesita adentro y la entrega a un marco con
`connect-src 'none'` y sin `allow-scripts`. Un sitio `.capsule` no puede cargar
una fuente, un píxel ni un script de otro origen, ni siquiera queriendo. Tor
Browser protege al visitante del sitio con heurísticas y configuración; acá es
una propiedad del formato.

**Reparto `k` de `n` entre relays.** Con codificación de borrado, cada relay
guarda un fragmento y hacen falta `k` para reconstruir. Ningún relay tiene lo
suficiente para tener algo, ni siquiera cifrado.

**Relleno a clase de tamaño por omisión.** El relay ve un bucket, no un tamaño.
Un sitio de 1,4 KiB y uno de 60 KiB ocupan exactamente lo mismo.

## Cómo verificar cada afirmación

| Afirmación                                        | Dónde se prueba                                              |
| ------------------------------------------------- | ------------------------------------------------------------ |
| El relay no puede leer una cápsula                | `tests/integration.test.ts`, `docs/PROTOCOL.md` §4           |
| El relay que guarda no ve al cliente con `--mix`  | `tests/mixnet.test.ts` («0 peticiones directas»)             |
| Un relay no puede falsificar ni revertir un sitio | `tests/sites.test.ts`, `packages/protocol/test/site.test.ts` |
| Una página `.capsule` no llega a la red           | `tests/viewer.test.ts`, `apps/extension/test/render.test.ts` |
| El relleno oculta el tamaño                       | `tests/sites.test.ts` («padded capsule»)                     |
| `k` de `n` deja a un relay sin nada útil          | `tests/network.test.ts`                                      |
