// ── Auth ─────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;          // seconds until access token expires
  refresh_expires_in?: number; // seconds until refresh token expires
  token_type: string;
}

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}

// ── Device data ───────────────────────────────────────────────────────────────

export interface DeviceStateValue {
  functionClass: string;
  functionInstance: string | null;
  value: unknown;
  lastUpdateTime?: number;
}

export interface DeviceState {
  metadeviceId: string;
  values: DeviceStateValue[];
}

export interface FunctionRange {
  min: number;
  max: number;
  step: number;
}

export interface FunctionValue {
  name: string;
  range?: FunctionRange;
  categories?: string[];
}

export interface DeviceFunction {
  id: string;
  functionClass: string;
  functionInstance: string | null;
  type: 'numeric' | 'category' | 'object' | string;
  schedulable?: boolean;
  values?: FunctionValue[];
}

export interface DeviceDescription {
  device?: {
    defaultName?: string;
    manufacturerName?: string;
    model?: string;
    deviceClass?: string;
    type?: string;
  };
  functions?: DeviceFunction[];
}

export interface HubspaceDevice {
  id: string;
  deviceId?: string;
  typeId?: string;
  friendlyName: string;
  description?: DeviceDescription;
  state?: DeviceState;
  children?: HubspaceDevice[];
}

// ── Convenience helpers ───────────────────────────────────────────────────────

/** Known device classes returned by the Hubspace API */
export type DeviceClass =
  | 'light'
  | 'fan'
  | 'switch'
  | 'outlet'
  | 'thermostat'
  | 'lock'
  | 'valve'
  | 'sensor'
  | string;
