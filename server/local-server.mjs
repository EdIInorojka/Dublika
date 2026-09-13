import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import ffmpegPath from 'ffmpeg-static';

const root = resolve(import.meta.dirname, '..');
// The desktop deployment runs directly with Node, so load an optional local
// secret file before reading configuration. Environment variables supplied by
// Docker, a process manager or the OS always win. `.env` is git-ignored.
function loadLocalEnv() {
  const envPath = join(root, '.env');
  try {
    for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(process.env, key)) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

loadLocalEnv();
const publicDir = join(root, 'vercel-dist');
const dataDir = join(root, '.local-data');
const uploadDir = join(dataDir, 'uploads');
const recordingDir = join(dataDir, 'recordings');
const outputDir = join(dataDir, 'outputs');
const stemsDir = join(dataDir, 'stems');
const thumbnailDir = join(dataDir, 'thumbnails');
const ytDlpPath = join(root, '.local-bin', 'yt-dlp.exe');
const demucsPythonPath = process.env.DUBLIKA_DEMUCS_PYTHON || join(root, '.local-bin', 'demucs-venv', 'Scripts', 'python.exe');
const demucsModel = process.env.DUBLIKA_DEMUCS_MODEL || 'htdemucs';
const deepgramKeyPath = join(root, 'ключ.txt');
const demoVideoPath = join(dataDir, 'dublika-demo-v2.mp4');
const productionStatePath = join(dataDir, 'state.json');
const sandboxStatePath = join(dataDir, 'test-state.json');
const port = Number(process.env.LOCAL_APP_PORT || 8788);
// Keep the safe loopback default for a desktop launch. A real deployment sits
// behind an HTTPS reverse proxy and opts in explicitly with DUBLIKA_HOST=0.0.0.0.
const bindHost = String(process.env.DUBLIKA_HOST || '127.0.0.1').trim();
const publicOrigin = String(process.env.DUBLIKA_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
const qaEnabled = process.env.DUBLIKA_ENABLE_QA === '1';
const maxConcurrentRenders = Math.max(1, Math.min(8, Number(process.env.DUBLIKA_MAX_CONCURRENT_RENDERS || 2) || 2));
const demucsDevice = String(process.env.DUBLIKA_DEMUCS_DEVICE || 'cpu').trim() || 'cpu';
const videoPreset = String(process.env.DUBLIKA_VIDEO_PRESET || 'veryfast').trim() || 'veryfast';
const videoCrf = Math.max(17, Math.min(28, Number(process.env.DUBLIKA_VIDEO_CRF || 21) || 21));
const yooKassaShopId = String(process.env.YOOKASSA_SHOP_ID || '').trim();
const yooKassaSecret = String(process.env.YOOKASSA_SECRET_KEY || '').trim();
const maxVideoBytes = 1024 * 1024 * 1024;
const maxAudioBytes = 40 * 1024 * 1024;
const maxSelectedSeconds = 240;
const minSegmentSeconds = 2;
const maxSegmentSeconds = 4;
const maxNaturalSentenceSeconds = 4;
const recordingLeadSeconds = 1;
const recordingTailSeconds = 1;
const mediaTokenLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const videoExtensions = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const audioExtensions = new Set(['.webm', '.ogg', '.wav', '.m4a', '.mp3', '.mp4']);
const allowedOrigins = new Set([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  'https://dublika-studio.gusta-voglenn19586.chatgpt.site',
  // The public studio is static on Vercel, while media processing remains on
  // this local machine behind the tunnel. Keep the stable production alias
  // here instead of relying on a PowerShell-only environment variable: the
  // allow-list must survive a normal server restart.
  'https://site-five-woad-16.vercel.app',
  ...String(process.env.DUBLIKA_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  ...(publicOrigin ? [publicOrigin] : []),
]);

for (const directory of [dataDir, uploadDir, recordingDir, outputDir, stemsDir, thumbnailDir]) mkdirSync(directory, { recursive: true });

function initialState() {
  return { secret: randomBytes(32).toString('hex'), users: {}, devices: {}, projects: {}, payments: {} };
}

function writeState(path, next) {
  mkdirSync(dataDir, { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2));
  renameSync(temporary, path);
}

function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { const next = initialState(); writeState(path, next); return next; }
}

const productionStore = { realm: 'production', path: productionStatePath, data: loadState(productionStatePath) };
const sandboxStore = { realm: 'test', path: sandboxStatePath, data: loadState(sandboxStatePath) };
const stateContext = new AsyncLocalStorage();
const requestBuckets = new Map();
let activeRenderCount = 0;
const renderWaiters = [];

function activeStore() {
  return stateContext.getStore() || productionStore;
}

// Existing route code can keep using `state`, while each request is isolated
// through AsyncLocalStorage. QA traffic never shares users, credits, projects
// or signing secrets with the production profile database.
const state = new Proxy({}, {
  get(_target, key) { return activeStore().data[key]; },
  set(_target, key, value) { activeStore().data[key] = value; return true; },
});

function saveState(next = activeStore().data) {
  writeState(activeStore().path, next);
}

function requestStore(request) {
  const environment = String(request.headers['x-dublika-environment'] || '').toLowerCase();
  const isSandboxMedia = String(request.url || '').includes('realm=test');
  // The isolated QA realm is useful on the developer machine, but must never
  // be exposed as an anonymous free-render endpoint on the public Internet.
  return (environment === 'test' || isSandboxMedia) && qaEnabled && isLoopbackRequest(request) ? sandboxStore : productionStore;
}

function remoteAddress(request) {
  return String(request.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

function isLoopbackRequest(request) {
  const address = remoteAddress(request);
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function rateLimit(request, scope, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${remoteAddress(request)}`;
  const bucket = (requestBuckets.get(key) || []).filter((time) => time > now - windowMs);
  if (bucket.length >= limit) throw Object.assign(new Error('Слишком много попыток. Подождите немного и повторите.'), { statusCode: 429 });
  bucket.push(now);
  requestBuckets.set(key, bucket);
}

async function withRenderSlot(task) {
  if (activeRenderCount >= maxConcurrentRenders) {
    await new Promise((resolve) => renderWaiters.push(resolve));
  }
  activeRenderCount += 1;
  try {
    return await task();
  } finally {
    activeRenderCount = Math.max(0, activeRenderCount - 1);
    renderWaiters.shift()?.();
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function setSecurityHeaders(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), payment=()');
  const origin = String(request.headers.origin || '');
  if (allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id, X-Dublika-Environment, X-File-Name, X-Recording-Lead-In, X-Recording-Tail-Out');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Vary', 'Origin');
  }
}

async function readJson(request, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function saveBody(request, destination, limit) {
  let size = 0;
  const stream = createWriteStream(destination, { flags: 'wx' });
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error('payload_too_large');
      if (!stream.write(chunk)) await new Promise((resolveDrain) => stream.once('drain', resolveDrain));
    }
    await new Promise((resolveEnd, rejectEnd) => stream.end((error) => error ? rejectEnd(error) : resolveEnd()));
    return size;
  } catch (error) {
    stream.destroy();
    try { unlinkSync(destination); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function safeName(value, fallback) {
  const cleaned = String(value || fallback).replace(/[^a-zA-Z0-9а-яА-ЯёЁ._ -]/g, '_').slice(0, 100);
  return cleaned || fallback;
}

function deviceId(request) {
  const value = String(request.headers['x-device-id'] || 'local-device').slice(0, 160);
  return createHash('sha256').update(value).digest('hex');
}

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const signature = createHmac('sha256', state.secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function signMediaToken(projectId, resource) {
  const payload = Buffer.from(JSON.stringify({ projectId, resource, expiresAt: Date.now() + mediaTokenLifetimeMs })).toString('base64url');
  const signature = createHmac('sha256', state.secret).update(`media:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

function hasMediaToken(url, projectId, resource) {
  const token = String(url.searchParams.get('access') || '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', state.secret).update(`media:${payload}`).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.projectId === projectId && parsed.resource === resource && Number(parsed.expiresAt) > Date.now();
  } catch { return false; }
}

function sourceMediaUrl(project) {
  return `/media/projects/${project.id}/source?access=${encodeURIComponent(signMediaToken(project.id, 'source'))}&realm=${activeStore().realm}`;
}

function takeMediaUrl(project, segmentId) {
  return `/media/projects/${project.id}/takes/${segmentId}?access=${encodeURIComponent(signMediaToken(project.id, `take:${segmentId}`))}&realm=${activeStore().realm}`;
}

function outputMediaUrl(project) {
  return `/media/outputs/${project.id}.mp4?access=${encodeURIComponent(signMediaToken(project.id, 'output'))}&realm=${activeStore().realm}`;
}

function thumbnailMediaUrl(project, index) {
  return `/media/projects/${project.id}/thumbnails/${index}?access=${encodeURIComponent(signMediaToken(project.id, `thumbnail:${index}`))}&realm=${activeStore().realm}`;
}

function tokenUser(request) {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', state.secret).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.expiresAt < Date.now()) return null;
    return state.users[parsed.userId] || null;
  } catch { return null; }
}

function actor(request, { allowLocalGuest = false } = {}) {
  const existing = tokenUser(request);
  if (existing) return existing;
  // The UI always gates the studio behind sign-in.  Guests are kept only for
  // local QA, so clearing browser storage or inventing a device id cannot
  // create unlimited free production renders.
  if (!allowLocalGuest || activeStore().realm !== 'test' || !isLoopbackRequest(request)) return null;
  const hash = deviceId(request);
  const knownUserId = state.devices[hash];
  if (knownUserId && state.users[knownUserId]) return state.users[knownUserId];
  const userId = `guest_${randomUUID()}`;
  const freeCredits = Object.prototype.hasOwnProperty.call(state.devices, hash) ? 0 : 3;
  state.users[userId] = { id: userId, email: null, role: 'user', deviceHash: hash, credits: freeCredits, plan: 'Пробный', createdAt: new Date().toISOString() };
  state.devices[hash] = userId;
  saveState();
  return state.users[userId];
}

function requireActor(request, options) {
  const user = actor(request, options);
  if (!user) throw Object.assign(new Error('Войдите в аккаунт, чтобы продолжить.'), { statusCode: 401 });
  return user;
}

const otpRequests = new Map();
const oauthSessions = new Map();
const oauthTickets = new Map();

function isLoopbackOrigin(request) {
  const origin = String(request.headers.origin || '');
  return /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
}

async function deliverOtpEmail(email, code) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.OTP_FROM_EMAIL || '').trim();
  if (!apiKey || !from) return false;
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Код входа в Дублику',
      text: `Ваш код входа: ${code}. Он действует 10 минут. Никому не сообщайте этот код.`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) throw new Error(`Не удалось отправить письмо (${result.status})`);
  return true;
}

function oauthCallbackUrl(provider) {
  const apiOrigin = String(process.env.DUBLIKA_API_ORIGIN || '').trim().replace(/\/$/, '');
  if (!apiOrigin) return '';
  return `${apiOrigin}/api/auth/oauth/${provider}/callback`;
}

function oauthProvider(provider) {
  const common = {
    google: { label: 'Google', clientId: process.env.OAUTH_GOOGLE_CLIENT_ID, clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET, authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userInfo: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile', scheme: 'Bearer' },
    yandex: { label: 'Яндекс', clientId: process.env.OAUTH_YANDEX_CLIENT_ID, clientSecret: process.env.OAUTH_YANDEX_CLIENT_SECRET, authorize: 'https://oauth.yandex.ru/authorize', token: 'https://oauth.yandex.ru/token', userInfo: 'https://login.yandex.ru/info?format=json', scope: 'login:email login:info', scheme: 'OAuth' },
    github: { label: 'GitHub', clientId: process.env.OAUTH_GITHUB_CLIENT_ID, clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET, authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userInfo: 'https://api.github.com/user', scope: 'read:user user:email', scheme: 'Bearer' },
    linkedin: { label: 'LinkedIn', clientId: process.env.OAUTH_LINKEDIN_CLIENT_ID, clientSecret: process.env.OAUTH_LINKEDIN_CLIENT_SECRET, authorize: 'https://www.linkedin.com/oauth/v2/authorization', token: 'https://www.linkedin.com/oauth/v2/accessToken', userInfo: 'https://api.linkedin.com/v2/userinfo', scope: 'openid profile email', scheme: 'Bearer' },
    // VK ID endpoints change independently from OAuth 2.0 providers, so they
    // stay explicit deployment secrets rather than becoming stale hard-coded
    // URLs in the client bundle.
    vk: { label: 'VK ID', clientId: process.env.OAUTH_VK_CLIENT_ID, clientSecret: process.env.OAUTH_VK_CLIENT_SECRET, authorize: process.env.OAUTH_VK_AUTHORIZE_URL, token: process.env.OAUTH_VK_TOKEN_URL, userInfo: process.env.OAUTH_VK_USERINFO_URL, scope: process.env.OAUTH_VK_SCOPE || 'email', scheme: 'Bearer' },
  };
  const item = common[String(provider || '').toLowerCase()];
  if (!item || !item.clientId || !item.clientSecret || !item.authorize || !item.token || !item.userInfo || !oauthCallbackUrl(provider)) return null;
  return item;
}

function configuredOauthProviders() {
  return ['vk', 'yandex', 'google', 'github', 'linkedin']
    .filter((provider) => oauthProvider(provider))
    .map((provider) => ({ id: provider, label: oauthProvider(provider).label }));
}

function oauthVerifier() {
  return randomBytes(48).toString('base64url');
}

function oauthChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeNextPath(value) {
  const path = String(value || '/studio');
  return path.startsWith('/') && !path.startsWith('//') ? path : '/studio';
}

async function exchangeOAuthIdentity(providerName, provider, code, verifier) {
  const callback = oauthCallbackUrl(providerName);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: provider.clientId, client_secret: provider.clientSecret, redirect_uri: callback, code_verifier: verifier });
  const tokenResult = await fetch(provider.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const token = await tokenResult.json().catch(() => ({}));
  if (!tokenResult.ok || !token.access_token) throw new Error('Провайдер не выдал токен входа');
  const profileResult = await fetch(provider.userInfo, {
    headers: { Authorization: `${provider.scheme} ${token.access_token}`, Accept: 'application/json', ...(providerName === 'github' ? { 'User-Agent': 'Dublika OAuth' } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const profile = await profileResult.json().catch(() => ({}));
  if (!profileResult.ok) throw new Error('Не удалось получить профиль провайдера');
  let email = String(profile.email || profile.default_email || '').trim().toLowerCase();
  if (!email && providerName === 'github') {
    const emailsResult = await fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Dublika OAuth' }, signal: AbortSignal.timeout(20_000) });
    const emails = await emailsResult.json().catch(() => []);
    email = String(Array.isArray(emails) ? emails.find((item) => item?.primary && item?.verified)?.email || emails.find((item) => item?.verified)?.email || '' : '').trim().toLowerCase();
  }
  const subject = String(profile.sub || profile.id || profile.user_id || profile.uid || '').trim();
  if (!subject || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Провайдер не передал подтверждённую почту. Выберите вход по коду.');
  return { subject, email };
}

function oauthUser(provider, identity, deviceHash) {
  const binding = `${provider}:${identity.subject}`;
  let user = Object.values(state.users).find((candidate) => candidate.oauthBinding === binding || candidate.email === identity.email);
  if (!user) {
    const id = `user_${randomUUID()}`;
    user = { id, email: identity.email, role: 'user', oauthBinding: binding, deviceHash, credits: Object.values(state.users).some((candidate) => candidate.email === identity.email) ? 0 : 3, plan: 'Пробный', createdAt: new Date().toISOString() };
    state.users[id] = user;
  } else if (!user.oauthBinding) {
    user.oauthBinding = binding;
  }
  // OAuth redirects do not preserve the browser's custom device header.
  // Bind the account to the device hash captured before leaving the studio,
  // rather than to the provider callback request itself.
  state.devices[deviceHash] = user.id;
  saveState();
  return user;
}

async function handleAuth(request, response, pathname, url) {
  if (pathname === '/api/auth/providers' && request.method === 'GET') return sendJson(response, 200, { providers: configuredOauthProviders() });
  if (pathname === '/api/auth/oauth/start' && request.method === 'POST') {
    rateLimit(request, 'oauth-start', 10, 15 * 60 * 1000);
    const { provider, next } = await readJson(request);
    const name = String(provider || '').toLowerCase();
    const config = oauthProvider(name);
    if (!config) return sendJson(response, 503, { error: 'Этот способ входа пока не подключён.' });
    const stateValue = randomBytes(24).toString('base64url');
    const verifier = oauthVerifier();
    oauthSessions.set(stateValue, { provider: name, verifier, deviceHash: deviceId(request), next: safeNextPath(next), expiresAt: Date.now() + 10 * 60 * 1000 });
    const authorize = new URL(config.authorize);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', config.clientId);
    authorize.searchParams.set('redirect_uri', oauthCallbackUrl(name));
    authorize.searchParams.set('scope', config.scope);
    authorize.searchParams.set('state', stateValue);
    authorize.searchParams.set('code_challenge', oauthChallenge(verifier));
    authorize.searchParams.set('code_challenge_method', 'S256');
    return sendJson(response, 200, { authorizationUrl: authorize.toString() });
  }
  const callback = pathname.match(/^\/api\/auth\/oauth\/(vk|yandex|google|github|linkedin)\/callback$/i);
  if (callback && request.method === 'GET') {
    const provider = callback[1].toLowerCase();
    const stateValue = String(url?.searchParams.get('state') || '');
    const code = String(url?.searchParams.get('code') || '');
    const session = oauthSessions.get(stateValue);
    oauthSessions.delete(stateValue);
    if (!session || session.provider !== provider || session.expiresAt < Date.now() || !code || !publicOrigin) {
      response.writeHead(303, { Location: `${publicOrigin || '/'}${publicOrigin ? '/auth?oauth=failed' : ''}` });
      return response.end();
    }
    try {
      const identity = await exchangeOAuthIdentity(provider, oauthProvider(provider), code, session.verifier);
      const user = oauthUser(provider, identity, session.deviceHash);
      const ticket = randomBytes(28).toString('base64url');
      oauthTickets.set(ticket, { token: signToken(user.id), email: user.email, deviceHash: session.deviceHash, next: session.next, expiresAt: Date.now() + 60_000 });
      response.writeHead(303, { Location: `${publicOrigin}/auth?oauth_ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(session.next)}` });
      return response.end();
    } catch {
      response.writeHead(303, { Location: `${publicOrigin}/auth?oauth=failed` });
      return response.end();
    }
  }
  if (pathname === '/api/auth/oauth/consume' && request.method === 'POST') {
    const { ticket } = await readJson(request);
    const record = oauthTickets.get(String(ticket || ''));
    oauthTickets.delete(String(ticket || ''));
    if (!record || record.expiresAt < Date.now() || record.deviceHash !== deviceId(request)) return sendJson(response, 401, { error: 'Сессия входа истекла. Попробуйте ещё раз.' });
    const user = tokenUser({ headers: { authorization: `Bearer ${record.token}` } });
    return sendJson(response, 200, { ok: true, token: record.token, user: { email: record.email, credits: user?.credits || 0, plan: user?.plan || 'Пробный' }, next: record.next });
  }
  if (pathname === '/api/auth/request-code' && request.method === 'POST') {
    rateLimit(request, 'auth-code', 5, 15 * 60 * 1000);
    const { email } = await readJson(request);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return sendJson(response, 400, { error: 'Некорректная почта' });
    const code = String(randomInt(100000, 999999));
    const localPreview = isLoopbackOrigin(request);
    let delivered = false;
    try { delivered = await deliverOtpEmail(normalizedEmail, code); } catch (error) {
      console.error(`[dublika] OTP delivery failed: ${String(error.message || error).slice(0, 500)}`);
      return sendJson(response, 503, { error: 'Почтовая доставка временно недоступна. Попробуйте ещё раз позже.' });
    }
    if (!delivered && !localPreview) {
      return sendJson(response, 503, { error: 'Почтовый вход ещё не подключён. Обратитесь в поддержку или откройте локальную версию для теста.' });
    }
    otpRequests.set(normalizedEmail, { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, deviceHash: deviceId(request) });
    // Never log or return production OTPs.  The local loopback preview is the
    // only development path that exposes a test code to make offline QA work.
    return sendJson(response, 200, { ok: true, expiresIn: 600, ...(localPreview && !delivered ? { devCode: code } : {}) });
  }
  if (pathname === '/api/auth/verify-code' && request.method === 'POST') {
    rateLimit(request, 'auth-verify', 12, 15 * 60 * 1000);
    const { email, code } = await readJson(request);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const record = otpRequests.get(normalizedEmail);
    if (!record || record.expiresAt < Date.now() || record.attempts >= 5) return sendJson(response, 401, { error: 'Код истёк. Запросите новый.' });
    record.attempts += 1;
    const digest = createHash('sha256').update(String(code || '')).digest('hex');
    if (digest !== record.digest) return sendJson(response, 401, { error: 'Неверный код' });
    otpRequests.delete(normalizedEmail);
    let user = Object.values(state.users).find((candidate) => candidate.email === normalizedEmail);
    if (!user) {
      const deviceOwnerId = state.devices[record.deviceHash];
      const deviceOwner = deviceOwnerId ? state.users[deviceOwnerId] : null;
      if (deviceOwner?.email === null) {
        deviceOwner.email = normalizedEmail;
        user = deviceOwner;
      } else {
        const id = `user_${randomUUID()}`;
        user = { id, email: normalizedEmail, role: 'user', deviceHash: record.deviceHash, credits: deviceOwnerId ? 0 : 3, plan: 'Пробный', createdAt: new Date().toISOString() };
        state.users[id] = user;
      }
    }
    state.devices[record.deviceHash] = user.id;
    saveState();
    return sendJson(response, 200, { ok: true, token: signToken(user.id), user: { email: user.email, credits: user.credits, plan: user.plan } });
  }
  return false;
}

const billingPlans = {
  start: { label: 'Старт', amount: '150.00', credits: 5, plan: 'Старт' },
  author: { label: 'Автор', amount: '490.00', credits: 25, plan: 'Автор' },
};

function billingReady() {
  return Boolean(yooKassaShopId && yooKassaSecret && publicOrigin.startsWith('https://'));
}

async function yooKassaRequest(path, init = {}) {
  if (!billingReady()) throw Object.assign(new Error('Оплата ещё не подключена. Добавьте ключи ЮKassa и публичный HTTPS-адрес приложения на сервере.'), { statusCode: 503 });
  const credentials = Buffer.from(`${yooKassaShopId}:${yooKassaSecret}`).toString('base64');
  const response = await fetch(`https://api.yookassa.ru/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`Платёжный сервис временно недоступен (${response.status}).`), { statusCode: 502, cause: payload });
  return payload;
}

async function handleBilling(request, response, pathname) {
  if (pathname === '/api/billing/config' && request.method === 'GET') {
    return sendJson(response, 200, { enabled: billingReady(), provider: billingReady() ? 'yookassa' : null });
  }
  if (pathname === '/api/billing/status' && request.method === 'GET') {
    const user = requireActor(request, { allowLocalGuest: false });
    return sendJson(response, 200, { credits: user.credits, plan: user.plan });
  }
  if (pathname === '/api/billing/create-payment' && request.method === 'POST') {
    rateLimit(request, 'payment-create', 6, 30 * 60 * 1000);
    const user = requireActor(request, { allowLocalGuest: false });
    const body = await readJson(request);
    const planKey = String(body.plan || '').toLowerCase();
    const plan = billingPlans[planKey];
    if (!plan) return sendJson(response, 400, { error: 'Неизвестный тариф' });
    const localOrderId = randomUUID();
    const payment = await yooKassaRequest('/payments', {
      method: 'POST',
      headers: { 'Idempotence-Key': localOrderId },
      body: JSON.stringify({
        amount: { value: plan.amount, currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: `${publicOrigin}/studio?payment=return` },
        description: `Дублика — пакет «${plan.label}»`,
        metadata: { dublika_order_id: localOrderId, dublika_user_id: user.id, dublika_plan: planKey },
      }),
    });
    const confirmationUrl = String(payment?.confirmation?.confirmation_url || '');
    if (!payment?.id || !confirmationUrl) return sendJson(response, 502, { error: 'Платёжный сервис не вернул ссылку на оплату.' });
    state.payments ??= {};
    state.payments[payment.id] = { id: payment.id, localOrderId, userId: user.id, plan: planKey, credits: plan.credits, amount: plan.amount, status: payment.status, createdAt: new Date().toISOString() };
    saveState();
    return sendJson(response, 201, { ok: true, confirmationUrl });
  }
  if (pathname === '/api/billing/yookassa' && request.method === 'POST') {
    const event = await readJson(request);
    const paymentId = String(event?.object?.id || '');
    if (!billingReady() || !paymentId) return sendJson(response, 200, { ok: true });
    const stored = state.payments?.[paymentId];
    if (!stored) return sendJson(response, 200, { ok: true });
    // Webhook bodies are not treated as proof of payment. Verify the object
    // against the provider API before granting any paid rendering credits.
    const verified = await yooKassaRequest(`/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
    if (verified.status !== 'succeeded' || verified.paid !== true || String(verified.metadata?.dublika_order_id || '') !== stored.localOrderId) return sendJson(response, 200, { ok: true });
    if (!stored.creditedAt) {
      const user = state.users[stored.userId];
      if (user) {
        user.credits = Math.max(0, Number(user.credits) || 0) + stored.credits;
        user.plan = billingPlans[stored.plan]?.plan || user.plan;
        user.updatedAt = new Date().toISOString();
      }
      stored.creditedAt = new Date().toISOString();
      stored.status = 'succeeded';
      saveState();
    }
    return sendJson(response, 200, { ok: true });
  }
  return false;
}

function runFfmpeg(argumentsList, onProgress) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, argumentsList, { windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-250000);
      if (onProgress) onProgress(chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code) => code === 0 ? resolveRun(stderr) : rejectRun(new Error(stderr.slice(-4000) || `ffmpeg exited ${code}`)));
  });
}

function runFfmpegBuffer(argumentsList, maximumBytes = 1024 * 1024) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, argumentsList, { windowsHide: true });
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-5000); });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (size > maximumBytes) return rejectRun(new Error('Слишком большая аудиодорожка для предпросмотра'));
      if (code === 0) return resolveRun(Buffer.concat(chunks));
      return rejectRun(new Error(stderr || `ffmpeg exited ${code}`));
    });
  });
}

