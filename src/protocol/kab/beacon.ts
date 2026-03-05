/**
 * KABNetManager beacon listener (port 10228).
 *
 * The device broadcasts an encrypted ~272-byte UDP packet on port 10228.
 * The app's a$g::run() in KabNetManager:
 *   1. Calls CPPParseBytesBroadcastEncryption(raw, decrypted)
 *   2. Validates magic bytes: decrypted[5]=0x55, [6]=0xAA, [7]=0x55, [8]=0xAA
 *   3. Validates name string starting at byte 9 == "ECO Plugs"
 *   4. Parses device fields from the decrypted buffer (KabNetDefine$d layout)
 *   5. Sends an unencrypted 36-byte ACK back to the device
 *
 * KabNetDefine$d::a([B) layout (after decryption):
 *   Offset  5: 0x55 magic
 *   Offset  6: 0xAA magic
 *   Offset  7: 0x55 magic
 *   Offset  8: 0xAA magic
 *   Offset  9: "ECO Plugs" name (9 bytes, then nulls)
 *   Offset 20: fields begin
 *   Offset 28: firmware version int
 *   Offset 36: deviceIdInt  (LE uint32 — matches cVar.f2465H in app)
 *   Offset 44: deviceId string ASCII (16 bytes) — e.g. "ECO-780XXXXX"
 *   Offset 60: device name string (16 bytes)
 *   Offset 76: command port int (LE uint32)
 *   Offset 80: cloud hostname string (64 bytes) — e.g. "server1.eco-plugs.net"
 *   Offset 144: firmware version string (6 bytes)
 *   Offset 152: localKey string (12 bytes)  ← USED AS kabKey IN COMMANDS (cVar2.f2467J)
 *   Offset 164: localPass string (32 bytes) ← USED AS password IN COMMANDS (cVar2.f2472O)
 *   Offset 240: powerState int (LE uint32: 0=off, 1=on)
 *   Offset 244: dimmable int (LE uint32)
 *   Offset 268: checksum int
 *
 * 36-byte unencrypted ACK (sent FROM Homebridge back TO device):
 *   Offset  0: "ECO Plugs   " (12 ASCII bytes, space-padded)
 *   Offset 12: random int (4 bytes big-endian)
 *   Offset 16: random int (4 bytes big-endian)
 *   Offset 20: current Unix timestamp (4 bytes big-endian)
 *   Offset 24: random int (4 bytes big-endian)
 *   Offset 28: current Unix timestamp (4 bytes big-endian)
 *   Offset 32: random int (4 bytes big-endian)
 */

import * as dgram from 'dgram';
import { cppParseBytesBroadcastEncryption } from './cipher.js';
import { KAB_BEACON_PORT, KAB_COMMAND_PORT, KAB_DEVICE_PORT } from '../../settings.js';
import type { DeviceInfo } from '../types.js';

import { kabSocket } from './socket.js';

const ECO_MAGIC = [0x55, 0xaa, 0x55, 0xaa];
const ECO_NAME  = 'ECO Plugs';

/** Minimum raw beacon size that can contain the needed fields. */
const BEACON_MIN_SIZE = 272;

/**
 * Parse a decrypted KAB beacon buffer into a DeviceInfo record.
 * Returns null if the magic bytes or name don't match.
 */
export function parseKabBeacon(decrypted: Buffer): DeviceInfo | null {
    if (decrypted.length < BEACON_MIN_SIZE) return null;

    // Validate magic bytes at offsets 5‥8 using the constant
    for (let i = 0; i < ECO_MAGIC.length; i++) {
        if (decrypted[5 + i] !== ECO_MAGIC[i]) return null;
    }

    // Validate "ECO Plugs" — some firmware versions place this at offset 9,
    // others insert an extra null byte at offset 9 and start the string at
    // offset 10.  This byte is ONLY padding before the name; all data fields
    // (id, name, cmdPort, kabKey, …) remain at their original documented offsets
    // in both variants.
    const nameAt9  = decrypted.toString('ascii', 9,  9  + ECO_NAME.length);
    const nameAt10 = decrypted.toString('ascii', 10, 10 + ECO_NAME.length);
    if (nameAt9 !== ECO_NAME && nameAt10 !== ECO_NAME) return null;

    // Null-terminated ASCII (same as O.d.d in Android app)
    const readStr  = (off: number, len: number) => {
        let s = '';
        for (let i = off; i < off + len && decrypted[i] !== 0; i++) s += String.fromCharCode(decrypted[i] & 0xff);
        return s;
    };
    // All ints in the beacon are little-endian (O.d.c / O.d.g in Android app)
    const readIntLE = (off: number) => decrypted.readUInt32LE(off);

    const idStr      = readStr(44, 16);
    let name         = readStr(60, 16) || idStr;
    // some firmware unfortunately uses the device's IP address as the beacon
    // name; that's not very helpful as a HomeKit accessory name.  if the
    // parsed name string looks like an IPv4 address we ignore it and fall back
    // to the ID string instead (which is usually `ECO-78…`).
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
        name = idStr;
    }
    const rawCmdPort = readIntLE(76);
    const cmdPort    = (rawCmdPort > 0 && rawCmdPort < 65536) ? rawCmdPort : KAB_DEVICE_PORT;
    // The device's LOCAL auth key is at offset 152 (12B) — KabNetManager sets
    // cVar2.f2467J = beacon.f2512o = d(decrypted, 152, 12).  This is what the
    // device checks when it receives a command packet.
    const localKey   = readStr(152, 12);
    // The LOCAL auth password is at offset 164 (32B) — cVar2.f2472O = beacon.f2513p
    const localPass  = readStr(164, 32);
    const powerState = readIntLE(240);
    const dimmable   = readIntLE(244);
    // Derive deviceIdInt from the ID string (e.g. "ECO-780C476D" → 0x0C476D).
    // The prefix is actually "ECO-78", not just "ECO-", as seen in the Android app:
    // String.format("ECO-78%06X", Integer.valueOf(deviceId))
    const idHex       = idStr.replace(/^ECO-78/i, '').replace(/^ECO-/i, '').trim();
    const deviceIdInt = readIntLE(36) || (parseInt(idHex, 16) >>> 0);

    return {
        id:             idStr || `KAB-${deviceIdInt.toString(16).toUpperCase()}`,
        name,
        host:           '',   // filled in by caller from remote.address
        port:           cmdPort,
        protocol:       'kab',
        status:         powerState !== 0,
        dimmable,
        kabDeviceIdInt: isNaN(deviceIdInt) ? 0 : deviceIdInt,
        kabKey:         localKey,   // from beacon offset 152 — actual local auth key
        kabPass:        localPass,  // from beacon offset 164 — actual local auth pass
        kabCommandPort: cmdPort,
        cloudCredential: readStr(80, 64),  // cloud hostname (for reference only)
        kabBeaconOffset264: readIntLE(264),
    };
}

