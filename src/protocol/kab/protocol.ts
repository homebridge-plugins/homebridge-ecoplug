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
    buildDiscoveryAck,
    parseDiscoveryResponse,
    parseKabResponse,
    parseDeviceIdInt,
    type KabResponse,
} from './packets.js';
import { KAB_COMMAND_PORT, DEFAULT_KAB_COMMAND_TIMEOUT_MS } from '../../settings.js';
import type { DeviceInfo } from '../types.js';

import { kabSocket } from './socket.js';

export const KAB_COMMAND_TIMEOUT_MS = DEFAULT_KAB_COMMAND_TIMEOUT_MS;
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
    filter?: (msg: Buffer, rinfo: dgram.RemoteInfo) => boolean,
    log?: (msg: string) => void,
): Promise<Buffer> {
    // if caller provided a filter function, it will be in the fifth argument;
    // the sixth argument, if present, is the logger.  This avoids relying on
    // `.length` which is unreliable for arrow functions.
    if (log) kabSocket.setLogger(log);
    // Let the global socket handle the UDP transaction
    return kabSocket.sendAndReceive(buf, host, port, timeoutMs, filter);
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
export async function performDiscovery(device: DeviceInfo, log?: (msg: string) => void): Promise<void> {
    if (device.kabSkipDiscovery) {
        log?.('KAB discovery skipped by device config');
        return;
    }

    const idInt = (device.kabUseBeaconId
        ? (device.kabDeviceIdInt ?? parseDeviceIdInt(device.id))
        : (parseDeviceIdInt(device.id) || device.kabDeviceIdInt || 0)) ?? 0;
    const key   = device.kabKey  ?? '';
    const pass  = device.kabPass ?? '111111';

    const beaconHost = device.host;
    const beaconPort = device.kabCommandPort ?? device.port;

    log?.(`KAB discovery → ${beaconHost}:${beaconPort}  (cmdCode=23 subtype=105)`);

    const timeoutMs = device.kabCommandTimeoutMs ?? KAB_COMMAND_TIMEOUT_MS;

    const maxAttempts = device.kabDiscoveryAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const discBuf = buildDiscoveryHandshake(idInt, key, pass, device.kabBeaconOffset264, attempt);
            // filter out any packets that are not parseable discovery responses
            const raw = await sendAndReceive(
                discBuf,
                beaconHost,
                beaconPort,
                timeoutMs,
                (msg: Buffer) => {
                    if (msg.equals(discBuf)) return false;
                    return parseDiscoveryResponse(msg) !== null;
                },
                log,
            );
            const disc = parseDiscoveryResponse(raw);
            if (disc && disc.ip !== '0.0.0.0' && disc.port > 0) {
                device.kabLanIp   = disc.ip;
                device.kabLanPort = disc.port;
                log?.(`KAB discovered LAN address: ${disc.ip}:${disc.port}`);

                // Send discovery acknowledgment
                const ack = buildDiscoveryAck(idInt, key, pass, device.kabBeaconOffset264);
                // Send and fire-and-forget (use small timeout)
                await kabSocket.sendAndReceive(ack, disc.ip, disc.port, Math.min(500, timeoutMs)).catch(() => {});
                log?.('KAB discovery acknowledgment sent (cmdCode=22, subtype=105)');
                return;
            } else {
                log?.(`KAB discovery response unreadable`);
            }
        } catch (e) {
            log?.(`KAB discovery attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    log?.(`KAB discovery exhausted — will use beacon address ${beaconHost}:${beaconPort}`);
}

/**
 * Throttle discovery so we don't burn 6s on every 10s poll.
 * Stores the last discovery attempt time per device ID.
 */
const lastDiscoveryAttemptMs = new Map<string, number>();
const DISCOVERY_REATTEMPT_INTERVAL_MS = 60_000; // retry discovery at most once per minute

/**
 * Send a pre-built command buffer, retrying up to `retries` times.
 */
async function sendWithRetry(
    buf: Buffer,
    device: DeviceInfo,
    retries = KAB_COMMAND_RETRIES,
    log?: (msg: string) => void,
    allowBindFallback = true,
): Promise<KabCommandResult> {
    // Phase 1: Discovery handshake — populates kabLanIp / kabLanPort.
    // Only attempt if we have no LAN address, and haven't tried recently.
    const now = Date.now();
    const lastAttempt = lastDiscoveryAttemptMs.get(device.id) ?? 0;
    const shouldDiscover = !device.kabSkipDiscovery && !device.kabLanIp && (now - lastAttempt > DISCOVERY_REATTEMPT_INTERVAL_MS);
    if (shouldDiscover) {
        lastDiscoveryAttemptMs.set(device.id, now);
        await performDiscovery(device, log);
    }

    // Use discovered LAN address if available; fall back to beacon host/port.
    const host = device.kabLanIp ?? device.host;
    const port = device.kabLanPort ?? device.kabCommandPort ?? device.port;
    let lastError: Error | undefined;

    const timeoutMs = device.kabCommandTimeoutMs ?? KAB_COMMAND_TIMEOUT_MS;
    const idIntInfo = (device.kabUseBeaconId ? (device.kabDeviceIdInt ?? 0) : parseDeviceIdInt(device.id) || (device.kabDeviceIdInt ?? 0));
    const b264 = device.kabBeaconOffset264 ?? 0;
    log?.(`KAB sendWithRetry → ${device.id} @ ${host}:${port}  idInt=0x${(idIntInfo).toString(16)}  key="${device.kabKey ?? ''}"  retries=${retries} timeout=${timeoutMs}ms beaconOffset=0x${b264.toString(16)}`);

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // calculate expected subtype from the outgoing buffer so we can filter
            const expectedSubtype = buf.readUInt32LE(76);
            const raw = await sendAndReceive(
                buf,
                host,
                port,
                timeoutMs,
                // accept any valid KAB response (cmdCode≠105) that isn’t a
                // byte‑for‑byte copy of the packet we just sent.  the
                // kernel sometimes loops back outgoing datagrams to us when
                // SO_REUSEPORT is enabled, and earlier we were erroneously
                // treating our self‑echo as the device’s reply.
                (msg: Buffer) => {
                    if (msg.equals(buf)) return false;            // ignore echo
                    const parsed = parseKabResponse(msg);
                    return parsed !== null;
                },
                log,
            );
            const parsed = parseKabResponse(raw); // should succeed because of filter
            if (parsed) {
                log?.(`KAB response ok: cmdCode=${parsed.cmdCode} subtype=${parsed.subtype} powerState=${parsed.powerState}`);
                return { ok: true, response: parsed };
            }
            // shouldn't happen since filter passed, but handle defensively
            log?.(`KAB response unparseable (${raw.length}B)`);
            lastError = new Error(`Unparseable KAB response (${raw.length}B)`);
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            log?.(`KAB attempt ${attempt + 1}/${retries} failed: ${lastError.message}`);
        }
    }

    // if we timed out on all retries and a bind port was configured, try ephemeral
    if (allowBindFallback && device && device.kabCommandPort !== undefined) {
        const currentBind = (kabSocket as any).bindPort;
        if (currentBind !== 0) {
            log?.('KAB command timed out on configured bind port, retrying with ephemeral port');
            kabSocket.setBindPort(0);
            return sendWithRetry(buf, device, retries, log, false);
        }
    }

    // priming step: certain devices stop listening after a few packets.  we'll
    // send a couple of extra discovery packets (broadcast + ephemeral source)
    // once per device lifetime, then retry the entire sequence.
    if (!device.kabPrimed) {
        device.kabPrimed = true;
        log?.('KAB priming device with broadcast/ephemeral discovery');
        try {
            // broadcast
            await kabSocket.sendAndReceive(buf, '255.255.255.255', port, timeoutMs).catch(() => {});
            // ephemeral source port
            const origBind = (kabSocket as any).bindPort;
            kabSocket.setBindPort(0);
            await kabSocket.sendAndReceive(buf, host, port, timeoutMs).catch(() => {});
            kabSocket.setBindPort(origBind);
        } catch {
            // ignore
        }
        return sendWithRetry(buf, device, retries, log, false);
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
    const idInt = (device.kabUseBeaconId
        ? (device.kabDeviceIdInt ?? parseDeviceIdInt(device.id))
        : (parseDeviceIdInt(device.id) || device.kabDeviceIdInt || 0)) ?? 0;
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

    const buf = buildPowerCommand(idInt, key, pass, on, device.kabBeaconOffset264);
    return sendWithRetry(buf, device, KAB_COMMAND_RETRIES, log);
}

/**
 * Send a status query to a KAB device.
 */
export async function kabGetStatus(
    device: DeviceInfo,
    log?: (msg: string) => void,
): Promise<KabCommandResult> {
    const idInt = (device.kabUseBeaconId
        ? (device.kabDeviceIdInt ?? parseDeviceIdInt(device.id))
        : (parseDeviceIdInt(device.id) || device.kabDeviceIdInt || 0)) ?? 0;
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

    const buf = buildStatusQueryCommand(idInt, key, pass, device.kabBeaconOffset264);
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
