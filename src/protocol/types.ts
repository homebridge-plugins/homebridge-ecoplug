/**
 * Shared data types passed between protocol layers and the platform.
 */

/** Protocol stack that discovered/controls this device. */
export type ProtocolStack = 'legacy' | 'kab';

/**
 * Unified device record produced by either protocol's discovery phase.
 */
export interface DeviceInfo {
    /** Full device ID string, e.g. "ECO-78ABCDEF". */
    id: string;
    /** Human-readable name (from device, or falls back to id). */
    name: string;
    /** IP address of device (LAN). */
    host: string;
    /** Port to send commands to. */
    port: number;
    /** Which protocol found / controls this device. */
    protocol: ProtocolStack;
    /** Firmware version string (if available). */
    version?: string;
    /** Current power state (true = on). */
    status?: boolean;
    /** Non-zero if device is dimmable. */
    dimmable?: number;

    // ── KAB-specific fields set during beacon parsing ──────────────────────
    /** Integer form of the device ID (from KAB beacon, offset 12 of command). */
    kabDeviceIdInt?: number;
    /** 8-byte credential key string (from KAB beacon offset 80, first 8 bytes). */
    kabKey?: string;
    /** Device password for KAB commands (default "111111"). */
    kabPass?: string;
    /** Cloud credential string (KAB beacon offset 164). */
    cloudCredential?: string;
    /** KAB command port read from beacon (may differ from default 9090). */
    kabCommandPort?: number;
    /**
     * LAN IP returned by the KAB cmdCode=105 discovery handshake.
     * Populated after the first successful discovery; used for all subsequent commands.
     */
    kabLanIp?: string;
    /**
     * LAN command port returned by the KAB cmdCode=105 discovery handshake.
     * Populated after the first successful discovery; used for all subsequent commands.
     */
    kabLanPort?: number;
    /** From beacon offset 264. Field `m` in command packets at offset 64. */
    kabBeaconOffset264?: number;
    /** When true, skip the KAB discovery handshake and send commands to beacon host:port */
    kabSkipDiscovery?: boolean;
    /** When true (default), use the raw beacon integer id (offset 36) for commands */
    kabUseBeaconId?: boolean;
    /** Per-device override for KAB command timeout (ms) */
    kabCommandTimeoutMs?: number;
    /** Per-device override for number of discovery attempts */
    kabDiscoveryAttempts?: number;
    /** Per-device override for maximum consecutive status failures */
    kabMaxFailures?: number;
}

/**
 * Minimal message passed up to the status callback from legacy responses.
 */
export interface StatusMessage {
    id: string;
    status: boolean;
}