function runProcess(executable, argumentsList, timeoutMs = 15 * 60 * 1000, label = 'Обработка') {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, argumentsList, { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error(`${label} заняла слишком много времени`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-120000); });
    child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-120000); });
    child.on('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(output);
      else rejectRun(new Error(output.slice(-2500) || `${label} завершилась с кодом ${code}`));
    });
  });
}

async function sourceHasAudio(path) {
  try { await runFfmpeg(['-hide_banner', '-i', path, '-map', '0:a:0', '-t', '0.1', '-f', 'null', '-']); return true; } catch { return false; }
}

async function videoDuration(path) {
  try {
    const report = await runFfmpeg(['-hide_banner', '-i', path, '-map', '0:v:0', '-t', '0.02', '-f', 'null', '-']);
    const match = report.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (!match) return 0;
    return rounded(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
  } catch {
    return 0;
  }
}

const demoCueTemplate = [
  { start: 0, end: 2.6, text: 'Это демо-реплика. Скажите её своим голосом.' },
  { start: 2.8, end: 5.6, text: 'Слушайте оригинал и начинайте говорить в своём темпе.' },
  { start: 5.9, end: 8.7, text: 'Запись остановится сама — ровно по длине фразы.' },
  { start: 9.0, end: 11.8, text: 'Готово. Дальше сервис соберёт один чистый ролик.' },
];

async function ensureDemoVideo() {
  if (existsSync(demoVideoPath) && statSync(demoVideoPath).size > 20_000) return demoVideoPath;
  // This is a locally generated, royalty-free test scene. It deliberately
  // never depends on a third-party CDN, so the first studio walkthrough works
  // even on an offline or firewalled server.
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
    '-t', '12', '-shortest',
    // The level is intentionally modulated in the generated scene. The
    // waveform shown in the studio is therefore sampled from real changing
    // audio, rather than looking like a decorative constant-height graphic.
    '-af', 'volume=0.06+0.16*sin(2*PI*t/1.3)*sin(2*PI*t/1.3):eval=frame,afade=t=in:st=0:d=0.15,afade=t=out:st=11.8:d=0.2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', demoVideoPath,
  ]);
  return demoVideoPath;
}

