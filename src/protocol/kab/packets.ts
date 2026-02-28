/**
 * KABNetManager command packet builder and response parser.
 *
 * Packet layout (KabNetDefine$j::m()[B):
 *
 *  Offset  Size  Field
 *  ──────────────────────────────────────────────────────────────────────
 * ALL integers are little-endian (O.d.g writes LE, O.d.c reads LE — confirmed
 * from KabNetDefine.java / O/d.java in the decompiled APK).
 *
 *   0      4     timeMark (LE uint32 Unix seconds) — also the cipher key
 *   4      4     cmdCode  (LE uint32: 23=primary, 22=secondary, 102=cloud)
 *   8      4     unused (0)
 *  12      4     deviceId int (LE uint32 — from beacon offset 36)
 *  16     ~12    localKey string from beacon offset 152 (null-padded by Buffer.alloc)
 *  36     ~10    localPass string from beacon offset 164 (null-padded by Buffer.alloc)
 *  64      4     field m (0)
 *  68      4     field n (0)  — was incorrectly set to 0x12345678
 *  72      4     field o (0)
 *        *** CPPtoBytesEncryption([B)V applied to bytes 0–75 HERE ***
 *  76      4     subtype p
 *
 *  For p = 106 (power control):
 *  80      4     powerState q  (0=OFF, 1=ON)
 *  84      4     dimmable r
 *  88‥151  (0-pad)
 *
 *  For p = 22 / 23 (status query – no extra payload beyond p):
 *  80‥151  (0-pad)
 *
 * Total: 152 bytes.
 *
 * Subtype constants (field p):
 *   106 = power on/off
 *   107 = dim level
 *   115 = schedule query
 *   116 = schedule set
 *   118 = full discovery packet (extends to 816 bytes with 736-byte discovery table)
 *   120 = set device name
 *   121 = set WiFi credentials
 *   131 = schedule extended (584-byte)
 */

import { cppToBytesEncryption } from './cipher.js';

// ── Subtype (p) constants ─────────────────────────────────────────────────────
export const KAB_CMD_POWER       = 106;
export const KAB_CMD_DIM         = 107;
export const KAB_CMD_STATUS      = 0;   // no subtype payload
/** Subtype used in outgoing discovery handshake (cmdCode=23, j.p=105). */
export const KAB_CMD_HELLO       = 105;
export const KAB_CMD_SCHED_QUERY = 115;
export const KAB_CMD_SCHED_SET   = 116;
export const KAB_CMD_DISCOVERY   = 118;
export const KAB_CMD_SET_NAME    = 120;

// ── Command code constants ────────────────────────────────────────────────────
export const KAB_CMDCODE_PRIMARY   = 23;
export const KAB_CMDCODE_SECONDARY = 22;
export const KAB_CMDCODE_CLOUD     = 102;

/**
 * Parameters needed to build any KAB command.
 */
export interface KabCommandParams {
    /** Integer form of device ID (from beacon offset 36, read as LE uint32). */
    deviceIdInt: number;
    /** Local auth key string from beacon offset 152 (12B, null-terminated ASCII). */
    deviceKey: string;
    /** Local auth password from beacon offset 164 (32B, null-terminated ASCII). */
    devicePass: string;
    /** Command code: 23 (primary) or 22 (secondary). Default 23. */
    cmdCode?: number;
    /** Subtype (p field, offset 76). */
    subtype: number;
    /** Payload bytes written starting at offset 80. */
    payload?: Buffer;
    /** Sequence counter (field n, offset 68). Default 0. */
    seqCounter?: number;
    /** Beacon offset 264 (field m, offset 64). Default 0. */
    beaconOffset264?: number;
}

/**
 * Build a 152-byte KAB command packet ready to send over UDP.
 * Encryption is applied in-place to bytes [0..75] before the subtype is written.
 */
