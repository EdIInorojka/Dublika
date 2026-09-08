'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  Captions,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Clock3,
  Download,
  FileVideo,
  Headphones,
  ListVideo,
  Link2,
  LockKeyhole,
  Mic,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Sparkles,
  SkipForward,
  Sun,
  Moon,
  TimerReset,
  UploadCloud,
  UserRound,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-react';

import { AppSidebar, ProductPages, type Navigate } from '@/components/product-pages';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiFetch, mediaUrl } from '@/lib/local-api';

type SourceKind = 'file' | 'link' | 'demo';
type SegmentState = 'ready' | 'pending' | 'original';
type PlaybackState = { kind: 'original' | 'take'; segmentId: number } | null;
type RecordingSession = {
  segmentId: number;
  stopReason: 'manual' | 'limit';
  leadIn: number;
  tailOut: number;
  duration: number;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type Segment = {
  id: number;
  start: number;
  end: number;
  text: string;
  state: SegmentState;
  clipId?: string;
  outputStart?: number;
  outputEnd?: number;
  audioUrl?: string;
};

type Clip = {
  id: string;
  start: number;
  end: number;
};

// Used only before the local media service has returned an actual waveform.
const fallbackWaveform = [18, 28, 34, 22, 48, 62, 38, 74, 54, 82, 44, 68, 30, 58, 72, 42, 88, 64, 46, 76, 34, 56, 84, 52, 70, 38, 60, 78, 48, 66, 26, 52, 72, 40, 58, 80, 46, 68, 36, 54, 74, 44, 62, 28, 50, 70, 38, 56];
const demoVideo = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const recordingLeadSeconds = 1;
const recordingTailSeconds = 1;
const maxSelectedSeconds = 240;
const maxSelectedClips = 6;

function formatTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const tenth = Math.floor((value % 1) * 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenth}`;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLButtonElement>(null);
  const timelineDragRef = useRef<'start' | 'end' | null>(null);
  const openedProjectRef = useRef<string | null>(null);
  const segmentVideoRef = useRef<HTMLVideoElement>(null);
  const liveWaveRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const recordingSessionRef = useRef<RecordingSession | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const takeAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackStopTimeoutRef = useRef<number | null>(null);
  const previewStartTimeoutRef = useRef<number | null>(null);
  const recordLimitTimeoutRef = useRef<number | null>(null);
  const recordTickRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef('');
  const recordStartedAtRef = useRef(0);
  const latestLevelsRef = useRef<number[]>(Array.from({ length: 96 }, () => 0));

  const [route, setRoute] = useState(() => typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}${window.location.hash}`);
  const [darkMode, setDarkMode] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem('dublika-theme') === 'dark');
  const [sourceTab, setSourceTab] = useState<SourceKind>('file');
  const [sourceReady, setSourceReady] = useState(false);
  const [sourceName, setSourceName] = useState('Новый ролик');
  const [sourceUrl, setSourceUrl] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(192);
  const [trim, setTrim] = useState<number[]>([36, 69]);
  const [clips, setClips] = useState<Clip[]>([{ id: 'clip-1', start: 36, end: 69 }]);
  const [activeClipId, setActiveClipId] = useState('clip-1');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzed, setAnalyzed] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [activeSegment, setActiveSegment] = useState(1);
  const [recording, setRecording] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [assembly, setAssembly] = useState<'idle' | 'processing' | 'done'>('idle');
  const [assemblyProgress, setAssemblyProgress] = useState(0);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem('dublika-auth') === '1');
  const [plan] = useState('Пробный');
  const [countdownEnabled, setCountdownEnabled] = useState(true);
  const [originalMonitor, setOriginalMonitor] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [transcriptionState, setTranscriptionState] = useState<'idle' | 'listening' | 'unsupported' | 'error'>('idle');
  const [playback, setPlayback] = useState<PlaybackState>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [resultUrl, setResultUrl] = useState('');
  const [credits, setCredits] = useState(() => Number(typeof window !== 'undefined' ? window.localStorage.getItem('dublika-credits') || 3 : 3));
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [transcriptionMode, setTranscriptionMode] = useState<'transcribed' | 'manual' | null>(null);
  const [originalLevels, setOriginalLevels] = useState<number[]>(Array.from({ length: 96 }, () => 0));
  const [editorLevels, setEditorLevels] = useState<number[]>([]);
  const [editorPlayhead, setEditorPlayhead] = useState(0);
  const [timelineDragging, setTimelineDragging] = useState(false);

  const clipLength = Math.max(1, clips.reduce((total, clip) => total + Math.max(0, clip.end - clip.start), 0));
  const finishedSegments = segments.filter((item) => item.state !== 'pending').length;
  const pendingSegments = segments.filter((item) => item.state === 'pending').length;
  const allSegmentsFinished = analyzed && segments.length > 0 && pendingSegments === 0;
  const currentStep = assembly === 'done' ? 5 : analyzed ? 3 : sourceReady ? 2 : 1;

  const timelineBlocks = useMemo(
    () => Array.from({ length: 12 }, (_, index) => ({ id: index, hue: 194 + (index % 4) * 8, lightness: 21 + (index % 3) * 5 })),
    [],
  );
  const editorWaveform = projectId && editorLevels.length === 96 ? editorLevels.map((level) => Math.max(10, level * 100)) : fallbackWaveform;
  const playheadPosition = Math.min(100, Math.max(0, editorPlayhead / Math.max(duration, 1) * 100));

  function recordingWindow(segment: Segment) {
    const phraseDuration = Math.max(0.35, segment.end - segment.start);
    // The recorded take always has a one-second count-in and tail. At the
    // very beginning of a clip the video simply starts at 0 while the take's
    // count-in is trimmed during final mixing, so the spoken line stays synced.
    const leadIn = recordingLeadSeconds;
    const tailOut = recordingTailSeconds;
    const sourceClip = clips.find((clip) => clip.id === segment.clipId)
      ?? clips.find((clip) => segment.start >= clip.start - .01 && segment.end <= clip.end + .01)
      ?? { start: trim[0], end: trim[1] };
    return {
      leadIn,
      tailOut,
      phraseDuration,
      duration: phraseDuration + leadIn + tailOut,
      start: Math.max(sourceClip.start, segment.start - leadIn),
      end: Math.min(sourceClip.end, segment.end + tailOut),
    };
  }

  useEffect(() => {
    return () => { if (videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl); };
  }, [videoUrl]);

  useEffect(() => {
    const syncRoute = () => setRoute(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    window.localStorage.setItem('dublika-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => () => {
    if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current);
    if (playbackStopTimeoutRef.current) window.clearTimeout(playbackStopTimeoutRef.current);
    if (recordLimitTimeoutRef.current) window.clearTimeout(recordLimitTimeoutRef.current);
    if (recordTickRef.current) window.clearInterval(recordTickRef.current);
    takeAudioRef.current?.pause();
    try { recognitionRef.current?.stop(); } catch { /* recognition may already be stopped */ }
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
  }, []);

  useEffect(() => {
    apiFetch<{ ok: boolean }>('/health').then(() => setBackendOnline(true)).catch(() => setBackendOnline(false));
  }, []);

  useEffect(() => {
    const query = route.includes('?') ? route.slice(route.indexOf('?') + 1).split('#')[0] : '';
    const requestedId = new URLSearchParams(query).get('project');
    if (!requestedId || requestedId === openedProjectRef.current) return;
    let cancelled = false;
    openedProjectRef.current = requestedId;
    type StoredProject = {
      id: string;
      title: string;
      inputUrl: string;
      outputUrl?: string | null;
      status: string;
      trim?: { start: number; end: number } | null;
      clips?: Clip[];
      segments: Segment[];
      transcriptionMode?: 'transcribed' | 'manual';
    };
    void apiFetch<{ project: StoredProject; credits: number }>(`/projects/${requestedId}`)
      .then(({ project, credits: nextCredits }) => {
        if (cancelled) return;
        const savedClips = Array.isArray(project.clips) && project.clips.length
          ? project.clips
          : project.trim ? [{ id: 'clip-1', start: project.trim.start, end: project.trim.end }] : [];
        if (!savedClips.length) throw new Error('В проекте ещё нет выбранных фрагментов');
        const firstClip = savedClips[0];
        setProjectId(project.id);
        setSourceName(project.title);
        setVideoUrl(mediaUrl(project.inputUrl));
        setSourceReady(true);
        setClips(savedClips);
        setActiveClipId(firstClip.id);
        setTrim([firstClip.start, firstClip.end]);
        setSegments(project.segments.map((segment) => segment.audioUrl ? { ...segment, audioUrl: mediaUrl(segment.audioUrl) } : segment));
        setActiveSegment(project.segments[0]?.id || 1);
        setTranscriptionMode(project.transcriptionMode || (project.segments.some((segment) => segment.text) ? 'transcribed' : null));
        setAnalyzed(project.segments.length > 0);
        setAssembly(project.status === 'done' && project.outputUrl ? 'done' : 'idle');
        setResultUrl(project.outputUrl ? mediaUrl(project.outputUrl) : '');
        setCredits(nextCredits);
        setEditorLevels([]);
        setBackendOnline(true);
        setMessage(`Открыт проект «${project.title}». Можно продолжить с любой реплики.`);
      })
      .catch((cause) => {
        if (!cancelled) {
          openedProjectRef.current = null;
          setMessage(cause instanceof Error ? cause.message : 'Не удалось открыть проект');
        }
      });
    return () => { cancelled = true; };
  }, [route]);

  useEffect(() => {
    if (!projectId || !analyzed || !activeSegment) return;
    let cancelled = false;
    void apiFetch<{ levels: number[] }>(`/projects/${projectId}/segments/${activeSegment}/waveform`)
      .then((result) => { if (!cancelled) setOriginalLevels(result.levels.length === 96 ? result.levels : Array.from({ length: 96 }, () => 0)); })
      .catch(() => { if (!cancelled) setOriginalLevels(Array.from({ length: 96 }, () => 0)); });
    return () => { cancelled = true; };
  }, [activeSegment, analyzed, projectId]);

  useEffect(() => {
    if (!projectId || !sourceReady || timelineDragging) return;
    let cancelled = false;
    // Dragging a trim handle can produce many values per second. Waiting a
    // moment keeps the editor responsive and asks ffmpeg only after the
    // person has released a boundary, rather than on every pointer move.
    const timer = window.setTimeout(() => {
      const start = Math.max(0, trim[0]).toFixed(2);
      const end = Math.max(trim[0] + 0.35, trim[1]).toFixed(2);
      void apiFetch<{ levels: number[] }>(`/projects/${projectId}/waveform?start=${start}&end=${end}`)
        .then((result) => {
          if (!cancelled) setEditorLevels(result.levels.length === 96 ? result.levels : []);
        })
        .catch(() => { if (!cancelled) setEditorLevels([]); });
    }, 360);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [projectId, sourceReady, timelineDragging, trim[0], trim[1]]);

  const navigate: Navigate = (path) => {
    window.history.pushState({}, '', path);
    setRoute(path);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const hash = path.split('#')[1];
    if (hash) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 60);
  };

  function handleSignedIn(email: string) {
    window.localStorage.setItem('dublika-auth', '1');
    window.localStorage.setItem('dublika-user', email);
    setSignedIn(true);
    setMessage('Профиль создан. Вам доступны 3 бесплатных видео.');
  }

  async function createRemoteProject(url: string, title: string) {
    setUploading(true);
    try {
      const result = await apiFetch<{ project: { id: string; inputUrl: string }; credits: number }>('/projects/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, title }) });
      setProjectId(result.project.id);
      setEditorLevels([]);
      setVideoUrl(mediaUrl(result.project.inputUrl));
      setCredits(result.credits);
      window.localStorage.setItem('dublika-credits', String(result.credits));
      setBackendOnline(true);
      return result.project.id;
    } catch (cause) {
      setBackendOnline(false);
      setMessage(cause instanceof Error ? cause.message : 'Не удалось импортировать видео');
      return null;
    } finally { setUploading(false); }
  }

  async function loadDemo() {
    setSourceTab('demo');
    setSourceReady(true);
    setSourceName('Цветы крупным планом.mp4');
    setVideoUrl(demoVideo);
    setDuration(5.05);
    setSingleClip(0, 5.05);
    setAnalyzed(false);
    setSegments([]);
    setTranscriptionMode(null);
    setMessage('Демо открыто. Подключаем его к локальному рендеру…');
    const id = await createRemoteProject(demoVideo, 'Цветы крупным планом.mp4');
    if (id) {
      try {
        const result = await apiFetch<{ segments: Segment[]; transcriptionMode: 'transcribed' | 'manual'; transcriptionReason?: 'no_speech' | 'unavailable' | null }>(`/projects/${id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: 0, end: 5.05 }) });
        setSegments(result.segments);
        setTranscriptionMode(result.transcriptionMode);
        setAnalyzed(true);
        setActiveSegment(1);
        setMessage(result.transcriptionMode === 'transcribed' ? 'Демо-проект готов: текст получен из речи.' : result.transcriptionReason === 'no_speech' ? 'В аудио демо не нашлось распознаваемой речи. Введите сценарий в таймированные реплики.' : 'Демо не содержит распознанного текста. Введите свой сценарий в таймированные реплики.');
        return;
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : 'Не удалось подготовить демо');
      }
    }
    setSegments([]);
    setAnalyzed(false);
    setMessage('Демо не удалось подготовить: локальный сервер обработки недоступен.');
  }

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'load_demo_project',
      title: 'Открыть демо-проект',
      description: 'Загружает демонстрационный ролик в студию дубляжа.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input: unknown) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0) {
          throw new Error('load_demo_project does not accept parameters');
        }
        await loadDemo();
        return { status: 'ready', project: 'Цветы крупным планом' };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  async function uploadSource(file: File) {
    setUploading(true);
    try {
      const result = await apiFetch<{ project: { id: string; inputUrl: string }; credits: number }>('/projects/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      setProjectId(result.project.id);
      setEditorLevels([]);
      setVideoUrl(mediaUrl(result.project.inputUrl));
      setCredits(result.credits);
      window.localStorage.setItem('dublika-credits', String(result.credits));
      setBackendOnline(true);
      setMessage('Видео сохранено на этом компьютере. Выберите нужный отрывок.');
    } catch (cause) {
      setBackendOnline(false);
      setMessage(cause instanceof Error ? cause.message : 'Не удалось загрузить видео');
    } finally { setUploading(false); }
  }

  function onFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setMessage('Нужен видеофайл: MP4, MOV или WebM.');
      return;
    }
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setSourceName(file.name);
    setSourceReady(true);
    setAnalyzed(false);
    setSegments([]);
    setTranscriptionMode(null);
    setAssembly('idle');
    setResultUrl('');
    setMessage('Загружаем видео в локальный медиасервер…');
    void uploadSource(file);
  }

  async function importLink() {
    const value = sourceUrl.trim();
    if (!/^https?:\/\//i.test(value)) {
      setMessage('Вставьте полную ссылку, которая начинается с http:// или https://');
      return;
    }
    const isDirect = /\.(mp4|webm|mov)(\?.*)?$/i.test(value);
    setVideoUrl(isDirect ? value : '');
    setSourceName(value.includes('youtu') ? 'Видео с YouTube' : value.includes('vk') ? 'Видео из VK' : 'Видео по ссылке');
    setSourceReady(true);
    setAnalyzed(false);
    setSegments([]);
    setTranscriptionMode(null);
    setMessage(isDirect ? 'Скачиваем прямую ссылку на локальный сервер…' : 'YouTube и VK могут потребовать прямой адрес видео. Пробуем импорт…');
    const id = await createRemoteProject(value, value.includes('youtu') ? 'Видео с YouTube' : value.includes('vk') ? 'Видео из VK' : 'Видео по ссылке');
    if (id) setMessage('Видео импортировано и сохранено локально.');
  }

  function handleMetadata() {
    const nextDuration = videoRef.current?.duration;
    if (!nextDuration || !Number.isFinite(nextDuration)) return;
    setDuration(nextDuration);
    if (openedProjectRef.current !== projectId) setSingleClip(0, Math.min(nextDuration, 60));
    setEditorPlayhead(0);
  }

  function setSingleClip(start: number, end: number) {
    const nextStart = Math.max(0, Math.min(start, Math.max(0, end - 2)));
    const nextEnd = Math.max(nextStart + Math.min(2, Math.max(0, end - nextStart)), end);
    const clip: Clip = { id: 'clip-1', start: Math.round(nextStart * 10) / 10, end: Math.round(nextEnd * 10) / 10 };
    setClips([clip]);
    setActiveClipId(clip.id);
    setTrim([clip.start, clip.end]);
  }

  function invalidatePreparedCues() {
    if (!analyzed && !segments.length && assembly === 'idle') return;
    setAnalyzed(false);
    setSegments([]);
    setTranscriptionMode(null);
    setAssembly('idle');
    setResultUrl('');
  }

  function handleTrim(next: number | readonly number[], invalidate = true) {
    const values = Array.isArray(next) ? [...next] : [0, Number(next)];
    const [firstValue = 0, secondValue = Math.min(duration, 60)] = values;
    let start = Math.min(firstValue, secondValue);
    let end = Math.max(firstValue, secondValue);
    const sorted = [...clips].sort((left, right) => left.start - right.start);
    const activeIndex = sorted.findIndex((clip) => clip.id === activeClipId);
    const before = activeIndex > 0 ? sorted[activeIndex - 1].end : 0;
    const after = activeIndex >= 0 && activeIndex < sorted.length - 1 ? sorted[activeIndex + 1].start : duration;
    const usedByOtherClips = sorted.filter((clip) => clip.id !== activeClipId).reduce((total, clip) => total + clip.end - clip.start, 0);
    const allowedLength = Math.max(2, Math.min(maxSelectedSeconds - usedByOtherClips, after - before));
    start = Math.max(before, Math.min(after, Number.isFinite(start) ? start : before));
    end = Math.max(before, Math.min(after, Number.isFinite(end) ? end : Math.min(after, before + 2)));
    if (end - start > allowedLength) end = start + allowedLength;
    if (end - start < 2 && after - before >= 2) {
      end = Math.min(after, start + 2);
      start = Math.max(before, end - 2);
    }
    const nextTrim: [number, number] = [Math.round(start * 10) / 10, Math.round(end * 10) / 10];
    setTrim(nextTrim);
    setClips((items) => items.map((clip) => clip.id === activeClipId ? { ...clip, start: nextTrim[0], end: nextTrim[1] } : clip).sort((left, right) => left.start - right.start));
    if (invalidate) invalidatePreparedCues();
  }

  function setTrimBoundary(boundary: 'start' | 'end', value: number) {
    if (!Number.isFinite(value)) return;
    handleTrim(boundary === 'start' ? [value, trim[1]] : [trim[0], value]);
  }

  function seekEditor(time: number, shouldPlay = false) {
    const nextTime = Math.max(0, Math.min(duration, time));
    const preview = videoRef.current;
    setEditorPlayhead(nextTime);
    if (!preview) return;
    preview.currentTime = nextTime;
    if (shouldPlay) {
      void preview.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  }

  function selectClip(id: string, shouldSeek = true) {
    const selected = clips.find((clip) => clip.id === id);
    if (!selected) return;
    setActiveClipId(id);
    setTrim([selected.start, selected.end]);
    if (shouldSeek) seekEditor(selected.start);
  }

  function timelineTime(event: React.PointerEvent<HTMLButtonElement>) {
    const bounds = timelineRef.current?.getBoundingClientRect();
    if (!bounds) return 0;
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    return ratio * duration;
  }

  function handleTimelinePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (!sourceReady || !timelineRef.current) return;
    const time = timelineTime(event);
    const selectedAtPoint = clips.find((clip) => time >= clip.start && time <= clip.end);
    if (selectedAtPoint && selectedAtPoint.id !== activeClipId) {
      selectClip(selectedAtPoint.id, false);
      seekEditor(time);
      return;
    }
    const bounds = timelineRef.current.getBoundingClientRect();
    const grabDistance = Math.max(.7, duration / Math.max(1, bounds.width) * 14);
    if (Math.abs(time - trim[0]) <= grabDistance) timelineDragRef.current = 'start';
    else if (Math.abs(time - trim[1]) <= grabDistance) timelineDragRef.current = 'end';
    if (timelineDragRef.current) {
      event.preventDefault();
      setTimelineDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    seekEditor(time);
  }

  function handleTimelinePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const edge = timelineDragRef.current;
    if (!edge) return;
    event.preventDefault();
    handleTrim(edge === 'start' ? [timelineTime(event), trim[1]] : [trim[0], timelineTime(event)], false);
  }

  function handleTimelinePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    if (!timelineDragRef.current) return;
    timelineDragRef.current = null;
    setTimelineDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    invalidatePreparedCues();
  }

  function addClip() {
    const selectedSeconds = clips.reduce((total, clip) => total + clip.end - clip.start, 0);
    const remainingSeconds = maxSelectedSeconds - selectedSeconds;
    if (clips.length >= maxSelectedClips) { setMessage(`Можно выбрать до ${maxSelectedClips} фрагментов в одном ролике.`); return; }
    if (remainingSeconds < 2) { setMessage('Достигнут общий лимит — до 4 минут выбранных фрагментов.'); return; }
    const sorted = [...clips].sort((left, right) => left.start - right.start);
    const gaps = [
      { start: 0, end: sorted[0]?.start ?? duration },
      ...sorted.slice(0, -1).map((clip, index) => ({ start: clip.end, end: sorted[index + 1].start })),
      { start: sorted.at(-1)?.end ?? 0, end: duration },
    ].filter((gap) => gap.end - gap.start >= 2);
    if (!gaps.length) { setMessage('В этом видео не осталось места для отдельного фрагмента длиной от 2 секунд.'); return; }
    const gap = [...gaps].sort((left, right) => Math.abs((left.start + left.end) / 2 - editorPlayhead) - Math.abs((right.start + right.end) / 2 - editorPlayhead))[0];
    const clipDuration = Math.min(12, remainingSeconds, gap.end - gap.start);
    const start = Math.max(gap.start, Math.min(gap.end - clipDuration, editorPlayhead - clipDuration / 2));
    const newClip: Clip = { id: `clip-${Date.now()}`, start: Math.round(start * 10) / 10, end: Math.round((start + clipDuration) * 10) / 10 };
    setClips((items) => [...items, newClip].sort((left, right) => left.start - right.start));
    setActiveClipId(newClip.id);
    setTrim([newClip.start, newClip.end]);
    seekEditor(newClip.start);
    invalidatePreparedCues();
  }

  function removeClip(id: string) {
    if (clips.length === 1) { setMessage('Нужен хотя бы один фрагмент. Измените его границы или выберите другое место.'); return; }
    const nextClips = clips.filter((clip) => clip.id !== id);
    const nextActive = nextClips.find((clip) => clip.start >= (clips.find((clip) => clip.id === id)?.start ?? 0)) ?? nextClips.at(-1)!;
    setClips(nextClips);
    setActiveClipId(nextActive.id);
    setTrim([nextActive.start, nextActive.end]);
    seekEditor(nextActive.start);
    invalidatePreparedCues();
  }

  async function analyzeClip() {
    if (!sourceReady) { setMessage('Сначала загрузите видео или откройте демо.'); return; }
    setAnalyzing(true);
    setMessage('Отделяем речь, распознаём текст и ищем паузы…');
    if (projectId) {
      try {
        const result = await apiFetch<{ segments: Segment[]; transcriptionMode: 'transcribed' | 'manual'; transcriptionReason?: 'no_speech' | 'unavailable' | null }>(`/projects/${projectId}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clips: clips.map((clip) => ({ id: clip.id, start: clip.start, end: clip.end })) }),
        });
        setSegments(result.segments);
        setActiveSegment(result.segments[0]?.id || 1);
        setTranscriptionMode(result.transcriptionMode);
        setAnalyzing(false);
        setAnalyzed(true);
        setMessage(result.transcriptionMode === 'transcribed'
          ? `Выбранные части уже собраны в одну очередь дубляжа. Deepgram распознал ${result.segments.length} смысловых фраз — проверьте текст перед записью.`
          : result.transcriptionReason === 'no_speech'
            ? `В этом фрагменте не нашлось распознаваемой речи. Создано ${result.segments.length} окон по 2–4 секунды — впишите сценарий вручную.`
            : `Создано ${result.segments.length} таймированных окон по 2–4 секунды. Автосубтитры недоступны — впишите сценарий вручную.`);
        return;
      } catch (cause) {
        setAnalyzing(false);
        setAnalyzed(false);
        setSegments([]);
        setMessage(cause instanceof Error ? cause.message : 'Серверный анализ не удался');
        return;
      }
    }
    setAnalyzing(false);
    setAnalyzed(false);
    setSegments([]);
    setMessage('Нужен запущенный локальный сервер: без него нельзя честно подготовить реплики и собрать MP4.');
  }

  function drawWaveform(analyser?: AnalyserNode) {
    const canvas = liveWaveRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(320, bounds.width);
    const height = Math.max(120, bounds.height);
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const barCount = 96;
    const gap = width / barCount;
    context.strokeStyle = 'rgba(239, 86, 86, .36)';
    context.lineWidth = 2;
    for (let index = 0; index < barCount; index += 1) {
      const originalHeight = Math.max(1, (originalLevels[index] || 0) * height * 0.78);
      context.beginPath();
      context.moveTo(index * gap + gap / 2, height / 2 - originalHeight / 2);
      context.lineTo(index * gap + gap / 2, height / 2 + originalHeight / 2);
      context.stroke();
    }

    if (analyser) {
      const samples = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += Math.abs(sample - 128) / 128;
      const level = Math.min(1, (energy / samples.length) * 4.8);
      latestLevelsRef.current = [...latestLevelsRef.current.slice(1), level];
    }

    const current = segments.find((item) => item.id === activeSegment);
    const levels = latestLevelsRef.current;
    context.strokeStyle = current?.audioUrl || analyser ? '#75e66d' : 'rgba(117, 230, 109, .22)';
    context.lineWidth = 3;
    levels.forEach((level, index) => {
      const voiceHeight = Math.max(2, level * height * 0.9);
      context.beginPath();
      context.moveTo(index * gap + gap / 2, height / 2 - voiceHeight / 2);
      context.lineTo(index * gap + gap / 2, height / 2 + voiceHeight / 2);
      context.stroke();
    });

    context.fillStyle = 'rgba(255,255,255,.78)';
    context.font = '600 11px Inter, sans-serif';
    const peak = Math.max(...levels);
    context.fillText(analyser ? `LIVE  ${Math.round(peak * 100)}%` : current?.audioUrl ? 'ДУБЛЬ ЗАПИСАН' : 'МИКРОФОН ГОТОВ', 14, 20);
    if (analyser) animationFrameRef.current = window.requestAnimationFrame(() => drawWaveform(analyser));
  }

  // The canvas is intentionally redrawn after a segment or take changes.
  useEffect(() => {
    if (analyzed && recording === null) drawWaveform();
    // drawWaveform is intentionally recreated with the current segment snapshot.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSegment, analyzed, originalLevels, recording, segments]);

  function stopPlayback() {
    if (playbackStopTimeoutRef.current) window.clearTimeout(playbackStopTimeoutRef.current);
    playbackStopTimeoutRef.current = null;
    segmentVideoRef.current?.pause();
    if (takeAudioRef.current) {
      takeAudioRef.current.onended = null;
      takeAudioRef.current.pause();
      takeAudioRef.current.currentTime = 0;
      takeAudioRef.current = null;
    }
    setPlayback(null);
  }

  function startTranscription(id: number) {
    transcriptRef.current = '';
    setLiveTranscript('');
    const browserWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setTranscriptionState('unsupported');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'ru-RU';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = String(result[0]?.transcript || '').trim();
        if (!text) continue;
        if (result.isFinal) finalText += `${text} `;
        else if (index >= event.resultIndex) interimText += `${text} `;
      }
      const transcript = `${finalText}${interimText}`.trim();
      transcriptRef.current = transcript;
      setLiveTranscript(transcript);
      if (transcript) setSegments((items) => items.map((item) => item.id === id ? { ...item, text: transcript } : item));
    };
    recognition.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') setTranscriptionState('error');
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setTranscriptionState((value) => value === 'listening' ? 'idle' : value);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setTranscriptionState('listening');
    } catch {
      recognitionRef.current = null;
      setTranscriptionState('error');
    }
  }

  function stopRecording(reason: 'manual' | 'limit' = 'manual') {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') return;
    if (recordingSessionRef.current) recordingSessionRef.current.stopReason = reason;
    if (recordLimitTimeoutRef.current) window.clearTimeout(recordLimitTimeoutRef.current);
    if (recordTickRef.current) window.clearInterval(recordTickRef.current);
    if (previewStartTimeoutRef.current) window.clearTimeout(previewStartTimeoutRef.current);
    if (playbackStopTimeoutRef.current) window.clearTimeout(playbackStopTimeoutRef.current);
    recordLimitTimeoutRef.current = null;
    recordTickRef.current = null;
    previewStartTimeoutRef.current = null;
    playbackStopTimeoutRef.current = null;
    try { recognitionRef.current?.stop(); } catch { /* recognition may already be stopped */ }
    recorderRef.current.stop();
    recorderRef.current.stream.getTracks().forEach((track) => track.stop());
    segmentVideoRef.current?.pause();
    if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setPlayback(null);
    setRecording(null);
    setCountdown(null);
    setRecordElapsed(0);
  }

  async function toggleRecord(id: number) {
    if (recording === id && recorderRef.current) {
      stopRecording('manual');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { setMessage('Этот браузер не поддерживает запись. Попробуйте Chrome или Edge.'); return; }
    try {
      if (recording !== null) {
        stopRecording('manual');
        setMessage('Предыдущая запись остановлена. Теперь можно начать новую реплику.');
        return;
      }
      stopPlayback();
      setActiveSegment(id);
      setLiveTranscript('');
      setTranscriptionState('idle');
      if (countdownEnabled) {
        for (const value of [3, 2, 1]) {
          setCountdown(value);
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        setCountdown(null);
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const recorder = new MediaRecorder(stream);
      const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) throw new Error('AudioContext is not supported');
      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.76;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      audioContextRef.current = audioContext;
      latestLevelsRef.current = Array.from({ length: 96 }, () => 0);
      recordingChunks.current = [];
      const segment = segments.find((item) => item.id === id);
      if (!segment) throw new Error('Реплика не найдена');
      const recordWindow = recordingWindow(segment);
      const recordingSession: RecordingSession = {
        segmentId: id,
        stopReason: 'manual',
        leadIn: recordWindow.leadIn,
        tailOut: recordWindow.tailOut,
        duration: recordWindow.duration,
      };
      recordingSessionRef.current = recordingSession;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunks.current, { type: recorder.mimeType || 'audio/webm' });
        if (!blob.size) {
          if (recordingSessionRef.current === recordingSession) recordingSessionRef.current = null;
          setMessage('Запись получилась пустой. Проверьте микрофон и повторите дубль.');
          return;
        }
        const audioUrl = URL.createObjectURL(blob);
        const segmentId = recordingSession.segmentId;
        const recognizedText = transcriptRef.current.trim();
        const willFinish = segments.every((item) => item.id === segmentId || item.state !== 'pending');
        setSegments((items) => items.map((item) => item.id === segmentId ? { ...item, state: 'ready', audioUrl, text: recognizedText || item.text } : item));
        const savedMessage = willFinish
          ? 'Все реплики готовы. Можно собрать итоговый дубляж.'
          : recordingSession.stopReason === 'limit'
            ? 'Лимит реплики достигнут — запись остановлена и сохранена.'
            : 'Дубль сохранён. Можно прослушать его или перейти дальше.';
        if (projectId && segmentId !== null) {
          void apiFetch<{ ok: boolean; takeUrl: string }>(`/projects/${projectId}/segments/${segmentId}`, {
            method: 'POST',
            headers: {
              'Content-Type': recorder.mimeType || 'audio/webm',
              'X-Recording-Lead-In': String(recordingSession.leadIn),
              'X-Recording-Tail-Out': String(recordingSession.tailOut),
            },
            body: blob,
          })
            .then((result) => {
              setSegments((items) => items.map((item) => item.id === segmentId ? { ...item, audioUrl: mediaUrl(result.takeUrl) } : item));
              setBackendOnline(true);
              setMessage(savedMessage);
            })
            .catch((cause) => setMessage(cause instanceof Error ? cause.message : 'Не удалось сохранить дубль на сервере'));
        } else {
          setMessage(willFinish ? savedMessage : 'Дубль сохранён в браузере. Для MP4-рендера загрузите видео через локальную версию.');
        }
        if (recordingSessionRef.current === recordingSession) recordingSessionRef.current = null;
        window.setTimeout(() => drawWaveform(), 0);
      };
      recorderRef.current = recorder;
      const maximumDuration = recordingSession.duration;
      recorder.start(100);
      setRecording(id);
      setRecordElapsed(0);
      recordStartedAtRef.current = performance.now();
      recordTickRef.current = window.setInterval(() => {
        setRecordElapsed(Math.min(maximumDuration, (performance.now() - recordStartedAtRef.current) / 1000));
      }, 50);
      recordLimitTimeoutRef.current = window.setTimeout(() => stopRecording('limit'), maximumDuration * 1000);
      startTranscription(id);
      drawWaveform(analyser);
      const preview = segmentVideoRef.current;
      if (preview) {
        preview.currentTime = Math.min(recordWindow.start, Math.max(0, (preview.duration || recordWindow.end) - 0.2));
        preview.muted = !originalMonitor;
        preview.volume = originalMonitor ? 0.34 : 0;
        const availableLead = Math.max(0, segment.start - recordWindow.start);
        const virtualLead = Math.max(0, recordWindow.leadIn - availableLead);
        const playPreview = () => {
          previewStartTimeoutRef.current = null;
          if (recorder.state === 'recording') void preview.play().catch(() => undefined);
        };
        if (virtualLead > 0) previewStartTimeoutRef.current = window.setTimeout(playPreview, virtualLead * 1000);
        else playPreview();
      }
      setMessage(`Идёт запись: ${formatTime(recordWindow.leadIn)} до реплики, фраза и ${formatTime(recordWindow.tailOut)} после. Автостоп через ${formatTime(maximumDuration)}.`);
    } catch {
      if (recordLimitTimeoutRef.current) window.clearTimeout(recordLimitTimeoutRef.current);
      if (recordTickRef.current) window.clearInterval(recordTickRef.current);
      if (previewStartTimeoutRef.current) window.clearTimeout(previewStartTimeoutRef.current);
      previewStartTimeoutRef.current = null;
      setCountdown(null);
      setMessage('Не получилось включить микрофон. Разрешите доступ в браузере.');
    }
  }

  function replayOriginal() {
    const segment = segments.find((item) => item.id === activeSegment);
    const preview = segmentVideoRef.current;
    if (!segment || !preview) return;
    if (playback?.kind === 'original' && playback.segmentId === segment.id && !preview.paused) {
      stopPlayback();
      return;
    }
    stopPlayback();
    const previewWindow = recordingWindow(segment);
    preview.currentTime = Math.min(previewWindow.start, Math.max(0, (preview.duration || previewWindow.end) - 0.2));
    preview.muted = false;
    preview.volume = 0.72;
    setPlayback({ kind: 'original', segmentId: segment.id });
    void preview.play().catch(() => setPlayback(null));
    playbackStopTimeoutRef.current = window.setTimeout(stopPlayback, Math.max(350, (previewWindow.end - previewWindow.start) * 1000));
  }

  function selectSegment(id: number) {
    if (recording !== null) stopRecording('manual');
    else stopPlayback();
    setActiveSegment(id);
    setLiveTranscript('');
    setRecordElapsed(0);
  }

  function previousSegment() {
    const currentIndex = segments.findIndex((item) => item.id === activeSegment);
    const previous = segments[currentIndex <= 0 ? segments.length - 1 : currentIndex - 1];
    if (previous) selectSegment(previous.id);
  }

  function nextSegment() {
    const currentIndex = segments.findIndex((item) => item.id === activeSegment);
    const next = segments[currentIndex >= segments.length - 1 ? 0 : currentIndex + 1];
    if (next) selectSegment(next.id);
  }

  function playTake(item: Segment) {
    if (!item.audioUrl) { setMessage('Это демонстрационный дубль. Запишите свой, чтобы прослушать.'); return; }
    const isCurrentTake = playback?.kind === 'take' && playback.segmentId === item.id;
    if (isCurrentTake) {
      stopPlayback();
      return;
    }
    if (recording !== null) stopRecording('manual');
    stopPlayback();
    setActiveSegment(item.id);
    const audio = new Audio(item.audioUrl);
    takeAudioRef.current = audio;
    setPlayback({ kind: 'take', segmentId: item.id });
    audio.onended = () => { takeAudioRef.current = null; setPlayback(null); };
    void audio.play().catch(() => {
      takeAudioRef.current = null;
      setPlayback(null);
      setMessage('Не удалось воспроизвести дубль. Попробуйте записать его ещё раз.');
    });
  }

  function handleSegmentVideoPlay() {
    if (takeAudioRef.current) {
      takeAudioRef.current.onended = null;
      takeAudioRef.current.pause();
      takeAudioRef.current.currentTime = 0;
      takeAudioRef.current = null;
    }
    if (recorderRef.current?.state === 'recording') setPlayback(null);
    else setPlayback({ kind: 'original', segmentId: activeSegment });
  }

  function handleSegmentVideoPause() {
    if (recorderRef.current?.state !== 'recording') setPlayback((value) => value?.kind === 'original' ? null : value);
  }

  function handleSegmentVideoTimeUpdate() {
    const preview = segmentVideoRef.current;
    const segment = segments.find((item) => item.id === activeSegment);
    if (!preview || !segment) return;
    const session = recordingSessionRef.current;
    const tailOut = recording === segment.id && session?.segmentId === segment.id
      ? session.tailOut
      : recordingWindow(segment).tailOut;
    const sourceClip = clips.find((clip) => clip.id === segment.clipId)
      ?? clips.find((clip) => segment.start >= clip.start - .01 && segment.end <= clip.end + .01)
      ?? { end: trim[1] };
    if (preview.currentTime < Math.min(sourceClip.end, segment.end + tailOut) - 0.03) return;
    if (recording === segment.id) preview.pause();
    else if (playback?.kind === 'original') stopPlayback();
  }

  function handleSegmentVideoSeeking() {
    const preview = segmentVideoRef.current;
    const segment = segments.find((item) => item.id === activeSegment);
    if (!preview || !segment) return;
    const previewWindow = recordingWindow(segment);
    if (preview.currentTime < previewWindow.start - .05 || preview.currentTime > previewWindow.end + .05) preview.currentTime = previewWindow.start;
  }

  useEffect(() => {
    if (!analyzed) return;
    const segment = segments.find((item) => item.id === activeSegment);
    if (!segment) return;
    const timer = window.setTimeout(() => {
      const preview = segmentVideoRef.current;
      if (!preview || recorderRef.current?.state === 'recording') return;
      preview.pause();
      preview.currentTime = recordingWindow(segment).start;
      preview.muted = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSegment, analyzed, clips, segments]);

  function setOriginal(id: number) {
    setSegments((items) => items.map((item) => item.id === id ? { ...item, state: item.state === 'original' ? 'pending' : 'original' } : item));
  }

  function updateText(id: number, text: string) {
    setSegments((items) => items.map((item) => item.id === id ? { ...item, text } : item));
  }

  async function assembleVideo() {
    if (!analyzed) { setMessage('Сначала подготовьте реплики из выбранного отрывка.'); return; }
    if (!projectId) { setMessage('Для настоящего MP4-рендера откройте локальное приложение и загрузите видео заново.'); return; }
    setAssembly('processing');
    setAssemblyProgress(1);
    setMessage('Склеиваем фрагменты, очищаем голос и подавляем исходную речь…');
    try {
      await apiFetch<{ ok: boolean }>(`/projects/${projectId}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments: segments.map(({ id, text }) => ({ id, text })), burnSubtitles }) });
      for (let attempt = 0; attempt < 900; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const status = await apiFetch<{ status: string; progress: number; error: string | null; outputUrl: string | null; credits: number }>(`/projects/${projectId}/status`);
        setAssemblyProgress(status.progress);
        if (status.status === 'done' && status.outputUrl) {
          setAssembly('done');
          setResultUrl(mediaUrl(status.outputUrl));
          setCredits(status.credits);
          window.localStorage.setItem('dublika-credits', String(status.credits));
          setMessage('Готово: фрагменты склеены, голос очищен, исходная речь подавлена, MP4 собран.');
          return;
        }
        if (status.status === 'failed') throw new Error(status.error || 'Не удалось собрать видео');
      }
      throw new Error('Рендер занял слишком много времени');
    } catch (cause) {
      setAssembly('idle');
      setMessage(cause instanceof Error ? cause.message : 'Ошибка сборки видео');
    }
  }

  function downloadResult() {
    if (resultUrl) {
      const link = document.createElement('a');
      link.href = resultUrl;
      link.download = `dublika-${sourceName.replace(/\.[^.]+$/, '')}.mp4`;
      link.click();
      setMessage('Готовый MP4 скачивается с этого компьютера.');
      return;
    }
    setMessage('Итоговый MP4 ещё не собран. Запишите реплики и нажмите «Собрать видео».');
  }

  function choosePlan(name: string) {
    setPricingOpen(false);
    setMessage(`Тариф «${name}» подготовлен. Для списания и начисления видео подключите ключи ЮKassa или CloudPayments.`);
  }

  const path = route.split('?')[0].split('#')[0] || '/';
  const activeLine = segments.find((item) => item.id === activeSegment) ?? segments[0];
  const activeSegmentDuration = Math.max(0.35, (activeLine?.end ?? 2) - (activeLine?.start ?? 0));
  const activeRecordingWindow = activeLine ? recordingWindow(activeLine) : { leadIn: 0, tailOut: 0, phraseDuration: activeSegmentDuration, duration: activeSegmentDuration, start: 0, end: activeSegmentDuration };
  const recordRemaining = Math.max(0, activeRecordingWindow.duration - recordElapsed);
  const recordProgress = Math.min(100, recordElapsed / activeRecordingWindow.duration * 100);
  const originalIsPlaying = playback?.kind === 'original' && playback.segmentId === activeSegment;
  const takeIsPlaying = playback?.kind === 'take' && playback.segmentId === activeSegment;
  const pageProps = {
    route,
    navigate,
    darkMode,
    toggleTheme: () => setDarkMode((value) => !value),
    signedIn,
    onSignedIn: handleSignedIn,
    notify: setMessage,
  };

  if (path !== '/studio' || !signedIn) {
    return (
      <div className="site-root">
        <ProductPages {...pageProps} route={path === '/studio' && !signedIn ? '/auth?next=/studio' : route} />
        {message && <output className="toast-message"><Check size={17} /><span>{message}</span><button onClick={() => setMessage('')} aria-label="Закрыть сообщение"><X size={15} /></button></output>}
      </div>
    );
  }

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar route="/studio" navigate={navigate} />
      <SidebarInset className="studio-inset">
    <div className="app-shell studio-app-shell">
      <header className="topbar">
        <div className="studio-brand-group"><SidebarTrigger /><button className="brand" type="button" onClick={() => navigate('/')} aria-label="Дублика — на главную">
          <span className="brand-mark"><span>Д</span></span><span className="brand-word">дублика</span><span className="beta">beta</span>
        </button></div>
        <nav className="main-nav" aria-label="Основная навигация">
          <a className="nav-active" href="#studio">Студия</a><button type="button" onClick={() => navigate('/videos')}>Мои видео</button><button type="button" onClick={() => setPricingOpen(true)}>Тарифы</button>
        </nav>
        <div className="header-actions">
          <button className="icon-button" type="button" onClick={() => setDarkMode((value) => !value)} aria-label={darkMode ? 'Светлая тема' : 'Тёмная тема'}>{darkMode ? <Sun size={18} /> : <Moon size={18} />}</button>
          <button className="credit-pill" type="button" onClick={() => setPricingOpen(true)}><Sparkles size={15} />{plan === 'Пробный' ? `${credits} видео` : plan}</button>
          <button className="icon-button help-button" type="button" aria-label="Помощь"><CircleHelp size={19} /></button>
          <button className="account-button" type="button" onClick={() => navigate('/dashboard')}><UserRound size={17} /><span>Алексей</span></button>
        </div>
      </header>

      <main id="top" className="main-area">
        <section className="page-heading">
          <div><p className="eyebrow"><span /> новый проект</p><h1>Озвучьте видео<br /><em>своим голосом</em></h1></div>
          <div className={`privacy-note local-server-note ${backendOnline ? 'is-online' : ''}`}><ShieldCheck size={22} /><p><strong>{backendOnline ? 'Локальный сервер работает' : 'Режим просмотра'}</strong><span>{backendOnline ? 'Файлы остаются на этом компьютере' : 'Запустите npm run local для обработки'}</span></p></div>
        </section>

        <section className="stepper" aria-label="Прогресс проекта">
          {[['01', 'Видео'], ['02', 'Отрывок'], ['03', 'Реплики'], ['04', 'Запись'], ['05', 'Готово']].map(([number, label], index) => (
            <div className={`step ${index + 1 <= currentStep ? 'is-active' : ''}`} key={number}>
              <span className="step-dot">{index + 1 < currentStep ? <Check size={14} /> : number}</span><span>{label}</span>{index < 4 && <i />}
            </div>
          ))}
        </section>

        <div id="studio" className="workspace-grid">
          <div className="workspace-main">
            <section className="surface source-card">
              <div className="section-header">
                <div><span className="section-index">01</span><div><h2>Добавьте видео</h2><p>Файл, ссылка или тестовый клип</p></div></div>
                {sourceReady && <span className="success-chip">{uploading ? <span className="loader" /> : <Check size={14} />} {uploading ? 'Сохраняем…' : 'Загружено'}</span>}
              </div>
              <Tabs value={sourceTab} onValueChange={(value) => setSourceTab(value as SourceKind)}>
                <TabsList className="source-tabs">
                  <TabsTrigger value="file"><UploadCloud /> С компьютера</TabsTrigger><TabsTrigger value="link"><Link2 /> По ссылке</TabsTrigger><TabsTrigger value="demo"><Clapperboard /> Демо</TabsTrigger>
                </TabsList>
                <TabsContent value="file">
                  <button className="drop-zone" type="button" onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onFile(event.dataTransfer.files[0]); }}>
                    <span className="upload-orb"><UploadCloud size={28} /></span><span><strong>Перетащите видео сюда</strong><small>или нажмите, чтобы выбрать файл</small></span><span className="format-pill">MP4 · MOV · WEBM</span>
                  </button>
                  <input ref={fileInputRef} className="sr-only" type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(event) => onFile(event.target.files?.[0])} />
                </TabsContent>
                <TabsContent value="link">
                  <div className="link-panel"><div className="link-input-wrap"><Link2 size={19} /><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="Ссылка на YouTube, VK Видео или прямой MP4" /></div><button className="primary-button small" type="button" onClick={importLink}>Загрузить <ArrowRight size={17} /></button></div>
                  <p className="legal-hint">Прямые ссылки работают сразу. YouTube и VK требуют доступный медиапоток; используйте только контент, на который у вас есть права.</p>
                </TabsContent>
                <TabsContent value="demo">
                  <div className="demo-panel"><div className="demo-cover"><Play size={24} fill="currentColor" /></div><div><strong>Тестовый видеоклип</strong><span>00:05 · проверка загрузки и записи</span></div><button className="secondary-button" type="button" onClick={loadDemo}>Открыть клип</button></div>
                </TabsContent>
              </Tabs>
            </section>

            <section className={`surface editor-card ${!sourceReady ? 'is-muted' : ''}`}>
              <div className="section-header">
                <div><span className="section-index">02</span><div><h2>Выберите фрагменты</h2><p>До 4 минут суммарно — можно собрать сцену из нескольких моментов</p></div></div>
                <span className="duration-chip"><Clock3 size={14} /> {formatTime(clipLength)}</span>
              </div>
              <div className="video-stage">
                {videoUrl ? <video ref={videoRef} src={videoUrl} controls onLoadedMetadata={handleMetadata} onTimeUpdate={() => setEditorPlayhead(videoRef.current?.currentTime || 0)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}><track kind="captions" label="Русские субтитры" srcLang="ru" /></video> : (
                  <button type="button" className="stage-placeholder" onClick={() => setIsPlaying(!isPlaying)}>
                    <span className="scene-light one" /><span className="scene-light two" /><span className="city-line" />
                    <span className="stage-play">{isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</span><span className="stage-caption">{sourceReady ? 'Демо-превью' : 'Загрузите видео, чтобы открыть превью'}</span>
                  </button>
                )}
                <div className="stage-topline"><span><FileVideo size={14} /> {sourceReady ? sourceName : 'Видео не выбрано'}</span><button aria-label="Действия с видео"><MoreHorizontal size={18} /></button></div>
              </div>
              <div className="timeline">
                <div className="timeline-toolbar"><span>{formatTime(trim[0])}</span><div><Scissors size={15} /> Фрагмент {Math.max(1, clips.findIndex((clip) => clip.id === activeClipId) + 1)} из {clips.length}</div><span>{formatTime(trim[1])}</span></div>
                <button ref={timelineRef} className="filmstrip" type="button" disabled={!sourceReady} onPointerDown={handleTimelinePointerDown} onPointerMove={handleTimelinePointerMove} onPointerUp={handleTimelinePointerUp} onPointerCancel={handleTimelinePointerUp} onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  seekEditor(editorPlayhead + (event.key === 'ArrowRight' ? 1 : -1));
                }} aria-label={`Текущая позиция ${formatTime(editorPlayhead)}. Тяните светлые границы активного фрагмента или нажмите по ленте, чтобы перейти к моменту видео.`}>
                  {timelineBlocks.map((block) => <span key={block.id} style={{ '--hue': block.hue, '--light': `${block.lightness}%` } as React.CSSProperties} />)}
                  {clips.map((clip) => {
                    const start = Math.min(100, Math.max(0, clip.start / Math.max(duration, 1) * 100));
                    const end = Math.min(100, Math.max(start, clip.end / Math.max(duration, 1) * 100));
                    return <span className={`selection-box ${clip.id === activeClipId ? 'is-active' : 'is-idle'}`} style={{ left: `${start}%`, right: `${100 - end}%` }} key={clip.id} aria-hidden="true" />;
                  })}
                  <span className="timeline-playhead" style={{ left: `${playheadPosition}%` }} aria-hidden="true" />
                </button>
                <div className="waveform" aria-label={editorLevels.length === 96 ? 'Форма волны выбранного отрывка' : 'Форма волны будет построена после загрузки видео'}>{editorWaveform.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
                <Slider className="trim-slider" value={trim} min={0} max={Math.max(duration, 1)} step={0.1} onValueChange={(next) => handleTrim(next, false)} onValueCommitted={() => invalidatePreparedCues()} disabled={!sourceReady} aria-label="Границы отрывка" />
                <div className="timeline-scale"><span>0:00</span><span>{formatTime(duration / 2)}</span><span>{formatTime(duration)}</span></div>
                <div className="timeline-inputs">
                  <label><span>Начало</span><input type="number" min={0} max={Math.max(0, trim[1] - 2)} step="0.1" value={trim[0].toFixed(1)} disabled={!sourceReady} onChange={(event) => setTrimBoundary('start', Number(event.target.value))} /><button type="button" onClick={() => seekEditor(trim[0])} disabled={!sourceReady}>К началу</button></label>
                  <label><span>Конец</span><input type="number" min={Math.min(duration, trim[0] + 2)} max={duration} step="0.1" value={trim[1].toFixed(1)} disabled={!sourceReady} onChange={(event) => setTrimBoundary('end', Number(event.target.value))} /><button type="button" onClick={() => seekEditor(trim[1])} disabled={!sourceReady}>К концу</button></label>
                  <button className="timeline-reset" type="button" disabled={!sourceReady} onClick={() => { setSingleClip(0, Math.min(duration, 60)); seekEditor(0); invalidatePreparedCues(); }}>Оставить один</button>
                </div>
                <div className="clip-picker" aria-label="Выбранные фрагменты">
                  <div className="clip-picker-head"><span><Scissors /> Выбрано {clips.length} из {maxSelectedClips}</span><small>{formatTime(clipLength)} / 4:00</small></div>
                  <div className="clip-picker-list">
                    {clips.map((clip, index) => <div className={`clip-chip ${clip.id === activeClipId ? 'is-active' : ''}`} key={clip.id}><button type="button" onClick={() => selectClip(clip.id)}><strong>Фрагмент {index + 1}</strong><span>{formatTime(clip.start)} — {formatTime(clip.end)}</span></button><button className="clip-remove" type="button" onClick={() => removeClip(clip.id)} aria-label={`Удалить фрагмент ${index + 1}`} disabled={clips.length === 1}>×</button></div>)}
                    <button className="add-clip" type="button" onClick={addClip} disabled={!sourceReady || clips.length >= maxSelectedClips || clipLength >= maxSelectedSeconds}><Plus /> Добавить в позиции {formatTime(editorPlayhead)}</button>
                  </div>
                  <p>Фрагменты нужны только чтобы выбрать нужные места видео. Они не пересекутся, а затем сразу станут одной общей очередью дубляжа и одним MP4.</p>
                </div>
              </div>
              <div className="editor-footer">
                <div className="quality-note"><WandSparkles size={18} /><p><strong>Умная обработка</strong><span>Приглушим оригинал под дублем и сохраним фон</span></p></div>
                <button className="primary-button" type="button" onClick={() => void analyzeClip()} disabled={!sourceReady || analyzing || uploading}>{analyzing ? <><span className="loader" /> Анализируем…</> : uploading ? 'Сохраняем видео…' : <>Подготовить реплики <ArrowRight size={18} /></>}</button>
              </div>
            </section>

            {analyzed && (
              <section className="surface dub-console-card">
                <div className="section-header dub-console-header"><div><span className="section-index">03</span><div><h2>Запишите реплики</h2><p>{transcriptionMode === 'transcribed' ? 'Текст получен от Deepgram. Предложения сохраняем целиком, без обрыва слов.' : 'Таймированные окна по 2–4 секунды. Введите сценарий перед записью.'}</p></div></div><span className="duration-chip">{finishedSegments}/{segments.length} готово</span></div>
                <div className="segment-navigator" aria-label="Выбор реплики"><div className="segment-navigator-title"><span>Реплики</span><small>выбирайте и записывайте в любом порядке</small></div><div className="segment-navigator-track">{segments.map((item) => <button className={activeSegment === item.id ? 'is-active' : item.state !== 'pending' ? 'is-complete' : ''} type="button" key={item.id} onClick={() => selectSegment(item.id)} title={item.text || `Реплика ${item.id}`}><span>{item.state === 'ready' ? <Check size={13} /> : item.state === 'original' ? <Volume2 size={13} /> : item.id}</span><strong>Реплика {item.id} · {formatTime(item.start)}</strong><small>{item.text || 'Введите текст реплики'}</small></button>)}</div></div>
                <div className="dub-console">
                  <div className="dub-workbench">
                    <div className="segment-video-wrap">
                      <video ref={segmentVideoRef} src={videoUrl} playsInline preload="auto" onPlay={handleSegmentVideoPlay} onPause={handleSegmentVideoPause} onSeeking={handleSegmentVideoSeeking} onTimeUpdate={handleSegmentVideoTimeUpdate}><track kind="captions" label="Русские субтитры" srcLang="ru" /></video>
                      <div className="segment-video-badge"><ListVideo /> {formatTime(activeLine.start)} — {formatTime(activeLine.end)} <i>+{formatTime(activeRecordingWindow.leadIn)} / +{formatTime(activeRecordingWindow.tailOut)}</i></div>
                      <button className="segment-preview-toggle" type="button" onClick={replayOriginal} disabled={recording !== null || countdown !== null}>{originalIsPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}<span>{originalIsPlaying ? 'Остановить' : 'Посмотреть фрагмент'}</span></button>
                      {countdown !== null && <div className="record-countdown"><span>{countdown}</span><small>приготовьтесь</small></div>}
                      {recording === activeSegment && <div className={`live-transcript-overlay ${transcriptionState !== 'listening' ? 'is-muted' : ''}`}><Captions /><span>{liveTranscript || (transcriptionState === 'unsupported' ? 'Живая транскрипция недоступна в этом браузере' : transcriptionState === 'error' ? 'Не удалось распознать речь — текст можно ввести ниже' : 'Говорите — субтитры появятся здесь…')}</span></div>}
                    </div>
                    <div className="active-caption"><span>{recording === activeSegment ? 'Живая транскрипция' : transcriptionMode === 'transcribed' ? `Deepgram · реплика ${activeSegment}` : `Сценарий · реплика ${activeSegment}`}</span><textarea rows={2} value={activeLine.text} onChange={(event) => updateText(activeLine.id, event.target.value)} placeholder={transcriptionMode === 'transcribed' ? 'Проверьте или вставьте полный текст реплики' : 'Введите или вставьте текст, который нужно озвучить'} aria-label="Текст активной реплики" /></div>
                    <div className="wave-compare-head"><div><span className="legend-original"><i /> Оригинал</span><span className="legend-dub"><i /> Ваш дубль</span></div><span className={recording === activeSegment ? 'live-indicator is-live' : 'live-indicator'}><i /> {recording === activeSegment ? 'микрофон активен' : activeLine.audioUrl ? 'дубль записан' : 'готов к записи'}</span></div>
                    <div className="live-wave-shell"><canvas ref={liveWaveRef} className="live-wave-canvas" aria-label="Сравнение громкости оригинала и живого сигнала микрофона" /><div className="wave-centerline" /></div>
                    <div className={`record-limit ${recording === activeSegment ? 'is-recording' : ''}`}><div><span>{recording === activeSegment ? 'Запись завершится автоматически' : `Окно: ${formatTime(activeRecordingWindow.leadIn)} до · реплика · ${formatTime(activeRecordingWindow.tailOut)} после`}</span><strong>{formatTime(recording === activeSegment ? recordRemaining : activeRecordingWindow.duration)}</strong></div><div className="record-limit-track"><i style={{ width: `${recording === activeSegment ? recordProgress : 0}%` }} /></div></div>
                    <div className="record-controls">
                      <button className={originalIsPlaying ? 'is-playing' : ''} type="button" onClick={replayOriginal} disabled={recording !== null || countdown !== null}><span>{originalIsPlaying ? <Pause /> : <Volume2 />}</span><strong>{originalIsPlaying ? 'Остановить' : 'Оригинал'}</strong><small>{originalIsPlaying ? 'идёт воспроизведение' : 'прослушать реплику'}</small></button>
                      <button className={recording === activeSegment ? 'main-record-control is-recording' : 'main-record-control'} type="button" onClick={() => void toggleRecord(activeSegment)} disabled={countdown !== null}><span>{recording === activeSegment ? <i /> : <Mic />}</span><strong>{recording === activeSegment ? 'Стоп' : countdown !== null ? `${countdown}…` : 'Записать'}</strong><small>{recording === activeSegment ? `осталось ${formatTime(recordRemaining)}` : `${formatTime(activeRecordingWindow.duration)} с запасом`}</small></button>
                      <button className={takeIsPlaying ? 'is-playing' : ''} type="button" onClick={() => playTake(activeLine)} disabled={!activeLine.audioUrl || recording !== null}><span>{takeIsPlaying ? <Pause /> : <Headphones />}</span><strong>{takeIsPlaying ? 'Остановить' : 'Мой дубль'}</strong><small>{takeIsPlaying ? 'идёт воспроизведение' : 'прослушать запись'}</small></button>
                      <button type="button" onClick={nextSegment}><span><SkipForward /></span><strong>Дальше</strong><small>следующая реплика</small></button>
                    </div>
                    <div className="record-options">
                      <div className="record-option-row"><span className="option-icon"><TimerReset /></span><span><strong>Отсчёт 3 секунды</strong><small>Даёт время приготовиться</small></span><Switch aria-label="Включить трёхсекундный отсчёт" checked={countdownEnabled} onCheckedChange={setCountdownEnabled} /></div>
                      <div className="record-option-row"><span className="option-icon"><Headphones /></span><span><strong>Слушать оригинал</strong><small>Тихо в наушниках во время записи</small></span><Switch aria-label="Слушать оригинал во время записи" checked={originalMonitor} onCheckedChange={setOriginalMonitor} /></div>
                    </div>
                    {allSegmentsFinished && assembly !== 'done' && <output className="final-dub-cta"><span className="final-dub-icon"><BadgeCheck /></span><div><strong>Все реплики готовы</strong><small>Проверьте дубли или сразу соберите итоговый ролик.</small></div><button type="button" onClick={assembleVideo} disabled={assembly === 'processing'}>{assembly === 'processing' ? <><span className="loader" /> {assemblyProgress}%</> : <><Sparkles /> Создать итоговый дубляж</>}</button></output>}
                    {assembly === 'done' && resultUrl && <section className="ready-video-card" aria-label="Готовое видео">
                      <div className="ready-video-head"><span><BadgeCheck /> Готово</span><div><strong>Ваш дубляж собран</strong><small>Голос нормализован, фон сохранён, субтитры {burnSubtitles ? 'добавлены в MP4' : 'отключены'}.</small></div></div>
                      <video className="ready-video-preview" src={resultUrl} controls playsInline><track kind="captions" label="Русские субтитры" srcLang="ru" /></video>
                      <div className="ready-video-actions"><button className="download-button" type="button" onClick={downloadResult}><Download size={18} /> Скачать MP4</button><span>Файл готов к публикации и останется доступен, пока работает ваш локальный медиасервер.</span></div>
                    </section>}
                  </div>
                  <div className="line-list segment-queue">
                    {segments.map((item) => (
                      <article className={`line-item ${activeSegment === item.id ? 'is-current' : ''}`} key={item.id}>
                        <button className="line-play" type="button" onClick={() => selectSegment(item.id)} aria-label={`Выбрать реплику ${item.id}`}><Play size={15} fill="currentColor" /></button>
                        <div className="line-copy"><span className="timecode">{formatTime(item.start)} — {formatTime(item.end)}</span><textarea rows={2} value={item.text} onChange={(event) => updateText(item.id, event.target.value)} placeholder={transcriptionMode === 'transcribed' ? 'Проверьте или вставьте субтитр' : 'Введите текст реплики'} aria-label={`Субтитр реплики ${item.id}`} /><div className="mini-wave">{originalLevels.slice(0, 18).map((level, index) => <i key={index} style={{ height: `${Math.max(8, level * 100)}%` }} />)}</div></div>
                        <div className="line-actions">
                          {item.state === 'ready' && <button className={`take-button ${playback?.kind === 'take' && playback.segmentId === item.id ? 'is-playing' : ''}`} type="button" onClick={(event) => { event.stopPropagation(); playTake(item); }}>{playback?.kind === 'take' && playback.segmentId === item.id ? <Pause size={15} /> : <Headphones size={15} />} {playback?.kind === 'take' && playback.segmentId === item.id ? 'Стоп' : 'Дубль'}</button>}
                          {item.state === 'original' && <span className="original-badge">Оригинал</span>}
                          <button className={`record-button ${recording === item.id ? 'is-recording' : ''}`} type="button" onClick={(event) => { event.stopPropagation(); void toggleRecord(item.id); }} aria-label={recording === item.id ? 'Остановить запись' : 'Записать реплику'}>{recording === item.id ? <span /> : <Mic size={17} />}</button>
                          <button className="reset-button" type="button" onClick={(event) => { event.stopPropagation(); setOriginal(item.id); }} aria-label="Оставить оригинальную реплику"><RotateCcw size={15} /></button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>

          <aside className="workspace-aside">
            <section className="summary-card">
              <div className="summary-head"><span>Ваш проект</span><button aria-label="Закрыть сводку"><X size={17} /></button></div>
              <div className="project-preview"><div className="project-thumb"><span><Play size={18} fill="currentColor" /></span></div><div><strong>{sourceReady ? sourceName.replace(/\.[^.]+$/, '') : 'Новый дубляж'}</strong><span>{formatTime(clipLength)} · {segments.length} реплики</span></div></div>
              <div className="summary-list">
                <div><span><Volume2 size={17} /> Голос</span><strong>Нормализация <Check size={14} /></strong></div>
                <div><span><Music2 size={17} /> Фоновая музыка</span><strong>Сохранить <Check size={14} /></strong></div>
                <div><span><Captions size={17} /> Субтитры</span><Switch aria-label="Добавить субтитры в готовое видео" checked={burnSubtitles} onCheckedChange={setBurnSubtitles} /></div>
                <div><span><BadgeCheck size={17} /> Качество</span><strong>Full HD <ChevronDown size={14} /></strong></div>
              </div>
              {assembly === 'processing' && <div className="render-state"><div><span>Собираем видео</span><strong>{assemblyProgress}%</strong></div><Progress value={assemblyProgress} /><small>Сводим голос, музыку и субтитры</small></div>}
              {assembly === 'done' ? <button className="download-button" type="button" onClick={downloadResult}><Download size={18} /> Скачать результат</button> : <button className="assemble-button" type="button" disabled={assembly === 'processing' || !allSegmentsFinished} onClick={assembleVideo}><Sparkles size={18} /> {assembly === 'processing' ? 'Обрабатываем…' : allSegmentsFinished ? 'Собрать видео' : `Осталось реплик: ${pendingSegments}`}</button>}
              <p className="price-line"><span>{plan === 'Пробный' ? 'Три обработки бесплатно' : `Тариф «${plan}» активен`}</span><ShieldCheck size={14} /> Без водяного знака</p>
            </section>
            <section className="aside-tip"><span className="tip-icon"><LockKeyhole size={20} /></span><div><strong>Приватный проект</strong><p>Ссылку на результат увидите только вы.</p></div></section>
            <section id="projects" className="quota-card"><div><span>Осталось обработок</span><strong>{plan === 'Пробный' ? `${credits} из 3` : '5 из 5'}</strong></div><Progress value={plan === 'Пробный' ? credits / 3 * 100 : 100} /><button type="button" onClick={() => setPricingOpen(true)}>Получить ещё обработки <ArrowRight size={15} /></button></section>
          </aside>
        </div>

        {message && <output className="toast-message"><Check size={17} /><span>{message}</span><button onClick={() => setMessage('')} aria-label="Закрыть сообщение"><X size={15} /></button></output>}
      </main>

      <Dialog open={pricingOpen} onOpenChange={setPricingOpen}>
        <DialogContent className="product-dialog pricing-dialog">
          <DialogHeader><span className="dialog-overline">простые тарифы</span><DialogTitle>Платите только за готовые видео</DialogTitle><DialogDescription>Три бесплатные обработки для нового пользователя. Без скрытых списаний.</DialogDescription></DialogHeader>
          <div className="plans">
            <button type="button" onClick={() => choosePlan('Старт')}><span className="plan-top"><strong>Старт</strong><em>популярный</em></span><span className="plan-price"><b>150 ₽</b><small>за пакет</small></span><span className="plan-features"><i><Check /> 5 видео до 4 минут</i><i><Check /> Full HD без водяного знака</i><i><Check /> Хранение 7 дней</i></span><span className="plan-cta">Выбрать пакет <ArrowRight /></span></button>
            <button type="button" onClick={() => choosePlan('Автор')}><span className="plan-top"><strong>Автор</strong></span><span className="plan-price"><b>490 ₽</b><small>в месяц</small></span><span className="plan-features"><i><Check /> 25 видео каждый месяц</i><i><Check /> Приоритетная обработка</i><i><Check /> Хранение 30 дней</i></span><span className="plan-cta muted">Оформить подписку <ArrowRight /></span></button>
          </div>
          <p className="dialog-legal">Экран оплаты подготовлен как демо. Для списаний потребуется подключить ЮKassa или CloudPayments.</p>
        </DialogContent>
      </Dialog>
    </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