/**
 * Build the 36-byte unencrypted ACK packet that the app sends back to a
 * device after receiving its beacon.
 */
export function buildBeaconAck(): Buffer {
    const ack = Buffer.alloc(36, 0);
    // "ECO Plugs   " (12 bytes: 9 chars + 3 spaces)
    ack.write('ECO Plugs   ', 0, 12, 'ascii');
    const ts = Math.floor(Date.now() / 1000) >>> 0;
    ack.writeUInt32BE((Math.random() * 0xffffffff) >>> 0,  12);
    ack.writeUInt32BE((Math.random() * 0xffffffff) >>> 0,  16);
    ack.writeUInt32BE(ts,                                   20);
    ack.writeUInt32BE((Math.random() * 0xffffffff) >>> 0,  24);
    ack.writeUInt32BE(ts,                                   28);
    ack.writeUInt32BE((Math.random() * 0xffffffff) >>> 0,  32);
    return ack;
}

export type BeaconCallback = (device: DeviceInfo) => void;

/**
 * Start a UDP listener on port 10228 that decrypts incoming KAB device
 * beacons and emits a DeviceInfo for each valid one.
 *
 * @param onBeacon   Called once per valid beacon (may be called repeatedly
 *                   from the same device as it re-broadcasts).
 * @param log        Optional logging function.
 * @returns          The bound dgram socket (call .close() to stop listening).
 */
export interface BeaconListenerOptions {
    /**
     * When false, the 36-byte ACK packet will not be sent.  Useful for
     * devices whose firmware treats the ACK as an actual command (many
     * older KAB units crash or toggle the relay when they see it).
     *
     * Defaults to `true` (ACK is sent).  The plugin passes
     * `{ack: !cfg.kabSkipBeaconAck}` so the Homebridge config option is
     * inverted here.
     */
    ack?: boolean;
}

export function startKabBeaconListener(
    onBeacon: BeaconCallback,
    log?: (msg: string) => void,
    opts: BeaconListenerOptions = {},
): dgram.Socket {
    const sock = dgram.createSocket('udp4');

    sock.on('error', (err) => {
        log?.(`KAB beacon socket error: ${err.message}`);
        sock.close();
    });

    sock.on('message', (raw: Buffer, remote: dgram.RemoteInfo) => {
        if (raw.length < BEACON_MIN_SIZE) return;

        const decrypted = Buffer.alloc(raw.length, 0);
        try {
            cppParseBytesBroadcastEncryption(raw, decrypted);
        } catch {
            return;
        }

        const device = parseKabBeacon(decrypted);
        if (!device) return;

        device.host = remote.address;
        if (!device.port || device.port === 0) {
            device.port = KAB_DEVICE_PORT;
        }

        const beaconMsg = `KAB beacon from ${remote.address}: ${device.id}` +
                          ` "${device.name}" port=${device.port}` +
                          ` offset=0x${(device.kabBeaconOffset264||0).toString(16)}`;
        log?.(beaconMsg);

        // The 36‑byte ACK is normally sent from the command port so that the
        // device records us as an active controller.  Some firmware versions
        // erroneously interpret it as a power command, so allow callers to
        // suppress it via `opts.ack`.
        if (opts.ack !== false) {
            // Send the ACK from KAB_COMMAND_PORT (9090), NOT from the beacon socket.
            // The Android app uses a single socket bound to 9090 for both ACK and commands,
            // so the device registers the controller as IP:9090 and replies there.
            // If we send the ACK from port 10228, the device will ignore commands from 9090.
            const ack = buildBeaconAck();
            if (log) kabSocket.setLogger(log);
            kabSocket.send(ack, remote.address, remote.port).then(() => {
                log?.(`KAB beacon ACK sent from port ${KAB_COMMAND_PORT} to ${remote.address}:${remote.port}`);
            }).catch(err => {
                log?.(`KAB beacon ACK send failed: ${err.message}`);
            });
        } else {
            log?.(`KAB beacon ACK suppressed for ${remote.address}`);
        }

        onBeacon(device);
    });

    sock.bind(KAB_BEACON_PORT, () => {
        sock.setBroadcast(true);
        log?.(`KAB beacon listener bound to port ${KAB_BEACON_PORT}`);
    });

    return sock;
}
