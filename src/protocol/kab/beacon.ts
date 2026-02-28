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
 *   Offset 20: checksum (int, big-endian) — also at offset 268
 *   Offset 28: firmware version int
 *   Offset 44: deviceId string ASCII (16 bytes) — e.g. "ECO-78XXXXXX"
 *   Offset 60: device name string (16 bytes)
 *   Offset 76: command port int (big-endian)
 *   Offset 80: credential/key string (64 bytes) — used as deviceKey
 *   Offset 144: firmware version string (6 bytes)
 *   Offset 152: cloud server IP string (12 bytes)   [in notes: offset 164]
 *   Offset 164: cloud credential string (24 bytes)  [in notes: offset 164 for cloudCred]
 *   Offset 196: hex ID string (16 bytes)
 *   Offset 228: ASCII model string (8 bytes)
 *   Offset 240: powerState int (0=off, 1=on)
 *   Offset 244: dimmable int
 *   Offset 268: checksum int (in notes as d->A)
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
import { parseDeviceIdInt } from './packets.js';
import { KAB_BEACON_PORT, KAB_COMMAND_PORT } from '../../settings.js';
import type { DeviceInfo } from '../types.js';

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

    // Validate magic bytes at offsets 5‥8
    if (
        decrypted[5] !== 0x55 || decrypted[6] !== 0xaa ||
        decrypted[7] !== 0x55 || decrypted[8] !== 0xaa
    ) {
        return null;
    }

    // Validate "ECO Plugs" starting at offset 9
    const nameInPacket = decrypted.toString('ascii', 9, 9 + ECO_NAME.length);
    if (nameInPacket !== ECO_NAME) return null;

    const readStr  = (off: number, len: number) =>
        decrypted.toString('ascii', off, off + len).replace(/\0/g, '').trim();
    const readInt  = (off: number) => decrypted.readUInt32BE(off);

    const idStr      = readStr(44, 16);
    const name       = readStr(60, 16) || idStr;
    const cmdPort    = readInt(76) || KAB_COMMAND_PORT;
    const credential = readStr(80, 64);
    // First 8 bytes of credential used as deviceKey in commands
    const deviceKey  = credential.slice(0, 8);
    const powerState = readInt(240);
    const dimmable   = readInt(244);
    const cloudCred  = readStr(164, 24);

    const deviceIdInt = parseDeviceIdInt(idStr);

    return {
        id:             idStr || `KAB-${deviceIdInt.toString(16).toUpperCase()}`,
        name,
        host:           '',   // filled in by caller from remote.address
        port:           cmdPort,
        protocol:       'kab',
        status:         powerState !== 0,
        dimmable,
        kabDeviceIdInt: isNaN(deviceIdInt) ? 0 : deviceIdInt,
        kabKey:         deviceKey,
        kabPass:        '111111',  // default; overridden by config if set
        kabCommandPort: cmdPort,
        cloudCredential: cloudCred,
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
export function startKabBeaconListener(
    onBeacon: BeaconCallback,
    log?: (msg: string) => void,
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
            device.port = KAB_COMMAND_PORT;
        }

        log?.(`KAB beacon from ${remote.address}: ${device.id} "${device.name}" port=${device.port}`);

        // Send the ACK back to the device
        const ack = buildBeaconAck();
        sock.send(ack, 0, ack.length, remote.port, remote.address);

        onBeacon(device);
    });

    sock.bind(KAB_BEACON_PORT, () => {
        sock.setBroadcast(true);
        log?.(`KAB beacon listener bound to port ${KAB_BEACON_PORT}`);
    });

    return sock;
}
