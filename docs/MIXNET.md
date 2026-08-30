# La red de mezcla de CAPSULE

**Estado:** implementada y funcionando; sin auditoría externa
**Fecha:** 2026-08-30
**Alcance:** relays como nodos de mezcla, CLI como cliente

## 1. Lo primero, porque cambia todo lo demás

**El anonimato de una red viene, sobre todo, del tamaño del conjunto en el que
te escondés.** Si en una red hay diez personas, un observador que sabe que el
mensaje salió de esa red ya redujo el problema a diez. Ninguna criptografía
arregla eso: no es una propiedad del código, es una propiedad de cuánta gente
lo usa y de cuántos operadores distintos sostienen los nodos.

Tor tiene millones de usuarios y miles de relays repartidos en jurisdicciones
distintas. Esta red empieza con vos. Por eso la CLI te dice, cada vez que la
usás, cuántos nodos y cuántos operadores aparentes hay:

```
Mix network: 4 mixes across 1 apparent operators, 3 hops each way.
Enough to keep the storing relay from seeing you, and not enough for anything more.
```

Esa frase no es humildad decorativa. Con cuatro nodos de un solo operador, lo
que ganás es concreto y acotado: **el relay que guarda tu cápsula no ve tu
dirección**. Nada más. Si el operador de esos cuatro nodos es la misma persona,
esa persona ve las dos puntas.

Todo lo que sigue describe cómo está construido lo que sí hace.

## 2. Por qué no es simplemente Tor

Tor está diseñado para navegar: una persona esperando una página web no tolera
un segundo de más. Esa restricción define su arquitectura y también su
debilidad más conocida y menos reparable: **como los paquetes salen tan rápido
como entran, quien observe las dos puntas puede emparejarlos por tiempo**. Es
correlación de tráfico de punta a punta, y para un sistema de baja latencia no
tiene solución.

Transferir un archivo no tiene esa restricción. Un archivo puede tardar
minutos. Eso habilita defensas que Tor no puede usar:

|                                        | Tor                                     | Esta red                                                |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| Latencia                               | Milisegundos                            | Segundos a minutos, por diseño                          |
| Mezcla real (retardos, reordenamiento) | No puede                                | Sí: cada salto retiene el paquete un tiempo aleatorio   |
| Tamaño de paquete                      | Celdas de 514 B sobre un flujo continuo | Un tamaño único, siempre, extremo a extremo             |
| Tráfico de cobertura                   | Limitado                                | Cada nodo emite bucles indistinguibles del tráfico real |
| Nodos de salida                        | Ve el tráfico en claro si no hay TLS    | **No existen**: el destino es el propio relay           |
| Directorio                             | Autoridades de directorio firmantes     | Gossip entre pares, sin autoridad                       |
| Conjunto de anonimato                  | Millones                                | El que tengas                                           |
| Resistencia a censura                  | Puentes, transportes conectables        | Nada                                                    |
| Análisis independiente                 | 20 años                                 | Ninguno                                                 |

Las dos últimas filas son la razón por la que **esto no reemplaza a Tor**, y por
la que la CLI permite usar los dos a la vez:

```bash
capsule --tor --mix send archivo.pdf --relay https://relay.example
```

Tor oculta de tu proveedor de Internet que estás usando CAPSULE. La red de
mezcla oculta de los relays quién sos. Son problemas distintos y se resuelven
en capas distintas.

## 3. Cómo funciona

### 3.1 El paquete

Cada paquete es un paquete Sphinx (Danezis y Goldberg, 2009) de **65 920 bytes,
siempre**, lleve lo que lleve. Un chunk de cápsula, una operación de control o
un bucle de relleno son del mismo tamaño y del mismo aspecto.

El formato exacto está en [PROTOCOL.md](./PROTOCOL.md) §16. Tres propiedades
importan:

- **La cabecera se enmascara en cada salto.** Cada nodo deriva un secreto con
  su clave privada y el punto efímero del paquete, pela un bloque de ruteo y
  transforma el punto para el siguiente. El paquete que sale de un nodo no se
  parece en nada al que entró.
- **El relleno tapa lo que se peló.** El bloque consumido se reemplaza por
  bytes pseudoaleatorios que el remitente calculó de antemano, así que la
  cabecera no encoge y un nodo no puede deducir cuán lejos está del origen ni
  cuánto falta.
