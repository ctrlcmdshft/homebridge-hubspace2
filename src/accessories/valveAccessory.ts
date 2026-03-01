import type { CharacteristicValue, PlatformAccessory } from 'homebridge';
import type { HubspacePlatform } from '../platform';
import { BaseAccessory } from './baseAccessory';

export class ValveAccessory extends BaseAccessory {
  private service!: InstanceType<HubspacePlatform['Service']['Valve']>;

  constructor(platform: HubspacePlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
  }

  protected setupServices(): void {
    const { Service, Characteristic } = this.platform;
    this.service =
      this.accessory.getService(Service.Valve) ??
      this.accessory.addService(Service.Valve, this.device.friendlyName);

    this.service
      .setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.GENERIC_VALVE);

    this.service
      .getCharacteristic(Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service
      .getCharacteristic(Characteristic.InUse)
      .onGet(this.getInUse.bind(this));
  }

  async refresh(): Promise<void> {
    await this.fetchState();
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.Active, this.getActive());
    this.service.updateCharacteristic(Characteristic.InUse, this.getInUse());
  }

  private getActive(): CharacteristicValue {
    const power = this.getStateValue('power') ?? this.getStateValue('toggle');
    return power === 'on'
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    await this.setState('power', on ? 'on' : 'off');
  }

  private getInUse(): CharacteristicValue {
    return this.getActive();
  }
}
