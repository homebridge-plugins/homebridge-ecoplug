/**
 * KABNetManager command flow: send a command on port 9090 and receive the
 * response, retrying on timeout.
 *
 * The app's KabNetManager uses three threads on its 9090 socket:
 *   a$f = send thread
 *   a$e = receive thread
 *   a$c = response demultiplexer
 *
 * We model this with a simple send-and-wait using a per-command timeout.
 */

import * as dgram from 'dgram';
import {
    buildPowerCommand,
    buildStatusQueryCommand,
    buildDimCommand,
    buildDiscoveryHandshake,
    parseDiscoveryResponse,
    parseKabResponse,
    type KabResponse,
} from './packets.js';
import { KAB_COMMAND_PORT } from '../../settings.js';
import type { DeviceInfo } from '../types.js';

export const KAB_COMMAND_TIMEOUT_MS = 2000;
export const KAB_COMMAND_RETRIES    = 3;

export interface KabCommandResult {
    ok: boolean;
    response?: KabResponse;
    error?: Error;
}

/**
 * Internal: send `buf` to `host:port` and wait up to `timeoutMs` for a
 * response.  The socket is bound to KAB_COMMAND_PORT (9090) so the device
 * sees port 9090 as the source and replies there — mirroring the Android
 * app which also binds a single socket to port 9090 for both send and receive.
 *
 * @param log  Optional logger — when supplied, debug lines are emitted.
 */
function sendAndReceive(
    buf: Buffer,
    host: string,
    port: number,
    timeoutMs: number,
    log?: (msg: string) => void,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        let settled = false;

        const finish = (err?: Error, data?: Buffer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.close(() => {
                if (err)  reject(err);
                else      resolve(data!);
            });
        };

        const timer = setTimeout(
            () => finish(new Error(`KAB command timeout after ${timeoutMs}ms`)),
            timeoutMs,
        );

        sock.on('error', (e) => finish(e));
        sock.on('message', (msg: Buffer, rinfo) => {
            log?.(`KAB rx ${msg.length}B from ${rinfo.address}:${rinfo.port}: ${msg.toString('hex')}`);
            finish(undefined, msg);
        });

        // Bind to KAB_COMMAND_PORT so the device sees 9090 as the source port
        // and replies to 9090 — exactly how the Android app works.
        sock.bind(KAB_COMMAND_PORT, () => {
            const addr = sock.address();
            log?.(`KAB tx ${buf.length}B to ${host}:${port} (from port ${addr.port}): ${buf.toString('hex')}`);
            sock.send(buf, 0, buf.length, port, host, (err) => {
                if (err) finish(err);
            });
        });
    });
}

/**
 * Perform the KAB discovery handshake (cmdCode=23, subtype=105) to learn the
 * device's actual LAN IP and command port.
 *
 * The Android app (a$d timer) sends this to the beacon-sender IP:beaconCmdPort
 * every second.  On success, `device.kabLanIp` and `device.kabLanPort` are
 * populated and used for all subsequent STATUS / POWER commands.
 *
 * The cmdCode=105 response from the device is NOT encrypted (per APK b([B)[B)).
 */
async function performDiscovery(device: DeviceInfo, log?: (msg: string) => void): Promise<void> {
    const idInt = device.kabDeviceIdInt ?? 0;
    const key   = device.kabKey  ?? '';
    const pass  = device.kabPass ?? '111111';

    const beaconHost = device.host;
    const beaconPort = device.kabCommandPort ?? device.port;

    log?.(`KAB discovery → ${beaconHost}:${beaconPort}  (cmdCode=23 subtype=105)`);

    try {
        const discBuf = buildDiscoveryHandshake(idInt, key, pass);
        const raw     = await sendAndReceive(discBuf, beaconHost, beaconPort, KAB_COMMAND_TIMEOUT_MS, log);
        const disc    = parseDiscoveryResponse(raw);
        if (disc && disc.ip !== '0.0.0.0' && disc.port > 0) {
            device.kabLanIp   = disc.ip;
            device.kabLanPort = disc.port;
            log?.(`KAB discovered LAN address: ${disc.ip}:${disc.port}`);
        } else {
            log?.(`KAB discovery response unreadable — will use beacon address ${beaconHost}:${beaconPort}`);
        }
    } catch (e) {
        log?.(`KAB discovery failed: ${e instanceof Error ? e.message : String(e)} — will use beacon address ${beaconHost}:${beaconPort}`);
    }
}

