#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWifiServer } from "../src/server.js";

const command = process.argv[2];
const port = Number(process.env.WIFI_PORT || 4173);
const url = `http://127.0.0.1:${port}`;

function openFrontend(address) {
  if (process.platform === "darwin") {
    const child = spawn("open", [address], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  if (process.platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", address], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [address], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    console.log(`Open this address in your browser: ${address}`);
  });
  child.unref();
}

if (command !== "start") {
  console.error("Usage: Wifi start");
  process.exit(2);
}

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("WIFI_PORT must be a port between 1024 and 65535.");
  process.exit(2);
}

try {
  const existing = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
  if (existing.ok) {
    console.log(`WiFi Hoster is already running at ${url}`);
    openFrontend(url);
    process.exit(0);
  }
} catch {
  // No server is listening on this port yet.
}

const app = await createWifiServer({ port });
console.log(`WiFi Hoster is running at ${url}`);
console.log("Press Ctrl+C to stop the app and any active broadcast.");
openFrontend(url);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
