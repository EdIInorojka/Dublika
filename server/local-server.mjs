import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const root = resolve(import.meta.dirname, '..');
const publicDir = join(root, 'vercel-dist');
const dataDir = join(root, '.local-data');
const uploadDir = join(dataDir, 'uploads');
const recordingDir = join(dataDir, 'recordings');
const outputDir = join(dataDir, 'outputs');
const ytDlpPath = join(root, '.local-bin', 'yt-dlp.exe');
const statePath = join(dataDir, 'state.json');
const port = Number(process.env.LOCAL_APP_PORT || 8788);
const maxVideoBytes = 1024 * 1024 * 1024;
const maxAudioBytes = 40 * 1024 * 1024;
const minSegmentSeconds = 2;
const maxSegmentSeconds = 4;
const videoExtensions = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const audioExtensions = new Set(['.webm', '.ogg', '.wav', '.m4a', '.mp3', '.mp4']);
const allowedOrigins = new Set([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  'https://dublika-studio.gusta-voglenn19586.chatgpt.site',
  ...String(process.env.DUBLIKA_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
]);

for (const directory of [dataDir, uploadDir, recordingDir, outputDir]) mkdirSync(directory, { recursive: true });

function initialState() {
  return { secret: randomBytes(32).toString('hex'), users: {}, devices: {}, projects: {} };
}

function loadState() {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { const state = initialState(); saveState(state); return state; }
}

const state = loadState();

function saveState(next = state) {
  mkdirSync(dataDir, { recursive: true });
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2));
  renameSync(temporary, statePath);
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
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id, X-File-Name');
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

function actor(request) {
  const existing = tokenUser(request);
  if (existing) return existing;
  const hash = deviceId(request);
  const knownUserId = state.devices[hash];
  if (knownUserId && state.users[knownUserId]) return state.users[knownUserId];
  const userId = `guest_${randomUUID()}`;
  const freeCredits = Object.prototype.hasOwnProperty.call(state.devices, hash) ? 0 : 3;
  state.users[userId] = { id: userId, email: null, deviceHash: hash, credits: freeCredits, plan: 'Пробный', createdAt: new Date().toISOString() };
  state.devices[hash] = userId;
  saveState();
  return state.users[userId];
}

const otpRequests = new Map();

async function handleAuth(request, response, pathname) {
  if (pathname === '/api/auth/request-code' && request.method === 'POST') {
    const { email } = await readJson(request);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return sendJson(response, 400, { error: 'Некорректная почта' });
    const code = String(randomInt(100000, 999999));
    otpRequests.set(normalizedEmail, { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, deviceHash: deviceId(request) });
    console.log(`[Дублика] Код входа для ${normalizedEmail}: ${code}`);
    return sendJson(response, 200, { ok: true, devCode: code, expiresIn: 600 });
  }
  if (pathname === '/api/auth/verify-code' && request.method === 'POST') {
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
        user = { id, email: normalizedEmail, deviceHash: record.deviceHash, credits: deviceOwnerId ? 0 : 3, plan: 'Пробный', createdAt: new Date().toISOString() };
        state.users[id] = user;
      }
    }
    state.devices[record.deviceHash] = user.id;
    saveState();
    return sendJson(response, 200, { ok: true, token: signToken(user.id), user: { email: user.email, credits: user.credits, plan: user.plan } });
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

function runProcess(executable, argumentsList, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, argumentsList, { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error('Импорт занял слишком много времени')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-120000); });
    child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-120000); });
    child.on('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(output);
      else rejectRun(new Error(output.slice(-2500) || `yt-dlp exited ${code}`));
    });
  });
}

async function sourceHasAudio(path) {
  try { await runFfmpeg(['-hide_banner', '-i', path, '-map', '0:a:0', '-t', '0.1', '-f', 'null', '-']); return true; } catch { return false; }
}

