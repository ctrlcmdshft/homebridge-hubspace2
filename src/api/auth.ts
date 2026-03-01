/**
 * Hubspace authentication — PKCE OAuth2 flow.
 *
 * OTP / 2FA session problem and solution:
 *   Every credential POST creates a new Keycloak session AND triggers a
 *   new OTP email.  If we restart Homebridge with the emailed code, a new
 *   credential POST fires first, invalidating the previous session.
 *
 *   Fix: after the credential POST returns the OTP form we save the
 *   session params + PKCE verifier to disk.  On the next restart, if an
 *   OTP code is present in config AND a saved session exists on disk, we
 *   skip the credential POST entirely and submit the OTP directly against
 *   the saved session (the one that sent the email the user read).
 */

import crypto from 'crypto';
import axios from 'axios';
import { HUBSPACE_API } from '../settings';
import type { AuthState, TokenResponse } from './types';
import { OtpSessionStore } from './otpSessionStore';

// ── PKCE ──────────────────────────────────────────────────────────────────────

function generatePKCE(): { verifier: string; challenge: string } {
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
    if (eq > 0) map.set(chunk.slice(0, eq).trim(), chunk.slice(eq + 1).trim());
  }
  return Array.from(map.entries()).filter(([k]) => k).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function extractFormAction(html: string, formId: string): string | null {
  const pattern = new RegExp(
    `<form[^>]*\\bid="${formId}"[^>]*\\baction="([^"]+)"` +
    `|<form[^>]*\\baction="([^"]+)"[^>]*\\bid="${formId}"`,
    'i',
  );
  const m = html.match(pattern);
  if (!m) return null;
  return (m[1] ?? m[2]).replace(/&amp;/g, '&');
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

function authUrl(endpoint: string): string {
  return `https://${HUBSPACE_API.AUTH_HOST}/auth/realms/${HUBSPACE_API.AUTH_REALM}/${endpoint}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCodeForTokens(code: string, verifier: string): Promise<TokenResponse> {
  const res = await axios.post<TokenResponse>(
    authUrl('protocol/openid-connect/token'),
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

// ── OTP submission (reuses a saved session) ───────────────────────────────────

async function submitOtp(
  otp: string,
  sessionCode: string,
  execution: string,
  tabId: string,
  cookies: string,
  log: (msg: string) => void,
): Promise<{ code: string; status: number }> {
  const url =
    authUrl('login-actions/authenticate') +
    `?session_code=${sessionCode}&execution=${execution}` +
    `&client_id=${HUBSPACE_API.CLIENT_ID}&tab_id=${tabId}`;

  log('[auth] POST OTP');
  const resp = await axios.post(
    url,
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

  log(`[auth] OTP POST status=${resp.status}`);
  const loc = resp.headers['location'] as string | undefined;
  log(`[auth] OTP location=${loc ?? 'none'}`);

  const code = loc ? parseAuthCode(loc) : null;
  if (resp.status !== 302 || !code) {
    throw new Error('Invalid OTP code — the code may have expired. Remove "otp" from config, restart to get a fresh code, then try again.');
  }
  return { code, status: resp.status };
}

// ── Main login flow ───────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string,
  otp: string | undefined,
  storagePath: string,
  log: (msg: string) => void = () => undefined,
): Promise<AuthState> {
  const otpStore = new OtpSessionStore(storagePath);

  // ── Fast path: saved OTP session + code provided ──────────────────────────
  if (otp) {
    const saved = otpStore.load();
    if (saved) {
      log('[auth] Submitting OTP against saved session (no new credential POST)');
      const { code } = await submitOtp(otp, saved.sessionCode, saved.execution, saved.tabId, '', log);
      otpStore.clear();
      const tokens = await exchangeCodeForTokens(code, saved.pkceVerifier);
      return tokensToAuthState(tokens);
    }
    log('[auth] OTP provided but no saved session found — doing full login to create a new session');
  }

  // ── Full PKCE login ───────────────────────────────────────────────────────
  const { verifier, challenge } = generatePKCE();

  const loginPageUrl = new URL(authUrl('protocol/openid-connect/auth'));
  loginPageUrl.searchParams.set('response_type', 'code');
  loginPageUrl.searchParams.set('client_id', HUBSPACE_API.CLIENT_ID);
  loginPageUrl.searchParams.set('redirect_uri', HUBSPACE_API.REDIRECT_URI);
  loginPageUrl.searchParams.set('code_challenge', challenge);
  loginPageUrl.searchParams.set('code_challenge_method', 'S256');
  loginPageUrl.searchParams.set('scope', 'openid offline_access');

  log('[auth] GET login page');
  const pageResp = await axios.get<string>(loginPageUrl.toString(), {
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
    headers: { 'User-Agent': HUBSPACE_API.USER_AGENT },
  });

  let cookies = parseCookies(pageResp.headers['set-cookie']);
  log(`[auth] login page status=${pageResp.status}`);

  // Active session cached — immediate 302
  if (pageResp.status === 302) {
    const loc = pageResp.headers['location'] as string | undefined;
    const code = loc ? parseAuthCode(loc) : null;
    if (code) {
      const tokens = await exchangeCodeForTokens(code, verifier);
      return tokensToAuthState(tokens);
    }
  }

  const html = pageResp.data as string;
  const formAction = extractFormAction(html, 'kc-form-login');
  if (!formAction) {
    log('[auth] ERROR: kc-form-login form not found in login page');
    throw new Error('Could not find login form. The Hubspace login page may have changed.');
  }

  const sessionCode = extractQueryParam(formAction, 'session_code');
  const execution = extractQueryParam(formAction, 'execution');
  const tabId = extractQueryParam(formAction, 'tab_id');
  log(`[auth] POST credentials session_code=${sessionCode}`);

  const submitUrl =
    authUrl('login-actions/authenticate') +
    `?session_code=${sessionCode}&execution=${execution}` +
    `&client_id=${HUBSPACE_API.CLIENT_ID}&tab_id=${tabId}`;

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

  // No OTP needed — success
  if (credResp.status === 302 && credLoc) {
    const code = parseAuthCode(credLoc);
    if (code) {
      const tokens = await exchangeCodeForTokens(code, verifier);
      return tokensToAuthState(tokens);
    }
  }

  const credBody = typeof credResp.data === 'string' ? credResp.data : '';

  // OTP required
  if (credResp.status === 200 && credBody.includes('kc-otp-login-form')) {
    log('[auth] OTP required — saving session to disk');

    // Parse the OTP form to get the correct session params for THIS session
    const otpAction = extractFormAction(credBody, 'kc-otp-login-form');
    const otpSessionCode = otpAction ? extractQueryParam(otpAction, 'session_code') : sessionCode;
    const otpExecution = otpAction ? extractQueryParam(otpAction, 'execution') : execution;
    const otpTabId = otpAction ? extractQueryParam(otpAction, 'tab_id') : tabId;

    // Save session so the next restart can submit the OTP without a new credential POST
    otpStore.save({
      sessionCode: otpSessionCode,
      execution: otpExecution,
      tabId: otpTabId,
      pkceVerifier: verifier,
      createdAt: Date.now(),
    });

    if (otp) {
      // OTP was provided but we just did a fresh credential POST (old saved session was expired).
      // Try submitting immediately against this new session.
      log('[auth] Trying provided OTP against fresh session');
      try {
        const { code } = await submitOtp(otp, otpSessionCode, otpExecution, otpTabId, cookies, log);
        otpStore.clear();
        const tokens = await exchangeCodeForTokens(code, verifier);
        return tokensToAuthState(tokens);
      } catch {
        // OTP was stale — fall through to raise OTP_REQUIRED so user gets a fresh code
        log('[auth] Provided OTP did not work against new session — a fresh code was emailed');
      }
    }

    throw new Error('OTP_REQUIRED');
  }

  if (credResp.status === 200) {
    throw new Error('Authentication failed: invalid username or password.');
  }

  throw new Error(`Authentication failed: unexpected response status ${credResp.status}.`);
}

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshTokens(refreshToken: string): Promise<AuthState> {
  const res = await axios.post<TokenResponse>(
    authUrl('protocol/openid-connect/token'),
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

function tokensToAuthState(tokens: TokenResponse): AuthState {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}