- **El cuerpo es un cifrado de bloque ancho.** Cambiar un bit en cualquier
  parte aleatoriza los 64 KiB enteros. Eso anula el ataque de marcado: un nodo
  no puede marcar un paquete para reconocerlo después, porque la marca destruye
  el contenido y el destino lo rechaza.

### 3.2 El camino

Un envío usa **dos caminos distintos**, elegidos de nuevo en cada petición:

```
cliente → mezcla A → mezcla B → relay que guarda la cápsula
                                        ↓ (bloque de respuesta)
buzón del proveedor ← mezcla D ← mezcla C
```

El relay de destino **es el último salto**, no hay nodo de salida. Esto es una
diferencia real con el ruteo cebolla para la web: no existe una parte que vea
la petición en claro sin ser, además, la parte a la que iba dirigida. El relay
aprende qué operación de cápsula se pidió —que aprendería igual— y no aprende
de quién.

La respuesta viaja por un **bloque de respuesta de un solo uso** que el cliente
arma y le entrega al relay dentro del pedido. El relay puede contestar y no
puede saber a dónde va la respuesta: sólo sabe a qué primer salto entregarla.

### 3.3 Los retardos

Cada salto retiene el paquete un tiempo tomado de una distribución exponencial
que elige el remitente. Eso es lo que rompe la correlación temporal: la cantidad
de paquetes que un nodo está reteniendo en un momento dado no depende de cuándo
llegaron, así que emparejar entradas con salidas por tiempo deja de funcionar.

El costo es real y se paga en segundos:

| Media por salto   | 3 saltos, ida y vuelta | 200 KB medidos |
| ----------------- | ---------------------- | -------------- |
| 0 ms              | inmediato              | ~1 s           |
| 200 ms            | ~1,2 s por petición    | ~10 s          |
| 2 s (por omisión) | ~12 s por petición     | ~90 s          |
| 30 s              | ~3 min por petición    | ~25 min        |

Un nodo acota lo que un remitente puede pedirle (`CAPSULE_MIX_MAX_DELAY_MS`),
para que nadie inmovilice su cola.

### 3.4 El buzón

Un cliente detrás de NAT no puede recibir conexiones, así que el último salto
de la respuesta la deja en un **buzón** en un relay que el cliente elige como
proveedor, y el cliente lo consulta.

Esto tiene una consecuencia que hay que decir claramente: **tu proveedor sabe
que existís**. Ve una dirección consultando un buzón. No ve qué pediste ni a
quién, pero sabe que alguien está usando la red desde ahí. Es inherente a un
cliente que no se puede llamar, no es un descuido. Elegí un proveedor con el
que estés cómodo, o poné Tor por debajo.

### 3.5 El tráfico de cobertura

Cada nodo se envía paquetes a sí mismo por caminos aleatorios, a intervalos.
Terminan en un salto que los descarta. Para cualquiera que mire un enlace entre
dos nodos, son idénticos a los paquetes reales.

Sin esto, un enlace que sólo transporta tráfico real le dice a un observador
exactamente cuándo hay tráfico real. Con esto, no le dice nada.

## 4. Cómo usarla

### 4.1 Como cliente

```bash
# Enviar por la red, con los valores por omisión (3 saltos, 2 s por salto)
capsule --mix send informe.pdf --relay https://relay.example

# Más lento y más difícil de correlacionar
capsule --mix --mix-hops 4 --mix-delay 15000 send informe.pdf

# Recibir por la red
capsule --mix receive "<enlace>"

# Borrar por la red
capsule --mix delete "<capability de retiro>"

# Elegir vos el proveedor del buzón
capsule --mix --mix-provider https://relay-de-confianza.example send informe.pdf

# Con Tor por debajo: el ISP no ve CAPSULE, los relays no te ven a vos
capsule --tor --mix send informe.pdf
```

La CLI imprime siempre el tamaño real de la red antes de enviar. Si dice
`single-node`, no estás obteniendo anonimato de ningún tipo y te lo dice así.

### 4.2 Como operador de un nodo

Un relay es un nodo de mezcla por omisión. No hay nada que instalar aparte del
relay:

