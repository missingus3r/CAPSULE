import type { Messages } from "./en";

export const pt: Messages = {
  "lang.name": "Português",
  "lang.switch": "Idioma",

  "app.title": "CAPSULE",
  "app.documentTitle": "CAPSULE",
  "app.tagline": "Sem conta. Cifrado no seu dispositivo.",

  "mode.choose": "Escolha uma ação",
  "mode.send": "Enviar",
  "mode.receive": "Receber",
  "mode.capsuleDetected": "Cápsula detectada",

  "send.title": "Enviar um arquivo",
  "send.sub": "É cifrado aqui, antes de qualquer envio.",

  "send.step1.label": "O que enviar",
  "send.step1.hint": "Um arquivo por cápsula",
  "drop.choose": "Escolha um arquivo",
  "drop.dragging": "Solte aqui",
  "drop.hint": "ou arraste até aqui",
  "drop.remove": "Remover arquivo",
  "drop.replace": "Trocar",
  "send.step2.label": "Quando expira",
  "send.step3.label": "Nota",
  "send.step3.hint": "Opcional, cifrada junto com o arquivo",
  "send.step3.placeholder": "Por exemplo: as fotos do fim de semana",
  "send.step4.label": "O que esconder",
  "send.step4.hint": "Opcional, cada opção tem um custo",

  "expiry.group": "Expiração da cápsula",
  "expiry.hour": "Uma hora",
  "expiry.hour.short": "1 h",
  "expiry.day": "Um dia",
  "expiry.day.short": "24 h",
  "expiry.week": "Sete dias",
  "expiry.week.short": "7 dias",
  "expiry.never": "Sem expiração",
  "expiry.never.short": "Sem limite",
  "expiry.unavailable": "Indisponível neste relay",
  "expiry.neverWarning":
    "O relay guarda a cápsula até você apagá-la com a sua chave de remoção. Se perder essa chave, ela fica.",

  "anon.title": "Modo anônimo",
  "anon.detail":
    "Remove os metadados do arquivo, troca o nome, preenche o tamanho até uma categoria e espaça o envio. Envia um pouco mais de dados e demora mais.",

  "mix.title": "Roteamento por mixes",
  "mix.detail":
    "O pedido passa por vários relays, cada um segurando-o por um instante ao acaso, e o relay que guarda a cápsula nunca sabe quem pediu. Custa minutos em vez de segundos.",
  "mix.unavailable":
    "Nenhum relay ao alcance encaminha para outros. Suba um com CAPSULE_MIX_ENABLED=true.",
  "mix.verdict.single-node":
    "{mixes} mix de {operators} operador aparente, {hops} saltos por lado. Isto não é anonimato: com um só nó, esse nó vê as duas pontas.",
  "mix.verdict.minimal":
    "{mixes} mixes de {operators} operadores aparentes, {hops} saltos por lado. Basta para que o relay que guarda não veja você, e para nada além disso.",
  "mix.verdict.small":
    "{mixes} mixes de {operators} operadores aparentes, {hops} saltos por lado. Um relay curioso aprende pouco; quem consegue observar vários aprende muito.",
  "mix.verdict.usable":
    "{mixes} mixes de {operators} operadores aparentes, {hops} saltos por lado. Ainda longe de uma rede grande: julgue por quem opera estes relays, não pela quantidade.",

  "mirror.title": "Cópias em outros relays",
  "mirror.detail":
    "Se um relay cair ou bloquear você, a cápsula continua em outro. Cada cópia é mais um operador que vê o tamanho e o horário.",
  "mirror.count": "Quantidade de cópias",
  "mirror.one": "Apenas um",
  "mirror.split":
    "Repartir em vez de copiar: nenhum relay guarda a cápsula inteira e bastam dois para abri-la.",

  "progress.encrypting": "Cifrando neste dispositivo",
  "progress.uploading": "Enviando dados cifrados",
  "progress.keepOpen": "Mantenha esta janela aberta",

  "action.encrypt": "Cifrar e criar link",
  "action.preparing": "Preparando…",
  "action.originalUntouched":
    "O arquivo original não é alterado e permanece aqui.",
  "action.createAnother": "Criar outra cápsula",

  "sendError.title": "A cápsula não saiu",

  "success.eyebrow": "A cápsula está pronta",
  "success.title": "Compartilhe este link",

  "summary.storedOn": "Guardada em {count} relay: {hosts}",
  "summary.storedOn.plural": "Guardada em {count} relays: {hosts}",
  "summary.padded":
    "Tamanho preenchido com {bytes} para o relay ver uma categoria, não o tamanho real",
  "summary.scrubbed": "Metadados removidos do arquivo: {items}",
  "summary.notScrubbed":
    "Ainda não sabemos limpar os metadados deste formato: o arquivo foi enviado como estava",
  "summary.sharded":
    "Repartida {k} de {n}: nenhum relay guarda o suficiente para reconstruí-la",
  "summary.remaining": "Não foi possível remover: {item}",
  "summary.mirrorFailed": "Não conseguimos copiar para {host}",

  "share.label": "Link privado",
  "share.copy": "Copiar",
  "share.copied": "Copiado",
  "share.containsKey":
    "Este link carrega a chave. Envie-o apenas a quem deve abri-lo.",
  "share.qrAlt": "Código QR do link privado",
  "share.qrScan": "Escaneie para abrir",

  "owner.title": "Guarde a sua chave de remoção",
  "owner.detail":
    "Não é o link que você compartilha. Ela apaga a cápsula antes de expirar.",
  "owner.inputLabel": "Chave privada de remoção",
  "owner.warning":
    "Não a compartilhe. O CAPSULE não pode recuperá-la por você: se for precisar dela depois, proteja-a com uma senha abaixo.",

  "recovery.title": "Proteja-a com uma senha",
  "recovery.detail":
    "Cifra a chave de remoção com uma senha sua, aqui mesmo. O resultado pode ser anotado em qualquer lugar: sem a senha não serve para nada. O relay não participa.",
  "recovery.placeholder": "Uma senha que você vá lembrar",
  "recovery.protect": "Proteger",
  "recovery.protecting": "Protegendo…",
  "recovery.label": "Chave de remoção protegida",

  "receive.title": "Receber um arquivo",
  "receive.sub": "É aberto aqui, no seu dispositivo.",
  "receive.opening": "Abrindo a cápsula",
  "receive.openingDetail":
    "Os dados cifrados são baixados e abertos neste dispositivo.",
  "receive.downloading": "Baixando",
  "receive.verifying": "Verificando e decifrando",
  "receive.keyNotSent": "A chave nunca é enviada ao relay",
  "receive.readyEyebrow": "Aberta e verificada",
  "receive.readyTitle": "Pronta para salvar",
  "receive.save": "Salvar {filename}",
  "receive.close": "Fechar esta cápsula",
  "receive.emptyTitle": "Cole um link CAPSULE",
  "receive.errorTitle": "Vamos conferir o link",
  "receive.emptyDetail":
    "Abrir o link completo começa o download sozinho. Você também pode colá-lo aqui.",
  "receive.linkLabel": "Link privado",
  "receive.open": "Abrir cápsula",
  "receive.hashExplainer":
    "A parte que começa com {fragment} carrega a chave. O navegador não a envia ao relay ao pedir a página.",

  "metadata.note": "Nota",
  "metadata.expires": "Expira",
  "metadata.noExpiry": "Sem expiração",
  "metadata.noExpiryDetail": "Só a sua chave de remoção a apaga",

  "privacy.eyebrow": "Privacidade",
  "privacy.title": "O arquivo sai fechado. A chave viaja no link.",
  "privacy.steps": "Como funciona",
  "privacy.step1.title": "Cifrado aqui",
  "privacy.step1.detail": "No seu dispositivo, antes do envio.",
  "privacy.step2.title": "O relay guarda ruído",
  "privacy.step2.detail": "Recebe dados cifrados, não o arquivo.",
  "privacy.step3.title": "O link abre",
  "privacy.step3.detail": "Quem o tiver pode baixar e decifrar.",
  "privacy.details.summary": "O que ainda pode ser visto",
  "privacy.details.body":
    "O relay vê o seu endereço IP no momento da conexão, embora não o guarde. O modo anônimo remove os metadados do arquivo, esconde o nome e preenche o tamanho até uma categoria, mas não esconde o seu endereço. O roteamento por mixes esconde: o pedido viaja por vários relays e aquele que guarda a cápsula nunca sabe quem pediu. Nenhum dos dois esconde que você usa CAPSULE — para isso a CLI tem {flag}. A cifragem não protege um dispositivo infectado nem impede que quem recebe guarde uma cópia.",

  "extension.eyebrow": "A outra metade",
  "extension.title": "Ler um site .capsule",
  "extension.body":
    "Um endereço .capsule não resolve em nenhum DNS, então o navegador precisa da extensão para abri-lo. Ela reconstrói cada página antes de mostrá-la, e o resultado não consegue fazer uma única requisição de rede.",
  "extension.cta": "Como instalar",
  "extension.note":
    "Não há listagem em loja alguma. Você compila a partir do repositório e carrega sem empacotar, que é também o motivo de poder ler o que está rodando.",

  "network.eyebrow": "A rede",
  "network.title": "Qualquer um pode subir um relay",
  "network.body":
    "Sem registro e sem permissão: você sobe um, aponta para um relay que já conhece e os dois se apresentam. Este app usa {host} e descobre o resto a partir daí.",
  "network.empty": "Nenhum relay respondeu ainda.",
  "network.persistent": "sem expiração",
  "network.temporary": "apenas temporário",
  "network.peers": "{count} vizinhos",

  "footer.noTracking": "Sem analytics e sem rastreadores de terceiros.",

  "size.unknown": "Tamanho desconhecido",
  "mime.pdf": "Documento PDF",
  "mime.jpeg": "Imagem JPEG",
  "mime.png": "Imagem PNG",
  "mime.gif": "Imagem GIF",
  "mime.webp": "Imagem WebP",
  "mime.mp4": "Vídeo MP4",
  "mime.zip": "Arquivo ZIP",
  "mime.plain": "Texto simples",
  "mime.generic": "Arquivo",

  "error.badLink":
    "Cole um link CAPSULE completo. A parte que começa com #capsule= carrega a chave.",
  "error.expired": "Esta cápsula expirou e não está mais disponível.",
  "error.notFound":
    "Não encontramos esta cápsula. Pode ter expirado ou sido removida.",
  "error.tooLarge": "O arquivo ou a expiração excede o limite deste relay.",
  "error.authentication":
    "O link está incompleto ou o arquivo não pôde ser verificado. Peça um link novo.",
  "error.network":
    "Não conseguimos alcançar o relay. Se ele está rodando, normalmente é o relay recusando o endereço em que esta página foi aberta: localhost e 127.0.0.1 são origens diferentes. Abra no endereço que o relay espera, ou defina CAPSULE_CORS_ORIGIN.",
  "error.uploadGeneric":
    "Não conseguimos preparar a cápsula. O arquivo continua no seu dispositivo; pode tentar de novo.",
  "error.downloadGeneric":
    "Não conseguimos abrir a cápsula. Tente de novo ou peça um link novo.",
  "error.passphraseShort": "Use pelo menos 8 caracteres.",
  "error.protectFailed": "Não conseguimos proteger a chave. Tente de novo.",
};
