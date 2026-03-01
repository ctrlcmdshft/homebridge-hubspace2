import axios, { type AxiosInstance } from 'axios';
import { login, refreshTokens } from './auth';
import { TokenStore } from './tokenStore';
import { HUBSPACE_API } from '../settings';
import type { AuthState, DeviceState, DeviceStateValue, HubspaceDevice } from './types';
import type { Logger } from 'homebridge';

/** Thrown when the API needs an OTP but none was supplied. */
export class OtpRequiredError extends Error {
  constructor() {
    super('OTP_REQUIRED');
    this.name = 'OtpRequiredError';
  }
}

export class HubspaceApi {
  private auth: AuthState | null = null;
  private accountId: string | null = null;
  private readonly http: AxiosInstance;
  private readonly store: TokenStore;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
    storagePath: string,
    private readonly temperatureUnit: 'fahrenheit' | 'celsius' = 'fahrenheit',
    /** OTP code – only needed on first login when the account uses email 2FA */
    private readonly otp?: string,
  ) {
    this.store = new TokenStore(storagePath);
    this.http = axios.create({
      headers: {
        'User-Agent': HUBSPACE_API.USER_AGENT,
        'accept-encoding': 'gzip',
      },
    });
  }

  // ── Auth management ─────────────────────────────────────────────────────────

  private async ensureAuth(): Promise<string> {
    // 1. Use in-memory token if still valid
    if (this.auth && Date.now() < this.auth.expiresAt - HUBSPACE_API.TOKEN_REFRESH_BUFFER_MS) {
      return this.auth.accessToken;
    }

    // 2. Try refresh token (in-memory or from disk)
    const stored = this.auth ?? this.store.load();
    if (stored) {
      this.log.debug('[HubspaceApi] Refreshing access token');
      try {
        this.auth = await refreshTokens(stored.refreshToken);
        this.store.save(this.auth);
        return this.auth.accessToken;
      } catch {
        this.log.warn('[HubspaceApi] Token refresh failed – doing full login');
        this.store.clear();
      }
    }

    // 3. Full login with username + password (+ optional OTP)
    this.log.debug('[HubspaceApi] Performing full login');
    try {
      this.auth = await login(this.username, this.password, this.otp);
    } catch (err) {
      if (err instanceof Error && err.message === 'OTP_REQUIRED') {
        throw new OtpRequiredError();
      }
      throw err;
    }
    this.store.save(this.auth);
    return this.auth.accessToken;
  }

  private async getAccountId(): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    const token = await this.ensureAuth();
    const response = await this.withRetry(() =>
      this.http.get<{ accountAccess: Array<{ account: { accountId: string } }> }>(
        `https://${HUBSPACE_API.API_HOST}/v1/users/me`,
        { headers: { Authorization: `Bearer ${token}`, host: HUBSPACE_API.API_HOST } },
      ),
    );
    this.accountId = response.data.accountAccess[0].account.accountId;
    this.log.debug(`[HubspaceApi] Account ID: ${this.accountId}`);
    return this.accountId;
  }

  // ── Retry logic ─────────────────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < HUBSPACE_API.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          if (status === 429 || status === 503 || status === 504) {
            const wait = 250 * (attempt + 1);
            this.log.debug(`[HubspaceApi] Rate-limited (${status}), retrying in ${wait}ms`);
            await new Promise((r) => setTimeout(r, wait));
            this.auth = null;
            continue;
          }
        }
        throw err;
      }
    }
    throw lastError;
  }

  // ── Device discovery ────────────────────────────────────────────────────────

  async getDevices(): Promise<HubspaceDevice[]> {
    const token = await this.ensureAuth();
    const accountId = await this.getAccountId();

    const url = `https://${HUBSPACE_API.API_DATA_HOST}/v1/accounts/${accountId}/metadevices`;
    const params: Record<string, string> = { expansions: 'state,capabilities,semantics' };
    if (this.temperatureUnit === 'fahrenheit') {
      params['units'] = 'fahrenheit';
    }

    const response = await this.withRetry(() =>
      this.http.get<HubspaceDevice[]>(url, {
        params,
        headers: { Authorization: `Bearer ${token}`, host: HUBSPACE_API.API_DATA_HOST },
      }),
    );
    return response.data;
  }

  // ── Device state ────────────────────────────────────────────────────────────

  async getDeviceState(deviceId: string): Promise<DeviceState> {
    const token = await this.ensureAuth();
    const accountId = await this.getAccountId();

    const url = `https://${HUBSPACE_API.API_DATA_HOST}/v1/accounts/${accountId}/metadevices/${deviceId}/state`;
    const response = await this.withRetry(() =>
      this.http.get<DeviceState>(url, {
        headers: { Authorization: `Bearer ${token}`, host: HUBSPACE_API.API_DATA_HOST },
      }),
    );
    return response.data;
  }

  async setDeviceState(deviceId: string, values: Partial<DeviceStateValue>[]): Promise<DeviceState> {
    const token = await this.ensureAuth();
    const accountId = await this.getAccountId();

    const url = `https://${HUBSPACE_API.API_DATA_HOST}/v1/accounts/${accountId}/metadevices/${deviceId}/state`;
    const body: DeviceState = { metadeviceId: deviceId, values: values as DeviceStateValue[] };

    const response = await this.withRetry(() =>
      this.http.put<DeviceState>(url, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          host: HUBSPACE_API.API_DATA_HOST,
        },
      }),
    );
    return response.data;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  static getStateValue(state: DeviceState, functionClass: string, functionInstance: string | null = null): unknown {
    return state.values.find(
      (v) => v.functionClass === functionClass && v.functionInstance === functionInstance,
    )?.value;
  }

  static makeStateUpdate(
    functionClass: string,
    value: unknown,
    functionInstance: string | null = null,
  ): Partial<DeviceStateValue> {
    return { functionClass, value, functionInstance };
  }
}
