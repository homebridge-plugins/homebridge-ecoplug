/**
 * EcoPlug platform — manages accessories, discovery and polling.
 *
 * Converted from the original index.js EcoPlugPlatform, extended with:
 *   - KAB beacon discovery (port 10228, passive)
 *   - Per-device protocol selection (legacy vs KAB)
 *   - Proper TypeScript types throughout
 */

import type {
    API,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service,
    Characteristic,
    CharacteristicValue,
} from 'homebridge';

import {
    PLATFORM_NAME,
    PLUGIN_NAME,
    DEFAULT_INCOMING_PORT,
    DEFAULT_DISCOVER_INTERVAL,
    DEFAULT_POLLING_INTERVAL,
    DEFAULT_DEVICE_INACTIVE_TIMEOUT,
    DEFAULT_DEVICE_REMOVE_TIMEOUT,
    DEFAULT_LOCAL_ONLY,
    DEFAULT_ENABLED,
    KAB_COMMAND_PORT,
    KAB_DEVICE_PORT,
    type EcoPlugConfig,
    type DeviceConfig,
    DEFAULT_KAB_COMMAND_TIMEOUT_MS,
    DEFAULT_KAB_DISCOVERY_ATTEMPTS,
    DEFAULT_KAB_MAX_FAILURES,
} from './settings.js';

// how long after issuing a KAB command we suppress any status query
// kicked off by HomeKit.  devices vary wildly; one of the EcoPlugs in our
// test fleet routinely needs ~2s to flick the relay, so 1s wasn’t enough
// and the state would flip back immediately when HomeKit polled.  this
// constant is arbitrary but is much longer than any realistic switch
// latency, and it avoids the “still polling after command” noise the user
// complained about.
const KAB_COMMAND_SUPPRESS_MS = 5000;

import {
    createLegacyManager,
    startKabBeaconListener,
    type LegacyManager,
    type DeviceInfo,
} from './protocol/index.js';

import { kabSetPower, kabGetStatus } from './protocol/kab/protocol.js';
import { kabSocket } from './protocol/kab/socket.js';
import { parseDeviceIdInt } from './protocol/kab/packets.js';
const pkg = require('../package.json') as { version: string };

export class EcoPlugPlatform implements DynamicPlatformPlugin {
    public readonly Service:        typeof Service;
    public readonly Characteristic: typeof Characteristic;

    /** Restored accessories from disk (before they're confirmed by discovery). */
    public readonly cachedAccessories = new Map<string, PlatformAccessory>();

    private readonly legacyManager: LegacyManager;
    private readonly config:        EcoPlugConfig;

    // Resolved configuration values
    private readonly incomingPort:         number;
    private readonly pollingIntervalMs:    number;
    private readonly discoverIntervalMs:   number;
    private readonly deviceInactiveMs:     number;
    private readonly deviceRemoveMs:       number;
    private readonly localOnly:            boolean;
    private readonly enabled:              boolean;
    private readonly deviceOverrideMap:    Map<string, DeviceConfig>;
    private staticDevices:                 DeviceConfig[] = [];
    private readonly statusInflight:       Map<string, Promise<void>> = new Map();
    // discovery handshake and beacon-id handling are now fixed behaviours
    private readonly kabCommandTimeoutMsGlobally: number;
    private readonly kabDiscoveryAttemptsGlobally: number;
    private readonly kabMaxFailuresGlobally: number;
    private readonly skipBeaconAckGlobally: boolean;
    /** service type used when adding accessories unless overridden */
    private readonly defaultServiceType: 'outlet' | 'switch';

