import crypto from 'crypto';
import axios from 'axios';
import { HUBSPACE_API } from '../settings';
import type { AuthState, TokenResponse } from './types';

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64urlEncode(crypto.randomBytes(40)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  const challenge = base64urlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── HTML parsing helpers ──────────────────────────────────────────────────────

/** Extract query params from a URL string */
function extractQueryParam(url: string, key: string): string | undefined {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://x.com${url}`);
    return parsed.searchParams.get(key) ?? undefined;
  } catch {
    const match = url.match(new RegExp(`[?&]${key}=([^&]*)`));
    return match ? decodeURIComponent(match[1]) : undefined;
  }
}

/** Extract the authorization code from a redirect URI (custom scheme) */
function extractAuthCode(locationHeader: string): string | null {
  // hubspace-app://loginredirect?code=XXX
  const match = locationHeader.match(/[?&]code=([^&]+)/);
  return match ? match[1] : null;
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCodeForTokens(code: string, verifier: string): Promise<TokenResponse> {
  const tokenUrl = `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/protocol/openid-connect/token`;

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: HUBSPACE_API.REDIRECT_URI,
    code_verifier: verifier,
    client_id: HUBSPACE_API.CLIENT_ID,
  });

  const response = await axios.post<TokenResponse>(tokenUrl, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'accept-encoding': 'gzip',
      'host': HUBSPACE_API.AUTH_HOST,
    },
  });

  return response.data;
}

// ── Main login flow ───────────────────────────────────────────────────────────

export async function login(username: string, password: string, otp?: string): Promise<AuthState> {
  const { verifier, challenge } = generatePKCE();

  const authUrl = new URL(
    `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/protocol/openid-connect/auth`,
  );
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', HUBSPACE_API.CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', HUBSPACE_API.REDIRECT_URI);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', 'openid offline_access');

  // Step 1 – fetch login page (do NOT follow redirects automatically)
  const loginPageResp = await axios.get<string>(authUrl.toString(), {
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
    headers: { 'User-Agent': HUBSPACE_API.USER_AGENT },
  });

  let authCode: string | null = null;

  // If already redirected (no OTP, maybe cached session), grab the code directly
  if (loginPageResp.status === 302 || loginPageResp.status === 301) {
    const location = loginPageResp.headers['location'] as string | undefined;
    if (location) {
      authCode = extractAuthCode(location);
    }
  }

  if (!authCode) {
    const html = loginPageResp.data as string;

    // Extract session parameters embedded in the form action URL
    const formActionMatch = html.match(/action="([^"]+)"/);
    if (!formActionMatch) {
      throw new Error('Could not find login form action URL');
    }
    const formAction = formActionMatch[1].replace(/&amp;/g, '&');

    const sessionCode = extractQueryParam(formAction, 'session_code');
    const execution = extractQueryParam(formAction, 'execution');
    const clientId = extractQueryParam(formAction, 'client_id');
    const tabId = extractQueryParam(formAction, 'tab_id');

    const submitUrl = `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/login-actions/authenticate` +
      `?session_code=${sessionCode}&execution=${execution}&client_id=${clientId}&tab_id=${tabId}`;

    // Step 2 – submit credentials
    const loginResp = await axios.post(
      submitUrl,
      new URLSearchParams({ username, password, credentialId: '' }).toString(),
      {
        maxRedirects: 0,
        validateStatus: (s) => s < 400,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-requested-with': 'io.afero.partner.hubspace',
          'User-Agent': HUBSPACE_API.USER_AGENT,
        },
      },
    );

    const location = loginResp.headers['location'] as string | undefined;

    // OTP required?
    if (loginResp.status === 200 && loginResp.data && (loginResp.data as string).includes('kc-otp-login-form')) {
      if (!otp) {
        throw new Error('OTP_REQUIRED: This account requires a one-time password. Provide it via the "otp" parameter.');
      }

      // Extract new session params from the OTP form
      const otpHtml = loginResp.data as string;
      const otpFormMatch = otpHtml.match(/action="([^"]+)"/);
      if (!otpFormMatch) {
        throw new Error('Could not parse OTP form');
      }
      const otpFormAction = otpFormMatch[1].replace(/&amp;/g, '&');
      const otpSessionCode = extractQueryParam(otpFormAction, 'session_code');
      const otpExecution = extractQueryParam(otpFormAction, 'execution');
      const otpClientId = extractQueryParam(otpFormAction, 'client_id');
      const otpTabId = extractQueryParam(otpFormAction, 'tab_id');

      const otpSubmitUrl = `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/login-actions/authenticate` +
        `?session_code=${otpSessionCode}&execution=${otpExecution}&client_id=${otpClientId}&tab_id=${otpTabId}`;

      const otpResp = await axios.post(
        otpSubmitUrl,
        new URLSearchParams({ action: 'submit', flowName: 'doLogIn', emailCode: otp }).toString(),
        {
          maxRedirects: 0,
          validateStatus: (s) => s < 400,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-requested-with': 'io.afero.partner.hubspace',
            'User-Agent': HUBSPACE_API.USER_AGENT,
          },
        },
      );

      const otpLocation = otpResp.headers['location'] as string | undefined;
      if (otpLocation) {
        authCode = extractAuthCode(otpLocation);
      }
    } else if (location) {
      authCode = extractAuthCode(location);
    }
  }

  if (!authCode) {
    throw new Error('Authentication failed: could not obtain authorization code. Check your credentials.');
  }

  // Step 3 – exchange code for tokens
  const tokens = await exchangeCodeForTokens(authCode, verifier);
  return tokensToAuthState(tokens);
}

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshTokens(refreshToken: string): Promise<AuthState> {
  const tokenUrl = `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/protocol/openid-connect/token`;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'openid email offline_access profile',
    client_id: HUBSPACE_API.CLIENT_ID,
  });

  const response = await axios.post<TokenResponse>(tokenUrl, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'accept-encoding': 'gzip',
      'host': HUBSPACE_API.AUTH_HOST,
    },
  });

  return tokensToAuthState(response.data);
}

function tokensToAuthState(tokens: TokenResponse): AuthState {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}
