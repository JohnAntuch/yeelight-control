"use strict";

const state = { lamps: [], presets: [], status: new Map(), cards: new Map() };
const $ = (selector) => document.querySelector(selector);

/* ---------- helpers ---------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function kelvinToHex(kelvin) {
  const t = kelvin / 100;
  const c = (v) => Math.round(Math.min(255, Math.max(0, v)));
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return "#" + [r, g, b].map((v) => c(v).toString(16).padStart(2, "0")).join("");
}

function hsvToHex(hue, sat) {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.min(100, Math.max(0, sat)) / 100;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(h) % 6];
  const ch = (v) => Math.round((v * s + (1 - s)) * 255).toString(16).padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111" : "#fff";
}

const describe = (p) => `${p.type === "color" ? `Color ${p.color}` : `White ${p.kelvin}K`}, ${p.brightness}%`;

let toastTimer;
function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = isError ? "error" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/** Sends one action to several lamps, reports the first error, then re-reads their state. */
async function act(ips, action) {
  const results = await Promise.all(ips.map((ip) => window.api.action(ip, action)));
  const failed = results.findIndex((r) => !r.ok);
  if (failed !== -1) toast(`${ips[failed]}: ${results[failed].error}`, true);
  setTimeout(() => ips.forEach(refresh), 700);
}

function sliderRow(label, { min, max, step = 1, value, unit, cls }, onCommit) {
  const input = el("input", { type: "range", min, max, step, value, className: `range ${cls}` });
  const out = el("span", { className: "val", textContent: `${value}${unit}` });
  const release = () => setTimeout(() => delete input.dataset.busy, 1500);

  input.addEventListener("pointerdown", () => (input.dataset.busy = "1"));
  input.addEventListener("pointerup", release);
  input.addEventListener("input", () => {
    input.dataset.busy = "1";
    out.textContent = `${input.value}${unit}`;
  });
  // Commands are only sent on release: lamps accept ~60 commands per minute.
  input.addEventListener("change", () => {
    onCommit(Number(input.value));
    release();
  });

  const row = el("div", { className: "row" }, [el("label", { textContent: label }), input, out]);
  return { row, input, out };
}

function colorRow(onCommit, value = "#ff0000") {
  const input = el("input", { type: "color", value });
  input.addEventListener("change", () => onCommit(input.value));
  const row = el("div", { className: "row" }, [el("label", { textContent: "Color" }), input]);
  return { row, input };
}

/* ---------- presets ---------- */

function sceneChips(onPick) {
  const wrap = el("div", { className: "chips" });
  if (state.presets.length === 0) wrap.append(el("span", { className: "hint", textContent: "No presets yet." }));

  for (const preset of state.presets) {
    const bg = preset.type === "color" ? preset.color : kelvinToHex(preset.kelvin);
    const chip = el("button", { type: "button", className: "chip", textContent: preset.name, title: describe(preset) });
    chip.style.background = bg;
    chip.style.color = textOn(bg);
    chip.addEventListener("click", () => onPick({ type: "scene", scene: preset }));

    const del = el("button", { type: "button", className: "chip-x", textContent: "×", title: `Delete "${preset.name}"` });
    del.addEventListener("click", async () => {
      if (!confirm(`Delete preset "${preset.name}"?`)) return;
      state.presets = await window.api.removePreset(preset.id);
      renderAll();
    });

    wrap.append(el("span", { className: "chip-wrap" }, [chip, del]));
  }
  return wrap;
}

/** Converts what a lamp is doing right now into a preset (without a name). */
function presetFromState(st) {
  const brightness = st.bright > 0 ? st.bright : 100;
  if (st.colorMode === 1 && st.rgb > 0) {
    return { type: "color", color: "#" + st.rgb.toString(16).padStart(6, "0"), brightness };
  }
  if (st.colorMode === 3) return { type: "color", color: hsvToHex(st.hue, st.sat), brightness };
  if (st.ct > 0) return { type: "ct", kelvin: st.ct, brightness };
  return null;
}

function askPresetName(summary) {
  const dialog = $("#preset-dialog");
  const input = $("#preset-name");
  $("#preset-summary").textContent = summary;
  input.value = "";
  dialog.returnValue = "";
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "save" ? input.value.trim() : null), { once: true });
  });
}

