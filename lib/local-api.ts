'use client';

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
  const response = await fetch(`/api${path}`, { ...init, headers });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('Локальный сервер обработки не запущен');
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Ошибка сервера: ${response.status}`);
  return payload;
}

export function mediaUrl(path: string) {
  return new URL(path, window.location.origin).toString();
}
