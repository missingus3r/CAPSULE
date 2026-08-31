/**
 * The page behind `/realtime`.
 *
 * A plain page served by the relay, not a `.capsule` site, so it may run its
 * own script and poll. It is written as one string with no build step because
 * the relay has no bundler and should not grow one to draw two numbers.
 *
 * The copy is in three languages, chosen from the browser's own preference.
 * Nothing about that choice is sent anywhere: the whole dictionary ships in
 * the page and the picking happens on the device.
 */

export const REALTIME_POLL_MS = 2000;

const STRINGS = `{
  "en": {
    "title": "Right now",
    "clients": "addresses",
    "relays": "relays",
    "peak": "peak",
    "clientsNote": "made a request in the last {minutes} minutes",
    "relaysNote": "in this relay's directory",
    "caveat": "Addresses are not people. Two devices are two, a household behind one router is one, and anyone routing through the mix network is counted as the relay that forwarded for them. The relay keeps a salted digest of the address for as long as the window, the same thing rate limiting already holds, and the salt rotates — so nothing here can be turned back into an address or followed from one window to the next.",
    "since": "counting since",
    "offline": "the relay is not answering"
  },
  "es": {
    "title": "Ahora mismo",
    "clients": "direcciones",
    "relays": "relays",
    "peak": "pico",
    "clientsNote": "hicieron un pedido en los últimos {minutes} minutos",
    "relaysNote": "en el directorio de este relay",
    "caveat": "Las direcciones no son personas. Dos dispositivos son dos, una casa detrás de un router es una, y quien rutea por la red mix cuenta como el relay que reenvió por él. El relay guarda un digest con sal de la dirección mientras dura la ventana, lo mismo que ya guarda el rate limiting, y la sal rota — así que nada de esto se puede volver a convertir en una dirección ni seguir de una ventana a la siguiente.",
    "since": "contando desde",
    "offline": "el relay no responde"
  },
  "pt": {
    "title": "Agora mesmo",
    "clients": "endereços",
    "relays": "relays",
    "peak": "pico",
    "clientsNote": "fizeram um pedido nos últimos {minutes} minutos",
    "relaysNote": "no diretório deste relay",
    "caveat": "Endereços não são pessoas. Dois dispositivos são dois, uma casa atrás de um roteador é uma, e quem roteia pela rede mix conta como o relay que encaminhou por ele. O relay guarda um digest com sal do endereço enquanto dura a janela, o mesmo que o rate limiting já guarda, e o sal gira — então nada aqui pode virar um endereço de novo nem ser seguido de uma janela para a outra.",
    "since": "contando desde",
    "offline": "o relay não responde"
  }
}`;

export const REALTIME_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>CAPSULE</title>
    <style>
      :root { color-scheme: light dark; --ink:#18352f; --muted:#6b7772; --faint:#9aa5a0; --bg:#f3efe6; --card:#fffdf8; --line:rgba(27,62,54,.13); --accent:#ef7959 }
      @media (prefers-color-scheme: dark) {
        :root { --ink:#e8efec; --muted:#9fb0aa; --faint:#6f807a; --bg:#12201d; --card:#18302b; --line:rgba(255,255,255,.09) }
      }
      * { box-sizing: border-box }
      body {
        margin: 0; min-height: 100vh; padding: 2rem 1.25rem;
        display: flex; align-items: center; justify-content: center;
        background: var(--bg); color: var(--ink);
        font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { width: 100%; max-width: 34rem; text-align: center }
      h1 { margin: 0 0 2.25rem; font-size: 1.05rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--muted) }
      .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem }
      .card { padding: 1.75rem 1rem; border: 1px solid var(--line); border-radius: 1.15rem; background: var(--card) }
      .n { font-size: clamp(2.6rem, 12vw, 3.6rem); font-weight: 300; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.03em }
      .k { margin-top: .5rem; font-size: .82rem; font-weight: 650; color: var(--ink) }
      .sub { margin-top: .2rem; font-size: .72rem; color: var(--faint) }
      .peak { margin-top: .9rem; padding-top: .7rem; border-top: 1px dashed var(--line); font-size: .74rem; color: var(--muted); font-variant-numeric: tabular-nums }
      .caveat { margin: 2rem 0 0; font-size: .78rem; line-height: 1.62; color: var(--muted); text-align: left }
      .since { margin: 1rem 0 0; font-size: .7rem; color: var(--faint); font-variant-numeric: tabular-nums }
      .off { color: var(--accent) }
      .dot { display: inline-block; width: .42rem; height: .42rem; margin-right: .45rem; border-radius: 50%; background: var(--accent); vertical-align: middle; animation: pulse 2s ease-in-out infinite }
      @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
      @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
    </style>
  </head>
  <body>
    <main>
      <h1><span class="dot" aria-hidden="true"></span><span id="title">Right now</span></h1>
      <div class="pair">
        <div class="card">
          <div class="n" id="clients">–</div>
          <div class="k" id="clients-k">addresses</div>
          <div class="sub" id="clients-note"></div>
          <div class="peak"><span id="peak-a">peak</span> <b id="clients-peak">–</b></div>
        </div>
        <div class="card">
          <div class="n" id="relays">–</div>
          <div class="k" id="relays-k">relays</div>
          <div class="sub" id="relays-note"></div>
          <div class="peak"><span id="peak-b">peak</span> <b id="relays-peak">–</b></div>
        </div>
      </div>
      <p class="caveat" id="caveat"></p>
      <p class="since" id="since"></p>
    </main>
    <script>
      (function () {
        var S = ${STRINGS};
        var lang = (navigator.languages || [navigator.language || "en"])
          .map(function (l) { return String(l).toLowerCase().split("-")[0]; })
          .filter(function (l) { return S[l]; })[0] || "en";
        var t = S[lang];
        document.documentElement.lang = lang;

        var set = function (id, value) {
          var node = document.getElementById(id);
          if (node) node.textContent = value;
        };
        set("title", t.title);
        set("clients-k", t.clients);
        set("relays-k", t.relays);
        set("peak-a", t.peak);
        set("peak-b", t.peak);
        set("relays-note", t.relaysNote);
        set("caveat", t.caveat);

        var render = function (data) {
          set("clients", String(data.clients));
          set("clients-peak", String(data.clientsPeak));
          set("relays", String(data.relays));
          set("relays-peak", String(data.relaysPeak));
          set(
            "clients-note",
            t.clientsNote.replace(
              "{minutes}",
              String(Math.round(data.windowSeconds / 60))
            )
          );
          var since = new Date(data.since);
          set(
            "since",
            t.since + " " + (isNaN(since.getTime()) ? "" : since.toLocaleString(lang))
          );
          document.getElementById("since").classList.remove("off");
        };

        var tick = function () {
          fetch("/v1/realtime", { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
            .then(render)
            .catch(function () {
              var node = document.getElementById("since");
              node.textContent = t.offline;
              node.classList.add("off");
            });
        };
        tick();
        setInterval(tick, ${REALTIME_POLL_MS});
      })();
    </script>
  </body>
</html>
`;