async function durationForProject(project) {
  if (Number.isFinite(project.duration) && project.duration > 0) return project.duration;
  const duration = await videoDuration(project.inputPath);
  if (duration > 0) {
    project.duration = duration;
    saveState();
  }
  return duration;
}

async function thumbnailsForProject(project, requestedCount = 12) {
  const duration = await durationForProject(project);
  if (!(duration > 0)) return { duration: 0, thumbnails: [] };
  const count = Math.max(1, Math.min(16, Number(requestedCount) || 12));
  const projectDirectory = join(thumbnailDir, project.id);
  mkdirSync(projectDirectory, { recursive: true });
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    const destination = join(projectDirectory, `${index}.jpg`);
    if (existsSync(destination) && statSync(destination).size > 600) return;
    const position = Math.min(Math.max(.02, duration - .02), duration * ((index + .5) / count));
    await runFfmpeg([
      '-y', '-ss', position.toFixed(3), '-i', project.inputPath,
      '-frames:v', '1', '-vf', 'scale=240:-2:force_original_aspect_ratio=decrease',
      '-q:v', '4', destination,
    ]);
  }));
  return { duration, thumbnails: Array.from({ length: count }, (_, index) => thumbnailMediaUrl(project, index)) };
}

function stemCacheKey(project, clips) {
  const source = statSync(project.inputPath);
  return createHash('sha256')
    .update(JSON.stringify({ input: project.inputPath, size: source.size, modified: source.mtimeMs, clips }))
    .digest('hex')
    .slice(0, 20);
}

