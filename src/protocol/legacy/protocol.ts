/**
 * Legacy FtNetManager command flow: discovery + send/receive on a shared socket.
 */

import * as dgram from 'dgram';
import {
    buildGetRequest,
    buildSetRequest,
    buildDiscoveryProbe,
    parseDiscoveryResponse,
    parseFullStatusResponse,
    LEGACY_DISCOVERY_LENGTH,
    LEGACY_ACK_LENGTH,
    LEGACY_STATUS_LENGTH,
} from './packets.js';
import {
    LEGACY_DISCOVERY_PORT,
    LEGACY_DISCOVERY_PORT2,
} from '../../settings.js';
import type { DeviceInfo, StatusMessage } from '../types.js';

const DISCOVERY_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS   = 500;
const DEFAULT_RETRIES      = 3;

export type StatusCallback = (msg: StatusMessage) => void;

export interface LegacyManager {
    /** Send a power set command. */
    setPower(device: DeviceInfo, on: boolean): void;
    /** Send a status poll request. */
    getStatus(device: DeviceInfo): void;
    /** Trigger a discovery broadcast; resolves with found devices. */
    discover(): Promise<DeviceInfo[]>;
    /** Start background status listener; `callback` called on each status message. */
    startStatusListener(callback: StatusCallback): void;
    /** Shut down the socket. */
    close(): void;
}

/**
 * Create a legacy protocol manager.  Call `startStatusListener` first to bind
 * the incoming port, then `discover` to populate your device list.
 *
 * @param incomingPort  UDP port Homebridge listens on for device messages.
 * @param localOnly     When true, silently ignore messages from public IPs.
 * @param log           Optional logger.
 */
export function createLegacyManager(
    incomingPort: number,
    localOnly: boolean,
    log?: (msg: string) => void,
): LegacyManager {
    const socket = dgram.createSocket('udp4');
    let statusCallback: StatusCallback | null = null;
    let bound = false;

    // Map of partial discoveries keyed by sequence number or device ID
    const discoveredMap = new Map<string, DeviceInfo>();

    socket.on('error', (err) => {
        log?.(`Legacy socket error: ${err.message}`);
    });

    socket.on('message', (raw: Buffer, remote: dgram.RemoteInfo) => {
        if (localOnly && !isPrivateAddress(remote.address)) return;

        try {
            if (raw.length >= LEGACY_DISCOVERY_LENGTH) {
                const device = parseDiscoveryResponse(
                    raw.subarray(0, LEGACY_DISCOVERY_LENGTH),
                    remote.address,
                );
                if (device) {
                    discoveredMap.set(device.id, device);
                }
                return;
            }

            if (raw.length >= LEGACY_STATUS_LENGTH) {
                const msg = parseFullStatusResponse(
                    raw.subarray(0, LEGACY_STATUS_LENGTH),
                );
                if (msg && statusCallback) {
                    statusCallback(msg);
                }
                return;
            }

            if (raw.length >= LEGACY_ACK_LENGTH) {
                // ACK — no action needed (setPower confirmation handled by timeout)
                return;
            }
        } catch (e) {
            log?.(`Legacy message parse error: ${(e as Error).message}`);
        }
    });

    function ensureBound(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            if (bound) { resolve(); return; }
            socket.bind(port, () => {
                socket.setBroadcast(true);
                bound = true;
                log?.(`Legacy socket bound to port ${port}`);
                resolve();
            });
            socket.once('error', reject);
        });
    }

    function sendToDevice(
        buf: Buffer,
        device: DeviceInfo,
        retries = DEFAULT_RETRIES,
        callback?: (err?: Error) => void,
    ): void {
        if (localOnly && !isPrivateAddress(device.host)) {
            callback?.(new Error(`Refusing to send to non-local host ${device.host}`));
            return;
        }
        const attempt = (remaining: number) => {
            socket.send(buf, 0, buf.length, device.port, device.host, (err) => {
                if (err) {
                    if (remaining > 1) {
                        setTimeout(() => attempt(remaining - 1), COMMAND_TIMEOUT_MS);
                    } else {
                        callback?.(err);
                    }
                }
            });
        };
        attempt(retries);
    }

    function sendDiscoveryProbe(
        port: number,
        retries: number,
        callback: (err?: Error) => void,
    ): void {
        const probe = buildDiscoveryProbe();
        const attempt = (remaining: number) => {
            socket.send(probe, 0, 128, port, '255.255.255.255', (err) => {
                if (err) {
                    callback(err);
                } else if (remaining > 1) {
                    setTimeout(() => attempt(remaining - 1), DISCOVERY_TIMEOUT_MS);
                } else {
                    setTimeout(() => callback(), DISCOVERY_TIMEOUT_MS);
                }
            });
        };
        attempt(retries);
    }

    return {
        startStatusListener(callback: StatusCallback): void {
            statusCallback = callback;
            ensureBound(incomingPort).catch((e) =>
                log?.(`Failed to bind legacy socket: ${(e as Error).message}`),
            );
        },

        discover(): Promise<DeviceInfo[]> {
            discoveredMap.clear();
            return ensureBound(incomingPort).then(
                () =>
                    new Promise((resolve) => {
                        let remaining = 2; // probe port 25 + port 5888
                        const done = () => {
                            remaining--;
                            if (remaining === 0) {
                                resolve([...discoveredMap.values()]);
                            }
                        };
                        sendDiscoveryProbe(LEGACY_DISCOVERY_PORT,  3, done);
                        sendDiscoveryProbe(LEGACY_DISCOVERY_PORT2, 3, done);
                    }),
            );
        },

        setPower(device: DeviceInfo, on: boolean): void {
            sendToDevice(buildSetRequest(device.id, on), device);
        },

        getStatus(device: DeviceInfo): void {
            sendToDevice(buildGetRequest(device.id), device);
        },

        close(): void {
            try { socket.close(); } catch { /* ignore */ }
        },
    };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isPrivateAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (address === 'localhost' || address === '127.0.0.1') return true;
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(isNaN)) return false;
    return octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254);
}
