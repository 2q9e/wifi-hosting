# WiFi Hoster

A local browser app for saving up to 20 Wi-Fi network names and choosing which ones to broadcast. The app binds only to `127.0.0.1`.

Each saved name is an SSID, limited to 32 UTF-8 bytes. Public/private is a label for organizing profiles; it does not change access behavior. Broadcast beacons are open, and the access point rejects every client association. The app does not provide DHCP, internet sharing, or a path for clients to connect.

## Run

Install Node.js, `iw`, and `hostapd`, then link the local command from this folder:

```sh
npm link
Wifi start
```

`Wifi start` opens the frontend. The server stays attached to the terminal; press Ctrl+C to stop it and any active broadcast. On Linux, run `sudo -v` in a terminal before starting a broadcast so the app can create a temporary AP interface and run `hostapd` with administrator privileges. Broadcasting is unavailable on systems without Linux AP mode, `iw`, or `hostapd`.

The number of simultaneous SSIDs is limited by the wireless adapter. On the adapter available during development, Linux reports a maximum of two AP interfaces. Profiles remain saved even when they are not being broadcast.

No Wi-Fi passwords are collected or stored. Broadcasting is opt-in from the frontend and ends when you stop it or exit the server.