/**
 * Send a pre-built command buffer, retrying up to `retries` times.
 */
async function sendWithRetry(
    buf: Buffer,
    device: DeviceInfo,
    retries = KAB_COMMAND_RETRIES,
    log?: (msg: string) => void,
): Promise<KabCommandResult> {
    // Phase 1: Discovery handshake (once per device — populates kabLanIp / kabLanPort).
    // The device only processes STATUS/POWER commands on its *discovered* LAN address;
    // sending to the beacon-sender address without discovery first causes timeouts.
    if (!device.kabLanIp) {
        await performDiscovery(device, log);
    }

    // Use discovered LAN address if available; fall back to beacon host/port.
    const host = device.kabLanIp ?? device.host;
    const port = device.kabLanPort ?? device.kabCommandPort ?? device.port;
    let lastError: Error | undefined;

    log?.(`KAB sendWithRetry → ${device.id} @ ${host}:${port}  idInt=0x${(device.kabDeviceIdInt ?? 0).toString(16)}  key="${device.kabKey ?? ''}"  retries=${retries}`);

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const raw = await sendAndReceive(buf, host, port, KAB_COMMAND_TIMEOUT_MS, log);
            const parsed = parseKabResponse(raw);
            if (parsed) {
                log?.(`KAB response ok: cmdCode=${parsed.cmdCode} subtype=${parsed.subtype} powerState=${parsed.powerState}`);
                return { ok: true, response: parsed };
            }
            log?.(`KAB response unparseable (${raw.length}B)`);
            lastError = new Error(`Unparseable KAB response (${raw.length}B)`);
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            log?.(`KAB attempt ${attempt + 1}/${retries} failed: ${lastError.message}`);
        }
    }
    return { ok: false, error: lastError };
}

/**
 * Send a power on/off command to a KAB device.
 */
export async function kabSetPower(
    device: DeviceInfo,
    on: boolean,
    log?: (msg: string) => void,
): Promise<KabCommandResult> {
    const idInt = device.kabDeviceIdInt ?? 0;
    const key   = device.kabKey  ?? '';
    const pass  = device.kabPass ?? '111111';

    if (!key) {
        return {
            ok: false,
            error: new Error(
                `KAB kabKey is empty for device ${device.id} — add kabKey (e.g. "keenfeng") to the devices[] config entry`,
            ),
        };
    }

    const buf = buildPowerCommand(idInt, key, pass, on);
    return sendWithRetry(buf, device, KAB_COMMAND_RETRIES, log);
}

/**
 * Send a status query to a KAB device.
 */
export async function kabGetStatus(
    device: DeviceInfo,
    log?: (msg: string) => void,
): Promise<KabCommandResult> {
    const idInt = device.kabDeviceIdInt ?? 0;
    const key   = device.kabKey  ?? '';
    const pass  = device.kabPass ?? '111111';

    if (!key) {
        return {
            ok: false,
            error: new Error(
                `KAB kabKey is empty for device ${device.id} — add kabKey (e.g. "keenfeng") to the devices[] config entry`,
            ),
        };
    }

    const buf = buildStatusQueryCommand(idInt, key, pass);
    return sendWithRetry(buf, device, KAB_COMMAND_RETRIES, log);
}

/**
 * Send a dim level command to a KAB device.
 */
export async function kabSetDim(
    device: DeviceInfo,
    level: number,
    log?: (msg: string) => void,
): Promise<KabCommandResult> {
    const idInt = device.kabDeviceIdInt ?? 0;
    const key   = device.kabKey  ?? '';
    const pass  = device.kabPass ?? '111111';

    if (!key) {
        return {
            ok: false,
            error: new Error(
                `KAB kabKey is empty for device ${device.id} — add kabKey (e.g. "keenfeng") to the devices[] config entry`,
            ),
        };
    }

    const buf = buildDimCommand(idInt, key, pass, level);
    return sendWithRetry(buf, device, KAB_COMMAND_RETRIES, log);
}