```bash
CAPSULE_MIX_ENABLED=true              # por omisión
CAPSULE_MIX_COVER_INTERVAL_MS=30000   # cada cuánto emite un bucle
CAPSULE_MIX_MAX_DELAY_MS=300000       # tope al retardo que puede pedir un remitente
CAPSULE_MIX_MAX_QUEUED=2048           # paquetes que puede estar reteniendo
CAPSULE_MIX_MAILBOX_TTL_MS=3600000    # cuánto guarda una respuesta sin reclamar
CAPSULE_MIX_RATE_LIMIT_MAX=12000      # el tráfico de mezcla no es tráfico de API
```

Lo que tu nodo ve, y por lo tanto lo que asumís:

- la dirección del nodo anterior y la del siguiente, nada más;
- que un paquete pasó, no de quién venía ni a dónde iba;
- si sos el destino: la operación de cápsula, igual que en una petición directa;
- si sos proveedor: que alguien consulta un buzón desde una dirección.

Lo que tu nodo **no** puede ver: el contenido de un paquete que no es para él,
la longitud del camino, su posición en el camino, ni la relación entre el
paquete que entró y el que salió.

## 5. Lo que esta red no hace

Ordenado por lo que más importa.

**No te protege si el conjunto de anonimato es chico.** Ya está dicho arriba y
es lo primero por una razón. Cuatro nodos de un operador no son una red
anónima; son una forma de que un relay no vea tu IP.

**No resiste a un observador global pasivo.** Alguien que vea todos los enlaces
puede, con suficiente tráfico y tiempo, hacer análisis estadístico de flujos.
Los retardos y el relleno lo encarecen mucho; no lo impiden. Un adversario así
está fuera del modelo.

**No resiste un ataque n−1 activo.** Un adversario que controle los nodos
alrededor del tuyo y pueda bloquear todo el tráfico ajeno puede aislar tu
paquete. Los bucles de cobertura y la elección aleatoria de camino encarecen
esto; no está resuelto y es un problema abierto en la literatura.

**No resiste Sybil por sí sola.** La prueba de trabajo en los anuncios y el
tope por operador aparente encarecen inventar nodos. Un adversario con recursos
puede levantar muchos igual. Un directorio grande no es evidencia de
independencia: fijate quién opera los relays, no cuántos hay.

**No oculta que estás usando CAPSULE.** Tu proveedor de Internet ve conexiones
a un relay. Para eso está Tor debajo.

**No funciona en el navegador todavía.** La aplicación web sigue hablando
directo con su relay. La red necesita X25519 en Web Crypto, que recién está
llegando a los navegadores; hasta entonces, `--mix` es sólo de la CLI y decir
lo contrario sería falso.

**No tiene análisis formal ni auditoría.** Las construcciones son publicadas y
se usan como están especificadas, pero _esta_ composición no fue revisada por
nadie de afuera. Las pruebas verifican propiedades concretas —indistinguibilidad
entre saltos, resistencia al marcado, rechazo de repeticiones— y eso no es lo
mismo que una revisión criptográfica.

## 6. Cómo saber si te está sirviendo

Tres preguntas, en orden:

1. **¿De quién te querés esconder?** Si es del relay que guarda el archivo,
   esta red sirve hoy. Si es de tu proveedor de Internet, necesitás Tor. Si es
   de alguien que ve toda la red, esto no alcanza y probablemente nada de lo
   que puedas instalar alcance.
2. **¿Cuántos operadores distintos hay?** No cuántos nodos: cuántas personas u
   organizaciones distintas. Con uno solo, el camino es decorativo.
3. **¿Podés esperar?** Si necesitás que el archivo llegue ya, bajá los retardos
   y aceptá que la mezcla deja de mezclar. La honestidad acá es la misma:
   `--mix-delay 0` es un proxy de tres saltos, no una red de mezcla.

## 7. Referencias

- George Danezis, Ian Goldberg. _Sphinx: A Compact and Provably Secure Mix
  Format._ IEEE S&P, 2009.
- Ania Piotrowska et al. _The Loopix Anonymity System._ USENIX Security, 2017.
  De acá vienen los retardos exponenciales, los bucles de cobertura y el modelo
  de proveedor con buzón.
- Ross Anderson, Eli Biham. _Two Practical and Provably Secure Block Ciphers:
  BEAR and LION._ FSE, 1996. El cifrado de bloque ancho del cuerpo.
- Roger Dingledine, Nick Mathewson, Paul Syverson. _Tor: The Second-Generation
  Onion Router._ USENIX Security, 2004. Vale leerlo sobre todo por la sección
  de lo que Tor decide **no** resolver, que es de donde sale la mitad de este
  diseño.
