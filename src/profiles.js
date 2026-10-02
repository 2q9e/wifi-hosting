import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_PROFILES = 20;
const dataDirectory = path.join(os.homedir(), ".wifi-hosting");
const profilesPath = path.join(dataDirectory, "profiles.json");

function newBssid(used) {
  for (;;) {
    const bytes = randomBytes(6);
    bytes[0] = (bytes[0] | 0x02) & 0xfe;
    const address = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
    if (!used.has(address)) return address;
  }
}

function isValidBssid(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value);
}

function normalizeStoredProfiles(value) {
  if (!Array.isArray(value)) return [];
  const used = new Set();
  const normalized = [];

  for (const item of value.slice(0, MAX_PROFILES)) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const visibility = item.visibility === "public" ? "public" : "private";
    if (!name || Buffer.byteLength(name, "utf8") > 32 || /[\u0000-\u001f\u007f]/u.test(name)) continue;

    let bssid = isValidBssid(item.bssid) ? item.bssid.toLowerCase() : "";
    if (!bssid || used.has(bssid)) bssid = newBssid(used);
    used.add(bssid);
    normalized.push({
      id: typeof item.id === "string" ? item.id : randomUUID(),
      name,
      visibility,
      bssid,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
    });
  }

  return normalized;
}

function validateProfileInput(input) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const visibility = input?.visibility;

  if (!name) throw Object.assign(new Error("Enter a network name."), { statusCode: 400 });
  if (Buffer.byteLength(name, "utf8") > 32) {
    throw Object.assign(new Error("Wi-Fi names can contain at most 32 UTF-8 bytes."), { statusCode: 400 });
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw Object.assign(new Error("The name cannot contain control characters."), { statusCode: 400 });
  }
  if (visibility !== "public" && visibility !== "private") {
    throw Object.assign(new Error("Choose public or private."), { statusCode: 400 });
  }

  return { name, visibility };
}

export async function createProfileStore() {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });

  let profiles = [];
  try {
    const saved = JSON.parse(await fs.readFile(profilesPath, "utf8"));
    profiles = normalizeStoredProfiles(saved);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read saved Wi-Fi names: ${error.message}`);
    }
  }

  async function persist(nextProfiles) {
    const temporaryPath = `${profilesPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(nextProfiles, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, profilesPath);
    await fs.chmod(profilesPath, 0o600);
    profiles = nextProfiles;
  }

  return {
    list() {
      return profiles.map(({ bssid, ...profile }) => profile);
    },

    async add(input) {
      if (profiles.length >= MAX_PROFILES) {
        throw Object.assign(new Error(`You can save up to ${MAX_PROFILES} names.`), { statusCode: 409 });
      }
      const { name, visibility } = validateProfileInput(input);
      if (profiles.some((profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw Object.assign(new Error("That name is already saved."), { statusCode: 409 });
      }

      const used = new Set(profiles.map((profile) => profile.bssid));
      const now = new Date().toISOString();
      const profile = {
        id: randomUUID(),
        name,
        visibility,
        bssid: newBssid(used),
        createdAt: now,
        updatedAt: now,
      };
      await persist([...profiles, profile]);
      return this.list().at(-1);
    },

    async update(id, input) {
      const current = profiles.find((profile) => profile.id === id);
      if (!current) throw Object.assign(new Error("That saved name no longer exists."), { statusCode: 404 });
      const { name, visibility } = validateProfileInput(input);
      if (profiles.some((profile) => profile.id !== id && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw Object.assign(new Error("That name is already saved."), { statusCode: 409 });
      }

      const updated = profiles.map((profile) =>
        profile.id === id ? { ...profile, name, visibility, updatedAt: new Date().toISOString() } : profile,
      );
      await persist(updated);
      return this.list().find((profile) => profile.id === id);
    },

    getForBroadcast(ids) {
      const selected = ids.map((id) => profiles.find((profile) => profile.id === id));
      if (selected.some((profile) => !profile)) {
        throw Object.assign(new Error("One or more selected names no longer exist."), { statusCode: 404 });
      }
      return selected.map((profile) => ({ ...profile }));
    },

    async remove(id) {
      if (!profiles.some((profile) => profile.id === id)) {
        throw Object.assign(new Error("That saved name no longer exists."), { statusCode: 404 });
      }
      await persist(profiles.filter((profile) => profile.id !== id));
    },
  };
}
