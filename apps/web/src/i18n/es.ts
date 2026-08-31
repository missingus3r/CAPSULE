import type { Messages } from "./en";

export const es: Messages = {
  "lang.name": "Español",
  "lang.switch": "Idioma",

  "app.title": "CAPSULE",
  "app.documentTitle": "CAPSULE",
  "app.tagline": "Sin cuenta. Cifrado en tu dispositivo.",

  "mode.choose": "Elegí una acción",
  "mode.send": "Enviar",
  "mode.receive": "Recibir",
  "mode.capsuleDetected": "Cápsula detectada",

  "send.title": "Enviar un archivo",
  "send.sub": "Se cifra acá, antes de subir nada.",

  "send.step1.label": "Qué enviar",
  "send.step1.hint": "Un archivo por cápsula",
  "drop.choose": "Elegí un archivo",
  "drop.dragging": "Soltalo acá",
  "drop.hint": "o arrastralo hasta acá",
  "drop.remove": "Quitar archivo",
  "drop.replace": "Cambiar",
  "send.step2.label": "Cuándo vence",
  "send.step3.label": "Nota",
  "send.step3.hint": "Opcional, se cifra con el archivo",
  "send.step3.placeholder": "Por ejemplo: las fotos del fin de semana",
  "send.step4.label": "Qué ocultar",
  "send.step4.hint": "Opcional, cada opción tiene un costo",

  "expiry.group": "Vencimiento de la cápsula",
  "expiry.hour": "Una hora",
  "expiry.hour.short": "1 h",
  "expiry.day": "Un día",
  "expiry.day.short": "24 h",
  "expiry.week": "Siete días",
  "expiry.week.short": "7 días",
  "expiry.never": "Sin vencimiento",
  "expiry.never.short": "Sin límite",
  "expiry.unavailable": "No disponible en este relay",
  "expiry.neverWarning":
    "El relay la guarda hasta que la borres con tu clave de retiro. Si perdés esa clave, queda ahí.",

  "anon.title": "Modo anónimo",
  "anon.detail":
    "Borra los metadatos del archivo, reemplaza el nombre, rellena el tamaño hasta una categoría y espacia la subida. Manda algo más de datos y tarda más.",

  "mix.title": "Ruteo por mixes",
  "mix.detail":
    "El pedido pasa por varios relays, cada uno lo retiene un momento al azar, y el relay que guarda la cápsula nunca sabe quién la pidió. Cuesta minutos en vez de segundos.",
  "mix.unavailable":
    "Ningún relay al alcance reenvía para otros. Levantá uno con CAPSULE_MIX_ENABLED=true.",
  "mix.verdict.single-node":
    "{mixes} mix de {operators} operador aparente, {hops} saltos por lado. Esto no es anonimato: con un solo nodo, ese nodo ve las dos puntas.",
  "mix.verdict.minimal":
    "{mixes} mixes de {operators} operadores aparentes, {hops} saltos por lado. Alcanza para que el relay que guarda no te vea, y para nada más.",
  "mix.verdict.small":
    "{mixes} mixes de {operators} operadores aparentes, {hops} saltos por lado. Un relay curioso aprende poco; alguien que pueda mirar varios aprende mucho.",
  "mix.verdict.usable":
    "{mixes} mixes de {operators} operadores aparentes, {hops} saltos por lado. Sigue lejos de una red grande: juzgala por quién opera estos relays, no por la cantidad.",

  "mirror.title": "Copias en otros relays",
  "mirror.detail":
    "Si un relay se cae o te bloquea, la cápsula sigue en otro. Cada copia es un operador más que ve el tamaño y el horario.",
  "mirror.count": "Cantidad de copias",
  "mirror.one": "Sólo uno",
  "mirror.split":
    "Repartir en vez de copiar: ningún relay guarda la cápsula entera y alcanza con dos para abrirla.",

  "progress.encrypting": "Cifrando en este dispositivo",
  "progress.uploading": "Subiendo datos cifrados",
  "progress.keepOpen": "No cierres esta ventana",

  "action.encrypt": "Cifrar y crear enlace",
  "action.preparing": "Preparando…",
  "action.originalUntouched":
    "El archivo original no se modifica y se queda acá.",
  "action.createAnother": "Crear otra cápsula",

  "sendError.title": "La cápsula no salió",

  "success.eyebrow": "La cápsula está lista",
  "success.title": "Compartí este enlace",

  "summary.storedOn": "Guardada en {count} relay: {hosts}",
  "summary.storedOn.plural": "Guardada en {count} relays: {hosts}",
  "summary.padded":
    "Tamaño rellenado con {bytes} para que el relay vea una categoría y no el tamaño real",
  "summary.scrubbed": "Metadatos borrados del archivo: {items}",
  "summary.notScrubbed":
    "Todavía no sabemos limpiar los metadatos de este formato: el archivo se envió tal cual",
  "summary.sharded":
    "Repartida {k} de {n}: ningún relay guarda lo suficiente para reconstruirla",
  "summary.remaining": "Quedó sin borrar: {item}",
  "summary.mirrorFailed": "No pudimos copiar a {host}",

  "share.label": "Enlace privado",
  "share.copy": "Copiar",
  "share.copied": "Copiado",
  "share.containsKey":
    "Este enlace lleva la llave. Mandáselo sólo a quien deba abrirlo.",
  "share.qrAlt": "Código QR del enlace privado",
  "share.qrScan": "Escaneá para abrir",

  "owner.title": "Guardá tu clave de retiro",
  "owner.detail":
    "No es el enlace que compartís. Borra la cápsula antes de que venza.",
  "owner.inputLabel": "Clave privada de retiro",
  "owner.warning":
    "No la compartas. CAPSULE no puede recuperarla por vos: si la vas a necesitar más adelante, protegela con una contraseña acá abajo.",

  "recovery.title": "Protegela con una contraseña",
  "recovery.detail":
    "Cifra la clave de retiro con una contraseña tuya, acá mismo. El resultado se puede anotar en cualquier lado: sin la contraseña no sirve. El relay no participa.",
  "recovery.placeholder": "Una contraseña que recuerdes",
  "recovery.protect": "Proteger",
  "recovery.protecting": "Protegiendo…",
  "recovery.label": "Clave de retiro protegida",

  "receive.title": "Recibir un archivo",
  "receive.sub": "Se abre acá, en tu dispositivo.",
  "receive.opening": "Abriendo la cápsula",
  "receive.openingDetail":
    "Los datos cifrados se descargan y se abren en este dispositivo.",
  "receive.downloading": "Descargando",
  "receive.verifying": "Verificando y descifrando",
  "receive.keyNotSent": "La llave nunca se manda al relay",
  "receive.readyEyebrow": "Abierta y verificada",
  "receive.readyTitle": "Lista para guardar",
  "receive.save": "Guardar {filename}",
  "receive.close": "Cerrar esta cápsula",
  "receive.emptyTitle": "Pegá un enlace o una dirección .capsule",
  "receive.errorTitle": "Revisemos el enlace",
  "receive.emptyDetail":
    "Abrir el enlace completo empieza la descarga sola. También podés pegarlo acá.",
  "receive.linkLabel": "Un enlace de cápsula, o una dirección .capsule",
  "receive.open": "Abrir",
  "receive.hashExplainer":
    "La parte que empieza con {fragment} lleva la llave. El navegador no la manda al relay cuando pide la página.",

  "metadata.note": "Nota",
  "metadata.expires": "Vence",
  "metadata.noExpiry": "Sin vencimiento",
  "metadata.noExpiryDetail": "Sólo tu clave de retiro la borra",

  "privacy.eyebrow": "Privacidad",
  "privacy.title": "El archivo sale cerrado. La llave viaja en el enlace.",
  "privacy.steps": "Cómo funciona",
  "privacy.step1.title": "Se cifra acá",
  "privacy.step1.detail": "En tu dispositivo, antes de subir.",
  "privacy.step2.title": "El relay guarda ruido",
  "privacy.step2.detail": "Recibe datos cifrados, no el archivo.",
  "privacy.step3.title": "El enlace lo abre",
  "privacy.step3.detail":
    "Cualquiera que lo tenga puede descargar y descifrar.",
  "privacy.details.summary": "Lo que todavía puede verse",
  "privacy.details.body":
    "El relay ve tu dirección IP en el momento de la conexión, aunque no la guarda. El modo anónimo borra los metadatos del archivo, oculta el nombre y rellena el tamaño hasta una categoría, pero no oculta tu dirección. El ruteo por mixes sí: el pedido viaja por varios relays y el que almacena la cápsula nunca sabe quién la pidió. Ninguno de los dos oculta que usás CAPSULE — para eso la CLI tiene {flag}. El cifrado no protege un dispositivo infectado ni evita que quien recibe guarde una copia.",

  "mode.publish": "Publicar",
  "mode.search": "Buscar",
  "mode.searchNeedsExtension":
    "Abre una dirección .capsule, que necesita la extensión CAPSULE instalada.",
  "mode.searchNeedsExtensionShort": "precisa la extensión",
  "publish.example": "Publicar un Hola mundo en su lugar",
  "publish.exampleNote":
    "El ejemplo se publica por una hora y no pide ser indexado, así que probar esto no deja nada atrás.",

  "publish.title": "Publicar un sitio",
  "publish.sub":
    "Una carpeta se convierte en una dirección que nadie emitió y que nadie te puede sacar.",
  "publish.step1.label": "El sitio",
  "publish.step1.hint":
    "Una carpeta con un index.html arriba de todo, o un zip de eso. Se empaqueta y se cifra acá, antes de que salga nada.",
  "publish.pickFolder": "Elegir una carpeta",
  "publish.pickZip": "Elegir un .zip",
  "publish.gathered": "{files} archivos, {size}, listos para empaquetar.",
  "publish.skipped": "{count} quedaron afuera por ser archivos del sistema.",
  "publish.step2.label": "El nombre",
  "publish.step2.hint":
    "Un nombre nuevo, o uno cuya clave ya tiene este navegador.",
  "publish.newName": "Un nombre nuevo",
  "publish.importKey": "Importar un archivo .capsulekey",
  "publish.step3.label": "Cómo se lista",
  "publish.step3.hint": "Todo opcional, y todo público una vez publicado.",
  "publish.titlePlaceholder": "Título, el que muestra la pestaña",
  "publish.listed": "Permitir que un índice liste este sitio",
  "publish.listedDetail":
    "Escribe el permiso dentro del propio sitio. Todavía no hay nada que indexe CAPSULE; cuando lo haya, tiene que tratar a un sitio que no dice nada como uno que dijo que no.",
  "publish.descriptionPlaceholder": "Una línea para un resultado de búsqueda",
  "publish.keyWarning":
    "El archivo de clave se descarga antes de publicar. Es el nombre: si lo perdés, nadie te lo puede devolver, nosotros tampoco.",
  "publish.keyReused":
    "Firmado con la clave que este navegador tiene para ese nombre. Puede firmar y no se puede leer de vuelta.",
  "publish.go": "Empaquetar, cifrar y publicar",
  "publish.working": "Publicando",
  "publish.workingDetail":
    "Empaquetando el bundle, cifrándolo, y firmando el record que lo apunta.",
  "publish.done": "Publicado",
  "publish.doneDetail": "Versión {version}, anunciada a {relays} relay(s).",
  "publish.address": "La dirección",
  "publish.copy": "Copiar",
  "publish.copied": "Copiado",
  "publish.keptKey":
    "Este navegador se quedó con un handle de firma para el nombre, así que la próxima versión es un click. El archivo de backup sigue siendo la única forma de publicar desde otro lado.",
  "publish.again": "Publicar otro",
  "publish.error.missingKey":
    "Este navegador ya no tiene esa clave. Importá el archivo .capsulekey.",

  "extension.eyebrow": "La otra mitad",
  "extension.title": "Leer un sitio .capsule",
  "extension.body":
    "Una dirección .capsule no resuelve en ningún DNS, así que el navegador necesita la extensión para abrirla. Reconstruye cada página antes de mostrarla, y el resultado no puede hacer una sola petición de red.",
  "extension.cta": "Cómo instalarla",
  "extension.note":
    "No hay listado en ninguna tienda. La compilás desde el repositorio y la cargás sin empaquetar, que es también por qué podés leer lo que estás corriendo.",

  "network.eyebrow": "La red",
  "network.title": "Cualquiera puede levantar un relay",
  "network.body":
    "No hay registro ni permiso: levantás uno, lo apuntás a un relay que ya conozcas y se presentan entre sí. Esta app usa {host} y descubre el resto desde ahí.",
  "network.empty": "Todavía no respondió ningún relay.",
  "network.persistent": "sin vencimiento",
  "network.temporary": "sólo temporal",
  "network.peers": "{count} vecinos",

  "footer.noTracking": "Sin analíticas ni rastreadores de terceros.",

  "size.unknown": "Tamaño desconocido",
  "mime.pdf": "Documento PDF",
  "mime.jpeg": "Imagen JPEG",
  "mime.png": "Imagen PNG",
  "mime.gif": "Imagen GIF",
  "mime.webp": "Imagen WebP",
  "mime.mp4": "Video MP4",
  "mime.zip": "Archivo ZIP",
  "mime.plain": "Texto plano",
  "mime.generic": "Archivo",

  "error.badLink":
    "Pegá un enlace CAPSULE completo. La parte que empieza con #capsule= lleva la llave.",
  "error.expired": "Esta cápsula venció y dejó de estar disponible.",
  "error.notFound":
    "No encontramos esta cápsula. Puede haber vencido o haber sido retirada.",
  "error.tooLarge":
    "El archivo o el vencimiento supera el límite de este relay.",
  "error.authentication":
    "El enlace está incompleto o el archivo no pudo verificarse. Pedí un enlace nuevo.",
  "error.network":
    "No pudimos llegar al relay. Si está corriendo, suele ser que rechaza el origen desde el que abriste esta página: localhost y 127.0.0.1 son orígenes distintos. Abrila en la dirección que el relay espera, o poné CAPSULE_CORS_ORIGIN.",
  "error.uploadGeneric":
    "No pudimos preparar la cápsula. El archivo sigue en tu dispositivo; podés intentar de nuevo.",
  "error.downloadGeneric":
    "No pudimos abrir la cápsula. Probá de nuevo o pedí un enlace nuevo.",
  "error.passphraseShort": "Usá al menos 8 caracteres.",
  "error.protectFailed": "No pudimos proteger la clave. Probá de nuevo.",
};
