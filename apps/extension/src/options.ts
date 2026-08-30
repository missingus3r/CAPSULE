import {
  normalizeRelayUrl,
  originsOf,
  readSettings,
  writeSettings,
} from "./settings.js";

const relayList = document.getElementById("relays") as HTMLUListElement;
const pinList = document.getElementById("pins") as HTMLUListElement;
const addForm = document.getElementById("add") as HTMLFormElement;
const forgetForm = document.getElementById("forget") as HTMLFormElement;
const urlInput = document.getElementById("url") as HTMLInputElement;
const status = document.getElementById("status") as HTMLElement;
const mixToggle = document.getElementById("mix") as HTMLInputElement;

function empty(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}

async function draw(): Promise<void> {
  const settings = await readSettings();
  mixToggle.checked = settings.mix;

  relayList.replaceChildren();
  if (settings.relays.length === 0) {
    relayList.append(empty("No relays. Add one to resolve any name."));
  }
  for (const relay of settings.relays) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = relay;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      void (async () => {
        const current = await readSettings();
        await writeSettings({
          relays: current.relays.filter((entry) => entry !== relay),
        });
        // The host permission goes with it: an extension that keeps access to
        // a host it no longer uses is an extension asking to be trusted for no
        // reason.
        await chrome.permissions.remove({ origins: originsOf([relay]) });
        await draw();
      })();
    });

    item.append(label);

    // A relay in the list that the extension may not contact yet looks
    // identical to one it can, which is the confusing half of asking for
    // permissions only when they are needed. Say which is which, and offer the
    // click that fixes it — a permission can only be requested from a gesture,
    // so it has to be a button.
    const allowed = await chrome.permissions.contains({
      origins: originsOf([relay]),
    });
    if (!allowed) {
      const grant = document.createElement("button");
      grant.type = "button";
      grant.className = "primary";
      grant.textContent = "Allow";
      grant.title = `CAPSULE has not been allowed to contact ${relay}`;
      grant.addEventListener("click", () => {
        void chrome.permissions
          .request({ origins: originsOf([relay]) })
          .then(() => draw());
      });
      item.append(grant);
    }

    item.append(remove);
    relayList.append(item);
  }

  pinList.replaceChildren();
  const names = Object.keys(settings.pins);
  if (names.length === 0) {
    pinList.append(empty("None yet."));
  }
  for (const name of names.sort()) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${name.slice(0, 14)}…${name.slice(-16)}`;
    label.title = name;
    const version = document.createElement("span");
    version.style.flex = "0 0 auto";
    version.textContent = `v${settings.pins[name]}${
      settings.scriptSites.includes(name) ? " · scripts on" : ""
    }`;
    item.append(label, version);
    pinList.append(item);
  }
}

addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const url = normalizeRelayUrl(urlInput.value);
    if (!url) {
      status.textContent = "That is not an http(s) address.";
      return;
    }
    // Asked for here because this click is a user gesture, which is the only
    // moment Chrome will let an extension request a host permission.
    const granted = await chrome.permissions.request({
      origins: originsOf([url]),
    });
    if (!granted) {
      status.textContent = `Not added: CAPSULE was not allowed to contact ${url}.`;
      return;
    }
    const settings = await readSettings();
    if (settings.relays.includes(url)) {
      status.textContent = "Already on the list.";
      return;
    }
    await writeSettings({ relays: [...settings.relays, url] });
    urlInput.value = "";
    status.textContent = `Added ${url}.`;
    await draw();
  })();
});

mixToggle.addEventListener("change", () => {
  void writeSettings({ mix: mixToggle.checked });
});

forgetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    await writeSettings({ pins: {}, scriptSites: [] });
    await chrome.storage.session.clear();
    status.textContent = "Forgotten.";
    await draw();
  })();
});

void draw();
