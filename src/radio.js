import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { accessSync, constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function findExecutable(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function parseInterfaces(output) {
  const found = [];
  let phy = null;
  let current = null;

  const save = () => {
    if (current?.name && current?.type && phy) found.push({ ...current, phy });
  };

  for (const line of output.split("\n")) {
    const phyMatch = line.match(/^\s*phy#(\d+)\s*$/);
    if (phyMatch) {
      save();
      current = null;
      phy = "phy" + phyMatch[1];
      continue;
    }

    const interfaceMatch = line.match(/^\s*Interface\s+(\S+)/);
    if (interfaceMatch) {
      save();
      current = { name: interfaceMatch[1], type: "" };
      continue;
    }

    const typeMatch = line.match(/^\s*type\s+(\S+)/);
    if (current && typeMatch) current.type = typeMatch[1];
  }

  save();
  return found;
}

function getApLimit(info) {
  const limits = [...info.matchAll(/#\{\s*AP\s*\}\s*<=\s*(\d+)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return limits.length ? Math.max(...limits) : 1;
}

async function probeSystem() {
  const paths = {
    iw: findExecutable("iw"),
    hostapd: findExecutable("hostapd"),
    sudo: findExecutable("sudo"),
    ip: findExecutable("ip"),
    true: findExecutable("true") || "/usr/bin/true",
  };

  if (process.platform !== "linux") {
    return {
      paths,
      public: {
        platform: process.platform,
        canBroadcast: false,
        adapters: [],
        missing: ["Linux access-point mode"],
        installCommand: null,
        note: "Beacon broadcasting is available on Linux systems with an AP-capable adapter.",
      },
    };
  }

  if (!paths.iw) {
    return {
      paths,
      public: {
        platform: process.platform,
        canBroadcast: false,
        adapters: [],
        missing: ["iw"],
        installCommand: null,
        note: "Install iw to inspect the wireless adapter.",
      },
    };
  }

  let interfaces = [];
  try {
    const result = await execFileAsync(paths.iw, ["dev"], { timeout: 4000, maxBuffer: 64 * 1024 });
    interfaces = parseInterfaces(result.stdout).filter((item) =>
      item.type === "managed" && !item.name.startsWith("p2p-"),
    );
  } catch {
    interfaces = [];
  }

  const phys = [...new Set(interfaces.map((item) => item.phy))];
  const adapters = [];

  for (const phy of phys) {
    try {
      const result = await execFileAsync(paths.iw, ["phy", phy, "info"], { timeout: 4000, maxBuffer: 256 * 1024 });
      const info = result.stdout;
      const supportsAp = /^\s*\*\s*AP\s*$/m.test(info);
      adapters.push({
        phy,
        interfaceName: interfaces.find((item) => item.phy === phy)?.name || phy,
        supportsAp,
        maxApInterfaces: supportsAp ? getApLimit(info) : 0,
      });
    } catch {
      // Ignore radios whose capabilities cannot be read.
    }
  }

  const missing = [];
  if (!paths.hostapd) missing.push("hostapd");
  if (!paths.sudo) missing.push("sudo");
  if (!paths.ip) missing.push("ip");
  if (!adapters.length) missing.push("wireless adapter");
  if (adapters.length && !adapters.some((adapter) => adapter.supportsAp)) missing.push("AP mode");

  const installCommand = !paths.hostapd
    ? findExecutable("dnf")
      ? "sudo dnf install hostapd"
      : findExecutable("apt")
        ? "sudo apt install hostapd"
        : null
    : null;

  let note = null;
  if (!paths.hostapd) note = "Install hostapd before broadcasting.";
  else if (!adapters.length) note = "No active Wi-Fi adapter was found.";
  else if (!adapters.some((adapter) => adapter.supportsAp)) note = "The available adapter does not report access-point mode.";
  else if (!paths.sudo || !paths.ip) note = "The system is missing a required Linux network command.";

  return {
    paths,
    public: {
      platform: process.platform,
      canBroadcast: missing.length === 0,
      adapters,
      missing,
      installCommand,
      note,
    },
  };
}

export async function inspectSystem() {
  const result = await probeSystem();
  return result.public;
}

function createInterfaceName() {
  return ("wfp" + randomBytes(5).toString("hex")).slice(0, 15);
}

function commandError(program, error) {
  const details = String(error.stderr || error.message || "").trim();
  if (/password is required|a password is required/i.test(details)) {
    return new Error("Run sudo -v in a terminal, then try broadcasting again.");
  }
  return new Error(details || path.basename(program) + " failed.");
}

export function createBeaconRotator() {
  let session = null;
  let queue = Promise.resolve();

  function serialize(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  function snapshot() {
    if (!session) {
      return {
        active: false,
        state: "stopped",
        currentProfileId: null,
        currentName: null,
        position: 0,
        total: 0,
        intervalSeconds: null,
        note: "No Wi-Fi beacons are being sent.",
      };
    }
    return {
      active: session.state === "broadcasting" || session.state === "switching",
      state: session.state,
      currentProfileId: session.currentProfileId,
      currentName: session.currentName,
      position: session.index < 0 ? 0 : session.index + 1,
      total: session.profiles.length,
      intervalSeconds: session.intervalSeconds,
      note: session.lastError || (
        session.profiles.length > 1
          ? "One name is broadcast at a time. Connections are rejected."
          : "This name is broadcast. Connections are rejected."
      ),
    };
  }

  async function runAsAdmin(current, program, args) {
    try {
      return await execFileAsync(current.paths.sudo, ["-n", program, ...args], {
        timeout: 8000,
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      throw commandError(program, error);
    }
  }

  async function stopHostapd(current) {
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = null;
    }

    const child = current.child;
    if (!child) return;
    current.child = null;
    current.intentionalChildStop = true;

    const pidFromFile = async () => {
      try {
        const value = (await fs.readFile(current.pidPath, "utf8")).trim();
        return /^\d+$/.test(value) ? value : null;
      } catch {
        return null;
      }
    };

    const closed = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(resolve, 1800);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
    await closed;

    const pid = await pidFromFile();
    if (pid && child.exitCode === null && child.signalCode === null) {
      try {
        await runAsAdmin(current, current.paths.kill, ["-TERM", pid]);
      } catch {
        // The child signal is still sent below if the privileged pid cannot be read.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  async function setInterfaceAddress(current, bssid) {
    const interfaceName = current.interfaceName;
    await runAsAdmin(current, current.paths.ip, ["link", "set", "dev", interfaceName, "down"]);
    await runAsAdmin(current, current.paths.ip, ["link", "set", "dev", interfaceName, "address", bssid]);
    await runAsAdmin(current, current.paths.ip, ["link", "set", "dev", interfaceName, "up"]);
  }

  async function startHostapd(current, profile) {
    const configPath = path.join(current.runtimeDirectory, "profile-" + profile.id + ".conf");
    const ssidHex = Buffer.from(profile.name, "utf8").toString("hex");
    const configuration = [
      "interface=" + current.interfaceName,
      "driver=nl80211",
      "ssid2=" + ssidHex,
      "hw_mode=g",
      "channel=1",
      "beacon_int=100",
      "auth_algs=1",
      "wpa=0",
      "macaddr_acl=1",
      "accept_mac_file=/dev/null",
      "ap_isolate=1",
      "ignore_broadcast_ssid=0",
      "",
    ].join("\n");
    await fs.writeFile(configPath, configuration, { encoding: "utf8", mode: 0o600 });
    current.configPath = configPath;

    const child = spawn(current.paths.sudo, [
      "-n",
      current.paths.hostapd,
      "-P",
      current.pidPath,
      configPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    current.child = child;
    current.intentionalChildStop = false;

    await new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const capture = (chunk) => {
        output = (output + chunk.toString()).slice(-4000);
        if (/AP-ENABLED/.test(output)) finish();
      };
      const timeout = setTimeout(() => {
        finish(new Error(output.trim() || "hostapd did not confirm that the beacon started."));
      }, 7000);

      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (!current.intentionalChildStop) {
          finish(new Error(output.trim() || "hostapd exited with status " + code + "."));
        }
      });
    });

    current.configPath = configPath;
    current.currentProfileId = profile.id;
    current.currentName = profile.name;
    current.state = "broadcasting";
    current.lastError = null;

    child.once("close", (code) => {
      if (session !== current || current.intentionalChildStop || current.state === "stopping") return;
      current.state = "error";
      current.lastError = "The beacon process stopped (exit " + (code ?? "unknown") + ").";
      if (current.timer) clearTimeout(current.timer);
      current.timer = null;
      current.currentProfileId = null;
      current.currentName = null;
    });
  }

  async function stopCurrentSession(current = session) {
    if (!current) return;
    current.state = "stopping";
    if (current.timer) clearTimeout(current.timer);
    current.timer = null;
    await stopHostapd(current);

    if (current.interfaceName) {
      try {
        await runAsAdmin(current, current.paths.iw, ["dev", current.interfaceName, "del"]);
      } catch {
        // Continue cleanup even if the driver already removed the AP interface.
      }
    }
    await fs.rm(current.runtimeDirectory, { recursive: true, force: true }).catch(() => {});
    if (session === current) session = null;
  }

  function scheduleNext(current) {
    if (current.profiles.length < 2 || current.state !== "broadcasting") return;
    current.timer = setTimeout(() => {
      serialize(async () => {
        if (session !== current || current.state !== "broadcasting") return;
        current.state = "switching";
        current.currentProfileId = null;
        current.currentName = null;
        await stopHostapd(current);
        current.index = (current.index + 1) % current.profiles.length;
        const profile = current.profiles[current.index];
        await setInterfaceAddress(current, profile.bssid);
        await startHostapd(current, profile);
        scheduleNext(current);
      }).catch(async (error) => {
        if (session !== current) return;
        current.state = "error";
        current.lastError = error.message;
        await stopHostapd(current);
      });
    }, current.intervalSeconds * 1000);
  }

  async function start({ profiles, phy, intervalSeconds = 2 }) {
    return serialize(async () => {
      if (session) throw Object.assign(new Error("Stop the current broadcast before starting another."), { statusCode: 409 });
      if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 20) {
        throw Object.assign(new Error("Choose between 1 and 20 saved names."), { statusCode: 400 });
      }
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 10) {
        throw Object.assign(new Error("Choose a rotation interval from 1 to 10 seconds."), { statusCode: 400 });
      }

      const system = await probeSystem();
      if (!system.public.canBroadcast) {
        const detail = system.public.installCommand
          ? system.public.note + " Install it with: " + system.public.installCommand
          : system.public.note || "This system cannot broadcast Wi-Fi beacons.";
        throw Object.assign(new Error(detail), { statusCode: 503 });
      }
      const adapter = system.public.adapters.find((item) => item.phy === phy && item.supportsAp);
      if (!adapter) throw Object.assign(new Error("Choose an AP-capable Wi-Fi adapter."), { statusCode: 400 });

      const uniqueIds = new Set(profiles.map((profile) => profile.id));
      if (uniqueIds.size !== profiles.length || profiles.some((profile) =>
        !profile || typeof profile.id !== "string" || typeof profile.name !== "string" ||
        typeof profile.bssid !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(profile.bssid),
      )) {
        throw Object.assign(new Error("The selected saved names are invalid."), { statusCode: 400 });
      }

      const current = {
        paths: {
          ...system.paths,
          kill: findExecutable("kill") || "/usr/bin/kill",
        },
        state: "starting",
        profiles: profiles.map((profile) => ({ ...profile })),
        intervalSeconds,
        index: 0,
        currentProfileId: null,
        currentName: null,
        interfaceName: createInterfaceName(),
        runtimeDirectory: await fs.mkdtemp(path.join(os.tmpdir(), "wifi-hosting-")),
        pidPath: "",
        configPath: null,
        child: null,
        timer: null,
        lastError: null,
        intentionalChildStop: false,
      };
      current.pidPath = path.join(current.runtimeDirectory, "hostapd.pid");
      session = current;

      try {
        await runAsAdmin(current, current.paths.true, []);
        await runAsAdmin(current, current.paths.iw, [
          "phy",
          adapter.phy,
          "interface",
          "add",
          current.interfaceName,
          "type",
          "__ap",
        ]);
        const profile = current.profiles[0];
        await setInterfaceAddress(current, profile.bssid);
        await startHostapd(current, profile);
        scheduleNext(current);
        return snapshot();
      } catch (error) {
        await stopCurrentSession(current);
        throw Object.assign(new Error(error.message), { statusCode: error.statusCode || 500 });
      }
    });
  }

  async function stop() {
    return serialize(async () => {
      await stopCurrentSession();
      return snapshot();
    });
  }

  return {
    snapshot,
    start,
    stop,
    async close() {
      await serialize(() => stopCurrentSession());
    },
  };
}
