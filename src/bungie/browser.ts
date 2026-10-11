import { spawn } from "node:child_process";

/** Launch the OS browser without a shell or embedded login view. */
export function openSystemBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
  child.on("error", () => console.error("Could not open the system browser automatically. Open the printed local URL yourself."));
  child.on("exit", (code) => { if (code && code !== 0) console.error("The system browser launcher failed. Open the printed local URL yourself."); });
  child.unref();
}