export function buildKabCommand(p: KabCommandParams): Buffer {
    const buf = Buffer.alloc(152, 0);

    const timeMark = Math.floor(Date.now() / 1000);
    const cmdCode  = p.cmdCode ?? KAB_CMDCODE_PRIMARY;

    // All integers are little-endian (O.d.g in the Android app).
    // Offset 0: timeMark (LE) — bytes 0-3 also serve as the cipher key
    buf.writeUInt32LE(timeMark >>> 0, 0);
    // Offset 4: cmdCode (LE)
    buf.writeUInt32LE(cmdCode >>> 0, 4);
    // Offset 8: 0 (unused)
    // Offset 12: deviceId int (LE)
    buf.writeUInt32LE(p.deviceIdInt >>> 0, 12);
    // Offset 16: localKey (full string, null-padded by Buffer.alloc(152,0))
    buf.write(p.deviceKey, 16, 'ascii');
    // Offset 36: localPass (full string, null-padded by Buffer.alloc(152,0))
    buf.write(p.devicePass, 36, 'ascii');
    // Offset 64: field m (from beacon offset 264)
    buf.writeUInt32LE((p.beaconOffset264 ?? 0) >>> 0, 64);
    // Offset 68: seqCounter / field n (LE)
    buf.writeUInt32LE((p.seqCounter ?? 0) >>> 0, 68);
    // Offset 72: field o = 0

    // Apply encryption to bytes [16..71] in-place (key = bytes 0-3)
    cppToBytesEncryption(buf);

    // Offset 76: subtype p (LE) — written AFTER encryption
    buf.writeUInt32LE(p.subtype >>> 0, 76);

    // Offset 80+: payload (written after encryption, not encrypted)
    if (p.payload && p.payload.length > 0) {
        const payloadLen = Math.min(p.payload.length, buf.length - 80);
        p.payload.copy(buf, 80, 0, payloadLen);
    }

    return buf;
}

/**
 * Build a power control command (subtype 106).
 */
export function buildPowerCommand(
    deviceIdInt: number,
    deviceKey: string,
    devicePass: string,
    on: boolean,
    beaconOffset264: number = 0,
): Buffer {
    const payload = Buffer.alloc(8, 0);
    payload.writeUInt32LE(on ? 1 : 0, 0); // powerState q (LE)
    payload.writeUInt32LE(0, 4);           // dimmable r (LE)

    return buildKabCommand({
        deviceIdInt,
        deviceKey,
        devicePass,
        subtype: KAB_CMD_POWER,
        payload,
        beaconOffset264,
    });
}

/**
 * Build a dim command (subtype 107).
 */
export function buildDimCommand(
    deviceIdInt: number,
    deviceKey: string,
    devicePass: string,
    level: number, // 0-100
): Buffer {
    const payload = Buffer.alloc(8, 0);
    payload.writeUInt32LE(level > 0 ? 1 : 0, 0); // powerState (LE)
    payload.writeUInt32LE(level >>> 0, 4);         // dim level (LE)

    return buildKabCommand({
        deviceIdInt,
        deviceKey,
        devicePass,
        subtype: KAB_CMD_DIM,
        payload,
    });
}

/**
 * Build a status query command (subtype 106 with powerState = 0, just to query).
 * The app uses cmdCode 22 (secondary) for status queries.
 */
export function buildStatusQueryCommand(
    deviceIdInt: number,
    deviceKey: string,
    devicePass: string,
    beaconOffset264: number = 0,
): Buffer {
    return buildKabCommand({
        deviceIdInt,
        deviceKey,
        devicePass,
        cmdCode: KAB_CMDCODE_SECONDARY,
        subtype: KAB_CMD_POWER,
        payload: Buffer.alloc(8, 0),
        seqCounter: 0x12345678,
        beaconOffset264,
    });
}

/**
 * Parsed KAB command response.
 */
export interface KabResponse {
    timeMark: number;
    cmdCode: number;
    deviceIdInt: number;
    subtype: number;
    powerState: number;
    dimmable: number;
    raw: Buffer;
}

/**
 * Discovery response returned by cmdCode=105 (NOT encrypted per APK b([B)[B decrypt).
 * Carries the device's actual LAN IP and command port.
 */
export interface KabDiscoveryResponse {
    /** Device LAN IP (4-byte network-order field at offset 24, decoded to dotted decimal). */
    ip: string;
    /** Device LAN command port (big-endian 16-bit at offset 28, per KabNetDefine$j.e()). */
    port: number;
    raw: Buffer;
}

