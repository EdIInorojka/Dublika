'use client';

function apiOrigin() {
  // A public media worker can be injected at build time for a shared preview.
  // Keep local loopback as the safe default for developer and offline use.
  const publicOrigin = String(import.meta.env.VITE_API_ORIGIN || '').trim().replace(/\/$/, '');
  if (publicOrigin) return publicOrigin;
  const { hostname, origin } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return origin;
  return window.localStorage.getItem('dublika-local-server') || 'http://127.0.0.1:8788';
}

function deviceId() {
  let value = window.localStorage.getItem('dublika-device-id');
  if (!value) {
    value = window.crypto.randomUUID();
    window.localStorage.setItem('dublika-device-id', value);
  }
  return value;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = window.localStorage.getItem('dublika-token');
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', deviceId());
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${apiOrigin()}/api${path}`, { ...init, headers });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('Локальный сервер обработки не запущен');
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Ошибка сервера: ${response.status}`);
  return payload;
}

export function mediaUrl(path: string) {
  return new URL(path, apiOrigin()).toString();
}