async function savePresetFrom(ip) {
  await refresh(ip); // read the lamp's real, current settings
  const st = state.status.get(ip);
  if (!st) return toast("The lamp is offline, so its settings can't be read.", true);

  const settings = presetFromState(st);
  if (!settings) return toast("Couldn't read this lamp's current color or temperature.", true);

  const name = await askPresetName(`Saving: ${describe(settings)}`);
  if (!name) return;

  const result = await window.api.addPreset({ ...settings, name });
  if (!result.ok) return toast(result.error, true);
  state.presets = result.presets;
  renderAll();
  toast(`Preset "${name}" saved.`);
}

/* ---------- lamp cards ---------- */

function buildCard(lamp) {
  const ip = lamp.ip;
  const send = (action) => {
    const st = state.status.get(ip);
    return act([ip], { ...action, turnOn: !st || !st.power });
  };

  const name = el("input", { className: "name", value: lamp.name, spellcheck: false, title: "Click to rename" });
  name.addEventListener("change", async () => {
    lamp.name = name.value.trim() || lamp.ip;
    name.value = lamp.name;
    await window.api.rename(ip, lamp.name);
  });
  name.addEventListener("keydown", (e) => e.key === "Enter" && name.blur());

  const badge = el("span", { className: "badge", textContent: "…" });

  const powerInput = el("input", { type: "checkbox" });
  powerInput.addEventListener("change", () => act([ip], { type: "power", on: powerInput.checked }));
  const power = el("label", { className: "switch" }, [powerInput, el("span", { className: "track" })]);

  const remove = el("button", { className: "remove", type: "button", textContent: "×", title: "Remove lamp" });
  remove.addEventListener("click", async () => {
    if (!confirm(`Remove "${lamp.name}" from the list?`)) return;
    state.lamps = await window.api.remove(ip);
    renderAll();
  });

  const bright = sliderRow("Brightness", { min: 1, max: 100, value: 100, unit: "%", cls: "bright" }, (value) =>
    send({ type: "brightness", value })
  );
  const ct = sliderRow("Temperature", { min: 1700, max: 6500, step: 100, value: 4000, unit: "K", cls: "ct" }, (value) =>
    send({ type: "ct", value })
  );
  const color = colorRow((value) => send({ type: "color", value }));

  const savePreset = el("button", {
    type: "button",
    className: "save-preset",
    textContent: "+ Save current as preset",
    title: "Save this lamp's current settings as a preset"
  });
  savePreset.addEventListener("click", () => savePresetFrom(ip));

  const card = el("article", { className: "card offline" }, [
    el("div", { className: "card-head" }, [
      el("div", { className: "card-title" }, [name, el("div", { className: "ip", textContent: ip })]),
      badge,
      power,
      remove
    ]),
    bright.row,
    ct.row,
    color.row,
    sceneChips((action) => act([ip], action)),
    savePreset
  ]);

  state.cards.set(ip, { card, badge, powerInput, bright, ct, color });
  return card;
}

function updateCard(ip) {
  const refs = state.cards.get(ip);
  if (!refs) return;
  const st = state.status.get(ip);

  refs.card.classList.toggle("offline", !st);
  if (!st) {
    refs.badge.className = "badge bad";
    refs.badge.textContent = "Offline";
    return;
  }
  refs.badge.className = `badge ${st.power ? "on" : "off"}`;
  refs.badge.textContent = st.power ? "On" : "Off";
  refs.powerInput.checked = st.power;

  if (st.bright > 0 && !refs.bright.input.dataset.busy) {
    refs.bright.input.value = st.bright;
    refs.bright.out.textContent = `${st.bright}%`;
  }
  if (st.ct > 0 && !refs.ct.input.dataset.busy) {
    refs.ct.input.value = st.ct;
    refs.ct.out.textContent = `${st.ct}K`;
  }
  if (st.rgb > 0) refs.color.input.value = "#" + st.rgb.toString(16).padStart(6, "0");
}

async function refresh(ip) {
  const result = await window.api.state(ip);
  state.status.set(ip, result.ok ? result.state : null);
  updateCard(ip);
}