    constructor(
        public readonly log: Logger,
        platformConfig: PlatformConfig,
        public readonly api: API,
    ) {
        this.Service        = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        const cfg = platformConfig as EcoPlugConfig;
        this.config            = cfg;
        // if the user asks for plugin-level debug, make .debug log to info so it
        // is always visible in the UI even without -D
        if (cfg.debug) {
            this.log.info('Plugin debug logging enabled');
            this.log.debug = this.log.info.bind(this.log);
        }
        this.incomingPort      = cfg.port              ?? DEFAULT_INCOMING_PORT;
        this.pollingIntervalMs = (cfg.pollingInterval  ?? DEFAULT_POLLING_INTERVAL)   * 1000;
        this.discoverIntervalMs= (cfg.discoverInterval ?? DEFAULT_DISCOVER_INTERVAL)  * 1000;
        this.deviceInactiveMs  = (cfg.deviceInactiveTimeout ?? DEFAULT_DEVICE_INACTIVE_TIMEOUT) * 1000;
        this.deviceRemoveMs    = (cfg.deviceRemoveTimeout   ?? DEFAULT_DEVICE_REMOVE_TIMEOUT)    * 1000;
        this.localOnly         = cfg.localOnly  ?? DEFAULT_LOCAL_ONLY;
        this.enabled           = cfg.enabled    ?? DEFAULT_ENABLED;
        // we always skip the discovery handshake – devices rarely respond
        // correctly anyway, and the beacon address is authoritative.
        // the plugin always skips the KAB discovery handshake and always
        // uses the beacon-derived integer id; the old config options have
        // been removed.
        this.kabCommandTimeoutMsGlobally = cfg.kabCommandTimeoutMs ?? DEFAULT_KAB_COMMAND_TIMEOUT_MS;
        this.kabDiscoveryAttemptsGlobally = cfg.kabDiscoveryAttempts ?? DEFAULT_KAB_DISCOVERY_ATTEMPTS;
        this.kabMaxFailuresGlobally = cfg.kabMaxFailures ?? DEFAULT_KAB_MAX_FAILURES;
        this.skipBeaconAckGlobally = cfg.kabSkipBeaconAck ?? false;
        // choose default service type with graceful fallback
        this.defaultServiceType = (cfg.defaultServiceType === 'switch' ? 'switch' : 'outlet');
        // beacon updates are always enabled now; there is no longer any
        // configuration toggle for polling.  periodic queries will only
        // target legacy devices.
        // optional bind port for outgoing KAB commands; 0 means ephemeral
        const bindPort = cfg.kabBindPort ?? KAB_COMMAND_PORT;
        kabSocket.setBindPort(bindPort);
        this.log.info(`KAB source bind port set to ${bindPort}`);

        const configuredDevices: DeviceConfig[] = [];
        const rawDevices = Array.isArray(cfg.devices)
            ? (cfg.devices as Array<Partial<DeviceConfig> | undefined>)
            : [];
        let skippedConfiguredDevices = 0;

        for (const [index, rawDevice] of rawDevices.entries()) {
            const id = typeof rawDevice?.id === 'string' ? rawDevice.id.trim() : '';
            if (!id) {
                skippedConfiguredDevices += 1;
                // missing ID is not fatal; summary log later reports how many were
                // skipped.  reduce verbosity to debug so an empty config doesn't
                // clutter the log.
                this.log.debug(`Ignoring devices[${index}] because "id" is missing or invalid`);
                continue;
            }

            const host = typeof rawDevice?.host === 'string' ? rawDevice.host.trim() : undefined;
            configuredDevices.push({
                ...(rawDevice as DeviceConfig),
                id,
                host: host || undefined,
            });
        }

        this.deviceOverrideMap = new Map(
            configuredDevices.map(d => [d.id.toUpperCase(), d]),
        );

        if (rawDevices.length > 0) {
            this.log.info(
                `Configured devices: total=${rawDevices.length}, valid=${configuredDevices.length}, ` +
                `skipped=${skippedConfiguredDevices}`,
            );
        }

        // Static-IP devices declared in config are seeded immediately after
        // launch without waiting for a beacon.  Store them separately so
        // onDidFinishLaunching can register them.
        this.staticDevices = configuredDevices.filter(d => !!d.host);

        this.legacyManager = createLegacyManager(
            this.incomingPort,
            this.localOnly,
            (msg) => this.log.debug(msg),
        );

        this.log.debug('EcoPlugPlatform initialised');

        this.api.on('didFinishLaunching', () => this.onDidFinishLaunching());
    }