async function extractSelectedAudio(project, clips, destination) {
  const filters = clips.map((clip, index) => {
    const clipDuration = Math.max(.04, clip.end - clip.start);
    // A small fade on both sides prevents a discontinuity in the source
    // waveform from becoming a click or a sudden loud pop between selected
    // pieces.  It only touches the accompaniment before stem separation.
    const fadeDuration = Math.min(.08, clipDuration / 3);
    return `[0:a]atrim=start=${clip.start}:end=${clip.end},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${Math.max(0, clipDuration - fadeDuration)}:d=${fadeDuration}[clip${index}]`;
  });
  filters.push(`${clips.map((_, index) => `[clip${index}]`).join('')}concat=n=${clips.length}:v=0:a=1,aresample=44100,aformat=channel_layouts=stereo[audio]`);
  await runFfmpeg(['-y', '-i', project.inputPath, '-filter_complex', filters.join(';'), '-map', '[audio]', '-c:a', 'pcm_s16le', destination]);
}

async function prepareAccompaniment(project, clips) {
  if (!existsSync(demucsPythonPath)) {
    throw new Error('AI-разделение звука не установлено на сервере. Запустите scripts/setup-demucs.ps1 и повторите рендер.');
  }
  const cacheKey = stemCacheKey(project, clips);
  if (project.accompaniment?.key === cacheKey && existsSync(project.accompaniment.path)) return project.accompaniment.path;

  const workspace = join(stemsDir, project.id);
  const sourceAudioPath = join(workspace, `scene-${cacheKey}.wav`);
  const outputRoot = join(workspace, 'demucs');
  mkdirSync(workspace, { recursive: true });
  project.progress = 8;
  saveState();
  await extractSelectedAudio(project, clips, sourceAudioPath);

  project.progress = 16;
  saveState();
  // `--two-stems=vocals` writes a dedicated no_vocals.wav accompaniment.
  // This is the only background that reaches the final mix: never a simple
  // mid/side subtraction of the original dialogue.
  await runProcess(
    demucsPythonPath,
    ['-m', 'demucs.separate', '--name', demucsModel, '--two-stems=vocals', '--device', demucsDevice, '--segment=7', '--out', outputRoot, sourceAudioPath],
    20 * 60 * 1000,
    'AI-разделение звука',
  );
  const trackName = basename(sourceAudioPath, extname(sourceAudioPath));
  const accompanimentPath = join(outputRoot, demucsModel, trackName, 'no_vocals.wav');
  if (!existsSync(accompanimentPath) || statSync(accompanimentPath).size < 1024) {
    throw new Error('AI-разделение не вернуло дорожку музыки и эффектов. Финальное видео не собрано, чтобы не вернуть исходный голос.');
  }
  project.accompaniment = { key: cacheKey, path: accompanimentPath, model: demucsModel, createdAt: new Date().toISOString() };
  project.progress = 50;
  saveState();
  return accompanimentPath;
}

async function waveformForRange(project, start, end) {
  let samples;
  try {
    const waveformStart = Math.max(0, Number(start) || 0);
    const waveformEnd = Math.max(waveformStart + .35, Number(end) || waveformStart + .35);
    samples = await runFfmpegBuffer([
      '-v', 'error', '-ss', String(waveformStart), '-t', String(Math.max(.35, waveformEnd - waveformStart)),
      '-i', project.inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '1000', '-f', 's16le', '-',
    ], 1024 * 1024);
  } catch {
    return Array.from({ length: 96 }, () => 0);
  }
  const rawLevels = [];
  const sampleCount = Math.floor(samples.length / 2);
  for (let bucket = 0; bucket < 96; bucket += 1) {
    const from = Math.floor(bucket * sampleCount / 96);
    const to = Math.max(from + 1, Math.floor((bucket + 1) * sampleCount / 96));
    let sum = 0;
    for (let index = from; index < to && index < sampleCount; index += 1) {
      const value = samples.readInt16LE(index * 2) / 32768;
      sum += value * value;
    }
    rawLevels.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  // Preserve the actual level. The browser draws the original and microphone
  // against one shared scale so equal loudness has equal height on screen.
  // Timeline positions are fine at centisecond precision, but a waveform is
  // visibly quantised at that resolution (quiet real audio turns into three
  // identical bars). Keep four decimals so the canvas reflects the actual
  // changing source level instead of looking like a decorative placeholder.
  return rawLevels.map((level) => Number(Math.min(1, Math.max(0, level)).toFixed(4)));
}

async function waveformForSegment(project, segment) {
  const cached = project.waveforms?.[segment.id];
  if (project.waveformVersion === 2 && Array.isArray(cached) && cached.length === 96) return cached;
  const sourceClip = segmentClip(project, segment);
  const waveformStart = Math.max(sourceClip.start, segment.start - recordingLeadSeconds);
  const waveformEnd = Math.min(sourceClip.end, segment.end + recordingTailSeconds);
  const levels = await waveformForRange(project, waveformStart, waveformEnd);
  project.waveforms ??= {};
  project.waveforms[segment.id] = levels;
  project.waveformVersion = 2;
  saveState();
  return levels;
}

function rounded(value) {
  return Number(Number(value).toFixed(2));
}

function hasPhraseEnd(value) {
  return /[.!?…;:]$/.test(String(value || '').trim());
}

/**
 * Return actual quiet points from ffmpeg's silencedetect output.  They are only
 * used as preferred cuts; the duration limits below always win.  This matters
 * because a breath or a tiny gap must never become an unusable 0.9 s take.
 */
function silenceCuts(silenceLog, start, end) {
  const starts = [...silenceLog.matchAll(/silence_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...silenceLog.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  return ends.map((silenceEnd, index) => {
    const silenceStart = starts[index];
    return Number.isFinite(silenceStart) && Number.isFinite(silenceEnd)
      ? start + (silenceStart + silenceEnd) / 2
      : null;
  }).filter((value) => value && value > start && value < end);
}

/**
 * No-STT fallback. It deliberately returns empty text rather than invented
 * captions. The editor can then be used as a timed script sheet.
 */
function manualSegments(start, end, silenceLog) {
  const duration = end - start;
  if (duration < minSegmentSeconds) throw new Error('Выберите отрывок не короче 2 секунд');
  let count = Math.ceil(duration / maxSegmentSeconds);
  while (count > 1 && duration / count < minSegmentSeconds) count -= 1;
  const cuts = silenceCuts(silenceLog, start, end);
  const boundaries = [start];
  for (let index = 1; index < count; index += 1) {
    const previous = boundaries[index - 1];
    const remaining = count - index;
    const nominal = start + duration * index / count;
    const lower = Math.max(previous + minSegmentSeconds, end - remaining * maxSegmentSeconds);
    const upper = Math.min(previous + maxSegmentSeconds, end - remaining * minSegmentSeconds);
    const suitable = cuts.filter((cut) => cut >= lower && cut <= upper);
    const chosen = suitable.sort((left, right) => Math.abs(left - nominal) - Math.abs(right - nominal))[0];
    boundaries.push(chosen ?? Math.min(upper, Math.max(lower, nominal)));
  }
  boundaries.push(end);
  return boundaries.slice(0, -1).map((segmentStart, index) => ({
    start: rounded(segmentStart),
    end: rounded(boundaries[index + 1]),
    text: '',
  }));
}

function transcriptUnits(payload, clipStart, clipEnd) {
  const utterances = Array.isArray(payload?.results?.utterances) ? payload.results.utterances : [];
  const words = utterances.flatMap((utterance) => Array.isArray(utterance.words) ? utterance.words : []).length
    ? utterances.flatMap((utterance) => Array.isArray(utterance.words) ? utterance.words : [])
    : Array.isArray(payload?.results?.channels?.[0]?.alternatives?.[0]?.words)
      ? payload.results.channels[0].alternatives[0].words
      : Array.isArray(payload.words) ? payload.words : [];
  const wordUnits = words.map((word) => ({
    start: clipStart + Number(word.start),
    end: clipStart + Number(word.end),
    text: String(word.punctuated_word || word.word || '').trim(),
  })).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start && word.end > clipStart && word.start < clipEnd && word.text)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  // Some provider responses repeat the boundary word inside two adjacent
  // utterances. Treat only an actually overlapping, identical token as a
  // duplicate — "да, да" with two distinct time ranges remains intact.
  const uniqueWordUnits = wordUnits.reduce((unique, word) => {
    const previous = unique.at(-1);
    const normalise = (value) => value.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, '');
    if (previous && word.start <= previous.end + .025 && normalise(word.text) === normalise(previous.text)) {
      previous.end = Math.max(previous.end, word.end);
      if (/[.!?…]$/.test(word.text)) previous.text = word.text;
      return unique;
    }
    unique.push(word);
    return unique;
  }, []);
  if (uniqueWordUnits.length) return uniqueWordUnits;
  const utteranceUnits = utterances.map((utterance) => ({
    start: clipStart + Number(utterance.start),
    end: clipStart + Number(utterance.end),
    text: String(utterance.transcript || '').trim(),
  })).filter((utterance) => Number.isFinite(utterance.start) && Number.isFinite(utterance.end) && utterance.end > utterance.start && utterance.text);
  if (utteranceUnits.length) return utteranceUnits;
  return (Array.isArray(payload.segments) ? payload.segments : []).map((segment) => ({
    start: clipStart + Number(segment.start),
    end: clipStart + Number(segment.end),
    text: String(segment.text || '').trim(),
  })).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text);
}

