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

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) return '';
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return headers
    .map((h) => h.split(';')[0].trim())
    .join('; ');
}

function mergeCookies(existing: string, newCookies: string): string {
  const map = new Map<string, string>();
  for (const part of [...existing.split('; '), ...newCookies.split('; ')]) {
    const eq = part.indexOf('=');
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── HTML / URL helpers ────────────────────────────────────────────────────────

function extractQueryParam(url: string, key: string): string | undefined {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://x.com${url}`);
    return parsed.searchParams.get(key) ?? undefined;
  } catch {
    const match = url.match(new RegExp(`[?&]${key}=([^&]*)`));
    return match ? decodeURIComponent(match[1]) : undefined;
  }
}

function extractAuthCode(location: string): string | null {
  const match = location.match(/[?&]code=([^&]+)/);
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

// ── Redirect follower ─────────────────────────────────────────────────────────

/**
 * Follow HTTP redirects manually so we can carry cookies at each hop.
 * Stops when we reach the hubspace-app:// custom scheme (which axios
 * cannot fetch) or when there are no more Location headers.
 * Returns the final Location value that contains the auth code.
 */
async function followRedirects(
  startUrl: string,
  cookies: string,
  log: (msg: string) => void,
): Promise<{ authCode: string | null; cookies: string }> {
  let currentUrl = startUrl;
  let currentCookies = cookies;

  for (let hop = 0; hop < 5; hop++) {
    log(`[auth] redirect hop ${hop + 1}: ${currentUrl}`);

    // Custom scheme — can't fetch, but the URL itself contains the code
    if (!currentUrl.startsWith('http')) {
      return { authCode: extractAuthCode(currentUrl), cookies: currentCookies };
    }

    const resp = await axios.get(currentUrl, {
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
      headers: {
        'User-Agent': HUBSPACE_API.USER_AGENT,
        ...(currentCookies ? { Cookie: currentCookies } : {}),
      },
    });

    currentCookies = mergeCookies(currentCookies, parseCookies(resp.headers['set-cookie']));
    log(`[auth] hop ${hop + 1} status: ${resp.status}`);

    const location = resp.headers['location'] as string | undefined;
    if (!location) break;

    const code = extractAuthCode(location);
    if (code) return { authCode: code, cookies: currentCookies };

    currentUrl = location.startsWith('http') ? location : `https://${HUBSPACE_API.AUTH_HOST}${location}`;
  }

  return { authCode: null, cookies: currentCookies };
}

// ── Main login flow ───────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string,
  otp?: string,
  log: (msg: string) => void = () => { /* no-op */ },
): Promise<AuthState> {
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

  // Step 1 – fetch login page
  log('[auth] fetching login page');
  const loginPageResp = await axios.get<string>(authUrl.toString(), {
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
    headers: { 'User-Agent': HUBSPACE_API.USER_AGENT },
  });

  log(`[auth] login page status: ${loginPageResp.status}`);
  let cookies = parseCookies(loginPageResp.headers['set-cookie']);
  log(`[auth] cookies captured: ${cookies ? 'yes' : 'none'}`);

  let authCode: string | null = null;

  // Already redirected — cached session
  if (loginPageResp.status === 302 || loginPageResp.status === 301) {
    const location = loginPageResp.headers['location'] as string | undefined;
    log(`[auth] immediate redirect to: ${location}`);
    if (location) {
      authCode = extractAuthCode(location);
      if (!authCode && location.startsWith('http')) {
        ({ authCode, cookies } = await followRedirects(location, cookies, log));
      }
    }
  }

  if (!authCode) {
    const html = loginPageResp.data as string;

    const formActionMatch = html.match(/action="([^"]+)"/);
    if (!formActionMatch) {
      throw new Error('Could not find login form action URL in the Hubspace login page');
    }
    const formAction = formActionMatch[1].replace(/&amp;/g, '&');
    log(`[auth] form action: ${formAction}`);

    const sessionCode = extractQueryParam(formAction, 'session_code');
    const execution = extractQueryParam(formAction, 'execution');
    const clientId = extractQueryParam(formAction, 'client_id');
    const tabId = extractQueryParam(formAction, 'tab_id');

    const submitUrl =
      `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/login-actions/authenticate` +
      `?session_code=${sessionCode}&execution=${execution}&client_id=${clientId}&tab_id=${tabId}`;

    // Step 2 – submit credentials
    log('[auth] submitting credentials');
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
          ...(cookies ? { Cookie: cookies } : {}),
        },
      },
    );

    log(`[auth] credential POST status: ${loginResp.status}`);
    cookies = mergeCookies(cookies, parseCookies(loginResp.headers['set-cookie']));

    const location = loginResp.headers['location'] as string | undefined;
    log(`[auth] credential POST location: ${location ?? 'none'}`);

    // OTP required?
    if (loginResp.status === 200 && typeof loginResp.data === 'string' && loginResp.data.includes('kc-otp-login-form')) {
      log('[auth] OTP required');
      if (!otp) throw new Error('OTP_REQUIRED');

      const otpHtml = loginResp.data;
      const otpFormMatch = otpHtml.match(/action="([^"]+)"/);
      if (!otpFormMatch) throw new Error('Could not parse OTP form');

      const otpFormAction = otpFormMatch[1].replace(/&amp;/g, '&');
      const otpSubmitUrl =
        `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/login-actions/authenticate` +
        `?session_code=${extractQueryParam(otpFormAction, 'session_code')}` +
        `&execution=${extractQueryParam(otpFormAction, 'execution')}` +
        `&client_id=${extractQueryParam(otpFormAction, 'client_id')}` +
        `&tab_id=${extractQueryParam(otpFormAction, 'tab_id')}`;

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
            ...(cookies ? { Cookie: cookies } : {}),
          },
        },
      );

      log(`[auth] OTP POST status: ${otpResp.status}`);
      cookies = mergeCookies(cookies, parseCookies(otpResp.headers['set-cookie']));
      const otpLocation = otpResp.headers['location'] as string | undefined;
      log(`[auth] OTP location: ${otpLocation ?? 'none'}`);

      if (otpLocation) {
        authCode = extractAuthCode(otpLocation);
        if (!authCode && otpLocation.startsWith('http')) {
          ({ authCode, cookies } = await followRedirects(otpLocation, cookies, log));
        }
      }
    } else if (location) {
      authCode = extractAuthCode(location);
      // Location might be an intermediate HTTP redirect before the app scheme
      if (!authCode && location.startsWith('http')) {
        log('[auth] following intermediate redirect chain');
        ({ authCode, cookies } = await followRedirects(location, cookies, log));
      }
    } else if (loginResp.status === 200) {
      // 200 with no OTP form = bad credentials
      log('[auth] server returned 200 with no redirect — likely invalid credentials');
      throw new Error('Authentication failed: invalid username or password.');
    }
  }

  if (!authCode) {
    throw new Error('Authentication failed: could not obtain authorization code. Check your credentials.');
  }

  log('[auth] got authorization code, exchanging for tokens');
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
