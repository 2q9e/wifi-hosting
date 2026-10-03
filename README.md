# Wifi Hoster

A local browser app for saving up to 20 custom Wi-Fi names and broadcasting them as beacon-only SSIDs. Public/private is a label for organizing profiles; it does not change radio behavior. No passwords are collected, no DHCP or internet sharing is configured, and client associations are rejected.

## Run

Requirements: Node.js 20+, Linux with an AP-capable Wi-Fi adapter, `iw`, `hostapd`, and `sudo`.

On Fedora, install hostapd if it is missing:

```sh
sudo dnf install hostapd
```

From this project folder, register the command and start the frontend:

```sh
npm link
Wifi start
```

The app opens at `http://127.0.0.1:4173` and stays attached to the terminal. Press Ctrl+C to close it. Before broadcasting, run `sudo -v` in a terminal so the app can create a temporary AP interface and launch hostapd without saving or requesting a password in the app.

## How broadcasting works

The built-in radio sends one selected name at a time and rotates through the selection. Each profile gets a distinct local BSSID, so nearby Wi-Fi scanners can distinguish the names as they cycle. A scanner may need a full rotation to discover every name. The radio cannot send all 20 names simultaneously: the adapter available during development reports at most two AP interfaces and does not advertise multiple-BSSID support. The app uses one AP interface and needs no additional radio.

Beacons are open so the names appear in Wi-Fi scans. The hostapd access-control list rejects every client association. Public/private remains a display label only. Profiles are saved on this device in `~/.wifi-hosting/profiles.json`.
