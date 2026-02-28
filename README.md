# homebridge-ecoplug

Homebridge platform plugin for ECO Plugs and WION Wi-Fi switches.

This plugin supports both legacy ECO firmware and newer KAB firmware with local-only control options.

## Features

- Supports both protocol families used by ECO devices:
  - Legacy FtNetManager devices
  - Newer KABNetManager devices (including port 9090 command flow)
- Auto discovery for both stacks:
  - Active legacy broadcast discovery
  - Passive KAB beacon discovery
- Optional static-IP onboarding per device (no need to wait for beacon)
- Local-only safety mode (prevents control of non-private IPs)
- Per-device overrides for protocol, command port, key, and password

## Compatibility

| Requirement | Version |
|---|---|
| Node.js | 22, 24, 25 |
| Homebridge | v1, v2 |

## Protocol and port support

| Protocol | Discovery | Commands | Typical devices |
|---|---|---|---|
| Legacy (FtNetManager) | UDP 25 + 5888 (broadcast) | UDP 80 | Older CT-065W / WiOn models |
| KAB (KABNetManager) | UDP 10228 (beacon) | UDP 9090 | Newer ECO firmware |

The plugin auto-selects protocol per device by discovery data. You can also force a protocol per device in config.

## Tested devices

- ECO Plugs CT-065W Wi-Fi Controlled Outlet (legacy + KAB firmware)
- WiOn Outdoor Outlet 50049
- Wion E211835 RC-031W Indoor Plugs
- ~~Woods WiOn 50052 WiFi In-Wall Light Switch~~ (recalled due to fire hazard)

## Installation

### Homebridge UI

Search for `homebridge-ecoplug` and install.

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
    "name": "EcoPlug"
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

| Parameter | Required | Default | Description |
|---|---|---|---|
| `platform` | yes | `EcoPlug` | Must be `"EcoPlug"` |
| `name` | yes | `EcoPlug` | Display name in Homebridge logs |
| `localOnly` | no | `true` | Only allow private LAN addresses for discovery/control |
| `port` | no | `9000` | Incoming UDP port for legacy status messages |

### Advanced options

| Parameter | Default | Description |
|---|---|---|
| `pollingInterval` | `10` | Seconds between status polls (`0` disables polling) |
| `discoverInterval` | `60` | Seconds between legacy discovery broadcasts (`0` disables) |
| `deviceInactiveTimeout` | `180` | Mark accessory unavailable after this many seconds without response (`0` disables) |
| `deviceRemoveTimeout` | `0` | Remove accessory after this many seconds without response (`0` disables) |

### Per-device options (`devices[]`)

| Field | Required | Description |
|---|---|---|
| `id` | yes | Device ID, e.g. `ECO-78ABCDEF` |
| `host` | no | Static IP to seed device at startup |
| `protocol` | no | `auto` (default), `legacy`, or `kab` |
| `commandPort` | no | Override command port (typically `9090` KAB, `80` legacy) |
| `kabKey` | no | KAB credential key (usually auto-populated from beacon) |
| `kabPass` | no | KAB command password (default `111111`) |

## Firewall checklist

Allow these UDP ports on the Homebridge host:

| Direction | Port | Use |
|---|---|---|
| Outbound | 25 | Legacy broadcast discovery |
| Outbound | 5888 | Legacy broadcast discovery (alt) |
| Inbound | 9000 | Legacy status responses |
| Inbound | 10228 | KAB beacons |
| Outbound | 9090 | KAB commands |

Example (`ufw`):

```sh
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