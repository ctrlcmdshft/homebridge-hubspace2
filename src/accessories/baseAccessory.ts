import type { PlatformAccessory, Service } from 'homebridge';
import type { HubspacePlatform } from '../platform';
import type { HubspaceDevice } from '../api/types';
import { HubspaceApi } from '../api/hubspaceApi';

export abstract class BaseAccessory {
  protected readonly Service: typeof Service;
  protected deviceId: string;
  protected device: HubspaceDevice;

  constructor(
    protected readonly platform: HubspacePlatform,
    protected readonly accessory: PlatformAccessory,
  ) {
    this.Service = platform.Service;
    this.device = accessory.context.device as HubspaceDevice;
    this.deviceId = this.device.id;

    // Accessory information (always set)
    const desc = this.device.description?.device;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, desc?.manufacturerName ?? 'Hubspace')
      .setCharacteristic(this.platform.Characteristic.Model, desc?.model ?? desc?.defaultName ?? 'Unknown')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.deviceId ?? this.device.id);

    this.setupServices();
  }

  /** Subclasses set up their HAP services here */
  protected abstract setupServices(): void;

  /** Called by the platform's polling loop. Subclasses update characteristics here. */
  abstract refresh(): Promise<void>;

  // ── Shared helpers ──────────────────────────────────────────────────────────

  protected get api(): HubspaceApi {
    return this.platform.hubspaceApi;
  }

  protected get log() { return this.platform.log; }

  protected getStateValue(functionClass: string, functionInstance: string | null = null): unknown {
    return this.device.state
      ? HubspaceApi.getStateValue(this.device.state, functionClass, functionInstance)
      : undefined;
  }

  protected async setState(functionClass: string, value: unknown, functionInstance: string | null = null): Promise<void> {
    try {
      const updated = await this.api.setDeviceState(this.deviceId, [
        HubspaceApi.makeStateUpdate(functionClass, value, functionInstance),
      ]);
      if (this.device.state) {
        this.device.state = updated;
      }
    } catch (err) {
      this.log.error(`[${this.device.friendlyName}] Failed to set ${functionClass}:`, err);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /** Pull latest state from API and store on device context */
  protected async fetchState(): Promise<void> {
    try {
      this.device.state = await this.api.getDeviceState(this.deviceId);
    } catch (err) {
      this.log.warn(`[${this.device.friendlyName}] Failed to refresh state:`, err);
    }
  }
}
