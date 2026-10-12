"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const yeelight = require("./lib/yeelight");

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const START_HIDDEN = process.argv.includes("--hidden");

// For the portable build, the real .exe path is in this variable (process.execPath points to a temp folder).
const EXE_PATH = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const LOGIN_ARGS = ["--hidden"];

const DEFAULT_PRESETS = [
  { name: "Warm", type: "ct", kelvin: 2700, brightness: 80 },
  { name: "Neutral", type: "ct", kelvin: 4000, brightness: 100 },
  { name: "Cool", type: "ct", kelvin: 6000, brightness: 100 },
  { name: "Reading", type: "ct", kelvin: 3500, brightness: 90 },
  { name: "Movie", type: "ct", kelvin: 2700, brightness: 15 },
  { name: "Night", type: "color", color: "#ff5a00", brightness: 5 },
  { name: "Party", type: "color", color: "#a020f0", brightness: 80 }
].map((p) => ({ id: crypto.randomUUID(), ...p }));

let lampsFile;
let presetsFile;
let mainWindow = null;

/* ---------- storage ---------- */

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const loadLamps = () => readJson(lampsFile, []);
const saveLamps = (lamps) => writeJson(lampsFile, lamps);

function loadPresets() {
  if (!fs.existsSync(presetsFile)) {
    writeJson(presetsFile, DEFAULT_PRESETS); // first run: seed with the built-in presets
    return DEFAULT_PRESETS;
  }
  return readJson(presetsFile, []);
}
const savePresets = (presets) => writeJson(presetsFile, presets);

function sanitizePreset(p) {
  const name = String((p && p.name) || "").trim().slice(0, 24);
  if (!name) return null;
  const brightness = yeelight.clamp(p.brightness, 1, 100);
  if (p.type === "color" && HEX.test(String(p.color))) {
    return { id: crypto.randomUUID(), name, type: "color", color: p.color.toLowerCase(), brightness };
  }
  if (p.type === "ct") {
    return { id: crypto.randomUUID(), name, type: "ct", kelvin: yeelight.clamp(p.kelvin, 1700, 6500), brightness };
  }
  return null;
}

/* ---------- lamp actions ---------- */

const hexToInt = (hex) => (HEX.test(String(hex)) ? parseInt(hex.slice(1), 16) : null);

/** Turns a UI action into Yeelight commands. Returns null for invalid input. */
function buildCommands(a) {
  const { cmd } = yeelight;
  const withPower = (c) => (a.turnOn ? [cmd.power(true), c] : [c]);

  switch (a && a.type) {
    case "power":
      return [cmd.power(!!a.on)];
    case "brightness":
      return withPower(cmd.brightness(a.value));
    case "ct":
      return withPower(cmd.colorTemp(a.value));
    case "color": {
      const v = hexToInt(a.value);
      return v === null ? null : withPower(cmd.rgb(v));
    }
    case "scene": {
      const s = a.scene || {};
      if (s.type === "color") {
        const v = hexToInt(s.color);
        return v === null ? null : [cmd.sceneColor(v, s.brightness)];
      }
      return [cmd.sceneTemp(s.kelvin, s.brightness)];
    }
    default:
      return null;
  }
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle("lamps:list", () => loadLamps());

  ipcMain.handle("lamps:add", (_e, ip, name) => {
    ip = String(ip || "").trim();
    if (!IPV4.test(ip)) return { ok: false, error: "Enter a valid IPv4 address, e.g. 192.168.1.50" };
    const lamps = loadLamps();
    const existing = lamps.find((l) => l.ip === ip);
    if (existing) existing.name = String(name || "").trim() || existing.name;
    else lamps.push({ ip, name: String(name || "").trim() || `Lamp ${ip}` });
    saveLamps(lamps);
    return { ok: true, lamps };
  });

  ipcMain.handle("lamps:remove", (_e, ip) => {
    const lamps = loadLamps().filter((l) => l.ip !== ip);
    saveLamps(lamps);
    return lamps;
  });

  ipcMain.handle("lamps:rename", (_e, ip, name) => {
    const lamps = loadLamps();
    const lamp = lamps.find((l) => l.ip === ip);
    if (lamp) lamp.name = String(name || "").trim() || lamp.ip;
    saveLamps(lamps);
    return lamps;
  });

  // opts.addNew === false: only update / identify saved lamps (silent background syncing).
  ipcMain.handle("lamps:discover", async (_e, opts) => {
    const addNew = !(opts && opts.addNew === false);
    const found = await yeelight.discover();
    const lamps = loadLamps();
    const { added, moved } = yeelight.mergeDiscovered(lamps, found, addNew);
    saveLamps(lamps);
    return { lamps, found: found.length, added, moved };
  });

  ipcMain.handle("lamp:state", async (_e, ip) => {
    try {
      return { ok: true, state: await yeelight.getState(ip) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("lamp:action", async (_e, ip, action) => {
    const commands = buildCommands(action);
    if (!IPV4.test(String(ip)) || !commands) return { ok: false, error: "Invalid request" };
    try {
      await yeelight.sendCommands(ip, commands);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* presets */
  ipcMain.handle("presets:list", () => loadPresets());

  ipcMain.handle("presets:add", (_e, preset) => {
    const clean = sanitizePreset(preset);
    if (!clean) return { ok: false, error: "Invalid preset" };
    const presets = loadPresets();
    presets.push(clean);
    savePresets(presets);
    return { ok: true, presets };
  });

  ipcMain.handle("presets:remove", (_e, id) => {
    const presets = loadPresets().filter((p) => p.id !== id);
    savePresets(presets);
    return presets;
  });

  /* start with Windows */
  const loginQuery = { path: EXE_PATH, args: LOGIN_ARGS };

  ipcMain.handle("settings:get", () => {
    if (!app.isPackaged) return { supported: false, startup: false };
    return { supported: true, startup: app.getLoginItemSettings(loginQuery).openAtLogin };
  });

  ipcMain.handle("settings:startup", (_e, enabled) => {
    if (!app.isPackaged) {
      return { ok: false, error: "Only available in the installed or portable app (build it with npm run dist)." };
    }
    app.setLoginItemSettings({ openAtLogin: !!enabled, ...loginQuery });
    return { ok: true, startup: app.getLoginItemSettings(loginQuery).openAtLogin };
  });
}

/* ---------- window ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 520,
    minHeight: 480,
    show: false,
    backgroundColor: "#14161a",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (START_HIDDEN) {
      // Launched by Windows at login: keep out of the way in the taskbar.
      mainWindow.showInactive();
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });
  mainWindow.on("closed", () => (mainWindow = null));
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    lampsFile = path.join(app.getPath("userData"), "lamps.json");
    presetsFile = path.join(app.getPath("userData"), "presets.json");
    registerIpc();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}
