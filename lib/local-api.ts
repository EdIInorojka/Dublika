'use client';

function apiOrigin() {
  // A public media worker must be injected at build time for a shared
  // deployment.  Never silently point a visitor on another computer to their
  // own 127.0.0.1 — that was the source of the opaque "Failed to fetch".
  const publicOrigin = String(import.meta.env.VITE_API_ORIGIN || '').trim().replace(/\/$/, '');
  if (publicOrigin) return publicOrigin;
  const { hostname, origin } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return origin;
  return String(window.localStorage.getItem('dublika-local-server') || '').trim().replace(/\/$/, '');
}

function deviceId() {
  let value = window.localStorage.getItem('dublika-device-id');
  if (!value) {
    value = window.crypto.randomUUID();
    window.localStorage.setItem('dublika-device-id', value);
  }
  return value;
}

function isQaSession() {
  return new URLSearchParams(window.location.search).get('dublika-qa') === '1';
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const origin = apiOrigin();
  if (!origin) throw new Error('Сервис обработки ещё не подключён. Попробуйте обновить страницу через минуту.');
  const token = window.localStorage.getItem('dublika-token');
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', deviceId());
  // Local QA can be pointed at a fully isolated data realm without creating
  // accounts or projects in the customer database.
  if (isQaSession()) headers.set('X-Dublika-Environment', 'test');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${origin}/api${path}`, { ...init, headers });
  } catch {
    throw new Error('Не удалось связаться с сервисом обработки. Проверьте подключение и повторите попытку.');
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('Локальный сервер обработки не запущен');
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Ошибка сервера: ${response.status}`);
  return payload;
}

export function mediaUrl(path: string) {
  const origin = apiOrigin();
  if (!origin) return '';
  return new URL(path, origin).toString();
}
