import type { CharacteristicValue, PlatformAccessory } from 'homebridge';
import type { HubspacePlatform } from '../platform';
import { BaseAccessory } from './baseAccessory';

// Hubspace → HomeKit HVAC mode mapping
const HS_TO_HK_MODE: Record<string, number> = {
  off: 0,   // HEAT_COOL off
  heat: 1,
  cool: 2,
  auto: 3,
};

const HK_TO_HS_MODE: Record<number, string> = {
  0: 'off',
  1: 'heat',
  2: 'cool',
  3: 'auto',
};

export class ThermostatAccessory extends BaseAccessory {
  private service!: InstanceType<HubspacePlatform['Service']['Thermostat']>;

  constructor(platform: HubspacePlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
  }

  protected setupServices(): void {
    const { Service, Characteristic } = this.platform;
    this.service =
      this.accessory.getService(Service.Thermostat) ??
      this.accessory.addService(Service.Thermostat, this.device.friendlyName);

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentMode.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetMode.bind(this))
      .onSet(this.setTargetMode.bind(this));

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT)
      .onSet(() => { /* ignore – controlled by Hubspace config */ });
  }

  async refresh(): Promise<void> {
    await this.fetchState();
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.getCurrentMode());
    this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, this.getTargetMode());
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.getCurrentTemperature());
    this.service.updateCharacteristic(Characteristic.TargetTemperature, this.getTargetTemperature());
  }

  // ── Current mode: derived from whether system is actively heating/cooling ───

  private getCurrentMode(): CharacteristicValue {
    const mode = this.getStateValue('hvac-mode') as string | undefined;
    return HS_TO_HK_MODE[mode ?? 'off'] ?? 0;
  }

  private getTargetMode(): CharacteristicValue {
    return this.getCurrentMode();
  }

  private async setTargetMode(value: CharacteristicValue): Promise<void> {
    const hsMode = HK_TO_HS_MODE[value as number] ?? 'off';
    await this.setState('hvac-mode', hsMode);
  }

  // ── Temperatures (API may return Fahrenheit; HomeKit always uses Celsius) ───

  private getCurrentTemperature(): CharacteristicValue {
    const raw = this.getStateValue('temperature') as number | undefined;
    if (raw === undefined) return 20;
    return this.toCelsius(raw);
  }

  private getTargetTemperature(): CharacteristicValue {
    const raw = this.getStateValue('target-temperature') ?? this.getStateValue('cool-setpoint') as number | undefined;
    if (raw === undefined) return 22;
    return this.toCelsius(raw as number);
  }

  private async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    // Determine if we should send Fahrenheit or Celsius based on config
    const celsius = value as number;
    const apiValue = this.platform.temperatureUnit === 'fahrenheit'
      ? Math.round(celsius * 9 / 5 + 32)
      : celsius;

    const fc = this.hasFunctionClass('target-temperature') ? 'target-temperature' : 'cool-setpoint';
    await this.setState(fc, apiValue);
  }

  private toCelsius(value: number): number {
    if (this.platform.temperatureUnit === 'fahrenheit') {
      return Math.round(((value - 32) * 5) / 9 * 10) / 10;
    }
    return value;
  }

  private hasFunctionClass(fc: string): boolean {
    return this.device.description?.functions?.some((f) => f.functionClass === fc) ?? false;
  }
}
