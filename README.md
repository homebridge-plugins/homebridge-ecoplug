# homebridge-ecoplug

[![npm version](https://badgen.net/npm/v/homebridge-ecoplug?icon=npm&label)](https://www.npmjs.com/package/homebridge-ecoplug) 
[![npm downloads](https://badgen.net/npm/dt/homebridge-ecoplug?label=downloads)](https://www.npmjs.com/package/homebridge-ecoplug) 
[![license](https://badgen.net/github/license/IWCaldwell/homebridge-ecoplug)](LICENSE.txt)

<p>The Homebridge plugin for ECO Plugs and WION Wi‑Fi switches. **All communication is local‑network only** (uses UDP broadcasts) and requires the plugin to be on the same subnet as the devices; it does not talk to the Eco Plug cloud servers like the official app.</p>

## Table of Contents
1. [Features](#features)
2. [Compatibility](#compatibility)
3. [Installation](#installation)
4. [Configuration](#configuration)
   - [Minimal config](#minimal-config-auto-discovery)
   - [Recommended config](#recommended-config-local-only--intervals)
   - [Static-IP config for newer KAB devices](#static-ip-config-for-newer-kab-devices)
5. [Parameters](#parameters)
   - [Main options](#main-options)
   - [Advanced options](#advanced-options)
   - [Per-device options](#per-device-options-devices)
6. [Protocol and Port Support](#protocol-and-port-support)
7. [Tested Devices](#tested-devices)
8. [Firewall checklist](#firewall-checklist)
9. [Troubleshooting](#troubleshooting)
10. [Credits](#credits)

## Features

- Supports both protocol families used by ECO devices:
  - Legacy FtNetManager devices
  - Newer KABNetManager devices (including port 9090 command flow)
- Auto discovery for both stacks:
  - Active legacy broadcast discovery (polled on interval)
  - Passive KAB beacon discovery (always listened for; status updates from beacons are automatically applied)
- KAB devices always use the beacon’s host/port and raw integer device ID; the discovery handshake is skipped unconditionally.
- Optional static-IP onboarding per device (no need to wait for beacon)
- **Local‑network only:** relies on broadcast packets; the plugin must run on the same LAN/subnet as the devices and has no cloud connectivity
- Local-only safety mode (prevents control of non-private IPs)
- Per-device overrides for protocol, command port, key, and password

## Compatibility

| Requirement | Version      |
|-------------|--------------|
| Node.js     | 22, 24, 25   |
| Homebridge  | v1, v2       |

## Installation

### Homebridge UI

Search for **homebridge-ecoplug** and install.

### Command line

```sh
sudo npm install -g homebridge-ecoplug
```

## Configuration

### Minimal config (auto discovery)

```json
"platforms": [
  {
    "platform": "EcoPlug",
    "name": "EcoPlug",
    "enabled": true
  }
]
```

### Recommended config (local-only + intervals)

```json
"platforms": [
  {
    "platform": "EcoPlug",
    "name": "EcoPlug",
    "localOnly": true,
    "port": 9000,
    "pollingInterval": 10,
    "discoverInterval": 60,
    "deviceInactiveTimeout": 180,
    "deviceRemoveTimeout": 0
  }
]
```

### Static-IP config for newer KAB devices

Use this when you want immediate startup registration without waiting for a beacon.

```json
"platforms": [
  {
    "platform": "EcoPlug",
    "name": "EcoPlug",
    "devices": [
      {
        "id": "ECO-78ABCDEF",
        "host": "192.168.1.50",
        "protocol": "kab",
        "commandPort": 9090,
        "kabKey": "keenfeng",
        "kabPass": "111111"
      }
    ]
  }
]
```

## Parameters

### Main options

| Parameter   | Required | Default   | Description                                       |
|-------------|----------|-----------|---------------------------------------------------|
| `platform`  | yes      | `EcoPlug` | Must be `"EcoPlug"`                              |
| `name`      | yes      | `EcoPlug` | Display name in Homebridge logs                  |
| `localOnly` | no       | `true`    | Only allow private LAN addresses for discovery/control |
| `port`      | no       | `9000`    | Incoming UDP port for legacy status messages     |

### Advanced options

| Parameter              | Default | Description                                                                                              |
|------------------------|---------|----------------------------------------------------------------------------------------------------------|
| `pollingInterval`      | `10`    | Seconds between status polls for **legacy** devices (`0` disables polling)                               |
| `discoverInterval`     | `60`    | Seconds between legacy discovery broadcasts (`0` disables)                                               |
| `deviceInactiveTimeout`| `180`   | Mark accessory unavailable after this many seconds without response (`0` disables)                      |
| `deviceRemoveTimeout`  | `0`     | Remove accessory after this many seconds without response (`0` disables)                                |
| `kabMaxFailures`       | `15`    | **(KAB only)** Give up on additional status queries after this many consecutive timeouts; resets on success or discovery |
| `kabBindPort`          | `9090`  | **(KAB only)** UDP source port to bind for outgoing commands (`0` lets OS choose ephemeral port)       

### Per-device options (`devices[]`)

| Field         | Required | Description                                                          |
|---------------|----------|----------------------------------------------------------------------|
| `id`          | yes      | Device ID, e.g. `ECO-78ABCDEF`                                      |
| `host`        | no       | Static IP to seed device at startup                                 |
| `protocol`    | no       | `auto` (default), `legacy`, or `kab`                                |
| `commandPort` | no       | Override command port (typically `9090` KAB, `80` legacy)           |
| `kabKey`      | no       | KAB credential key (usually auto-populated from beacon)             |
| `kabPass`     | no       | KAB command password (default `111111`)                             |
| `kabMaxFailures`| no     | Override global max consecutive status failures for this device     |
| `kabBindPort` | no       | Override source bind port just for this device (0 = ephemeral)      |

## Protocol and Port Support

| Protocol                 | Discovery                    | Commands | Typical devices                    |
|--------------------------|------------------------------|----------|-------------------------------------|
| Legacy (FtNetManager)    | UDP 25 + 5888 (broadcast)    | UDP 80   | Older CT-065W / WiOn models        |
| KAB (KABNetManager)      | UDP 10228 (beacon)           | UDP 9090 | Newer ECO firmware                 |

The plugin auto-selects protocol per device by discovery data. You can also force a protocol per device in config.

## Tested Devices

- ECO Plugs CT-065W Wi-Fi Controlled Outlet (legacy + KAB firmware)
- WiOn Outdoor Outlet 50049
- Wion E211835 RC-031W Indoor Plugs
- ~~Woods WiOn 50052 WiFi In-Wall Light Switch~~ (recalled due to fire hazard)
- DEWENWILS 300W Smart Low Voltage Transformer

## Firewall checklist

Allow these UDP ports on the Homebridge host:

| Direction | Port | Use                                    |
|-----------|------|----------------------------------------|
| Outbound  | 25   | Legacy broadcast discovery             |
| Outbound  | 5888 | Legacy broadcast discovery (alt)       |
| Inbound   | 9000 | Legacy status responses                |
| Inbound   | 10228| KAB beacons                            |
| Outbound  | 9090 | KAB commands                           |

*Example firewall rules shown use `ufw` on a Linux host; Homebridge installations often don’t include it.  Apply equivalent rules using whatever firewall tool your system provides.*

```sh
# ufw example (Linux)
sudo ufw allow in 9000/udp
sudo ufw allow in 10228/udp
sudo ufw allow out 25/udp
sudo ufw allow out 5888/udp
sudo ufw allow out 9090/udp
```
## Troubleshooting

- Device not found:
  - Confirm same LAN/subnet
  - Confirm UDP broadcast allowed
  - Add static `host` under `devices[]` for immediate startup registration
- Accessory shows no response:
  - Check firewall rules above
  - Verify `localOnly` is not blocking a non-private address
  - Verify `commandPort` override for that device
- Device disappears frequently:
  - Increase `deviceInactiveTimeout`
  - Leave `deviceRemoveTimeout` at `0` unless you explicitly want auto-removal

## Credits

- Danimal4326 — Initial ECO Plug protocol work
- NorthernMan54 — Device auto-discovery
- askovi — Tested WiOn Outdoor Outlet 50049
- JeffreyStocker — Additional addons
- IWCaldwell - KAB Protocal implementation, Homebridge V2 support and conversion to TypeScript