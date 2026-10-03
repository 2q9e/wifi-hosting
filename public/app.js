const form = document.querySelector("#profile-form");
const nameInput = document.querySelector("#profile-name");
const nameCount = document.querySelector("#name-count");
const saveButton = document.querySelector("#save-profile");
const cancelEditButton = document.querySelector("#cancel-edit");
const profilesList = document.querySelector("#profiles-list");
const emptyState = document.querySelector("#empty-state");
const savedCount = document.querySelector("#saved-count");
const savedMeter = document.querySelector("#saved-meter");
const headingCount = document.querySelector("#heading-count");
const selectedCount = document.querySelector("#selected-count");
const selectAllButton = document.querySelector("#select-all");
const notice = document.querySelector("#notice");
const noticeText = document.querySelector("#notice-text");
const adapterSelect = document.querySelector("#adapter-select");
const intervalSelect = document.querySelector("#interval-select");
const hardwareText = document.querySelector("#hardware-text");
const hardwareNote = document.querySelector("#hardware-note");
const startButton = document.querySelector("#start-broadcast");
const stopButton = document.querySelector("#stop-broadcast");
const currentName = document.querySelector("#current-name");
const airDetail = document.querySelector("#air-detail");
const airPosition = document.querySelector("#air-position");
const airProgress = document.querySelector("#air-progress");
const airIndicator = document.querySelector("#air-indicator");
const airCard = document.querySelector(".air-card");
const formHeading = document.querySelector("#form-heading");

const encoder = new TextEncoder();
const selected = new Set();
let profiles = [];
let system = { canBroadcast: false, adapters: [], note: "Checking Wi-Fi adapter…" };
let broadcast = { state: "stopped", active: false };
let editingId = null;
let nameStartedAt = Date.now();
let lastBroadcastPosition = "";
let pending = false;
let noticeTimer = null;

function showNotice(message, kind = "error") {
  noticeText.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, kind === "success" ? 3800 : 7000);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function updateNameCount() {
  const size = encoder.encode(nameInput.value).length;
  nameCount.textContent = size + " / 32 bytes";
  nameCount.classList.toggle("is-over", size > 32);
  saveButton.disabled = pending || size === 0 || size > 32 || (!editingId && profiles.length >= 20);
}

function buildProfileRow(profile) {
  const row = document.createElement("article");
  row.className = "profile-row";
  row.classList.toggle("is-selected", selected.has(profile.id));

  const pick = document.createElement("label");
  pick.className = "profile-pick";
  pick.setAttribute("aria-label", "Select " + profile.name + " for broadcast rotation");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selected.has(profile.id);
  checkbox.disabled = broadcast.state !== "stopped";
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(profile.id);
    else selected.delete(profile.id);
    render();
  });
  const checkmark = document.createElement("span");
  checkmark.className = "custom-check";
  pick.append(checkbox, checkmark);

  const initials = document.createElement("span");
  initials.className = "profile-initial";
  initials.textContent = profile.name.trim().slice(0, 1).toUpperCase() || "•";

  const details = document.createElement("div");
  details.className = "profile-details";
  const titleLine = document.createElement("div");
  titleLine.className = "profile-title-line";
  const name = document.createElement("strong");
  name.className = "profile-name";
  name.textContent = profile.name;
  const badge = document.createElement("span");
  badge.className = "visibility-badge " + profile.visibility;
  badge.textContent = profile.visibility;
  titleLine.append(name, badge);

  const date = document.createElement("span");
  date.className = "profile-subline";
  date.textContent = "Saved name · beacon only";
  details.append(titleLine, date);

  const actions = document.createElement("div");
  actions.className = "profile-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "icon-button";
  edit.setAttribute("aria-label", "Edit " + profile.name);
  edit.title = "Edit name";
  edit.textContent = "↗";
  edit.disabled = broadcast.state !== "stopped";
  edit.addEventListener("click", () => beginEdit(profile));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-button remove-button";
  remove.setAttribute("aria-label", "Delete " + profile.name);
  remove.title = "Delete name";
  remove.textContent = "×";
  remove.disabled = broadcast.state !== "stopped";
  remove.addEventListener("click", () => removeProfile(profile));
  actions.append(edit, remove);

  row.append(pick, initials, details, actions);
  return row;
}

