/**
 * The bootstrap inside the sandboxed frame.
 *
 * It waits for the viewer to hand it a rendered page and writes it. That is the
 * whole job: this file must stay small enough to read in one sitting, because
 * it is the only script that shares a global object with untrusted content.
 *
 * It holds nothing worth taking. The page it writes arrives already rebuilt —
 * every reference resolved inside the bundle, everything pointing outward
 * removed — and carries its own Content-Security-Policy, which applies on top
 * of the sandbox policy rather than replacing it. `connect-src 'none'` survives
 * that combination, so a site with its scripts allowed cannot issue a request.
 *
 * A navigation is not a request, and no CSP directive has covered one since
 * `navigate-to` left the standard — so the frame is not given the reach to
 * perform one. It cannot touch the top browsing context, and the links the
 * renderer wrote are handed up to the viewer instead, which decides what to
 * honour. A site's script may ask for anywhere it likes; an address outside
 * CAPSULE becomes the confirmation the visitor would have seen anyway.
 */

const RENDER = "capsule:render";
const NAVIGATE = "capsule:navigate";

interface RenderMessage {
  type: typeof RENDER;
  html: string;
}

function isRenderMessage(value: unknown): value is RenderMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RenderMessage).type === RENDER &&
    typeof (value as RenderMessage).html === "string"
  );
}

let written = false;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  // Only the frame's own embedder may write here. A sandboxed document has an
  // opaque origin, so `event.origin` is "null" and cannot be checked; the
  // source window can be, and it is the thing that actually matters.
  if (event.source !== window.parent) return;
  if (written || !isRenderMessage(event.data)) return;
  written = true;

  document.open();
  document.write(event.data.html);
  document.close();

  // Registered after the write, because `document.open` clears what was
  // registered on the document before it.
  //
  // This is a convenience, not a control. The frame has no way to reach the
  // top browsing context, so a site's script cannot navigate the tab whether
  // this listener runs or not; what it can do is ask, and the viewer decides
  // what to honour. Removing this listener, or stopping the event before it
  // arrives, costs the site its own links and gains it nothing.
  document.addEventListener(
    "click",
    (click) => {
      const node = click.target as Element | null;
      const anchor = node?.closest?.("a[href], area[href]");
      if (!anchor) return;
      click.preventDefault();
      window.parent.postMessage(
        { type: NAVIGATE, href: (anchor as HTMLAnchorElement).href },
        "*",
      );
    },
    true,
  );
});

// The viewer waits for this rather than for `load`, because a frame is ready to
// receive a message only once this listener exists.
window.parent.postMessage({ type: "capsule:ready" }, "*");