async function waveformForSegment(project, segment) {
  const cached = project.waveforms?.[segment.id];
  if (Array.isArray(cached) && cached.length === 96) return cached;
  let samples;
  try {
    samples = await runFfmpegBuffer([
      '-v', 'error', '-ss', String(segment.start), '-t', String(segment.end - segment.start),
      '-i', project.inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-',
    ], 256 * 1024);
  } catch {
    return Array.from({ length: 96 }, () => 0);
  }
  const levels = [];
  const sampleCount = Math.floor(samples.length / 2);
  for (let bucket = 0; bucket < 96; bucket += 1) {
    const from = Math.floor(bucket * sampleCount / 96);
    const to = Math.max(from + 1, Math.floor((bucket + 1) * sampleCount / 96));
    let sum = 0;
    for (let index = from; index < to && index < sampleCount; index += 1) {
      const value = samples.readInt16LE(index * 2) / 32768;
      sum += value * value;
    }
    levels.push(rounded(Math.min(1, Math.sqrt(sum / Math.max(1, to - from)) * 2.4)));
  }
  project.waveforms ??= {};
  project.waveforms[segment.id] = levels;
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
  const words = Array.isArray(payload.words) ? payload.words : [];
  const wordUnits = words.map((word) => ({
    start: clipStart + Number(word.start),
    end: clipStart + Number(word.end),
    text: String(word.word || '').trim(),
  })).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start && word.end > clipStart && word.start < clipEnd && word.text);
  if (wordUnits.length) return wordUnits;
  return (Array.isArray(payload.segments) ? payload.segments : []).map((segment) => ({
    start: clipStart + Number(segment.start),
    end: clipStart + Number(segment.end),
    text: String(segment.text || '').trim(),
  })).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text);
}

/**
 * Build one script cue per natural phrase. A word end, sentence punctuation or
 * natural pause can be a boundary, but every recordable window is 2–4 seconds.
 */
function phraseSegments(units, clipStart, clipEnd) {
  const inClip = units.map((unit) => ({
    ...unit,
    start: Math.max(clipStart, unit.start),
    end: Math.min(clipEnd, unit.end),
  })).filter((unit) => unit.end > unit.start);
  if (!inClip.length) return [];
  const groups = [];
  let group = [];
  const commit = () => {
    if (!group.length) return;
    groups.push(group);
    group = [];
  };
  for (const unit of inClip) {
    if (!group.length) {
      group.push(unit);
      continue;
    }
    const groupStart = group[0].start;
    const candidateDuration = unit.end - groupStart;
    const groupDuration = group[group.length - 1].end - groupStart;
    const gap = unit.start - group[group.length - 1].end;
    const shouldCut = groupDuration >= minSegmentSeconds && (
      candidateDuration > maxSegmentSeconds + 0.12 ||
      (hasPhraseEnd(group[group.length - 1].text) && groupDuration >= 2.25) ||
      (gap >= 0.35 && groupDuration >= 2.15)
    );
    if (shouldCut) commit();
    group.push(unit);
  }
  commit();

  // A trailing short phrase is still useful text. Merge it only when doing so
  // keeps a take under four seconds; otherwise give it a two-second cue window.
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const lastDuration = last[last.length - 1].end - last[0].start;
    const previous = groups[groups.length - 2];
    if (lastDuration < minSegmentSeconds && last[last.length - 1].end - previous[0].start <= maxSegmentSeconds + 0.12) {
      previous.push(...last);
      groups.pop();
    }
  }

  return groups.slice(0, 80).map((group) => {
    const phraseStart = group[0].start;
    const phraseEnd = group[group.length - 1].end;
    // A little lead-in/out makes the cue pleasant to perform while preventing
    // sub-two-second recording windows. It does not change the source text.
    const cueStart = Math.max(clipStart, phraseStart - 0.12);
    const cueEnd = Math.min(clipEnd, Math.max(phraseEnd + 0.18, cueStart + minSegmentSeconds));
    return {
      start: rounded(cueStart),
      end: rounded(Math.min(cueStart + maxSegmentSeconds, cueEnd)),
      text: group.map((unit) => unit.text).join(' ').replace(/\s+([,.!?…;:])/g, '$1').trim(),
    };
  }).filter((segment) => segment.end - segment.start >= minSegmentSeconds - 0.02);
}

function srtTime(value) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
}