    /** Called by Homebridge for each accessory restored from cache. */
    configureAccessory(accessory: PlatformAccessory): void {
        this.log.info('Restoring cached accessory:', accessory.context.id);
        accessory.context.lastUpdated = Date.now();

        // reconcile service type from configuration overrides or platform default
        const override = this.deviceOverrideMap.get((accessory.context.id as string).toUpperCase());
        if (override && override.serviceType) {
            accessory.context.serviceType = override.serviceType;
        } else if (!accessory.context.serviceType) {
            accessory.context.serviceType = this.defaultServiceType;
        }

        this.cachedAccessories.set(accessory.context.id, accessory);
        this.configureServices(accessory);
    }

    private onDidFinishLaunching(): void {
        if (!this.enabled) {
            this.log.info('Plugin disabled');
            return;
        }

        this.log.info(
            `Starting EcoPlug discovery (cached=${this.cachedAccessories.size}, localOnly=${this.localOnly}, ` +
            `discoverInterval=${this.discoverIntervalMs / 1000}s, pollingInterval=${this.pollingIntervalMs / 1000}s)`,
        );

        // Start legacy status listener (shared socket)
        this.legacyManager.startStatusListener((msg) => {
            const acc = this.cachedAccessories.get(msg.id);
            if (!acc) {
                this.log.debug('Status from unknown device', msg.id);
                return;
            }

            acc.context.lastUpdated = Date.now();
            this.getOnCharacteristic(acc)
                    ?.updateValue(msg.status);
        });

        // Start passive KAB beacon listener; the `ack` option controls
        // whether we send the 36‑byte acknowledgement packet.  the global
        // config setting is inverted here because the option means “send ACK”.
        // Beacon processing is now mandatory; we always listen and act on
        // beacons regardless of configuration.
        startKabBeaconListener(
            (device) => this.handleDiscoveredDevice(device, 'kab-beacon'),
            (msg)    => this.log.debug(msg),
            { ack: !this.skipBeaconAckGlobally },
        );

        // Seed any statically-configured IP devices immediately
        this.seedStaticDevices();

        // Initial active discovery
        void this.runDiscovery();

        // Polling timer: only legacy devices are queried on the interval.
        if (this.pollingIntervalMs > 0) {
            setInterval(() => this.pollAllDevices(), this.pollingIntervalMs);
        }

        // Re-discovery timer
        if (this.discoverIntervalMs > 0) {
            setInterval(() => void this.runDiscovery(), this.discoverIntervalMs);
        }
    }

    // ── Discovery ────────────────────────────────────────────────────────────

    /**
     * Register devices that have a static `host` in the config, without
     * waiting for their beacon.  They will still be updated when a beacon
     * arrives (mergeKabContext), but this ensures they appear in Homebridge
     * immediately and can be commanded right away.
     */
    private seedStaticDevices(): void {
        for (const d of this.staticDevices) {
            if (!d.host) {
                continue;
            }
            const idInt = parseDeviceIdInt(d.id);
            const device: DeviceInfo = {
                id:             d.id,
                name:           d.id,           // updated when beacon arrives
                host:           d.host,
                port:           d.commandPort ?? KAB_DEVICE_PORT,
                protocol:       (d.protocol === 'legacy' ? 'legacy' : 'kab'),
                kabDeviceIdInt: isNaN(idInt) ? 0 : idInt,
                kabKey:         d.kabKey   ?? '',
                kabPass:        d.kabPass  ?? '',
                kabCommandPort: d.commandPort ?? KAB_DEVICE_PORT,
                kabSkipDiscovery: true,
                kabUseBeaconId: true,
                kabCommandTimeoutMs: d.kabCommandTimeoutMs ?? this.kabCommandTimeoutMsGlobally,
                kabMaxFailures: d.kabMaxFailures ?? this.kabMaxFailuresGlobally,
                kabDiscoveryAttempts: d.kabDiscoveryAttempts ?? this.kabDiscoveryAttemptsGlobally,
            };
            this.log.info(`Seeding static IP device: ${d.id} @ ${d.host}`);
            this.handleDiscoveredDevice(device, 'static-config');
        }
    }