/**
 * Keep a thought together whenever possible, while keeping recording turns
 * comfortable on a phone. Prefer sentence and comma boundaries; if speech has
 * no natural pause, split only between complete words at about five seconds.
 */
function phraseSegments(units, clipStart, clipEnd) {
  const inClip = units.map((unit) => ({
    ...unit,
    start: Math.max(clipStart, unit.start),
    end: Math.min(clipEnd, unit.end),
  })).filter((unit) => unit.end > unit.start);
  if (!inClip.length) return [];

  const rawGroups = [];
  let group = [];
  const commit = () => {
    if (!group.length) return;
    rawGroups.push(group);
    group = [];
  };

  for (const unit of inClip) {
    if (!group.length) {
      group.push(unit);
      continue;
    }
    const groupStart = group[0].start;
    const previousEnd = group[group.length - 1].end;
    const candidateDuration = unit.end - groupStart;
    const groupDuration = previousEnd - groupStart;
    const gap = unit.start - previousEnd;
    // An unpunctuated narration must still have a comfortable ceiling.
    if (candidateDuration > maxNaturalSentenceSeconds && groupDuration >= 1.25) commit();
    group.push(unit);
    const duration = group[group.length - 1].end - group[0].start;
    const hasSoftBreak = /[,;:—–-]$/.test(unit.text);
    if (hasPhraseEnd(unit.text) || (hasSoftBreak && duration >= 2.15) || (gap >= 0.48 && duration >= 1.6)) commit();
  }
  commit();

  // A one-word sentence or a very brief interjection is awkward to record on
  // its own. Merge it with its neighbour when the complete thought still fits.
  const groups = [];
  for (const nextGroup of rawGroups) {
    const previous = groups[groups.length - 1];
    const nextDuration = nextGroup[nextGroup.length - 1].end - nextGroup[0].start;
    // A one-word answer at the end of a thought is never useful as a separate
    // recording turn. Keep it with the preceding sentence even when that
    // produces a slightly longer natural line rather than an unusable 0.9 s
    // fragment.
    if (previous && nextDuration < minSegmentSeconds) {
      previous.push(...nextGroup);
    } else {
      groups.push(nextGroup);
    }
  }

  for (let index = groups.length - 2; index >= 0; index -= 1) {
    const current = groups[index];
    const next = groups[index + 1];
    const currentDuration = current[current.length - 1].end - current[0].start;
    const combinedDuration = next[next.length - 1].end - current[0].start;
    if (currentDuration < minSegmentSeconds && combinedDuration <= maxNaturalSentenceSeconds + minSegmentSeconds) {
      current.push(...next);
      groups.splice(index + 1, 1);
    }
  }

  const candidates = groups.slice(0, 80).map((sentence) => ({
    start: rounded(Math.max(clipStart, sentence[0].start)),
    end: rounded(Math.min(clipEnd, sentence[sentence.length - 1].end)),
    text: sentence.map((unit) => unit.text).join(' ').replace(/\s+([,.!?…;:])/g, '$1').trim(),
  }));

  // Do not silently throw away a short but meaningful final answer such as
  // “Да.”.  We borrow only adjacent silence inside the selected clip, never
  // another phrase, so the recording control remains at least two seconds
  // without cutting a word or duplicating it in the next cue.
  return candidates.map((segment, index) => {
    if (segment.end - segment.start >= minSegmentSeconds || clipEnd - clipStart < minSegmentSeconds) return segment;
    const previousEnd = index > 0 ? candidates[index - 1].end : clipStart;
    const nextStart = index < candidates.length - 1 ? candidates[index + 1].start : clipEnd;
    const preferredEnd = Math.min(clipEnd, nextStart, segment.start + minSegmentSeconds);
    if (preferredEnd - segment.start >= minSegmentSeconds) return { ...segment, end: rounded(preferredEnd) };
    const preferredStart = Math.max(clipStart, previousEnd, segment.end - minSegmentSeconds);
    return { ...segment, start: rounded(preferredStart) };
  }).filter((segment) => segment.end > segment.start + .24);
}

function projectClips(project) {
  const incoming = Array.isArray(project.clips) && project.clips.length ? project.clips : project.trim ? [{ id: 'clip-1', ...project.trim }] : [];
  return incoming
    .map((clip, index) => ({ id: String(clip.id || `clip-${index + 1}`).slice(0, 40), start: Number(clip.start), end: Number(clip.end) }))
    .filter((clip) => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end - clip.start >= minSegmentSeconds)
    .sort((left, right) => left.start - right.start);
}

function segmentClip(project, segment) {
  const clips = projectClips(project);
  return clips.find((clip) => clip.id === segment.clipId)
    ?? clips.find((clip) => segment.start >= clip.start - .01 && segment.end <= clip.end + .01)
    ?? { start: project.trim?.start ?? segment.start, end: project.trim?.end ?? segment.end };
}

function deepgramKeyState() {
  // A desktop launch may not inherit the PowerShell session where the user
  // pasted the key. The optional ignored local file keeps the key server-side
  // and lets a restarted media service use the same configuration. It is never
  // exposed through an API response or included in logs.
  let key = String(process.env.DEEPGRAM_API_KEY || '').trim();
  if (!key && existsSync(deepgramKeyPath)) {
    try { key = readFileSync(deepgramKeyPath, 'utf8').trim(); } catch { /* use no key */ }
  }
  return { key, valid: Boolean(key) && /^[\x21-\x7E]+$/.test(key) };
}

function deepgramApiKey() {
  const { key, valid } = deepgramKeyState();
  if (!key) return null;
  if (!valid) {
    throw new Error('Ключ Deepgram содержит лишний текст, пробел или не-латинские символы. Вставьте только сам API key из Deepgram Console и перезапустите сервер.');
  }
  return key;
}

async function transcribeWithDeepgram(inputPath, start, end) {
  const apiKey = deepgramApiKey();
  if (!apiKey) return null;
  // 24 kHz / 64 kbps still keeps a four-minute selection compact, but retains
  // consonants and short Russian function words much better than the old
  // 16 kHz / 32 kbps proxy. Those were the common cause of a caption ending
  // while the audible phrase was still continuing.
  const audioPath = join(dataDir, `transcribe-${randomUUID()}.mp3`);
  await runFfmpeg(['-y', '-ss', String(start), '-t', String(end - start), '-i', inputPath, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', audioPath]);
  try {
    const query = new URLSearchParams({
      model: process.env.DEEPGRAM_TRANSCRIBE_MODEL || 'nova-3',
      // The studio is Russian-first, but source videos are often English or
      // mixed-language. Nova-3 multilingual keeps their real phrase timing.
      language: process.env.DEEPGRAM_LANGUAGE || 'multi',
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
      // A short silence is natural inside one sentence. Waiting a little
      // longer keeps the words that belong to one spoken thought together.
      utt_split: '0.8',
      paragraphs: 'true',
      numerals: 'true',
      mip_opt_out: process.env.DEEPGRAM_MIP_OPT_OUT || 'true',
    });
    const result = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/mpeg',
      },
      body: readFileSync(audioPath),
      signal: AbortSignal.timeout(120000),
    });
    if (!result.ok) {
      const details = (await result.text()).slice(0, 400);
      throw new Error(`Deepgram не распознал речь (${result.status})${details ? `: ${details}` : ''}`);
    }
    const payload = await result.json();
    return phraseSegments(transcriptUnits(payload, start, end), start, end);
  } finally {
    try { unlinkSync(audioPath); } catch { /* best-effort cleanup */ }
  }
}

function projectFor(request, id) {
  const user = actor(request, { allowLocalGuest: true });
  const project = state.projects[id];
  return user && project && project.userId === user.id ? { user, project } : null;
}

