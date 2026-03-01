import type { CharacteristicValue, PlatformAccessory } from 'homebridge';
import type { HubspacePlatform } from '../platform';
import { BaseAccessory } from './baseAccessory';

export class LightAccessory extends BaseAccessory {
  private service!: InstanceType<HubspacePlatform['Service']['Lightbulb']>;

  constructor(platform: HubspacePlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
  }

  protected setupServices(): void {
    const { Service, Characteristic } = this.platform;
    this.service =
      this.accessory.getService(Service.Lightbulb) ??
      this.accessory.addService(Service.Lightbulb, this.device.friendlyName);

    // On/Off
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Brightness (if supported)
    if (this.hasFunctionClass('brightness')) {
      this.service
        .getCharacteristic(Characteristic.Brightness)
        .onGet(this.getBrightness.bind(this))
        .onSet(this.setBrightness.bind(this));
    }

    // Color temperature (if supported)
    if (this.hasFunctionClass('color-temperature')) {
      this.service
        .getCharacteristic(Characteristic.ColorTemperature)
        .onGet(this.getColorTemperature.bind(this))
        .onSet(this.setColorTemperature.bind(this));
    }

    // Hue & Saturation (if RGB supported)
    if (this.hasFunctionClass('color-rgb')) {
      this.service
        .getCharacteristic(Characteristic.Hue)
        .onGet(this.getHue.bind(this))
        .onSet(this.setHue.bind(this));
      this.service
        .getCharacteristic(Characteristic.Saturation)
        .onGet(this.getSaturation.bind(this))
        .onSet(this.setSaturation.bind(this));
    }
  }

  async refresh(): Promise<void> {
    await this.fetchState();
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.On, this.getOn());
    if (this.hasFunctionClass('brightness')) {
      this.service.updateCharacteristic(Characteristic.Brightness, this.getBrightness());
    }
    if (this.hasFunctionClass('color-temperature')) {
      this.service.updateCharacteristic(Characteristic.ColorTemperature, this.getColorTemperature());
    }
    if (this.hasFunctionClass('color-rgb')) {
      this.service.updateCharacteristic(Characteristic.Hue, this.getHue());
      this.service.updateCharacteristic(Characteristic.Saturation, this.getSaturation());
    }
  }

  // ── Getters / setters ───────────────────────────────────────────────────────

  private getOn(): CharacteristicValue {
    return this.getStateValue('power') === 'on';
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    await this.setState('power', value ? 'on' : 'off');
  }

  private getBrightness(): CharacteristicValue {
    const v = this.getStateValue('brightness');
    return typeof v === 'number' ? Math.round(v) : 100;
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    await this.setState('brightness', Math.round(value as number));
  }

  /**
   * Hubspace uses Kelvin (2200–6500). HomeKit uses Mired (140–500).
   * Conversion: mired = 1_000_000 / kelvin
   */
  private getColorTemperature(): CharacteristicValue {
    const kelvin = this.getStateValue('color-temperature');
    if (typeof kelvin !== 'number' || kelvin === 0) {
      return 370; // ~2700K warm white default
    }
    return Math.round(1_000_000 / kelvin);
  }

  private async setColorTemperature(value: CharacteristicValue): Promise<void> {
    const kelvin = Math.round(1_000_000 / (value as number));
    await this.setState('color-temperature', kelvin);
    // Switch to white mode when adjusting color temperature
    if (this.hasFunctionClass('color-mode')) {
      await this.setState('color-mode', 'white');
    }
  }

  // RGB → HSV helpers
  private rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, v: v * 100 };
  }

  private hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
    h /= 360; s /= 100; v /= 100;
    let r = 0, g = 0, b = 0;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  private getHue(): CharacteristicValue {
    const rgb = this.getStateValue('color-rgb') as { r: number; g: number; b: number } | undefined;
    if (!rgb) return 0;
    return Math.round(this.rgbToHsv(rgb.r, rgb.g, rgb.b).h);
  }

  private async setHue(value: CharacteristicValue): Promise<void> {
    const rgb = this.getStateValue('color-rgb') as { r: number; g: number; b: number } | undefined;
    const current = rgb ? this.rgbToHsv(rgb.r, rgb.g, rgb.b) : { h: 0, s: 100, v: 100 };
    const newRgb = this.hsvToRgb(value as number, current.s, current.v);
    await this.setState('color-rgb', newRgb);
    if (this.hasFunctionClass('color-mode')) {
      await this.setState('color-mode', 'color');
    }
  }

  private getSaturation(): CharacteristicValue {
    const rgb = this.getStateValue('color-rgb') as { r: number; g: number; b: number } | undefined;
    if (!rgb) return 100;
    return Math.round(this.rgbToHsv(rgb.r, rgb.g, rgb.b).s);
  }

  private async setSaturation(value: CharacteristicValue): Promise<void> {
    const rgb = this.getStateValue('color-rgb') as { r: number; g: number; b: number } | undefined;
    const current = rgb ? this.rgbToHsv(rgb.r, rgb.g, rgb.b) : { h: 0, s: 100, v: 100 };
    const newRgb = this.hsvToRgb(current.h, value as number, current.v);
    await this.setState('color-rgb', newRgb);
    if (this.hasFunctionClass('color-mode')) {
      await this.setState('color-mode', 'color');
    }
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  private hasFunctionClass(fc: string): boolean {
    return this.device.description?.functions?.some((f) => f.functionClass === fc) ?? false;
  }
}