    private async runDiscovery(): Promise<void> {
        this.log.debug('Running legacy device discovery…');
        let devices: DeviceInfo[];
        try {
            devices = await this.legacyManager.discover();
        } catch (e) {
            this.log.error('Discovery error:', (e as Error).message);
            return;
        }

        this.log.debug(`Discovery found ${devices.length} legacy device(s)`);
        for (const d of devices) {
            this.handleDiscoveredDevice(d, 'legacy-discovery');
        }
    }

    /** Common handler for both legacy and KAB discovered devices. */
    private handleDiscoveredDevice(
        device: DeviceInfo,
        source: 'legacy-discovery' | 'kab-beacon' | 'static-config',
    ): void {
        const deviceId = typeof device.id === 'string' ? device.id.trim() : '';
        if (!deviceId) {
            this.log.warn(`Skipping discovered device with invalid id (${source}) @ ${device.host}`);
            return;
        }
        // if we have an accessory keyed by this deviceId already, great.
        // otherwise, try to locate an accessory whose cached host matches the
        // incoming beacon/seed host.  this handles the case where the user
        // initially seeded a static device using its IP address as the `id`;
        // once a real beacon arrives we want to adopt the canonical ID and
        // rename the existing accessory rather than adding a duplicate.
        let existingAcc = this.cachedAccessories.get(deviceId);
        if (!existingAcc) {
            for (const [key, acc] of this.cachedAccessories.entries()) {
                if (acc.context.host === device.host) {
                    // assume this is the same device; rename the key
                    existingAcc = acc;
                    this.cachedAccessories.delete(key);
                    this.cachedAccessories.set(deviceId, existingAcc);
                    this.log.info(`Rekeying accessory ${key} → ${deviceId} based on host ${device.host}`);
                    // also update its context.id and displayName
                    existingAcc.context.id = deviceId;
                    existingAcc.displayName = existingAcc.context.name || deviceId;
                    break;
                }
            }
        }
        device.id = deviceId;

        // if we learned the IP/port via a beacon, treat it as a known LAN
        // address so the command layer will skip the discovery handshake.
        if (device.protocol === 'kab' && source === 'kab-beacon') {
            // beacon gives us the current LAN address; store it so that
            // sendWithRetry() can skip the expensive/fussy discovery handshake.
            device.kabLanIp = device.host;
            device.kabLanPort = device.port;
        }

        if (this.localOnly && !isPrivateAddress(device.host)) {
            this.log.info(`Skipping non-local device ${device.id} @ ${device.host} (${source})`);
            return;
        }

        // Apply per-device config overrides.
        // For kabKey/kabPass: the beacon is the authoritative source (its localKey
        // at offset 152 and localPass at offset 164 are what the device verifies).
        // Config values are only used as a fallback when the device field is empty
        // (i.e. no beacon has been received yet, as in the static-config seed path).
        const override = this.deviceOverrideMap.get(deviceId.toUpperCase());
        if (override) {
            if (override.kabKey && !device.kabKey) {
                device.kabKey  = override.kabKey;
            }
            if (override.kabPass && !device.kabPass) {
                device.kabPass = override.kabPass;
            }
            if (override.commandPort) {
                device.kabCommandPort = override.commandPort;
            }
            if (override.kabMaxFailures !== undefined) {
                device.kabMaxFailures = override.kabMaxFailures;
            }
            if (override.protocol && override.protocol !== 'auto') {
                device.protocol = override.protocol as 'legacy' | 'kab';
            }
            if (override.serviceType) {
                (device as any).serviceType = override.serviceType;
            }
            // any per-device skipDiscovery/useBeacon flags are ignored; plugin
            // behaviour is fixed.
        }

        const existing = this.cachedAccessories.get(device.id);
        let acc: PlatformAccessory | undefined;

        if (existing) {
            acc = existing;
            // update name from beacon if it changed
            if (device.name && device.name !== existing.context.name) {
                this.log.info(`Renaming accessory ${device.id} "${existing.context.name}" → "${device.name}" from beacon`);
                existing.context.name = device.name;
                existing.displayName = device.name;
                // outlet service title is set when the service was added; update it too
                this.getAccessoryService(existing).setCharacteristic(this.Characteristic.Name, device.name);
            }

            if (existing.context.host !== device.host) {
                this.log.info(`Updated IP for ${device.id}: ${existing.context.host} -> ${device.host} (${source})`);
                existing.context.host = device.host;
                existing.context.port = device.port;
            } else {
                this.log.debug(`Seen known device ${device.id} via ${source} @ ${device.host}`);
            }
            // Always re-apply KAB context so config overrides (kabKey, kabPass,
            // commandPort) are never silently lost to stale cached values.
            // ensure the device object has our fixed behaviour flags set
            if (device.protocol === 'kab') {
                device.kabSkipDiscovery = true;
                device.kabUseBeaconId = true;
            }
            this.mergeKabContext(existing, device);
            // apply serviceType change if override changed
            if ((device as any).serviceType && (device as any).serviceType !== existing.context.serviceType) {
                existing.context.serviceType = (device as any).serviceType;
                // reconfigure services to ensure the correct one exists
                this.configureServices(existing);
            }
            // also propagate any LAN address discovered via beacon so subsequent
            // commands don’t trigger discovery handshakes
            if (device.kabLanIp) {
                existing.context.kabLanIp = device.kabLanIp;
            }
            if (device.kabLanPort) {
                existing.context.kabLanPort = device.kabLanPort;
            }
            existing.context.lastUpdated = Date.now();
        } else {
            this.log.info(`Adding new device (${source}): ${device.id} "${device.name}" @ ${device.host}`);
            this.addAccessory(device);
            acc = this.cachedAccessories.get(device.id)!;
        }

        // if the beacon supplied an immediate status we can update HomeKit
        if (device.status !== undefined && acc) {
            const prev = this.getOnCharacteristic(acc)?.value as boolean | undefined;
            this.log.debug(`Beacon reports powerState=${device.status ? 'ON' : 'OFF'}`);
            if (prev !== undefined && prev !== device.status) {
                this.log.info(`Updating ${device.id} state ${prev ? 'ON' : 'OFF'}→${device.status ? 'ON' : 'OFF'} from beacon`);
            }
            this.getOnCharacteristic(acc)?.updateValue(device.status);
        }
    }