/**
 * Build the discovery handshake command: cmdCode=23, subtype/p=105.
 *
 * The Android app (a$d timer) sends this every second to the beacon-sender
 * IP:beaconCmdPort.  The device replies with an UNENCRYPTED packet where
 * cmdCode=105 and bytes [24–27] = LAN IP, bytes [28–29] = LAN port (BE 16-bit).
 */
export function buildDiscoveryHandshake(
    deviceIdInt: number,
    deviceKey: string,
    devicePass: string,
    beaconOffset264: number = 0,
    attempt: number = 1,
): Buffer {
    return buildKabCommand({
        deviceIdInt,
        deviceKey,
        devicePass,
        cmdCode: KAB_CMDCODE_PRIMARY,
        subtype: KAB_CMD_HELLO,   // j.p = 105
        seqCounter: attempt,
        beaconOffset264,
    });
}

/**
 * Build the discovery acknowledgment packet sent back to the discovered LAN IP/port.
 */
export function buildDiscoveryAck(
    deviceIdInt: number,
    deviceKey: string,
    devicePass: string,
    beaconOffset264: number = 0,
): Buffer {
    let seq = 0x12345678;

    return buildKabCommand({
        deviceIdInt,
        deviceKey,
        devicePass,
        cmdCode: KAB_CMDCODE_SECONDARY,
        subtype: KAB_CMD_HELLO,
        seqCounter: seq,
        beaconOffset264,
    });
}

/**
 * Attempt to parse a raw UDP packet as a cmdCode=105 discovery response.
 * Returns null if the packet is too short or the cmdCode is not 105.
 *
 * The device sends cmdCode=105 responses WITHOUT encryption (APK b([B)[B skips
 * CPPParseBytesEncryption when cmdCode==105).
 */
export function parseDiscoveryResponse(raw: Buffer): KabDiscoveryResponse | null {
    if (raw.length < 32) return null;
    const cmdCode = raw.readUInt32LE(4);
    if (cmdCode !== 105) return null;
    // Bytes 24–27: device LAN IP in network (big-endian) order
    const ip = `${raw[24]}.${raw[25]}.${raw[26]}.${raw[27]}`;
    // Bytes 28–29: device LAN port, big-endian 16-bit
    // (KabNetDefine$j.e() swaps buf[offset] and buf[offset+1] before LE-reading)
    const port = ((raw[28] & 0xff) << 8) | (raw[29] & 0xff);
    return { ip, port, raw };
}

/**
 * Parse a KAB command response received on port 9090.
 *
 * The fields we care about — subtype (offset 76), powerState (offset 80),
 * dimmable (offset 84) — lie OUTSIDE the encrypted range (bytes 16–71), so
 * no decryption is needed for a valid status/power response.  The plain
 * bytes are read directly from `raw`.
 *
 * cmdCode=105 discovery responses are handled by parseDiscoveryResponse();
 * this function returns null for them.
 */
export function parseKabResponse(raw: Buffer): KabResponse | null {
    if (raw.length < 88) return null;

    // All response integers are little-endian; subtype/powerState/dimmable
    // are at offsets 76/80/84 which are OUTSIDE the encrypted range (16–71).
    const timeMark    = raw.readUInt32LE(0);
    const cmdCode     = raw.readUInt32LE(4);

    // Discovery responses have a different layout; reject them here.
    if (cmdCode === 105) return null;

    const deviceIdInt = raw.readUInt32LE(12);
    const subtype     = raw.readUInt32LE(76);
    const powerState  = raw.readUInt32LE(80);
    const dimmable    = raw.readUInt32LE(84);

    return { timeMark, cmdCode, deviceIdInt, subtype, powerState, dimmable, raw };
}

/**
 * Extract the integer device ID from an "ECO-78XXXXXX" string.
 * Returns NaN if the format is not recognised.
 */
export function parseDeviceIdInt(idStr: string): number {
    const stripped = idStr.replace(/^ECO-78/i, '').replace(/^ECO-/i, '').trim();
    const val = parseInt(stripped, 16);
    return val;
}
