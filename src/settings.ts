export const PLATFORM_NAME = 'HubspacePlatform';
export const PLUGIN_NAME = 'homebridge-hubspace2';

export const HUBSPACE_API = {
  AUTH_HOST: 'accounts.hubspaceconnect.com',
  AUTH_REALM: 'thd',
  CLIENT_ID: 'hubspace_android',
  REDIRECT_URI: 'hubspace-app://loginredirect',
  API_HOST: 'api2.afero.net',
  API_DATA_HOST: 'semantics2.afero.net',
  USER_AGENT:
    'Mozilla/5.0 (Linux; Android 15; aioafero Build/test; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.63 Mobile Safari/537.36',
  TOKEN_REFRESH_BUFFER_MS: 10_000, // refresh 10s before expiry
  MAX_RETRIES: 3,
} as const;
