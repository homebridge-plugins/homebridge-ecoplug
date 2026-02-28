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
} from './settings.js';

import {
    createLegacyManager,
    startKabBeaconListener,
    type LegacyManager,
    type DeviceInfo,
} from './protocol/index.js';

import { kabSetPower, kabGetStatus }    from './protocol/kab/protocol.js';
import { parseDeviceIdInt }              from './protocol/kab/packets.js';

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

    constructor(
        public readonly log: Logger,
        platformConfig: PlatformConfig,
        public readonly api: API,
    ) {
        this.Service        = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        const cfg = platformConfig as EcoPlugConfig;
        this.config            = cfg;
        this.incomingPort      = cfg.port              ?? DEFAULT_INCOMING_PORT;
        this.pollingIntervalMs = (cfg.pollingInterval  ?? DEFAULT_POLLING_INTERVAL)   * 1000;
        this.discoverIntervalMs= (cfg.discoverInterval ?? DEFAULT_DISCOVER_INTERVAL)  * 1000;
        this.deviceInactiveMs  = (cfg.deviceInactiveTimeout ?? DEFAULT_DEVICE_INACTIVE_TIMEOUT) * 1000;
        this.deviceRemoveMs    = (cfg.deviceRemoveTimeout   ?? DEFAULT_DEVICE_REMOVE_TIMEOUT)    * 1000;
        this.localOnly         = cfg.localOnly  ?? DEFAULT_LOCAL_ONLY;
        this.enabled           = cfg.enabled    ?? DEFAULT_ENABLED;

        this.deviceOverrideMap = new Map(
            (cfg.devices ?? []).map(d => [d.id.toUpperCase(), d]),
        );

        // Static-IP devices declared in config are seeded immediately after
        // launch without waiting for a beacon.  Store them separately so
        // onDidFinishLaunching can register them.
        this.staticDevices = (cfg.devices ?? []).filter(d => !!d.host);

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
            if (!acc) { this.log.debug('Status from unknown device', msg.id); return; }

            acc.context.lastUpdated = Date.now();
            acc.getService(this.Service.Outlet)
               ?.getCharacteristic(this.Characteristic.On)
               ?.updateValue(msg.status);
        });

        // Start passive KAB beacon listener
        startKabBeaconListener(
            (device) => this.handleDiscoveredDevice(device, 'kab-beacon'),
            (msg)    => this.log.debug(msg),
        );

        // Seed any statically-configured IP devices immediately
        this.seedStaticDevices();

        // Initial active discovery
        void this.runDiscovery();

        // Polling timer
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
            if (!d.host) continue;
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
        if (this.localOnly && !isPrivateAddress(device.host)) {
            this.log.info(`Skipping non-local device ${device.id} @ ${device.host} (${source})`);
            return;
        }

        // Apply per-device config overrides.
        // For kabKey/kabPass: the beacon is the authoritative source (its localKey
        // at offset 152 and localPass at offset 164 are what the device verifies).
        // Config values are only used as a fallback when the device field is empty
        // (i.e. no beacon has been received yet, as in the static-config seed path).
        const override = this.deviceOverrideMap.get(device.id.toUpperCase());
        if (override) {
            if (override.kabKey && !device.kabKey)   device.kabKey  = override.kabKey;
            if (override.kabPass && !device.kabPass) device.kabPass = override.kabPass;
            if (override.commandPort) device.kabCommandPort = override.commandPort;
            if (override.protocol && override.protocol !== 'auto') {
                device.protocol = override.protocol as 'legacy' | 'kab';
            }
        }

        const existing = this.cachedAccessories.get(device.id);
        if (existing) {
            if (existing.context.host !== device.host) {
                this.log.info(`Updated IP for ${device.id}: ${existing.context.host} -> ${device.host} (${source})`);
                existing.context.host = device.host;
                existing.context.port = device.port;
            } else {
                this.log.debug(`Seen known device ${device.id} via ${source} @ ${device.host}`);
            }
            // Always re-apply KAB context so config overrides (kabKey, kabPass,
            // commandPort) are never silently lost to stale cached values.
            this.mergeKabContext(existing, device);
            existing.context.lastUpdated = Date.now();
        } else {
            this.log.info(`Adding new device (${source}): ${device.id} "${device.name}" @ ${device.host}`);
            this.addAccessory(device);
        }
    }

    private mergeKabContext(acc: PlatformAccessory, device: DeviceInfo): void {
        if (device.protocol === 'kab') {
            acc.context.kabDeviceIdInt = device.kabDeviceIdInt;
            acc.context.kabKey         = device.kabKey;
            acc.context.kabPass        = device.kabPass;
            acc.context.kabCommandPort = device.kabCommandPort;
            acc.context.protocol       = 'kab';
        }
    }

    // ── Accessory management ─────────────────────────────────────────────────

    private addAccessory(device: DeviceInfo): void {
        const uuid = this.api.hap.uuid.generate(device.id);
        const accessory = new this.api.platformAccessory(device.name || device.id, uuid);

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
        };

        const pkg = require('../package.json') as { version: string };
        accessory.getService(this.Service.AccessoryInformation)!
            .setCharacteristic(this.Characteristic.Manufacturer,       'KAB / ECO Plugs')
            .setCharacteristic(this.Characteristic.Model,              'CT-065W')
            .setCharacteristic(this.Characteristic.SerialNumber,       device.id)
            .setCharacteristic(this.Characteristic.FirmwareRevision,   pkg.version);

        accessory.addService(this.Service.Outlet, device.name || device.id);

        this.configureServices(accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(device.id, accessory);
        this.log.info(`Registered accessory ${device.id} (${device.protocol})`);
    }

    private configureServices(accessory: PlatformAccessory): void {
        const outlet = accessory.getService(this.Service.Outlet)
                    ?? accessory.addService(this.Service.Outlet);

        outlet.getCharacteristic(this.Characteristic.On)
            .onSet(async (value) => {
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

    // ── Polling ──────────────────────────────────────────────────────────────

    private pollAllDevices(): void {
        for (const [id, acc] of this.cachedAccessories) {
            const ctx = acc.context;
            this.log.debug('Polling', id, ctx.name);

            if (ctx.protocol === 'kab') {
                void this.refreshAccessoryState(acc);
            } else {
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
            acc.getService(this.Service.Outlet)
               ?.updateCharacteristic(this.Characteristic.On, new Error('No Response'));
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
            const result = await kabSetPower(ctx as unknown as DeviceInfo, on, (msg) => this.log.debug(msg));
            if (!result.ok) {
                throw new Error(result.error?.message ?? 'KAB command failed');
            }
        } else {
            this.legacyManager.setPower(ctx as unknown as DeviceInfo, on);
        }

        if (this.cachedAccessories.has(ctx.id as string)) {
            const acc = this.cachedAccessories.get(ctx.id as string)!;
            acc.context.lastUpdated = Date.now();
            acc.getService(this.Service.Outlet)
               ?.getCharacteristic(this.Characteristic.On)
               ?.updateValue(on);
        }
    }

    private getCachedPowerState(id: string): boolean {
        const acc = this.cachedAccessories.get(id);
        const val = acc?.getService(this.Service.Outlet)
                        ?.getCharacteristic(this.Characteristic.On)
                        ?.value;
        return typeof val === 'boolean' ? val : false;
    }

    private async refreshAccessoryState(acc: PlatformAccessory): Promise<void> {
        const ctx = acc.context as Record<string, unknown>;
        if (ctx.protocol !== 'kab') {
            return;
        }

        try {
            const result = await kabGetStatus(ctx as unknown as DeviceInfo, (msg) => this.log.debug(msg));
            if (!result.ok || !result.response) {
                if (result.error) {
                    this.log.warn(`KAB status failed for ${ctx.id as string}: ${result.error.message}`);
                }
                return;
            }

            const on = result.response.powerState !== 0;
            acc.context.lastUpdated = Date.now();
            acc.getService(this.Service.Outlet)
               ?.getCharacteristic(this.Characteristic.On)
               ?.updateValue(on);
        } catch (e) {
            this.log.debug(`KAB status refresh failed for ${ctx.id as string}: ${(e as Error).message}`);
        }
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
