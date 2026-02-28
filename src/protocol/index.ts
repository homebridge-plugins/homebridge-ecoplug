/**
 * Unified discovery coordinator: runs legacy broadcast discovery in parallel
 * with passive KAB beacon listening.
 *
 * KAB discovery is passive: devices announce themselves on port 10228, so
 * we just listen continuously.  Legacy discovery is active: we broadcast and
 * collect responses.
 *
 * The platform calls `discoverLegacy()` on its polling interval and keeps a
 * single `startKabBeaconListener` alive the whole time.
 */

export { createLegacyManager } from './legacy/protocol.js';
export { startKabBeaconListener } from './kab/beacon.js';
export type { LegacyManager } from './legacy/protocol.js';
export type { BeaconCallback }  from './kab/beacon.js';

export type { DeviceInfo, StatusMessage } from './types.js';
