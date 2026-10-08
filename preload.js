"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  list: () => ipcRenderer.invoke("lamps:list"),
  add: (ip, name) => ipcRenderer.invoke("lamps:add", ip, name),
  remove: (ip) => ipcRenderer.invoke("lamps:remove", ip),
  rename: (ip, name) => ipcRenderer.invoke("lamps:rename", ip, name),
  discover: () => ipcRenderer.invoke("lamps:discover"),
  state: (ip) => ipcRenderer.invoke("lamp:state", ip),
  action: (ip, action) => ipcRenderer.invoke("lamp:action", ip, action),

  listPresets: () => ipcRenderer.invoke("presets:list"),
  addPreset: (preset) => ipcRenderer.invoke("presets:add", preset),
  removePreset: (id) => ipcRenderer.invoke("presets:remove", id),

  getSettings: () => ipcRenderer.invoke("settings:get"),
  setStartup: (enabled) => ipcRenderer.invoke("settings:startup", enabled)
});
