import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILES } from "./profiles.js";
import { createBeaconRotator, inspectSystem } from "./radio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(projectRoot, "public");
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const maxBodyBytes = 16 * 1024;

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  sendJson(response, statusCode, { error: error.message || "The request could not be completed." });
}

async function readJson(request) {
  if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Send this request as JSON."), { statusCode: 415 });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw Object.assign(new Error("The request is too large."), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("The request body is not valid JSON."), { statusCode: 400 });
  }
}

function allowedHost(host, port) {
  return host === "127.0.0.1:" + port || host === "localhost:" + port;
}

function sendPageAsset(response, pathname) {
  const entry = assets.get(pathname);
  if (!entry) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  fs.readFile(path.join(publicDirectory, entry[0]))
    .then((body) => {
      response.writeHead(200, {
        "Content-Type": entry[1],
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(body);
    })
    .catch(() => sendJson(response, 404, { error: "Page asset not found." }));
}

export async function createWifiServer({ port = 4173 } = {}) {
  const store = await createProfileStore();
  const rotator = createBeaconRotator();

  const server = http.createServer(async (request, response) => {
    const requestHost = request.headers.host || "";
    if (!allowedHost(requestHost, port)) {
      sendJson(response, 403, { error: "This app only accepts requests from its local address." });
      return;
    }

    const url = new URL(request.url || "/", "http://127.0.0.1:" + port);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && pathname === "/api/state") {
      try {
        const system = await inspectSystem();
        sendJson(response, 200, {
          profiles: store.list(),
          maxProfiles: MAX_PROFILES,
          system,
          broadcast: rotator.snapshot(),
        });
      } catch (error) {
        sendError(response, error);
      }
      return;
    }

    try {
      if (pathname === "/api/profiles" && request.method === "POST") {
        if (rotator.snapshot().state !== "stopped") {
          throw Object.assign(new Error("Stop broadcasting before editing saved names."), { statusCode: 409 });
        }
        const body = await readJson(request);
        const profile = await store.add(body);
        sendJson(response, 201, { profile });
        return;
      }

      const profileRoute = pathname.match(/^\/api\/profiles\/([^/]+)$/);
      if (profileRoute && request.method === "PUT") {
        if (rotator.snapshot().state !== "stopped") {
          throw Object.assign(new Error("Stop broadcasting before editing saved names."), { statusCode: 409 });
        }
        const body = await readJson(request);
        const profile = await store.update(profileRoute[1], body);
        sendJson(response, 200, { profile });
        return;
      }

      if (profileRoute && request.method === "DELETE") {
        if (rotator.snapshot().state !== "stopped") {
          throw Object.assign(new Error("Stop broadcasting before editing saved names."), { statusCode: 409 });
        }
        await store.remove(profileRoute[1]);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (pathname === "/api/broadcast/start" && request.method === "POST") {
        const body = await readJson(request);
        if (!Array.isArray(body.profileIds)) {
          throw Object.assign(new Error("Select one or more saved names."), { statusCode: 400 });
        }
        const profiles = store.getForBroadcast(body.profileIds);
        const broadcast = await rotator.start({
          profiles,
          phy: body.phy,
          intervalSeconds: body.intervalSeconds,
        });
        sendJson(response, 200, { broadcast });
        return;
      }

      if (pathname === "/api/broadcast/stop" && request.method === "POST") {
        const broadcast = await rotator.stop();
        sendJson(response, 200, { broadcast });
        return;
      }

      if (request.method === "GET") {
        sendPageAsset(response, pathname);
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  await new Promise((resolve, reject) => {
    const fail = (error) => {
      server.off("listening", resolve);
      reject(error);
    };
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });

  return {
    server,
    port,
    async close() {
      await rotator.close();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
