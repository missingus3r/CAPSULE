# Example `.capsule` site

`site/` is a small, complete site meant to be published against a local relay
and opened in the extension. It is also a fixture: three of its checks are
deliberate attempts that the viewer is supposed to refuse.

| File              | What it is for                                            |
| ----------------- | --------------------------------------------------------- |
| `index.html`      | The landing page: what a `.capsule` name is and is not.   |
| `proof.html`      | An external image, an inline script and an outbound link. |
| `style.css`       | A linked stylesheet, to check bundle resolution.          |
| `assets/mark.svg` | A local image, to check it becomes a `data:` URL.         |

Nothing here loads a web font or any other external asset, because a published
site cannot make a network request at all.

## Publish it

```bash
npm run build
npm run dev:relay                                  # a second terminal

node apps/cli/dist/index.js site key --out site.capsulekey
node apps/cli/dist/index.js site publish ./examples/site --key site.capsulekey --ttl 7d
```

The key file **is** the site. It is git-ignored on purpose: whoever copies it
can replace the pages.

`--ttl 7d` is the ceiling a relay allows out of the box; ask for longer and it
refuses the capsule. Raise it with `CAPSULE_MAX_TTL_SECONDS` on the relay.

## Read it back

```bash
node apps/cli/dist/index.js site resolve "<name>.capsule"
node apps/cli/dist/index.js site get "<name>.capsule" --out ./recovered/
```

In a browser: `npm run build:extension`, load `apps/extension/dist` unpacked,
add `http://localhost:8787` in the extension options, and type the `.capsule`
address in the address bar.

## What you should see

- **Check 1** — no image appears, and the viewer reports one blocked external
  resource.
- **Check 2** — the sentence still says the script did not run. Turn scripts on
  for the site and reload: it changes, which is what that setting costs.
- **Check 3** — the outbound link asks for confirmation before leaving.
- Navigation between `index.html` and `proof.html` works with no network.
