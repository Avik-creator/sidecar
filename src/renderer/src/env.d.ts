import type { SidecarApi, SidecarShell } from "../../shared/types";

declare global {
  interface Window {
    sidecar: SidecarApi;
    sidecarShell: SidecarShell;
    sidecarEvents: {
      onChanged: (handler: () => void) => () => void;
    };
  }
}

export {};
