/**
 * KABNetManager command packet builder and response parser.
 *
 * Packet layout (KabNetDefine$j::m()[B):
 *
 *  Offset  Size  Field
 *  ──────────────────────────────────────────────────────────────────────
 *   0      4     timeMark (big-endian Unix seconds)
 *   4      4     cmdCode  (23=primary, 22=secondary, 102=cloud)
 *   8      4     unused (0)
 *  12      4     deviceId int (big-endian hex, e.g. 0x78ABCDEF)
 *  16      8     deviceKey string (credential, null-padded)
 *  24      4     (0-pad to 28)
 *  28      4     field f (sequence counter, 0 for one-shot)
 *  32      4     field g (0)
 *  36     28     devicePass string (null-padded to 28 bytes)
 *  64      4     field m (0)
 *  68      4     0x12345678 magic constant
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

import { cppToBytesEncryption, cppParseBytesEncryption } from './cipher.js';

// ── Subtype (p) constants ─────────────────────────────────────────────────────
export const KAB_CMD_POWER       = 106;
export const KAB_CMD_DIM         = 107;
export const KAB_CMD_STATUS      = 0;   // no subtype payload
export const KAB_CMD_SCHED_QUERY = 115;
export const KAB_CMD_SCHED_SET   = 116;
export const KAB_CMD_DISCOVERY   = 118;
export const KAB_CMD_SET_NAME    = 120;

// ── Command code constants ────────────────────────────────────────────────────
export const KAB_CMDCODE_PRIMARY   = 23;
export const KAB_CMDCODE_SECONDARY = 22;
export const KAB_CMDCODE_CLOUD     = 102;

// ── Magic ─────────────────────────────────────────────────────────────────────
const MAGIC_N = 0x12345678;

/**
 * Parameters needed to build any KAB command.
 */
export interface KabCommandParams {
    /** Integer form of device ID (e.g. parseInt("78ABCDEF", 16)). */
    deviceIdInt: number;
    /** Credential key string (≤8 bytes, from beacon offset 80). */
    deviceKey: string;
    /** Password string (≤28 bytes, default "111111"). */
    devicePass: string;
    /** Command code: 23 (primary) or 22 (secondary). Default 23. */
    cmdCode?: number;
    /** Subtype (p field, offset 76). */
    subtype: number;
    /** Payload bytes written starting at offset 80. */
    payload?: Buffer;
    /** Sequence counter (field f, offset 28). Default 0. */
    seqCounter?: number;
}

/**
 * Build a 152-byte KAB command packet ready to send over UDP.
 * Encryption is applied in-place to bytes [0..75] before the subtype is written.
 */
export function buildKabCommand(p: KabCommandParams): Buffer {
    const buf = Buffer.alloc(152, 0);

    const timeMark = Math.floor(Date.now() / 1000);
    const cmdCode  = p.cmdCode ?? KAB_CMDCODE_PRIMARY;

    // Offset 0: timeMark (4 bytes, big-endian)
    buf.writeUInt32BE(timeMark >>> 0, 0);
    // Offset 4: cmdCode (4 bytes, big-endian)
    buf.writeUInt32BE(cmdCode >>> 0, 4);
    // Offset 8: 0 (unused)
    // Offset 12: deviceId int (4 bytes, big-endian)
    buf.writeUInt32BE(p.deviceIdInt >>> 0, 12);
    // Offset 16: deviceKey (8 bytes null-padded)
    buf.write(p.deviceKey.slice(0, 8), 16, 'ascii');
    // Offset 24-27: 0-pad (already zeroed)
    // Offset 28: seqCounter / field f
    buf.writeUInt32BE((p.seqCounter ?? 0) >>> 0, 28);
    // Offset 32: field g = 0
    // Offset 36: devicePass (28 bytes null-padded)
    buf.write(p.devicePass.slice(0, 28), 36, 'ascii');
    // Offset 64: field m = 0
    // Offset 68: magic 0x12345678
    buf.writeUInt32BE(MAGIC_N, 68);
    // Offset 72: field o = 0

    // Apply encryption to bytes [0..75] in-place
    cppToBytesEncryption(buf);

    // Offset 76: subtype p (4 bytes, big-endian) — AFTER encryption
    buf.writeUInt32BE(p.subtype >>> 0, 76);

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
): Buffer {
    const payload = Buffer.alloc(8, 0);
    payload.writeUInt32BE(on ? 1 : 0, 0); // powerState q
    payload.writeUInt32BE(0, 4);           // dimmable r

    return buildKabCommand({
        deviceIdInt,
        deviceKey,
        devicePass,
        subtype: KAB_CMD_POWER,
        payload,
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
    payload.writeUInt32BE(level > 0 ? 1 : 0, 0); // powerState
    payload.writeUInt32BE(level >>> 0, 4);         // dim level

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
): Buffer {
    return buildKabCommand({
        deviceIdInt,
        deviceKey,
        devicePass,
        cmdCode: KAB_CMDCODE_SECONDARY,
        subtype: KAB_CMD_POWER,
        payload: Buffer.alloc(8, 0),
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
 * Parse a KAB command response received on port 9090.
 * The response has the same 152-byte structure but bytes [56..71] are
 * decrypted by CPPParseBytesEncryption.
 */
export function parseKabResponse(raw: Buffer): KabResponse | null {
    if (raw.length < 152) return null;

    const dst = Buffer.alloc(raw.length, 0);
    cppParseBytesEncryption(raw, dst);

    const timeMark  = dst.readUInt32BE(0);
    const cmdCode   = dst.readUInt32BE(4);
    const deviceIdInt = dst.readUInt32BE(12);
    const subtype   = dst.readUInt32BE(76);
    const powerState = dst.readUInt32BE(80);
    const dimmable  = dst.readUInt32BE(84);

    return { timeMark, cmdCode, deviceIdInt, subtype, powerState, dimmable, raw: dst };
}

/**
 * Extract the integer device ID from an "ECO-78XXXXXX" string.
 * Returns NaN if the format is not recognised.
 */
export function parseDeviceIdInt(idStr: string): number {
    const stripped = idStr.replace(/^ECO-/i, '').trim();
    const val = parseInt(stripped, 16);
    return val;
}
