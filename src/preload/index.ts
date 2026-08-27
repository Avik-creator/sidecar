import { contextBridge, ipcRenderer } from "electron";
import type { SidecarApi, SidecarShell } from "../shared/types.js";

const api: SidecarApi = {
  health: () => ipcRenderer.invoke("sidecar:health"),
  ingest: () => ipcRenderer.invoke("sidecar:ingest"),
  usage: (days) => ipcRenderer.invoke("sidecar:usage", days),
  sessions: () => ipcRenderer.invoke("sidecar:sessions"),
  setup: () => ipcRenderer.invoke("sidecar:setup"),
  candidates: (limit) => ipcRenderer.invoke("sidecar:candidates", limit),
  clusters: () => ipcRenderer.invoke("sidecar:clusters"),
  suggestions: () => ipcRenderer.invoke("sidecar:suggestions"),
  runImprove: () => ipcRenderer.invoke("sidecar:runImprove"),
  applySuggestion: (id) => ipcRenderer.invoke("sidecar:applySuggestion", id),
  undoSuggestion: (id) => ipcRenderer.invoke("sidecar:undoSuggestion", id),
  dismissSuggestion: (id) => ipcRenderer.invoke("sidecar:dismissSuggestion", id),
};

const shellApi: SidecarShell = {
  setPinned: (pinned) => ipcRenderer.invoke("sidecar:setPinned", pinned),
  hidePanel: () => ipcRenderer.invoke("sidecar:hidePanel"),
  quitApp: () => ipcRenderer.invoke("sidecar:quitApp"),
};

contextBridge.exposeInMainWorld("sidecar", api);
contextBridge.exposeInMainWorld("sidecarShell", shellApi);
contextBridge.exposeInMainWorld("sidecarEvents", {
  onChanged: (handler: () => void) => {
    const listener = (): void => {
      handler();
    };
    ipcRenderer.on("sidecar:changed", listener);
    return () => {
      ipcRenderer.removeListener("sidecar:changed", listener);
    };
  },
});