function renderAll() {
  const grid = $("#lamps");
  grid.replaceChildren();
  state.cards.clear();
  state.lamps.forEach((lamp) => grid.append(buildCard(lamp)));
  $("#empty").hidden = state.lamps.length > 0;
  $("#all").hidden = state.lamps.length === 0;
  buildAllBar();
  state.lamps.forEach((lamp) => (state.status.has(lamp.ip) ? updateCard(lamp.ip) : refresh(lamp.ip)));
}

/* ---------- "all lamps" bar ---------- */

const allIps = () => state.lamps.map((l) => l.ip);

function buildAllBar() {
  const box = $("#all-controls");
  const send = (action) => act(allIps(), { ...action, turnOn: true });

  box.replaceChildren(
    sliderRow("Brightness", { min: 1, max: 100, value: 100, unit: "%", cls: "bright" }, (value) => send({ type: "brightness", value })).row,
    sliderRow("Temperature", { min: 1700, max: 6500, step: 100, value: 4000, unit: "K", cls: "ct" }, (value) => send({ type: "ct", value })).row,
    colorRow((value) => send({ type: "color", value })).row,
    sceneChips((action) => act(allIps(), action))
  );
}

/* ---------- discovery / add ---------- */

// Every lamp has a permanent id. When a saved lamp is offline (for example its IP changed after a
// power cut), a quiet discovery finds it again by id and updates the saved IP.
let syncing = false;
let lastSync = 0;
async function syncLamps(force = false) {
  if (syncing || state.lamps.length === 0) return;
  if (!force && Date.now() - lastSync < 30000) return;
  const needed = state.lamps.some((l) => !l.id || state.status.get(l.ip) === null);
  if (!needed && !force) return;

  syncing = true;
  lastSync = Date.now();
  try {
    const result = await window.api.discover({ addNew: false });
    state.lamps = result.lamps;
    if (result.moved > 0) {
      renderAll();
      toast(`${result.moved} lamp(s) changed IP address. The app updated it automatically.`);
    }
  } finally {
    syncing = false;
  }
}

async function discover() {
  const button = $("#discover");
  button.disabled = true;
  button.textContent = "Searching…";
  try {
    const result = await window.api.discover();
    state.lamps = result.lamps;
    renderAll();
    toast(
      result.found === 0
        ? "No lamps found. Check that LAN Control is on and Windows Firewall allows the app, or add a lamp by IP."
        : `Found ${result.found} lamp(s): ${result.added} new, ${result.moved} with an updated IP.`,
      result.found === 0
    );
  } finally {
    button.disabled = false;
    button.textContent = "Discover lamps";
  }
}

$("#discover").addEventListener("click", discover);
$("#all-on").addEventListener("click", () => act(allIps(), { type: "power", on: true }));
$("#all-off").addEventListener("click", () => act(allIps(), { type: "power", on: false }));

$("#add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await window.api.add($("#add-ip").value, $("#add-name").value);
  if (!result.ok) return toast(result.error, true);
  state.lamps = result.lamps;
  $("#add-ip").value = "";
  $("#add-name").value = "";
  renderAll();
  setTimeout(() => syncLamps(true), 1500); // learn the new lamp's permanent id
});

/* ---------- start with Windows ---------- */

async function initStartupOption() {
  const checkbox = $("#startup");
  const settings = await window.api.getSettings();
  checkbox.checked = settings.startup;

  if (!settings.supported) {
    checkbox.disabled = true;
    $("#startup-label").classList.add("disabled");
    $("#startup-label").title = "Available in the installed or portable app (npm run dist), not in dev mode.";
    return;
  }
  checkbox.addEventListener("change", async () => {
    const result = await window.api.setStartup(checkbox.checked);
    if (!result.ok) {
      checkbox.checked = !checkbox.checked;
      return toast(result.error, true);
    }
    checkbox.checked = result.startup;
    toast(result.startup ? "The app will start with Windows (minimized)." : "The app will no longer start with Windows.");
  });
}

/* ---------- start ---------- */

(async function init() {
  initStartupOption();
  state.presets = await window.api.listPresets();
  state.lamps = await window.api.list();
  renderAll();
  if (state.lamps.length === 0) discover();
  setTimeout(syncLamps, 3000);
  setInterval(async () => {
    if (document.hidden) return;
    await Promise.all(state.lamps.map((l) => refresh(l.ip)));
    syncLamps();
  }, 10000);
})();
