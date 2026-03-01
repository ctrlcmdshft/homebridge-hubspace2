import type { CharacteristicValue, PlatformAccessory } from 'homebridge';
import type { HubspacePlatform } from '../platform';
import { BaseAccessory } from './baseAccessory';

export class LockAccessory extends BaseAccessory {
  private service!: InstanceType<HubspacePlatform['Service']['LockMechanism']>;

  constructor(platform: HubspacePlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
  }

  protected setupServices(): void {
    const { Service, Characteristic } = this.platform;
    this.service =
      this.accessory.getService(Service.LockMechanism) ??
      this.accessory.addService(Service.LockMechanism, this.device.friendlyName);

    this.service
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));

    this.service
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));
  }

  async refresh(): Promise<void> {
    await this.fetchState();
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.LockCurrentState, this.getLockCurrentState());
    this.service.updateCharacteristic(Characteristic.LockTargetState, this.getLockTargetState());
  }

  private getLockCurrentState(): CharacteristicValue {
    const state = this.getStateValue('lock-control') as string | undefined;
    const { LockCurrentState } = this.platform.Characteristic;
    if (state === 'lock') return LockCurrentState.SECURED;
    if (state === 'unlock') return LockCurrentState.UNSECURED;
    return LockCurrentState.UNKNOWN;
  }

  private getLockTargetState(): CharacteristicValue {
    const state = this.getStateValue('lock-control') as string | undefined;
    const { LockTargetState } = this.platform.Characteristic;
    return state === 'lock' ? LockTargetState.SECURED : LockTargetState.UNSECURED;
  }

  private async setLockTargetState(value: CharacteristicValue): Promise<void> {
    const { LockTargetState } = this.platform.Characteristic;
    const command = value === LockTargetState.SECURED ? 'lock' : 'unlock';
    await this.setState('lock-control', command);
  }
}
