import type { CharacteristicValue, PlatformAccessory } from 'homebridge';
import type { HubspacePlatform } from '../platform';
import { BaseAccessory } from './baseAccessory';

/** Covers both on/off switches and smart outlets */
export class SwitchAccessory extends BaseAccessory {
  private service!:
    | InstanceType<HubspacePlatform['Service']['Switch']>
    | InstanceType<HubspacePlatform['Service']['Outlet']>;

  private readonly isOutlet: boolean;

  constructor(platform: HubspacePlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
    this.isOutlet = (accessory.context.device as { description?: { device?: { deviceClass?: string } } })
      .description?.device?.deviceClass === 'outlet';
  }

  protected setupServices(): void {
    const { Service, Characteristic } = this.platform;
    const ServiceType = this.isOutlet ? Service.Outlet : Service.Switch;

    this.service =
      (this.accessory.getService(ServiceType) as typeof this.service | undefined) ??
      this.accessory.addService(ServiceType, this.device.friendlyName);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  async refresh(): Promise<void> {
    await this.fetchState();
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.getOn());
  }

  private getOn(): CharacteristicValue {
    const power = this.getStateValue('power') ?? this.getStateValue('toggle');
    return power === 'on';
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const fc = this.hasFunctionClass('power') ? 'power' : 'toggle';
    await this.setState(fc, value ? 'on' : 'off');
  }

  private hasFunctionClass(fc: string): boolean {
    return this.device.description?.functions?.some((f) => f.functionClass === fc) ?? false;
  }
}