function writeSubtitles(project) {
  const subtitlePath = join(dataDir, `${project.id}.srt`);
  const contents = project.segments.map((segment, index) => {
    const start = segment.start - project.trim.start;
    const end = segment.end - project.trim.start;
    const text = String(segment.text || '').replace(/[\r\n]+/g, ' ').trim();
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`;
  }).join('\n');
  writeFileSync(subtitlePath, contents, 'utf8');
  return subtitlePath;
}

async function transcribeWithOpenAI(inputPath, start, end) {
  if (!process.env.OPENAI_API_KEY) return null;
  // 32 kbps mono MP3 keeps a four-minute clip below the transcription API's
  // upload limit. The previous WAV export could exceed that limit before the
  // request even started.
  const audioPath = join(dataDir, `transcribe-${randomUUID()}.mp3`);
  await runFfmpeg(['-y', '-ss', String(start), '-t', String(end - start), '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', audioPath]);
  try {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(audioPath)], { type: 'audio/mpeg' }), 'clip.mp3');
    form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
    const result = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
    if (!result.ok) {
      const details = (await result.text()).slice(0, 400);
      throw new Error(`Не удалось распознать речь (${result.status})${details ? `: ${details}` : ''}`);
    }
    const payload = await result.json();
    return phraseSegments(transcriptUnits(payload, start, end), start, end);
  } finally {
    try { unlinkSync(audioPath); } catch { /* best-effort cleanup */ }
  }
}

function projectFor(request, id) {
  const user = actor(request);
  const project = state.projects[id];
  return project && project.userId === user.id ? { user, project } : null;
}

async function analyzeProject(project, body) {
  const start = Math.max(0, Number(body.start) || 0);
  const end = Math.min(start + 240, Number(body.end) || start + 30);
  if (!(end - start >= minSegmentSeconds)) throw new Error('Выберите отрывок не короче 2 секунд');
  project.trim = { start, end };
  let segments = await transcribeWithOpenAI(project.inputPath, start, end);
  let transcriptionMode = 'transcribed';
  if (!segments?.length) {
    transcriptionMode = 'manual';
    let log = '';
    try { log = await runFfmpeg(['-hide_banner', '-ss', String(start), '-t', String(end - start), '-i', project.inputPath, '-vn', '-af', 'silencedetect=noise=-32dB:d=0.32', '-f', 'null', '-']); } catch (error) { log = String(error.message || ''); }
    segments = manualSegments(start, end, log);
  }
  project.segments = segments.map((item, index) => ({ id: index + 1, start: rounded(item.start), end: rounded(item.end), text: String(item.text || ''), state: 'pending' }));
  project.transcriptionMode = transcriptionMode;
  project.waveforms = {};
  project.status = 'ready';
  project.updatedAt = new Date().toISOString();
  saveState();
  return { segments: project.segments, transcriptionMode };
}

async function renderProject(user, project, burnSubtitles = true) {
  if (user.credits <= 0 && user.plan === 'Пробный') throw new Error('Бесплатные обработки закончились');
  const recorded = project.segments.filter((segment) => project.recordings?.[segment.id]);
  if (!recorded.length) throw new Error('Запишите хотя бы одну реплику');
  const duration = project.trim.end - project.trim.start;
  const outputPath = join(outputDir, `${project.id}.mp4`);
  const args = ['-y', '-ss', String(project.trim.start), '-t', String(duration), '-i', project.inputPath];
  recorded.forEach((segment) => args.push('-i', project.recordings[segment.id].path));
  const filters = [];
  recorded.forEach((segment, index) => {
    const delay = Math.max(0, Math.round((segment.start - project.trim.start) * 1000));
    const takeDuration = Math.max(.25, segment.end - segment.start);
    filters.push(`[${index + 1}:a]highpass=f=80,lowpass=f=12000,afftdn=nf=-24,dynaudnorm=f=150:g=13,loudnorm=I=-16:TP=-1.5:LRA=9,atrim=0:${takeDuration.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delay}:all=1[t${index}]`);
  });
  const takeLabels = recorded.map((_, index) => `[t${index}]`).join('');
  filters.push(`${takeLabels}amix=inputs=${recorded.length}:normalize=0,alimiter=limit=.9[voice]`);
  if (await sourceHasAudio(project.inputPath)) {
    filters.push(`[0:a]asetpts=PTS-STARTPTS[original]`);
    filters.push('[voice]asplit=2[voice_sc][voice_mix]');
    filters.push('[original][voice_sc]sidechaincompress=threshold=.018:ratio=12:attack=8:release=300[ducked]');
    filters.push("[ducked][voice_mix]amix=inputs=2:normalize=0:weights='0.9 1.15',alimiter=limit=.95[aout]");
  } else {
    filters.push('[voice]anull[aout]');
  }
  args.push('-filter_complex', filters.join(';'));
  if (burnSubtitles) {
    const subtitlePath = writeSubtitles(project).replace(/\\/g, '/').replace(':', '\\:').replace(/'/g, "\\'");
    args.push('-vf', `subtitles=filename='${subtitlePath}':force_style='FontName=Arial,FontSize=19,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=34,Alignment=2'`);
  }
  args.push('-map', '0:v:0', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', '-progress', 'pipe:2', '-nostats', outputPath);
  project.status = 'processing';
  project.progress = 1;
  project.error = null;
  saveState();
  await runFfmpeg(args, (chunk) => {
    const match = String(chunk).match(/out_time_ms=(\d+)/);
    if (match) project.progress = Math.min(99, Math.round((Number(match[1]) / 1_000_000) / duration * 100));
  });
  project.status = 'done';
  project.progress = 100;
  project.outputPath = outputPath;
  project.outputUrl = `/media/outputs/${project.id}.mp4`;
  project.updatedAt = new Date().toISOString();
  if (user.plan === 'Пробный') user.credits = Math.max(0, user.credits - 1);
  saveState();
}

async function validateRemoteUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Разрешены только HTTP/HTTPS ссылки');
  const result = await lookup(url.hostname, { all: true });
  const blocked = result.some(({ address }) => address === '::1' || address.startsWith('127.') || address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || address.startsWith('169.254.'));
  if (blocked) throw new Error('Локальные сетевые адреса запрещены');
  return url;
}

async function downloadRemote(value, destination) {
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
  try {
    await pipeline(Readable.fromWeb(result.body.pipeThrough(limiter)), createWriteStream(destination, { flags: 'wx' }));
  } catch (error) {
    try { unlinkSync(destination); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return size;
}

async function downloadPlatformVideo(value, destination) {
  if (!existsSync(ytDlpPath)) throw new Error('Модуль импорта YouTube/VK не установлен. Выполните npm run setup:media');
  const url = await validateRemoteUrl(value);
  const ffmpegDirectory = resolve(ffmpegPath, '..');
  await runProcess(ytDlpPath, ['--no-playlist', '--no-warnings', '--max-filesize', '1G', '--format', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpegDirectory, '--output', destination, url.toString()]);
  if (!existsSync(destination)) throw new Error('Видео не было сохранено');
  return statSync(destination).size;
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (pathname === '/api/health') return sendJson(response, 200, {
    ok: true,
    ffmpeg: Boolean(ffmpegPath && existsSync(ffmpegPath)),
    ytDlp: existsSync(ytDlpPath),
    transcription: Boolean(process.env.OPENAI_API_KEY),
    local: true,
  });
  const authHandled = await handleAuth(request, response, pathname);
  if (authHandled !== false) return authHandled;

  if (pathname === '/api/projects/upload' && request.method === 'POST') {
    const user = actor(request);
    let headerName = request.headers['x-file-name'];
    try { headerName = decodeURIComponent(String(headerName || '')); } catch { /* use the raw header */ }
    const originalName = safeName(headerName, 'video.mp4');
    const extension = extname(originalName).toLowerCase();
    if (!videoExtensions.has(extension)) return sendJson(response, 415, { error: 'Поддерживаются MP4, MOV, WebM, MKV и M4V' });
    const id = randomUUID();
    const inputPath = join(uploadDir, `${id}${extension}`);
    const size = await saveBody(request, inputPath, maxVideoBytes);
    state.projects[id] = { id, userId: user.id, title: originalName, inputPath, size, status: 'uploaded', progress: 0, trim: null, segments: [], recordings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveState();
    return sendJson(response, 201, { project: { id, title: originalName, status: 'uploaded', inputUrl: `/media/projects/${id}/source` }, credits: user.credits });
  }

  if (pathname === '/api/projects/import' && request.method === 'POST') {
    const user = actor(request);
    const body = await readJson(request);
    const source = new URL(String(body.url || ''));
    const extension = videoExtensions.has(extname(source.pathname).toLowerCase()) ? extname(source.pathname).toLowerCase() : '.mp4';
    const id = randomUUID();
    const inputPath = join(uploadDir, `${id}${extension}`);
    const platformHost = /(^|\.)(youtube\.com|youtu\.be|vk\.com|vkvideo\.ru)$/i.test(source.hostname);
    const size = platformHost ? await downloadPlatformVideo(source.toString(), inputPath) : await downloadRemote(source.toString(), inputPath);
    const title = safeName(body.title || source.pathname.split('/').pop(), 'Видео по ссылке');
    state.projects[id] = { id, userId: user.id, title, inputPath, size, sourceUrl: source.toString(), status: 'uploaded', progress: 0, trim: null, segments: [], recordings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveState();
    return sendJson(response, 201, { project: { id, title, status: 'uploaded', inputUrl: `/media/projects/${id}/source` }, credits: user.credits });
  }

  if (pathname === '/api/projects' && request.method === 'GET') {
    const user = actor(request);
    const projects = Object.values(state.projects).filter((project) => project.userId === user.id).map(({ inputPath: _input, outputPath: _output, recordings: _recordings, ...project }) => project);
    return sendJson(response, 200, { projects, credits: user.credits, plan: user.plan });
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)(?:\/(analyze|render|status)|\/segments\/([0-9]+)(\/waveform)?)?$/i);
  if (!projectMatch) return sendJson(response, 404, { error: 'Маршрут не найден' });
  const access = projectFor(request, projectMatch[1]);
  if (!access) return sendJson(response, 404, { error: 'Проект не найден' });
  const { user, project } = access;
  const action = projectMatch[2];
  const segmentId = Number(projectMatch[3]);
  const wantsWaveform = Boolean(projectMatch[4]);

  if (!action && !Number.isFinite(segmentId) && request.method === 'GET') return sendJson(response, 200, { project: { ...project, inputPath: undefined, outputPath: undefined }, credits: user.credits });
  if (action === 'analyze' && request.method === 'POST') return sendJson(response, 200, await analyzeProject(project, await readJson(request)));
  if (wantsWaveform && request.method === 'GET') {
    const segment = project.segments.find((item) => item.id === segmentId);
    if (!segment) return sendJson(response, 404, { error: 'Реплика не найдена' });
    return sendJson(response, 200, { levels: await waveformForSegment(project, segment) });
  }
  if (Number.isFinite(segmentId) && request.method === 'POST') {
    if (!project.segments.some((segment) => segment.id === segmentId)) return sendJson(response, 404, { error: 'Реплика не найдена' });
    const type = String(request.headers['content-type'] || 'audio/webm').split(';')[0];
    const extension = type.includes('ogg') ? '.ogg' : type.includes('wav') ? '.wav' : type.includes('mp4') ? '.m4a' : '.webm';
    if (!audioExtensions.has(extension)) return sendJson(response, 415, { error: 'Неподдерживаемый аудиоформат' });
    const takePath = join(recordingDir, `${project.id}-${segmentId}-${Date.now()}${extension}`);
    const size = await saveBody(request, takePath, maxAudioBytes);
    project.recordings[segmentId] = { path: takePath, size, type, createdAt: new Date().toISOString() };
    const segment = project.segments.find((item) => item.id === segmentId);
    segment.state = 'ready';
    project.updatedAt = new Date().toISOString();
    saveState();
    return sendJson(response, 201, { ok: true, segmentId, takeUrl: `/media/projects/${project.id}/takes/${segmentId}` });
  }
  if (action === 'render' && request.method === 'POST') {
    if (project.status === 'processing') return sendJson(response, 409, { error: 'Рендер уже выполняется' });
    const body = await readJson(request);
    if (Array.isArray(body.segments)) {
      for (const incoming of body.segments) {
        const segment = project.segments.find((item) => item.id === Number(incoming.id));
        if (segment) segment.text = String(incoming.text || segment.text).slice(0, 500);
      }
    }
    renderProject(user, project, body.burnSubtitles !== false).catch((error) => { project.status = 'failed'; project.error = String(error.message || error).slice(-1000); saveState(); });
    return sendJson(response, 202, { ok: true, status: 'processing' });
  }
  if (action === 'status' && request.method === 'GET') return sendJson(response, 200, { status: project.status, progress: project.progress || 0, error: project.error || null, outputUrl: project.outputUrl || null, credits: user.credits });
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

const server = createServer(async (request, response) => {
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
      return existsSync(path) ? sendFile(request, response, path) : sendJson(response, 404, { error: 'Файл не найден' });
    }
    const projectSource = url.pathname.match(/^\/media\/projects\/([a-f0-9-]+)\/source$/i);
    if (projectSource) {
      const project = state.projects[projectSource[1]];
      return project?.inputPath && existsSync(project.inputPath) ? sendFile(request, response, project.inputPath) : sendJson(response, 404, { error: 'Файл не найден' });
    }
    const projectTake = url.pathname.match(/^\/media\/projects\/([a-f0-9-]+)\/takes\/([0-9]+)$/i);
    if (projectTake) {
      const project = state.projects[projectTake[1]];
      const take = project?.recordings?.[Number(projectTake[2])];
      return take?.path && existsSync(take.path) ? sendFile(request, response, take.path) : sendJson(response, 404, { error: 'Запись не найдена' });
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    let path = join(publicDir, relative || 'index.html');
    if (!path.startsWith(publicDir) || !existsSync(path) || statSync(path).isDirectory()) path = join(publicDir, 'index.html');
    return sendFile(request, response, path);
  } catch (error) {
    console.error(error);
    return sendJson(response, error.message === 'payload_too_large' ? 413 : 500, { error: String(error.message || 'Ошибка сервера') });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\nДублика запущена: http://localhost:${port}`);
  console.log(`FFmpeg: ${ffmpegPath}`);
  console.log('Исходники и результаты хранятся только в .local-data на этом компьютере.\n');
});
