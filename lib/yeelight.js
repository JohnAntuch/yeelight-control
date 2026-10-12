"use strict";
const net = require("node:net");
const dgram = require("node:dgram");
const os = require("node:os");

const PORT = 55443;
const DURATION = 400; // ms, smooth transitions
let counter = 0;

/**
 * Opens a connection to a lamp, sends all commands, waits for every reply, closes.
 * Lamps only allow a few simultaneous connections, so sockets are not kept open.
 */
function sendCommands(ip, commands, timeoutMs = 3000, port = PORT) {
  return new Promise((resolve, reject) => {
    const ids = commands.map(() => ++counter);
    const waiting = new Set(ids);
    const results = new Array(commands.length);
    let buffer = "";
    let finished = false;

    const socket = net.createConnection({ host: ip, port });

    const finish = (error) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(results);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error("Lamp did not respond (timeout)")));
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish(new Error("Connection closed early")));

    socket.on("connect", () => {
      const payload = commands
        .map((c, i) => JSON.stringify({ id: ids[i], method: c.method, params: c.params || [] }) + "\r\n")
        .join("");
      socket.write(payload);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 2);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined || !waiting.has(msg.id)) continue; // ignore "props" notifications
        if (msg.error) {
          finish(new Error((msg.error && msg.error.message) || "Lamp returned an error"));
          return;
        }
        results[ids.indexOf(msg.id)] = msg.result || [];
        waiting.delete(msg.id);
        if (waiting.size === 0) finish();
      }
    });
  });
}

async function getState(ip) {
  const [reply] = await sendCommands(ip, [
    { method: "get_prop", params: ["power", "bright", "ct", "rgb", "color_mode", "hue", "sat"] }
  ]);
  const [power, bright, ct, rgb, colorMode, hue, sat] = reply;
  return {
    power: power === "on",
    bright: Number(bright) || 0,
    ct: Number(ct) || 0,
    rgb: Number(rgb) || 0,
    colorMode: Number(colorMode) || 0,
    hue: Number(hue) || 0,
    sat: Number(sat) || 0
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

const cmd = {
  power: (on) => ({ method: "set_power", params: [on ? "on" : "off", "smooth", DURATION] }),
  brightness: (p) => ({ method: "set_bright", params: [clamp(p, 1, 100), "smooth", DURATION] }),
  colorTemp: (k) => ({ method: "set_ct_abx", params: [clamp(k, 1700, 6500), "smooth", DURATION] }),
  rgb: (v) => ({ method: "set_rgb", params: [v, "smooth", DURATION] }),
  sceneColor: (v, b) => ({ method: "set_scene", params: ["color", v, clamp(b, 1, 100)] }),
  sceneTemp: (k, b) => ({ method: "set_scene", params: ["ct", clamp(k, 1700, 6500), clamp(b, 1, 100)] })
};

function parseResponse(text) {
  const headers = {};
  for (const line of text.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const m = /yeelight:\/\/([\d.]+):(\d+)/.exec(headers.location || "");
  if (!m) return null;
  return { ip: m[1], port: Number(m[2]), id: (headers.id || "").toLowerCase(), model: headers.model || "", name: headers.name || "" };
}

/** SSDP discovery, sent from every local IPv4 interface (Windows often has several). */
function discover(timeoutMs = 2500) {
  const message = Buffer.from(
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n\r\n'
  );
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);

  return new Promise((resolve) => {
    const found = new Map();
    const sockets = addresses.map((address) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socket.on("error", () => {});
      socket.on("message", (buf) => {
        const lamp = parseResponse(buf.toString("utf8"));
        if (lamp) found.set(lamp.ip, lamp);
      });
      socket.bind(0, address, () => {
        try {
          socket.setMulticastInterface(address);
          socket.send(message, 1982, "239.255.255.250");
        } catch {
          /* ignore this interface */
        }
      });
      return socket;
    });

    setTimeout(() => {
      sockets.forEach((s) => {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      });
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/**
 * Merges lamps found on the network into the saved list (modified in place).
 * Lamps are recognized by their permanent id, so a lamp that got a new IP is updated, not duplicated.
 * Saved lamps without an id (added by IP) learn their id when discovery finds them at the saved IP.
 * With addNew === false, lamps that aren't saved yet are ignored.
 */
function mergeDiscovered(lamps, found, addNew = true) {
  let added = 0;
  let moved = 0;
  const unmatched = [];

  for (const f of found) {
    const lamp = f.id ? lamps.find((l) => l.id === f.id) : null;
    if (!lamp) {
      unmatched.push(f);
      continue;
    }
    if (lamp.ip !== f.ip) {
      lamp.ip = f.ip;
      moved++;
    }
  }

  for (const f of unmatched) {
    const lamp = lamps.find((l) => !l.id && l.ip === f.ip);
    if (lamp) {
      if (f.id) lamp.id = f.id;
    } else if (addNew) {
      lamps.push({ ip: f.ip, id: f.id || undefined, name: f.name || `Yeelight ${f.model}`.trim() });
      added++;
    }
  }
  return { added, moved };
}

module.exports = { sendCommands, getState, discover, parseResponse, mergeDiscovered, clamp, cmd };
