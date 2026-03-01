/**
 * Hubspace authentication — PKCE OAuth2 flow.
 *
 * Ported directly from aioafero (Python) by Expl0dingBanana.
 * The key points:
 *   1. GET the login page, find the <form id="kc-form-login"> action URL
 *   2. POST credentials to that URL (no redirects)
 *   3. If 302  → parse auth code from Location header
 *   4. If 200 + "kc-otp-login-form" in body → OTP required
 *   5. Exchange auth code for tokens
 *
 * Cookies from every response are captured and forwarded to the next
 * request so Keycloak's session tracking works without a cookie jar lib.
 */

import crypto from 'crypto';
import axios from 'axios';
import { HUBSPACE_API } from '../settings';
import type { AuthState, TokenResponse } from './types';

// ── PKCE ──────────────────────────────────────────────────────────────────────

function generatePKCE(): { verifier: string; challenge: string } {
  // Matches aioafero: base64url(40 random bytes), strip non-alphanumeric
  const verifier = Buffer.from(crypto.randomBytes(40))
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '');

  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { verifier, challenge };
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(header: string | string[] | undefined): string {
  if (!header) return '';
  const list = Array.isArray(header) ? header : [header];
  return list.map((h) => h.split(';')[0].trim()).join('; ');
}

function mergeCookies(existing: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const chunk of `${existing}; ${incoming}`.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) {
      map.set(chunk.slice(0, eq).trim(), chunk.slice(eq + 1).trim());
    }
  }
  return Array.from(map.entries())
    .filter(([k]) => k)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

/**
 * Find a <form id="formId"> and return its action attribute value.
 * Matches aioafero's BeautifulSoup: auth_page.find("form", id=formId).attrs["action"]
 */
function extractFormAction(html: string, formId: string): string | null {
  // The id= and action= attributes can appear in either order
  const pattern = new RegExp(
    `<form[^>]*\\bid="${formId}"[^>]*\\baction="([^"]+)"` +
    `|<form[^>]*\\baction="([^"]+)"[^>]*\\bid="${formId}"`,
    'i',
  );
  const match = html.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[2]).replace(/&amp;/g, '&');
}