function renderProfiles() {
  profilesList.replaceChildren();
  for (const profile of profiles) profilesList.append(buildProfileRow(profile));

  const count = profiles.length;
  const selectedTotal = profiles.reduce((total, profile) => total + Number(selected.has(profile.id)), 0);
  savedCount.textContent = count + " / 20";
  headingCount.textContent = String(count).padStart(2, "0");
  selectedCount.textContent = selectedTotal + (selectedTotal === 1 ? " name selected" : " names selected");
  savedMeter.style.width = Math.min(100, count * 5) + "%";
  profilesList.hidden = count === 0;
  emptyState.hidden = count !== 0;
  selectAllButton.disabled = count === 0 || broadcast.state !== "stopped";
  selectAllButton.textContent = count > 0 && selectedTotal === count ? "Clear selection" : "Select all";
  updateNameCount();
}

function renderAdapterOptions() {
  const previous = adapterSelect.value;
  adapterSelect.replaceChildren();

  const adapters = system.adapters.filter((item) => item.supportsAp);
  if (!adapters.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No AP-capable radio found";
    adapterSelect.append(option);
    adapterSelect.disabled = true;
    return;
  }

  for (const adapter of adapters) {
    const option = document.createElement("option");
    option.value = adapter.phy;
    option.textContent = adapter.interfaceName + " · " + adapter.maxApInterfaces + " AP limit";
    adapterSelect.append(option);
  }
  if (adapters.some((item) => item.phy === previous)) adapterSelect.value = previous;
  adapterSelect.disabled = broadcast.state !== "stopped";
}

function renderHardware() {
  renderAdapterOptions();
  if (system.canBroadcast) {
    hardwareNote.dataset.kind = "ready";
    const adapter = system.adapters.find((item) => item.phy === adapterSelect.value);
    const limit = adapter ? adapter.maxApInterfaces : 1;
    hardwareText.textContent = "AP mode is available. This radio sends one rotating beacon at a time (hardware reports up to " + limit + " AP interfaces).";
  } else {
    hardwareNote.dataset.kind = "missing";
    const hint = system.installCommand ? " " + system.installCommand : "";
    hardwareText.textContent = (system.note || "Beacon broadcasting is unavailable on this system.") + hint;
  }
}

function renderBroadcast() {
  const active = broadcast.state !== "stopped";
  const switching = broadcast.state === "switching" || broadcast.state === "starting";
  const running = broadcast.state === "broadcasting";

  airCard.classList.toggle("is-broadcasting", running || switching);
  airIndicator.classList.toggle("is-on", running || switching);
  if (running) {
    currentName.textContent = broadcast.currentName || "Starting beacon…";
    airDetail.textContent = broadcast.total > 1
      ? "Next name in " + broadcast.intervalSeconds + " seconds"
      : "Nearby devices can see this name";
    airPosition.textContent = broadcast.total > 1
      ? "Name " + broadcast.position + " of " + broadcast.total
      : "Single beacon";
  } else if (switching) {
    currentName.textContent = "Changing name…";
    airDetail.textContent = "Refreshing the beacon on this radio";
    airPosition.textContent = broadcast.total > 1
      ? "Name " + Math.max(1, broadcast.position) + " of " + broadcast.total
      : "Starting";
  } else if (broadcast.state === "error") {
    currentName.textContent = "Broadcast stopped";
    airDetail.textContent = broadcast.note || "The radio stopped sending beacons.";
    airPosition.textContent = "Needs attention";
  } else {
    currentName.textContent = "Broadcast off";
    airDetail.textContent = "Choose saved names to get started.";
    airPosition.textContent = "Ready";
  }

  const positionKey = broadcast.currentProfileId + ":" + broadcast.position + ":" + broadcast.state;
  if (positionKey !== lastBroadcastPosition) {
    lastBroadcastPosition = positionKey;
    nameStartedAt = Date.now();
  }
  if (running && broadcast.total > 1) {
    const duration = (broadcast.intervalSeconds || 2) * 1000;
    const elapsed = (Date.now() - nameStartedAt) % duration;
    airProgress.style.width = Math.min(100, (elapsed / duration) * 100) + "%";
  } else {
    airProgress.style.width = running ? "100%" : "0%";
  }

  startButton.hidden = active;
  stopButton.hidden = !active;
  startButton.disabled = pending || !system.canBroadcast || profiles.length === 0 || selected.size === 0;
  stopButton.disabled = pending;
  intervalSelect.disabled = active;
  adapterSelect.disabled = active || !system.canBroadcast;

  const locked = active;
  for (const element of form.elements) element.disabled = locked;
  cancelEditButton.disabled = locked;
  if (!active) {
    formHeading.textContent = editingId ? "Edit name" : "Add a name";
  }
}

