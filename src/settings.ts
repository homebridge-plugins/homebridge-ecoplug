/**
 * Plugin settings, constants and configuration interface.
 */

export const PLUGIN_NAME    = 'homebridge-ecoplug';
export const PLATFORM_NAME  = 'EcoPlug';

/** UDP port Homebridge listens on for legacy device status/ack messages. */
export const DEFAULT_INCOMING_PORT    = 9000;
/** Broadcast interval in seconds. */
export const DEFAULT_DISCOVER_INTERVAL  = 60;
/** Status poll interval in seconds. */
export const DEFAULT_POLLING_INTERVAL   = 10;
/** Mark accessory inactive after X seconds without response (0 = never). */
export const DEFAULT_DEVICE_INACTIVE_TIMEOUT = DEFAULT_DISCOVER_INTERVAL * 3;
/** Remove accessory after X seconds without response (0 = never). */
export const DEFAULT_DEVICE_REMOVE_TIMEOUT = 0;

/** Legacy broadcast discovery port (FtNetManager). */
export const LEGACY_DISCOVERY_PORT  = 25;
/** Secondary legacy discovery port. */
export const LEGACY_DISCOVERY_PORT2 = 5888;
/** KABNetManager device beacon broadcast port. */
export const KAB_BEACON_PORT        = 10228;
/** KABNetManager command SOURCE port — we bind here so the device registers us at IP:9090. */
export const KAB_COMMAND_PORT       = 9090;
/** KABNetManager command DESTINATION port — the device listens here for incoming commands. */
export const KAB_DEVICE_PORT        = 1022;
/** KABNetManager fallback command port A. */
export const KAB_COMMAND_PORT_B     = 6000;
/** KABNetManager fallback command port B (legacy). */
export const KAB_COMMAND_PORT_C     = 80;

export const DEFAULT_LOCAL_ONLY    = true;
export const DEFAULT_ENABLED       = true;

/** Per‑device protocol preference. */
export type ProtocolPreference = 'auto' | 'legacy' | 'kab';

/**
 * Shape of a single device override entry in the Homebridge configuration.
 */
export interface DeviceConfig {
    /** Device ID string, e.g. "ECO-78ABCDEF". */
    id: string;
    /**
     * Static IP address of the device.
     * When set, the platform will seed this device on startup without
     * waiting for a beacon on port 10228.  The kabKey/kabPass will be
     * applied immediately; if not set, the defaults are used and will be
     * updated as soon as a beacon is received from the device.
     */
    host?: string;
    /** Override command destination port on the device (default: 1022). */
    commandPort?: number;
    /** Override credential/key from beacon (default: auto from beacon). */
    kabKey?: string;
    /** Override password for KAB commands (default: "111111"). */
    kabPass?: string;
    /** Force a specific protocol (default: "auto"). */
    protocol?: ProtocolPreference;
}

/**
 * Shape of the full Homebridge platform configuration block.
 */
export interface EcoPlugConfig {
    platform: string;
    name: string;
    enabled?: boolean;
    localOnly?: boolean;
    port?: number;
    pollingInterval?: number;
    discoverInterval?: number;
    deviceInactiveTimeout?: number;
    deviceRemoveTimeout?: number;
    /** Per‑device overrides. */
    devices?: DeviceConfig[];
}
