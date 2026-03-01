import type { CharacteristicValue, PlatformAccessory } from 'homebridge';
import type { HubspacePlatform } from '../platform';
import { BaseAccessory } from './baseAccessory';

export class FanAccessory extends BaseAccessory {
  private service!: InstanceType<HubspacePlatform['Service']['Fanv2']>;

  constructor(platform: HubspacePlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
  }

  protected setupServices(): void {
    const { Service, Characteristic } = this.platform;
    // Use Fanv2 – it supports rotation speed and direction
    this.service =
      this.accessory.getService(Service.Fanv2) ??
      this.accessory.addService(Service.Fanv2, this.device.friendlyName);

    this.service
      .getCharacteristic(Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    // Speed
    this.service
      .getCharacteristic(Characteristic.RotationSpeed)
      .onGet(this.getSpeed.bind(this))
      .onSet(this.setSpeed.bind(this));

    // Direction (if supported)
    if (this.hasFunctionClass('fan-reverse')) {
      this.service
        .getCharacteristic(Characteristic.RotationDirection)
        .onGet(this.getDirection.bind(this))
        .onSet(this.setDirection.bind(this));
    }
  }

  async refresh(): Promise<void> {
    await this.fetchState();
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.Active, this.getActive());
    this.service.updateCharacteristic(Characteristic.RotationSpeed, this.getSpeed());
    if (this.hasFunctionClass('fan-reverse')) {
      this.service.updateCharacteristic(Characteristic.RotationDirection, this.getDirection());
    }
  }

  // ── Getters / setters ───────────────────────────────────────────────────────

  private getActive(): CharacteristicValue {
    const power = this.getStateValue('power') ?? this.getStateValue('toggle');
    return power === 'on'
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    const fc = this.hasFunctionClass('power') ? 'power' : 'toggle';
    await this.setState(fc, on ? 'on' : 'off');
  }

  /** Map numeric speed (0–N) to 0–100 percentage */
  private getSpeed(): CharacteristicValue {
    const speed = this.getStateValue('fan-speed') ?? this.getStateValue('speed');
    if (typeof speed !== 'number') return 0;

    const maxSpeed = this.getMaxSpeed();
    return maxSpeed > 0 ? Math.round((speed / maxSpeed) * 100) : 0;
  }

  private async setSpeed(value: CharacteristicValue): Promise<void> {
    const pct = value as number;
    const maxSpeed = this.getMaxSpeed();
    const raw = Math.round((pct / 100) * maxSpeed);
    const fc = this.hasFunctionClass('fan-speed') ? 'fan-speed' : 'speed';
    await this.setState(fc, raw);
  }

  private getDirection(): CharacteristicValue {
    const reversed = this.getStateValue('fan-reverse');
    return reversed === 'on'
      ? this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE
      : this.platform.Characteristic.RotationDirection.CLOCKWISE;
  }

  private async setDirection(value: CharacteristicValue): Promise<void> {
    const counterClockwise = value === this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE;
    await this.setState('fan-reverse', counterClockwise ? 'on' : 'off');
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  private getMaxSpeed(): number {
    const fn = this.device.description?.functions?.find(
      (f) => f.functionClass === 'fan-speed' || f.functionClass === 'speed',
    );
    return fn?.values?.[0]?.range?.max ?? 6;
  }

  private hasFunctionClass(fc: string): boolean {
    return this.device.description?.functions?.some((f) => f.functionClass === fc) ?? false;
  }
}