function render() {
  renderProfiles();
  renderHardware();
  renderBroadcast();
}

async function refreshState({ quiet = true } = {}) {
  try {
    const state = await request("/api/state");
    profiles = state.profiles || [];
    system = state.system || system;
    broadcast = state.broadcast || broadcast;
    for (const id of [...selected]) {
      if (!profiles.some((profile) => profile.id === id)) selected.delete(id);
    }
    render();
  } catch (error) {
    if (!quiet) showNotice(error.message);
  }
}

function setPending(value) {
  pending = value;
  render();
}

function selectedVisibility() {
  return form.querySelector('input[name="visibility"]:checked')?.value || "private";
}

function beginEdit(profile) {
  editingId = profile.id;
  nameInput.value = profile.name;
  const radio = form.querySelector('input[name="visibility"][value="' + profile.visibility + '"]');
  if (radio) radio.checked = true;
  formHeading.textContent = "Edit name";
  saveButton.querySelector("span:last-child").textContent = "Save changes";
  cancelEditButton.hidden = false;
  updateNameCount();
  nameInput.focus();
  nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetForm() {
  editingId = null;
  form.reset();
  formHeading.textContent = "Add a name";
  saveButton.querySelector("span:last-child").textContent = "Save name";
  cancelEditButton.hidden = true;
  updateNameCount();
}

async function removeProfile(profile) {
  if (!window.confirm('Delete "' + profile.name + '" from saved names?')) return;
  setPending(true);
  try {
    await request("/api/profiles/" + encodeURIComponent(profile.id), { method: "DELETE" });
    selected.delete(profile.id);
    if (editingId === profile.id) resetForm();
    await refreshState();
    showNotice("Name removed from your collection.", "success");
  } catch (error) {
    showNotice(error.message);
  } finally {
    setPending(false);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = { name: nameInput.value, visibility: selectedVisibility() };
  setPending(true);
  try {
    const route = editingId ? "/api/profiles/" + encodeURIComponent(editingId) : "/api/profiles";
    const wasEditing = Boolean(editingId);
    const result = await request(route, {
      method: wasEditing ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    const savedId = result.profile?.id;
    if (savedId) selected.add(savedId);
    resetForm();
    await refreshState();
    showNotice(wasEditing ? "Saved name updated." : "Name saved on this device.", "success");
  } catch (error) {
    showNotice(error.message);
  } finally {
    setPending(false);
  }
});

cancelEditButton.addEventListener("click", resetForm);
nameInput.addEventListener("input", updateNameCount);

selectAllButton.addEventListener("click", () => {
  const allSelected = profiles.length > 0 && profiles.every((profile) => selected.has(profile.id));
  if (allSelected) selected.clear();
  else for (const profile of profiles) selected.add(profile.id);
  render();
});

document.querySelector("#notice-close").addEventListener("click", () => {
  notice.hidden = true;
  clearTimeout(noticeTimer);
});

startButton.addEventListener("click", async () => {
  if (!selected.size) {
    showNotice("Select at least one saved name to broadcast.");
    return;
  }
  setPending(true);
  try {
    const result = await request("/api/broadcast/start", {
      method: "POST",
      body: JSON.stringify({
        profileIds: profiles.filter((profile) => selected.has(profile.id)).map((profile) => profile.id),
        phy: adapterSelect.value,
        intervalSeconds: Number(intervalSelect.value),
      }),
    });
    broadcast = result.broadcast;
    lastBroadcastPosition = "";
    render();
    showNotice(selected.size > 1 ? "Name rotation started." : "Beacon started.", "success");
    await refreshState();
  } catch (error) {
    showNotice(error.message);
    await refreshState();
  } finally {
    setPending(false);
  }
});

stopButton.addEventListener("click", async () => {
  setPending(true);
  try {
    const result = await request("/api/broadcast/stop", { method: "POST", body: "{}" });
    broadcast = result.broadcast;
    render();
    showNotice("Broadcast stopped.", "success");
  } catch (error) {
    showNotice(error.message);
  } finally {
    setPending(false);
    await refreshState();
  }
});

setInterval(() => refreshState(), 2500);
setInterval(renderBroadcast, 120);
updateNameCount();
refreshState({ quiet: false });
