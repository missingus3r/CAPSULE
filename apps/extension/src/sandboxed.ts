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
 * that combination, so a site with its scripts allowed can compute anything at
 * all and still has nowhere to send it.
 */

const RENDER = "capsule:render";

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
});

// The viewer waits for this rather than for `load`, because a frame is ready to
// receive a message only once this listener exists.
window.parent.postMessage({ type: "capsule:ready" }, "*");