async function analyzeProject(project, body) {
  const rawClips = Array.isArray(body.clips) && body.clips.length ? body.clips : [{ id: 'clip-1', start: body.start, end: body.end }];
  if (rawClips.length > 6) throw new Error('Можно выбрать не больше 6 фрагментов');
  const sourceDuration = await durationForProject(project);
  if (!(sourceDuration >= minSegmentSeconds)) throw badRequest('Не удалось определить длительность видео');
  const clips = rawClips.map((clip, index) => {
    const start = Number(clip.start);
    const end = Number(clip.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > sourceDuration + .05) throw badRequest('Границы фрагмента выходят за пределы видео');
    return {
      id: String(clip.id || `clip-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || `clip-${index + 1}`,
      start: rounded(Math.max(0, start)),
      end: rounded(Math.min(sourceDuration, end)),
    };
  }).sort((left, right) => left.start - right.start);
  if (clips.some((clip) => !(clip.end - clip.start >= minSegmentSeconds) || clip.end - clip.start > maxSelectedSeconds)) throw new Error('Каждый фрагмент должен быть от 2 секунд до 4 минут');
  if (clips.some((clip, index) => index > 0 && clip.start < clips[index - 1].end)) throw new Error('Выбранные фрагменты не должны пересекаться');
  const totalDuration = clips.reduce((total, clip) => total + clip.end - clip.start, 0);
  if (totalDuration > maxSelectedSeconds) throw new Error('Суммарная длительность фрагментов не может быть больше 4 минут');

  project.clips = clips;
  project.trim = { start: clips[0].start, end: clips.at(-1).end };
  const analysisStartedAt = Date.now();
  console.info(`[dublika] analyse ${project.id}: ${clips.length} selected parts, ${totalDuration.toFixed(1)}s total`);

  // The selection is an edit decision, not a set of separate dubbing jobs.
  // Prepare every chosen piece at once, then flatten the results into one
  // timeline below. This avoids making a person wait for one Deepgram request
  // after another when they picked several pieces from the source video.
  const analyses = await Promise.all(clips.map(async (clip) => {
    if (project.isDemo) {
      const demoSegments = demoCueTemplate
        .filter((cue) => cue.start >= clip.start - .01 && cue.end <= clip.end + .01)
        .map((cue) => ({ ...cue }));
      if (demoSegments.length) return { clip, segments: demoSegments, transcribed: true, noSpeech: false, transcriptionUnavailable: false, preparedDemo: true };
    }
    let segments = null;
    let transcriptionUnavailable = false;
    try {
      segments = await transcribeWithDeepgram(project.inputPath, clip.start, clip.end);
    } catch (error) {
      // An expired key or a temporarily blocked Deepgram connection must not
      // destroy the entire editing session.  We still create honest, empty
      // timed recording windows from the selected source audio.
      transcriptionUnavailable = true;
      console.error(`[dublika] transcription unavailable for ${project.id}: ${String(error.message || error).slice(-700)}`);
    }
    let transcribed = Boolean(segments?.length);
    let noSpeech = false;
    if (!segments?.length) {
      noSpeech = deepgramKeyState().valid && !transcriptionUnavailable;
      let log = '';
      try { log = await runFfmpeg(['-hide_banner', '-ss', String(clip.start), '-t', String(clip.end - clip.start), '-i', project.inputPath, '-vn', '-af', 'silencedetect=noise=-32dB:d=0.32', '-f', 'null', '-']); } catch (error) { log = String(error.message || ''); }
      segments = manualSegments(clip.start, clip.end, log);
      transcribed = false;
    }
    return { clip, segments, transcribed, noSpeech, transcriptionUnavailable, preparedDemo: false };
  }));

  const collected = [];
  let outputOffset = 0;
  const allTranscribed = analyses.every((analysis) => analysis.transcribed);
  const onlyNoSpeech = analyses.every((analysis) => !analysis.transcribed && analysis.noSpeech);
  const hadUnavailableTranscription = analyses.some((analysis) => analysis.transcriptionUnavailable);
  const hasPreparedDemo = analyses.some((analysis) => analysis.preparedDemo);
  for (const { clip, segments } of analyses) {
    for (const segment of segments) {
      const start = rounded(segment.start);
      const end = rounded(segment.end);
      collected.push({
        id: collected.length + 1,
        clipId: clip.id,
        start,
        end,
        outputStart: rounded(outputOffset + start - clip.start),
        outputEnd: rounded(outputOffset + end - clip.start),
        text: String(segment.text || ''),
        state: 'pending',
      });
    }
    outputOffset += clip.end - clip.start;
  }
  project.segments = collected;
  // A new selection changes the flattened timeline.  Reusing takes by their
  // old numeric ids could lay a voice over the wrong phrase, so analysis is a
  // hard edit boundary: the user records the refreshed cues from scratch.
  project.recordings = {};
  project.outputPath = null;
  project.outputUrl = null;
  project.error = null;
  project.progress = 0;
  const transcriptionMode = hasPreparedDemo ? 'demo' : allTranscribed ? 'transcribed' : 'manual';
  const transcriptionReason = allTranscribed ? null : onlyNoSpeech ? 'no_speech' : hadUnavailableTranscription ? 'unavailable' : 'no_speech';
  project.transcriptionMode = transcriptionMode;
  project.waveforms = {};
  project.status = 'ready';
  project.updatedAt = new Date().toISOString();
  saveState();
  console.info(`[dublika] analyse ${project.id}: ${collected.length} cues ready in ${((Date.now() - analysisStartedAt) / 1000).toFixed(1)}s`);
  return { segments: project.segments, clips, transcriptionMode, transcriptionReason };
}

async function renderProject(user, project) {
  if (user.credits <= 0 && user.plan === 'Пробный') throw new Error('Бесплатные обработки закончились');
  const expectedSegments = [...project.segments].sort((left, right) => (left.outputStart ?? left.start) - (right.outputStart ?? right.start));
  const missing = expectedSegments.filter((segment) => !project.recordings?.[segment.id]);
  if (missing.length) throw new Error(`Сначала сохраните все реплики. Не записано: ${missing.map((segment) => segment.id).join(', ')}`);
  const recorded = expectedSegments;
  if (!recorded.length) throw new Error('Запишите хотя бы одну реплику');
  const clips = projectClips(project);
  if (!clips.length) throw new Error('Сначала выберите хотя бы один фрагмент');
  const duration = clips.reduce((total, clip) => total + clip.end - clip.start, 0);
  const outputPath = join(outputDir, `${project.id}.mp4`);
  project.status = 'processing';
  project.progress = 2;
  project.error = null;
  saveState();
  // Use one source input and exact trim filters. Input-side seeking can begin
  // at a non-keyframe and was causing clicks/pops where selected pieces met.
  const args = ['-y', '-i', project.inputPath];
  const filters = [];
  const sourceHasSound = await sourceHasAudio(project.inputPath);
  const accompanimentPath = sourceHasSound ? await prepareAccompaniment(project, clips) : null;
  if (accompanimentPath) args.push('-i', accompanimentPath);
  recorded.forEach((segment) => args.push('-i', project.recordings[segment.id].path));
  const sourceVideoLabels = clips.map((clip, index) => `[0:v]trim=start=${clip.start}:end=${clip.end},setpts=PTS-STARTPTS[v${index}]`);
  filters.push(...sourceVideoLabels);
  const sourceVideoLabel = '[vsource]';
  filters.push(`${clips.map((_, index) => `[v${index}]`).join('')}concat=n=${clips.length}:v=1:a=0[vsource]`);
  const firstTakeInput = accompanimentPath ? 2 : 1;
  recorded.forEach((segment, index) => {
    const take = project.recordings[segment.id];
    // Recordings made before this feature have no padding metadata and remain
    // sample-aligned. New takes include their one-second lead-in and tail-out.
    const leadIn = Math.min(recordingLeadSeconds, Math.max(0, Number(take.leadIn) || 0));
    const delay = Math.max(0, Math.round((Number.isFinite(segment.outputStart) ? segment.outputStart : segment.start - project.trim.start) * 1000));
    const spokenDuration = Math.max(.25, segment.end - segment.start);
    const takeEnd = leadIn + spokenDuration;
    // The extra second captured before and after a cue is only a recording
    // safety margin. It must never bleed into the next cue in the export.
    // A short fade removes the click that arose when WebM takes met exactly
    // at a segment boundary.
    const edgeFade = Math.min(.07, spokenDuration / 4);
    const fadeOutAt = Math.max(0, spokenDuration - edgeFade);
    filters.push(`[${firstTakeInput + index}:a]highpass=f=80,lowpass=f=12000,afftdn=nf=-25,acompressor=threshold=-20dB:ratio=3:attack=12:release=150:makeup=2,atrim=start=${leadIn.toFixed(3)}:end=${takeEnd.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${edgeFade.toFixed(3)},afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${edgeFade.toFixed(3)},volume=.82,adelay=${delay}:all=1[t${index}]`);
  });
  const takeLabels = recorded.map((_, index) => `[t${index}]`).join('');
  // Every take is delayed onto its one flattened output timeline.  Because
  // they are validated as separate cues this produces one voice track rather
  // than stacking takes at clip boundaries.  The limiter is a final safety
  // net, not a gain boost, so adjacent lines cannot produce a volume burst.
  filters.push(`${takeLabels}amix=inputs=${recorded.length}:duration=longest:normalize=0:dropout_transition=0,alimiter=limit=.76[voice]`);
  if (accompanimentPath) {
    filters.push(`[1:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=.96[effects]`);
    filters.push('[voice]asplit=2[voice_sc][voice_mix]');
    filters.push('[effects][voice_sc]sidechaincompress=threshold=.024:ratio=6:attack=15:release=260[ducked]');
    // Apply a broadcast-safe target after the stems and the voice have been
    // mixed. The final limiter prevents an abrupt peak when two consonants
    // meet at a cue boundary, while loudnorm keeps all finished videos at a
    // stable listening level.
    filters.push("[ducked][voice_mix]amix=inputs=2:duration=first:normalize=0:dropout_transition=0:weights='0.72 1',loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=.92[aout]");
  } else {
    filters.push('[voice]loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=.92[aout]');
  }
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', sourceVideoLabel, '-map', '[aout]', '-c:v', 'libx264', '-preset', videoPreset, '-crf', String(videoCrf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-progress', 'pipe:2', '-nostats', outputPath);
  await runFfmpeg(args, (chunk) => {
    const match = String(chunk).match(/out_time_ms=(\d+)/);
    if (match) project.progress = Math.min(99, 55 + Math.round((Number(match[1]) / 1_000_000) / duration * 44));
  });
  project.status = 'done';
  project.progress = 100;
  project.outputPath = outputPath;
  project.outputUrl = `/media/outputs/${project.id}.mp4`;
  project.updatedAt = new Date().toISOString();
  if (user.plan === 'Пробный') user.credits = Math.max(0, user.credits - 1);
  saveState();
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function isBlockedRemoteAddress(value) {
  const address = String(value || '').toLowerCase();
  if (!address || address === '::' || address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return ipv4 === '0.0.0.0'
    || ipv4.startsWith('127.')
    || ipv4.startsWith('10.')
    || ipv4.startsWith('192.168.')
    || ipv4.startsWith('169.254.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ipv4)
    || ipv4.startsWith('198.18.')
    || ipv4.startsWith('198.19.');
}

async function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw badRequest('Введите корректную ссылку на видео'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Разрешены только HTTP/HTTPS ссылки');
  const result = await lookup(url.hostname, { all: true });
  const blocked = result.some(({ address }) => isBlockedRemoteAddress(address));
  if (blocked) throw badRequest('Локальные сетевые адреса запрещены');
  return url;
}

async function downloadRemote(value, destination) {
  try {
    let url = await validateRemoteUrl(value);
    let result;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
      if (![301, 302, 303, 307, 308].includes(result.status)) break;
      const location = result.headers.get('location');
      if (!location) throw new Error('Ссылка перенаправляет без адреса');
      url = await validateRemoteUrl(new URL(location, url).toString());
    }
    if (!result) throw new Error('Не удалось открыть ссылку');
    if (!result.ok || !result.body) throw new Error(`Не удалось скачать видео: HTTP ${result.status}`);
    const length = Number(result.headers.get('content-length') || 0);
    if (length > maxVideoBytes) throw new Error('Видео больше 1 ГБ');
    let size = 0;
    const limiter = new TransformStream({ transform(chunk, controller) { size += chunk.byteLength; if (size > maxVideoBytes) throw new Error('Видео больше 1 ГБ'); controller.enqueue(chunk); } });
    await pipeline(Readable.fromWeb(result.body.pipeThrough(limiter)), createWriteStream(destination, { flags: 'wx' }));
    return size;
  } catch (error) {
    try { unlinkSync(destination); } catch { /* best-effort cleanup */ }
    // Some Windows security profiles permit the isolated downloader but block
    // Node's network stack. Keep direct MP4 links usable in that environment
    // by falling back to the same sandboxed yt-dlp worker used for platforms.
    try { return await downloadWithYtDlp(value, destination, false); } catch {
      console.error(`[dublika] direct import failed: ${String(error.message || error).slice(-800)}`);
      throw badRequest('Не удалось загрузить видео по ссылке. Проверьте, что ссылка открывается без авторизации, или загрузите файл с устройства.');
    }
  }
}

async function downloadWithYtDlp(value, destination, platform) {
  if (!existsSync(ytDlpPath)) throw new Error('Модуль импорта YouTube/VK не установлен. Выполните npm run setup:media');
  const url = await validateRemoteUrl(value);
  const ffmpegDirectory = resolve(ffmpegPath, '..');
  const format = platform ? 'bv*[height<=1080]+ba/b[height<=1080]' : 'best';
  // YouTube increasingly requires its player JavaScript while negotiating
  // formats. Pinning the already-installed Node runtime prevents yt-dlp from
  // silently falling back to its incomplete no-JS extractor.
  try {
    await runProcess(ytDlpPath, ['--no-playlist', '--no-warnings', '--no-part', '--max-filesize', '1G', '--js-runtimes', 'node', '--format', format, '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpegDirectory, '--output', destination, url.toString()]);
  } catch (error) {
    try { unlinkSync(destination); } catch { /* a partial download is never reused */ }
    console.error(`[dublika] platform import failed: ${String(error.message || error).slice(-1600)}`);
    throw badRequest('Не удалось получить видео из YouTube или VK. Проверьте публичный доступ к ролику или загрузите файл с устройства.');
  }
  if (!existsSync(destination)) throw new Error('Видео не было сохранено');
  return statSync(destination).size;
}

async function downloadPlatformVideo(value, destination) {
  return downloadWithYtDlp(value, destination, true);
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  const deepgram = deepgramKeyState();
  if (pathname === '/api/health') return sendJson(response, 200, {
    ok: true,
    ffmpeg: Boolean(ffmpegPath && existsSync(ffmpegPath)),
    stemSeparation: existsSync(demucsPythonPath),
    stemModel: demucsModel,
    ytDlp: existsSync(ytDlpPath),
    transcription: deepgram.valid,
    transcriptionProvider: 'deepgram',
    transcriptionIssue: deepgram.key && !deepgram.valid ? 'invalid_key_format' : null,
    local: true,
  });
  const authHandled = await handleAuth(request, response, pathname, url);
  if (authHandled !== false) return authHandled;
  const billingHandled = await handleBilling(request, response, pathname);
  if (billingHandled !== false) return billingHandled;

  if (pathname === '/api/projects/demo' && request.method === 'POST') {
    const user = requireActor(request, { allowLocalGuest: true });
    const inputPath = await ensureDemoVideo();
    const id = randomUUID();
    const duration = await videoDuration(inputPath);
    state.projects[id] = {
      id,
      userId: user.id,
      title: 'Демо-сцена Дублики.mp4',
      inputPath,
      size: statSync(inputPath).size,
      duration,
      isDemo: true,
      status: 'uploaded',
      progress: 0,
      trim: null,
      segments: [],
      recordings: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveState();
    return sendJson(response, 201, { project: { id, title: state.projects[id].title, duration, inputUrl: sourceMediaUrl(state.projects[id]) }, credits: user.credits });
  }

  if (pathname === '/api/projects/upload' && request.method === 'POST') {
    rateLimit(request, 'upload', 12, 60 * 60 * 1000);
    const user = requireActor(request, { allowLocalGuest: true });
    let headerName = request.headers['x-file-name'];
    try { headerName = decodeURIComponent(String(headerName || '')); } catch { /* use the raw header */ }
    const originalName = safeName(headerName, 'video.mp4');
    const extension = extname(originalName).toLowerCase();
    if (!videoExtensions.has(extension)) return sendJson(response, 415, { error: 'Поддерживаются MP4, MOV, WebM, MKV и M4V' });
    const id = randomUUID();
    const inputPath = join(uploadDir, `${id}${extension}`);
    const size = await saveBody(request, inputPath, maxVideoBytes);
    const duration = await videoDuration(inputPath);
    if (duration < minSegmentSeconds) {
      try { unlinkSync(inputPath); } catch { /* invalid uploads are not retained */ }
      return sendJson(response, 422, { error: 'Видео должно быть не короче двух секунд' });
    }
    state.projects[id] = { id, userId: user.id, title: originalName, inputPath, size, duration, status: 'uploaded', progress: 0, trim: null, segments: [], recordings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveState();
    return sendJson(response, 201, { project: { id, title: originalName, duration, status: 'uploaded', inputUrl: sourceMediaUrl(state.projects[id]) }, credits: user.credits });
  }

  if (pathname === '/api/projects/import' && request.method === 'POST') {
    rateLimit(request, 'import', 8, 60 * 60 * 1000);
    const user = requireActor(request, { allowLocalGuest: true });
    const body = await readJson(request);
    const source = await validateRemoteUrl(String(body.url || ''));
    const extension = videoExtensions.has(extname(source.pathname).toLowerCase()) ? extname(source.pathname).toLowerCase() : '.mp4';
    const id = randomUUID();
    const inputPath = join(uploadDir, `${id}${extension}`);
    const platformHost = /(^|\.)(youtube\.com|youtu\.be|vk\.com|vkvideo\.ru|vk\.ru|vkontakte\.ru)$/i.test(source.hostname);
    const size = platformHost ? await downloadPlatformVideo(source.toString(), inputPath) : await downloadRemote(source.toString(), inputPath);
    const duration = await videoDuration(inputPath);
    if (duration < minSegmentSeconds) {
      try { unlinkSync(inputPath); } catch { /* invalid imports are not retained */ }
      return sendJson(response, 422, { error: 'Видео должно быть не короче двух секунд' });
    }
    const title = safeName(body.title || source.pathname.split('/').pop(), 'Видео по ссылке');
    state.projects[id] = { id, userId: user.id, title, inputPath, size, duration, sourceUrl: source.toString(), status: 'uploaded', progress: 0, trim: null, segments: [], recordings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveState();
    return sendJson(response, 201, { project: { id, title, duration, status: 'uploaded', inputUrl: sourceMediaUrl(state.projects[id]) }, credits: user.credits });
  }

  if (pathname === '/api/projects' && request.method === 'GET') {
    const user = requireActor(request, { allowLocalGuest: true });
    const projects = Object.values(state.projects).filter((project) => project.userId === user.id).map(({ inputPath: _input, outputPath: _output, recordings: _recordings, accompaniment: _accompaniment, ...project }) => ({
      ...project,
      inputUrl: sourceMediaUrl(project),
      outputUrl: project.outputUrl ? outputMediaUrl(project) : null,
    }));
    return sendJson(response, 200, { projects, credits: user.credits, plan: user.plan });
  }

  const thumbnailsMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/thumbnails$/i);
  if (thumbnailsMatch && request.method === 'GET') {
    const access = projectFor(request, thumbnailsMatch[1]);
    if (!access) return sendJson(response, 404, { error: 'Проект не найден' });
    return sendJson(response, 200, await thumbnailsForProject(access.project, Number(url.searchParams.get('count')) || 12));
  }

  const editorWaveformMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/waveform$/i);
  if (editorWaveformMatch && request.method === 'GET') {
    const access = projectFor(request, editorWaveformMatch[1]);
    if (!access) return sendJson(response, 404, { error: 'Проект не найден' });
    const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
    const requestedEnd = Number(url.searchParams.get('end'));
    const duration = await durationForProject(access.project);
    const end = Math.min(duration || start + 240, start + 240, Math.max(start + .35, Number.isFinite(requestedEnd) ? requestedEnd : start + .35));
    return sendJson(response, 200, { levels: await waveformForRange(access.project, start, end) });
  }

  const segmentTextMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/segments\/text$/i);
  if (segmentTextMatch && request.method === 'POST') {
    const access = projectFor(request, segmentTextMatch[1]);
    if (!access) return sendJson(response, 401, { error: 'Войдите в аккаунт, чтобы изменить проект.' });
    const body = await readJson(request);
    if (!Array.isArray(body.segments) || body.segments.length > 100) return sendJson(response, 400, { error: 'Некорректный список реплик' });
    const incoming = new Map(body.segments.map((item) => [Number(item?.id), String(item?.text || '').trim().slice(0, 500)]));
    for (const segment of access.project.segments) {
      if (incoming.has(segment.id)) segment.text = incoming.get(segment.id);
    }
    access.project.updatedAt = new Date().toISOString();
    saveState();
    return sendJson(response, 200, { ok: true });
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)(?:\/(analyze|render|status)|\/segments\/([0-9]+)(\/waveform)?)?$/i);
  if (!projectMatch) return sendJson(response, 404, { error: 'Маршрут не найден' });
  const access = projectFor(request, projectMatch[1]);
  if (!access) return sendJson(response, 404, { error: 'Проект не найден' });
  const { user, project } = access;
  const action = projectMatch[2];
  const segmentId = Number(projectMatch[3]);
  const wantsWaveform = Boolean(projectMatch[4]);

  if (!action && !Number.isFinite(segmentId) && request.method === 'GET') {
    const { inputPath: _input, outputPath: _output, recordings, accompaniment: _accompaniment, ...safeProject } = project;
    const segments = project.segments.map((segment) => recordings?.[segment.id] ? { ...segment, audioUrl: takeMediaUrl(project, segment.id) } : segment);
    return sendJson(response, 200, { project: { ...safeProject, segments, inputUrl: sourceMediaUrl(project), outputUrl: project.outputUrl ? outputMediaUrl(project) : null }, credits: user.credits });
  }
  if (action === 'analyze' && request.method === 'POST') {
    // Transcription is a paid external call. Bound it server-side as well as
    // in the UI, otherwise a scripted client could exhaust an account's API
    // budget by repeatedly pressing “prepare”.
    rateLimit(request, 'analyse', 24, 60 * 60 * 1000);
    return sendJson(response, 200, await analyzeProject(project, await readJson(request)));
  }
  if (wantsWaveform && request.method === 'GET') {
    const segment = project.segments.find((item) => item.id === segmentId);
    if (!segment) return sendJson(response, 404, { error: 'Реплика не найдена' });
    return sendJson(response, 200, { levels: await waveformForSegment(project, segment) });
  }
  if (Number.isFinite(segmentId) && request.method === 'POST') {
    if (!project.segments.some((segment) => segment.id === segmentId)) return sendJson(response, 404, { error: 'Реплика не найдена' });
    rateLimit(request, 'take-upload', 120, 60 * 60 * 1000);
    const skipped = project.segments.find((segment) => segment.id < segmentId && !project.recordings?.[segment.id]);
    if (skipped) return sendJson(response, 409, { error: `Сначала запишите реплику ${skipped.id}.` });
    const type = String(request.headers['content-type'] || 'audio/webm').split(';')[0];
    const extension = type.includes('ogg') ? '.ogg' : type.includes('wav') ? '.wav' : type.includes('mp4') ? '.m4a' : '.webm';
    if (!audioExtensions.has(extension)) return sendJson(response, 415, { error: 'Неподдерживаемый аудиоформат' });
    const takePath = join(recordingDir, `${project.id}-${segmentId}-${Date.now()}${extension}`);
    const size = await saveBody(request, takePath, maxAudioBytes);
    const leadIn = Math.min(recordingLeadSeconds, Math.max(0, Number(request.headers['x-recording-lead-in']) || 0));
    const tailOut = Math.min(recordingTailSeconds, Math.max(0, Number(request.headers['x-recording-tail-out']) || 0));
    const previousTake = project.recordings[segmentId];
    project.recordings[segmentId] = { path: takePath, size, type, leadIn, tailOut, createdAt: new Date().toISOString() };
    // A replacement take supersedes the old private recording. Retaining all
    // retries indefinitely both wastes disk and risks an old take being used
    // by an operator accidentally.
    if (previousTake?.path && previousTake.path !== takePath) {
      try { unlinkSync(previousTake.path); } catch { /* the new take remains valid */ }
    }
    const segment = project.segments.find((item) => item.id === segmentId);
    segment.state = 'ready';
    project.updatedAt = new Date().toISOString();
    saveState();
    return sendJson(response, 201, { ok: true, segmentId, takeUrl: takeMediaUrl(project, segmentId) });
  }
  if (action === 'render' && request.method === 'POST') {
    // A queued project has already reserved a job.  Starting it again used to
    // create two ffmpeg processes that wrote the same MP4 concurrently.
    if (project.status === 'processing' || project.status === 'queued') return sendJson(response, 409, { error: 'Рендер уже выполняется' });
    rateLimit(request, 'render', 12, 60 * 60 * 1000);
    const body = await readJson(request);
    if (Array.isArray(body.segments)) {
      for (const incoming of body.segments) {
        const segment = project.segments.find((item) => item.id === Number(incoming.id));
        if (segment) segment.text = String(incoming.text || segment.text).slice(0, 500);
      }
    }
    project.status = activeRenderCount >= maxConcurrentRenders ? 'queued' : 'processing';
    project.progress = 0;
    project.error = null;
    saveState();
    void withRenderSlot(async () => {
      project.status = 'processing';
      project.progress = 2;
      saveState();
      try {
        await renderProject(user, project);
      } catch (error) {
        project.status = 'failed';
        project.error = String(error.message || error).slice(-1000);
        saveState();
      }
    });
    return sendJson(response, 202, { ok: true, status: project.status });
  }
  if (action === 'status' && request.method === 'GET') return sendJson(response, 200, { status: project.status, progress: project.progress || 0, error: project.error || null, outputUrl: project.outputUrl ? outputMediaUrl(project) : null, credits: user.credits });
  return sendJson(response, 405, { error: 'Метод не поддерживается' });
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };

function sendFile(request, response, path) {
  const stats = statSync(path);
  const range = request.headers.range;
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream');
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
    if (start > end || start >= stats.size) { response.writeHead(416, { 'Content-Range': `bytes */${stats.size}` }); return response.end(); }
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stats.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(path, { start, end }).pipe(response);
  }
  response.writeHead(200, { 'Content-Length': stats.size });
  createReadStream(path).pipe(response);
}

const server = createServer((request, response) => stateContext.run(requestStore(request), async () => {
  setSecurityHeaders(request, response);
  try {
    const origin = String(request.headers.origin || '');
    if (origin && !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Этот сайт не имеет доступа к локальному серверу' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (url.pathname.startsWith('/media/outputs/')) {
      const name = safeName(url.pathname.split('/').pop(), 'missing');
      const path = join(outputDir, name);
      const projectId = name.replace(/\.mp4$/i, '');
      const project = state.projects[projectId];
      if (!project || !hasMediaToken(url, projectId, 'output')) return sendJson(response, 403, { error: 'Нет доступа к медиафайлу' });
      return existsSync(path) ? sendFile(request, response, path) : sendJson(response, 404, { error: 'Файл не найден' });
    }
    const projectSource = url.pathname.match(/^\/media\/projects\/([a-f0-9-]+)\/source$/i);
    if (projectSource) {
      const project = state.projects[projectSource[1]];
      if (!project || !hasMediaToken(url, project.id, 'source')) return sendJson(response, 403, { error: 'Нет доступа к медиафайлу' });
      return project?.inputPath && existsSync(project.inputPath) ? sendFile(request, response, project.inputPath) : sendJson(response, 404, { error: 'Файл не найден' });
    }
    const projectThumbnail = url.pathname.match(/^\/media\/projects\/([a-f0-9-]+)\/thumbnails\/([0-9]+)$/i);
    if (projectThumbnail) {
      const project = state.projects[projectThumbnail[1]];
      const index = Number(projectThumbnail[2]);
      if (!project || !Number.isInteger(index) || index < 0 || index > 15 || !hasMediaToken(url, project.id, `thumbnail:${index}`)) return sendJson(response, 403, { error: 'Нет доступа к медиафайлу' });
      const path = join(thumbnailDir, project.id, `${index}.jpg`);
      return existsSync(path) ? sendFile(request, response, path) : sendJson(response, 404, { error: 'Кадр не найден' });
    }
    const projectTake = url.pathname.match(/^\/media\/projects\/([a-f0-9-]+)\/takes\/([0-9]+)$/i);
    if (projectTake) {
      const project = state.projects[projectTake[1]];
      if (!project || !hasMediaToken(url, project.id, `take:${projectTake[2]}`)) return sendJson(response, 403, { error: 'Нет доступа к медиафайлу' });
      const take = project?.recordings?.[Number(projectTake[2])];
      return take?.path && existsSync(take.path) ? sendFile(request, response, take.path) : sendJson(response, 404, { error: 'Запись не найдена' });
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    let path = join(publicDir, relative || 'index.html');
    if (!path.startsWith(publicDir) || !existsSync(path) || statSync(path).isDirectory()) path = join(publicDir, 'index.html');
    return sendFile(request, response, path);
  } catch (error) {
    const status = error.message === 'payload_too_large' ? 413 : Number(error.statusCode) || 500;
    // Authentication, validation and rate-limit rejections are expected at an
    // Internet edge. Keep their diagnostics compact; only unexpected 5xx
    // failures need a full stack trace in the operator log.
    if (status >= 500) console.error(error);
    else console.warn(`[dublika] ${status} ${request.method || 'REQUEST'} ${request.url || '/'}`);
    return sendJson(response, status, { error: String(error.message || 'Ошибка сервера') });
  }
}));

server.listen(port, bindHost, () => {
  console.log(`\nДублика запущена: ${bindHost === '127.0.0.1' ? `http://localhost:${port}` : `http://${bindHost}:${port}`}`);
  console.log(`FFmpeg: ${ffmpegPath}`);
  console.log(`Рендеров одновременно: ${maxConcurrentRenders}; Demucs: ${demucsModel}/${demucsDevice}`);
  console.log('Исходники и результаты хранятся в изолированном хранилище сервера.\n');
});