    private mergeKabContext(acc: PlatformAccessory, device: DeviceInfo): void {
        if (device.protocol === 'kab') {
            acc.context.kabDeviceIdInt = device.kabDeviceIdInt;
            acc.context.kabKey         = device.kabKey;
            acc.context.kabPass        = device.kabPass;
            acc.context.kabCommandPort = device.kabCommandPort;
            acc.context.protocol       = 'kab';
            // discovery is always skipped and beacon ID always used
            acc.context.kabSkipDiscovery = true;
            acc.context.kabUseBeaconId = true;
            acc.context.kabCommandTimeoutMs = device.kabCommandTimeoutMs;
            acc.context.kabDiscoveryAttempts = device.kabDiscoveryAttempts;
            // propagate new beacon offset if available
            if (device.kabBeaconOffset264 !== undefined) {
                acc.context.kabBeaconOffset264 = device.kabBeaconOffset264;
            }
            acc.context.kabMaxFailures = device.kabMaxFailures ?? this.kabMaxFailuresGlobally;
            // received an updated beacon; clear any past failure tally so we try again
            acc.context.kabFailureCount = 0;
        }
    }

    // ── Accessory management ─────────────────────────────────────────────────

    private addAccessory(device: DeviceInfo): void {
        const uuid = this.api.hap.uuid.generate(device.id);
        const accessory = new this.api.platformAccessory(device.name || device.id, uuid);

        // record chosen serviceType so we can resolve it later
        const svcType: 'outlet' | 'switch' = (device as any).serviceType === 'switch'
            ? 'switch'
            : this.defaultServiceType;

        accessory.context = {
            id:            device.id,
            name:          device.name,
            host:          device.host,
            port:          device.port,
            protocol:      device.protocol,
            lastUpdated:   Date.now(),
            kabDeviceIdInt: device.kabDeviceIdInt,
            kabKey:        device.kabKey,
            kabPass:       device.kabPass,
            kabCommandPort: device.kabCommandPort,
            kabSkipDiscovery: true,
            kabUseBeaconId: true,
            kabCommandTimeoutMs: device.kabCommandTimeoutMs,
            // store the beacon offset field which is crucial for KAB encryption
            kabBeaconOffset264: device.kabBeaconOffset264,
            kabFailureCount: 0,
            kabMaxFailures: device.kabMaxFailures ?? this.kabMaxFailuresGlobally,
            serviceType:    svcType,
        };

        accessory.getService(this.Service.AccessoryInformation)!
            .setCharacteristic(this.Characteristic.Manufacturer,       'KAB / ECO Plugs')
            .setCharacteristic(this.Characteristic.Model,              'CT-065W')
            .setCharacteristic(this.Characteristic.SerialNumber,       device.id)
            .setCharacteristic(this.Characteristic.FirmwareRevision,   pkg.version);

        // add either outlet or switch service per configuration
        const serviceToAdd = svcType === 'switch' ? this.Service.Switch : this.Service.Outlet;
        accessory.addService(serviceToAdd, device.name || device.id);

        this.configureServices(accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(device.id, accessory);
        this.log.info(`Registered accessory ${device.id} (${device.protocol})`);
    }

    private configureServices(accessory: PlatformAccessory): void {
        const service = this.getAccessoryService(accessory);

        service.getCharacteristic(this.Characteristic.On)
            .onSet(async (value: CharacteristicValue) => {
                await this.setPowerState(accessory.context, value as boolean);
            })
            .onGet(() => {
                void this.refreshAccessoryState(accessory);
                return this.getCachedPowerState(accessory.context.id as string);
            });

        accessory.on('identify', () => {
            this.log.info('Identify:', accessory.context.id, accessory.context.name);
        });
    }

    // Helpers ───────────────────────────────────────────────────────────────

    /**
     * Return the service instance for a given accessory, creating it if absent.
     * Respects the `serviceType` stored in the accessory context or the
     * platform-wide default.
     */
    private getAccessoryService(acc: PlatformAccessory): Service {
        const type = (acc.context.serviceType as 'outlet' | 'switch') || this.defaultServiceType;
        if (type === 'switch') {
            // if an outlet service exists from a previous configuration, remove it
            const old = acc.getService(this.Service.Outlet);
            if (old) {
                acc.removeService(old);
            }
            return acc.getService(this.Service.Switch) ?? acc.addService(this.Service.Switch);
        }
        // ensure no leftover switch service
        const old = acc.getService(this.Service.Switch);
        if (old) {
            acc.removeService(old);
        }
        return acc.getService(this.Service.Outlet) ?? acc.addService(this.Service.Outlet);
    }

    private getOnCharacteristic(acc: PlatformAccessory) {
        return this.getAccessoryService(acc).getCharacteristic(this.Characteristic.On);
    }

    // ── Polling ──────────────────────────────────────────────────────────────

    private pollAllDevices(): void {
        for (const [id, acc] of this.cachedAccessories) {
            const ctx = acc.context;
            this.log.debug('Polling', id, ctx.name);

            // only poll legacy devices; KAB status comes from beacons
            if (ctx.protocol !== 'kab') {
                this.legacyManager.getStatus(ctx as DeviceInfo);
            }

            this.checkInactiveDevice(acc);
        }
    }

    private checkInactiveDevice(acc: PlatformAccessory): void {
        const lastUpdated: number = acc.context.lastUpdated ?? Date.now();
        const elapsed = Date.now() - lastUpdated;

        if (this.deviceRemoveMs > 0 && elapsed > this.deviceRemoveMs) {
            this.log.warn('Removing unresponsive device:', acc.context.id);
            this.removeAccessory(acc);
            return;
        }

        if (this.deviceInactiveMs > 0 && elapsed > this.deviceInactiveMs) {
            this.getOnCharacteristic(acc)?.updateValue(new Error('No Response'));
        }
    }

    private removeAccessory(acc: PlatformAccessory): void {
        this.log.info(`Unregistering accessory ${acc.context.id}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.cachedAccessories.delete(acc.context.id as string);
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    private async setPowerState(ctx: Record<string, unknown>, on: boolean): Promise<void> {
        this.log.info(`Setting ${ctx.id} "${ctx.name}" → ${on ? 'ON' : 'OFF'}`);

        if (ctx.protocol === 'kab') {
            // early bail if we've flagged this device as non‑responsive
            if ((ctx as any).kabUnreliable) {
                throw new Error('KAB device has previously failed to obey commands');
            }

            const desired = on;
            // track that we're actively retrying so polls/back-to-back commands
            // can be suppressed.
            (ctx as any).kabRetrying = true;
            try {
                let attempt = 0;
                while (true) {
                    attempt += 1;

                    // if a beacon has already told us the desired state we can skip
                    // the entire command+poll sequence.  check at the very start of
                    // each iteration so late-arriving beacons are respected.
                    if (this.cachedAccessories.has(ctx.id as string)) {
                        const acc = this.cachedAccessories.get(ctx.id as string)!;
                        const cachedVal = this.getOnCharacteristic(acc)
                             ?.value as boolean | undefined;
                        if (cachedVal !== undefined && cachedVal === desired) {
                            this.log.info('Desired state already reflected by beacon, skipping further attempts');
                            ctx.kabConsecCmdFails = 0;
                            on = desired;
                            break;
                        }
                    }

                    const result = await kabSetPower(ctx as unknown as DeviceInfo, on, (msg) => this.log.debug(msg));
                    if (!result.ok) {
                        throw new Error(result.error?.message ?? 'KAB command failed');
                    }

                    // command sent; use the response packet if present but
                    // never perform an extra status query for KAB devices.
                    let actual = on;
                    if (result.response) {
                        actual = result.response.powerState === 1;
                        this.log.info(`Command response reports powerState=${result.response.powerState}`);
                        if (actual !== desired) {
                            this.log.warn('Power command response did not match desired state');
                        }
                    }

                    if (actual === desired) {
                        // success
                        ctx.kabConsecCmdFails = 0;
                        on = actual;
                        break;
                    }

                    // failure
                    this.log.warn(`KAB command attempt ${attempt} failed to reach desired state`);
                    (ctx as any).kabConsecCmdFails = ((ctx as any).kabConsecCmdFails ?? 0) + 1;
                    if ((ctx as any).kabConsecCmdFails >= 3) {
                        (ctx as any).kabUnreliable = true;
                        this.log.error(`Marking device ${ctx.id} as unreliable after ${(ctx as any).kabConsecCmdFails} failed commands`);
                        break;
                    }

                    if (attempt >= 3) {
                break;
            }
                    // small delay before retry
                    await new Promise(r => setTimeout(r, 200));
                }
            } finally {
                delete (ctx as any).kabRetrying;
            }

            // reset failure count regardless; status check above updates 'on'
            (ctx as any).kabFailureCount = 0;
        } else {
            this.legacyManager.setPower(ctx as unknown as DeviceInfo, on);
        }

        if (this.cachedAccessories.has(ctx.id as string)) {
            const acc = this.cachedAccessories.get(ctx.id as string)!;
            acc.context.lastUpdated = Date.now();
            this.getOnCharacteristic(acc)?.updateValue(on);

            // remember when we last sent a command; `refreshAccessoryState` will
            // use this to ignore queries for a short period so HomeKit doesn’t
            // immediately ask the plug for its state and end up seeing the old
            // value while the relay is still moving.
            const id = ctx.id as string;
            (ctx as any).kabLastCommandTs = Date.now();

            // prevent the immediate onGet-triggered refresh from firing while
            // the device may still be applying the command.  we insert a dummy
            // entry in `statusInflight` that lasts a few seconds.
            this.statusInflight.set(id, Promise.resolve());
            // some devices take a little longer to actually toggle the relay;
            // give a generous window before allowing a status query to run.
            // the previous 1 second value was too short for slower units and
            // resulted in the behaviour the user reports above.  the exact
            // duration is arbitrary but is now tied to KAB_COMMAND_SUPPRESS_MS.
            setTimeout(() => { this.statusInflight.delete(id); }, KAB_COMMAND_SUPPRESS_MS);
        }
    }

    private getCachedPowerState(id: string): boolean {
        const acc = this.cachedAccessories.get(id);
        const val = acc ? this.getOnCharacteristic(acc)?.value : undefined;
        return typeof val === 'boolean' ? val : false;
    }

    private async refreshAccessoryState(acc: PlatformAccessory): Promise<void> {
        const ctx = acc.context as Record<string, any>;
        if (ctx.protocol !== 'kab') {
            return;
        }

        // If we've already failed too many times in a row, skip polling.
        const maxFails = (ctx.kabMaxFailures as number) ?? this.kabMaxFailuresGlobally;
        const failCount = ctx.kabFailureCount ?? 0;
        if (failCount >= maxFails) {
            this.log.debug(`Skipping KAB status for ${ctx.id as string}: ${failCount} consecutive failures (max=${maxFails})`);
            return;
        }

        const id = ctx.id as string;

        if (ctx.kabRetrying) {
            this.log.debug(`Skipping KAB status for ${id} while retrying command`);
            return;
        }
        if (this.statusInflight.has(id)) {
            this.log.debug(`KAB status already in-flight for ${id}, skipping`);
            return;
        }

        // avoid querying immediately after we just commanded the device; the
        // relay can take several seconds and an early poll often returns the
        // previous state (see KAB_COMMAND_SUPPRESS_MS).  HomeKit’s own polls
        // trigger `refreshAccessoryState` via onGet, so we need this check to
        // keep the UI from flipping back and forth.
        if (ctx.kabLastCommandTs && (Date.now() - ctx.kabLastCommandTs) < KAB_COMMAND_SUPPRESS_MS) {
            this.log.debug(`Skipping KAB status for ${id} due to recent command`);
            return;
        }

        const req = (async () => {
            try {
                const result = await kabGetStatus(ctx as unknown as DeviceInfo, (msg) => this.log.debug(msg));
                if (!result.ok || !result.response) {
                    if (result.error) {
                        this.log.warn(`KAB status failed for ${ctx.id as string}: ${result.error.message}`);
                    }
                    // increment failure counter
                    ctx.kabFailureCount = (ctx.kabFailureCount ?? 0) + 1;
                    if (ctx.kabFailureCount === maxFails) {
                        this.log.warn(`Giving up KAB status for ${ctx.id as string} after ${maxFails} failures`);
                    }
                    return;
                }

                // success: reset failure count
                ctx.kabFailureCount = 0;

                const on = result.response.powerState !== 0;
                acc.context.lastUpdated = Date.now();
                // log if the poll changed the cached state so the user can see what
                // triggered an update vs the subsequent beacon that might follow.
                const prevVal = this.getOnCharacteristic(acc)
                                   ?.value as boolean | undefined;
                if (prevVal !== undefined && prevVal !== on) {
                    this.log.info(`Updating ${ctx.id} state ${prevVal ? 'ON' : 'OFF'}→${on ? 'ON' : 'OFF'} from status query`);
                }
                this.getOnCharacteristic(acc)?.updateValue(on);
            } catch (e) {
                this.log.debug(`KAB status refresh failed for ${ctx.id as string}: ${(e as Error).message}`);
                ctx.kabFailureCount = (ctx.kabFailureCount ?? 0) + 1;
            } finally {
                this.statusInflight.delete(id);
            }
        })();

        this.statusInflight.set(id, req);
        await req;
    }
}

// ── Utility ───────────────────────────────────────────────────────────────────

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