function extractQueryParam(url: string, key: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://x.com${url}`);
    return u.searchParams.get(key) ?? '';
  } catch {
    const m = url.match(new RegExp(`[?&]${key}=([^&]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  }
}

function parseAuthCode(location: string): string | null {
  const m = location.match(/[?&]code=([^&]+)/);
  return m ? m[1] : null;
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCodeForTokens(code: string, verifier: string): Promise<TokenResponse> {
  const url = `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/protocol/openid-connect/token`;

  const res = await axios.post<TokenResponse>(
    url,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HUBSPACE_API.REDIRECT_URI,
      code_verifier: verifier,
      client_id: HUBSPACE_API.CLIENT_ID,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'accept-encoding': 'gzip',
        host: HUBSPACE_API.AUTH_HOST,
      },
    },
  );
  return res.data;
}

// ── Main login flow ───────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string,
  otp?: string,
  log: (msg: string) => void = () => undefined,
): Promise<AuthState> {
  const { verifier, challenge } = generatePKCE();

  // ── Step 1: GET login page ────────────────────────────────────────────────
  const authUrl = new URL(
    `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/protocol/openid-connect/auth`,
  );
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', HUBSPACE_API.CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', HUBSPACE_API.REDIRECT_URI);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', 'openid offline_access');

  log('[auth] GET login page');
  const pageResp = await axios.get<string>(authUrl.toString(), {
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
    headers: { 'User-Agent': HUBSPACE_API.USER_AGENT },
  });

  let cookies = parseCookies(pageResp.headers['set-cookie']);
  log(`[auth] login page status=${pageResp.status} cookies=${cookies ? 'yes' : 'none'}`);

  // Active session — already redirected
  if (pageResp.status === 302) {
    const loc = pageResp.headers['location'] as string | undefined;
    log(`[auth] active session redirect → ${loc}`);
    const code = loc ? parseAuthCode(loc) : null;
    if (code) {
      const tokens = await exchangeCodeForTokens(code, verifier);
      return tokensToAuthState(tokens);
    }
  }

  // ── Step 2: Parse kc-form-login and POST credentials ─────────────────────
  const html = pageResp.data as string;
  const formAction = extractFormAction(html, 'kc-form-login');
  if (!formAction) {
    log('[auth] ERROR: could not find kc-form-login form in login page HTML');
    throw new Error('Could not find login form. The Hubspace login page may have changed.');
  }
  log(`[auth] form action: ${formAction}`);

  const sessionCode = extractQueryParam(formAction, 'session_code');
  const execution = extractQueryParam(formAction, 'execution');
  const tabId = extractQueryParam(formAction, 'tab_id');
  log(`[auth] session_code=${sessionCode} execution=${execution} tab_id=${tabId}`);

  const submitUrl =
    `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/login-actions/authenticate` +
    `?session_code=${sessionCode}&execution=${execution}` +
    `&client_id=${HUBSPACE_API.CLIENT_ID}&tab_id=${tabId}`;

  log('[auth] POST credentials');
  const credResp = await axios.post(
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

  cookies = mergeCookies(cookies, parseCookies(credResp.headers['set-cookie']));
  const credLoc = credResp.headers['location'] as string | undefined;
  log(`[auth] credential POST status=${credResp.status} location=${credLoc ?? 'none'}`);

  // ── Step 3a: 302 → success, extract code ─────────────────────────────────
  if (credResp.status === 302 && credLoc) {
    const code = parseAuthCode(credLoc);
    if (code) {
      log('[auth] got auth code, exchanging for tokens');
      const tokens = await exchangeCodeForTokens(code, verifier);
      return tokensToAuthState(tokens);
    }
  }

  // ── Step 3b: 200 + OTP form ───────────────────────────────────────────────
  const credBody = typeof credResp.data === 'string' ? credResp.data : '';
  if (credResp.status === 200 && credBody.includes('kc-otp-login-form')) {
    log('[auth] OTP required');
    if (!otp) throw new Error('OTP_REQUIRED');

    const otpAction = extractFormAction(credBody, 'kc-otp-login-form');
    if (!otpAction) throw new Error('Could not parse OTP form action');

    const otpSessionCode = extractQueryParam(otpAction, 'session_code');
    const otpExecution = extractQueryParam(otpAction, 'execution');
    const otpTabId = extractQueryParam(otpAction, 'tab_id');

    const otpUrl =
      `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/login-actions/authenticate` +
      `?session_code=${otpSessionCode}&execution=${otpExecution}` +
      `&client_id=${HUBSPACE_API.CLIENT_ID}&tab_id=${otpTabId}`;

    log('[auth] POST OTP');
    const otpResp = await axios.post(
      otpUrl,
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

    const otpLoc = otpResp.headers['location'] as string | undefined;
    log(`[auth] OTP POST status=${otpResp.status} location=${otpLoc ?? 'none'}`);

    if (otpResp.status !== 302 || !otpLoc) {
      throw new Error('Invalid OTP code — check your email and try again.');
    }
    const code = parseAuthCode(otpLoc);
    if (!code) throw new Error('Could not parse auth code from OTP redirect.');

    log('[auth] OTP success, exchanging for tokens');
    const tokens = await exchangeCodeForTokens(code, verifier);
    return tokensToAuthState(tokens);
  }

  // ── Step 3c: 200 with no OTP form = wrong credentials ────────────────────
  if (credResp.status === 200) {
    throw new Error('Authentication failed: invalid username or password.');
  }

  throw new Error(`Authentication failed: unexpected response status ${credResp.status}.`);
}

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshTokens(refreshToken: string): Promise<AuthState> {
  const url = `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/protocol/openid-connect/token`;

  const res = await axios.post<TokenResponse>(
    url,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid email offline_access profile',
      client_id: HUBSPACE_API.CLIENT_ID,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'accept-encoding': 'gzip',
        host: HUBSPACE_API.AUTH_HOST,
      },
    },
  );
  return tokensToAuthState(res.data);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokensToAuthState(tokens: TokenResponse): AuthState {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}
