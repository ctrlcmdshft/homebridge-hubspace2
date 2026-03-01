import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HubspaceApi, OtpRequiredError } from './api/hubspaceApi';
import type { HubspaceDevice } from './api/types';
import { BaseAccessory } from './accessories/baseAccessory';
import { LightAccessory } from './accessories/lightAccessory';
import { FanAccessory } from './accessories/fanAccessory';
import { SwitchAccessory } from './accessories/switchAccessory';
import { ThermostatAccessory } from './accessories/thermostatAccessory';
import { LockAccessory } from './accessories/lockAccessory';
import { ValveAccessory } from './accessories/valveAccessory';

/** Maps Hubspace deviceClass → accessory constructor */
type AccessoryCtor = new (platform: HubspacePlatform, accessory: PlatformAccessory) => BaseAccessory;

const CLASS_MAP: Record<string, AccessoryCtor> = {
  light: LightAccessory,
  fan: FanAccessory,
  'ceiling-fan': FanAccessory,
  switch: SwitchAccessory,
  outlet: SwitchAccessory,
  transformer: SwitchAccessory,
  thermostat: ThermostatAccessory,
  freezer: ThermostatAccessory,
  lock: LockAccessory,
  valve: ValveAccessory,
  'water-timer': ValveAccessory,
};

export class HubspacePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly hubspaceApi: HubspaceApi;
  public readonly temperatureUnit: 'fahrenheit' | 'celsius';

  /** Cached accessories restored from disk */
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  /** Active accessory handlers (UUID → handler) */
  private readonly accessories = new Map<string, BaseAccessory>();

  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.temperatureUnit = (config['temperatureUnit'] as 'fahrenheit' | 'celsius') ?? 'fahrenheit';

    this.hubspaceApi = new HubspaceApi(
      config['username'] as string,
      config['password'] as string,
      log,
      api.user.storagePath(),
      this.temperatureUnit,
      config['otp'] as string | undefined,
    );

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
      this.startPolling();
    });

    this.api.on('shutdown', () => {
      this.stopPolling();
    });

    log.debug('Hubspace platform initialized');
  }

  // ── Homebridge lifecycle ────────────────────────────────────────────────────

  /** Called by Homebridge for each accessory found in the cache at startup */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // ── Device discovery ────────────────────────────────────────────────────────

  private async discoverDevices(): Promise<void> {
    let devices: HubspaceDevice[];
    try {
      devices = await this.hubspaceApi.getDevices();
      this.log.info(`Discovered ${devices.length} Hubspace device(s)`);
    } catch (err) {
      if (err instanceof OtpRequiredError) {
        this.log.error('');
        this.log.error('══════════════════════════════════════════════════════');
        this.log.error('  Hubspace: Two-factor authentication (OTP) required');
        this.log.error('══════════════════════════════════════════════════════');
        this.log.error('  A one-time code was just sent to your email address.');
        this.log.error('  To complete login:');
        this.log.error('    1. Copy the code from your email.');
        this.log.error('    2. Add  "otp": "<code>"  to your Hubspace config.');
        this.log.error('    3. Restart Homebridge.');
        this.log.error('    4. Once running, remove the "otp" line – it is no');
        this.log.error('       longer needed after the first successful login.');
        this.log.error('══════════════════════════════════════════════════════');
        this.log.error('');
      } else {
        this.log.error('Failed to discover Hubspace devices:', err);
      }
      return;
    }

    const seenUUIDs = new Set<string>();

    for (const device of devices) {
      const deviceClass = device.description?.device?.deviceClass ?? '';
      const Ctor = CLASS_MAP[deviceClass];

      if (!Ctor) {
        if (this.config['debug']) {
          this.log.debug(`Skipping unsupported device class "${deviceClass}": ${device.friendlyName}`);
        }
        continue;
      }

      const uuid = this.api.hap.uuid.generate(device.id);
      seenUUIDs.add(uuid);

      if (this.cachedAccessories.has(uuid)) {
        // Restore from cache, update context with latest device info
        const cached = this.cachedAccessories.get(uuid)!;
        cached.context.device = device;
        this.api.updatePlatformAccessories([cached]);
        this.registerHandler(Ctor, cached);
        this.log.debug(`Restored: ${device.friendlyName}`);
      } else {
        // Create new accessory
        const accessory = new this.api.platformAccessory(device.friendlyName, uuid);
        accessory.context.device = device;
        this.registerHandler(Ctor, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added new device: ${device.friendlyName} (${deviceClass})`);
      }
    }

    // Remove accessories that no longer exist in the Hubspace account
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!seenUUIDs.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
        this.accessories.delete(uuid);
      }
    }
  }

  private registerHandler(Ctor: AccessoryCtor, accessory: PlatformAccessory): void {
    try {
      const handler = new Ctor(this, accessory);
      this.accessories.set(accessory.UUID, handler);
    } catch (err) {
      this.log.error(`Failed to initialize handler for ${accessory.displayName}:`, err);
    }
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  private startPolling(): void {
    const intervalSec = (this.config['pollingInterval'] as number | undefined) ?? 30;
    const intervalMs = Math.max(intervalSec, 10) * 1000;

    this.log.debug(`Starting state polling every ${intervalSec}s`);
    this.pollingTimer = setInterval(() => this.pollAll(), intervalMs);
  }

  private stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private async pollAll(): Promise<void> {
    const handlers = Array.from(this.accessories.values());
    await Promise.allSettled(handlers.map((h) => h.refresh()));
  }
}
