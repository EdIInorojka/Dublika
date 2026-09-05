'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Clock3,
  Download,
  FileVideo,
  Headphones,
  Link2,
  LockKeyhole,
  Mic,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  UserRound,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type SourceKind = 'file' | 'link' | 'demo';
type SegmentState = 'ready' | 'pending' | 'original';

type Segment = {
  id: number;
  start: number;
  end: number;
  text: string;
  state: SegmentState;
  audioUrl?: string;
};

const initialSegments: Segment[] = [
  { id: 1, start: 2.4, end: 6.8, text: 'Кажется, мы всё-таки успели.', state: 'ready' },
  { id: 2, start: 8.1, end: 12.6, text: 'Не спеши радоваться. Смотри вперёд.', state: 'pending' },
  { id: 3, start: 14.2, end: 18.9, text: 'Ладно. Тогда держись крепче!', state: 'pending' },
  { id: 4, start: 21.3, end: 26.4, text: 'Вот теперь можно радоваться.', state: 'pending' },
];

const waveform = [18, 28, 34, 22, 48, 62, 38, 74, 54, 82, 44, 68, 30, 58, 72, 42, 88, 64, 46, 76, 34, 56, 84, 52, 70, 38, 60, 78, 48, 66, 26, 52, 72, 40, 58, 80, 46, 68, 36, 54, 74, 44, 62, 28, 50, 70, 38, 56];

function formatTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const tenth = Math.floor((value % 1) * 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenth}`;
}

function ProviderIcon({ name }: { name: string }) {
  return <span className="provider-letter">{name.slice(0, 1)}</span>;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const recordingSegment = useRef<number | null>(null);

  const [sourceTab, setSourceTab] = useState<SourceKind>('file');
  const [sourceReady, setSourceReady] = useState(false);
  const [sourceName, setSourceName] = useState('Новый ролик');
  const [sourceUrl, setSourceUrl] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(192);
  const [trim, setTrim] = useState<number[]>([36, 69]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzed, setAnalyzed] = useState(false);
  const [segments, setSegments] = useState(initialSegments);
  const [activeSegment, setActiveSegment] = useState(1);
  const [recording, setRecording] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [assembly, setAssembly] = useState<'idle' | 'processing' | 'done'>('idle');
  const [assemblyProgress, setAssemblyProgress] = useState(0);
  const [authOpen, setAuthOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [plan, setPlan] = useState('Пробный');

  const clipLength = Math.max(1, trim[1] - trim[0]);
  const finishedSegments = segments.filter((item) => item.state !== 'pending').length;
  const currentStep = assembly === 'done' ? 5 : analyzed ? 3 : sourceReady ? 2 : 1;

  const timelineBlocks = useMemo(
    () => Array.from({ length: 12 }, (_, index) => ({ id: index, hue: 194 + (index % 4) * 8, lightness: 21 + (index % 3) * 5 })),
    [],
  );

  useEffect(() => {
    return () => { if (videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl); };
  }, [videoUrl]);

  useEffect(() => {
    if (assembly !== 'processing') return;
    const timer = window.setInterval(() => {
      setAssemblyProgress((value) => {
        if (value >= 100) {
          window.clearInterval(timer);
          setAssembly('done');
          return 100;
        }
        return Math.min(100, value + 7);
      });
    }, 150);
    return () => window.clearInterval(timer);
  }, [assembly]);

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
        loadDemo();
        return { status: 'ready', project: 'Город после дождя' };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  function loadDemo() {
    setSourceTab('demo');
    setSourceReady(true);
    setSourceName('Город после дождя.mp4');
    setDuration(192);
    setTrim([36, 69]);
    setAnalyzed(true);
    setSegments(initialSegments);
    setMessage('Демо-проект готов: 4 реплики уже размечены.');
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
    setAssembly('idle');
    setMessage('Видео загружено. Выберите отрывок до 4 минут.');
  }

  function importLink() {
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
    setMessage(isDirect ? 'Прямая ссылка подключена.' : 'Ссылка принята. В продуктовой версии импорт выполняет защищённый сервер.');
  }

  function handleMetadata() {
    const nextDuration = videoRef.current?.duration;
    if (!nextDuration || !Number.isFinite(nextDuration)) return;
    setDuration(nextDuration);
    setTrim([0, Math.min(nextDuration, 60)]);
  }

  function handleTrim(next: number | readonly number[]) {
    const values = Array.isArray(next) ? [...next] : [0, Number(next)];
    let [start, end] = values;
    if (end - start > 240) end = start + 240;
    setTrim([Math.max(0, start), Math.min(duration, end)]);
  }

  function analyzeClip() {
    if (!sourceReady) { setMessage('Сначала загрузите видео или откройте демо.'); return; }
    setAnalyzing(true);
    setMessage('Отделяем речь, распознаём текст и ищем паузы…');
    window.setTimeout(() => {
      const offset = trim[0];
      setSegments(initialSegments.map((item) => ({ ...item, start: item.start + offset, end: item.end + offset, state: item.id === 1 ? 'ready' : 'pending' })));
      setAnalyzing(false);
      setAnalyzed(true);
      setMessage('Готово: найдено 4 реплики. Текст можно поправить перед записью.');
    }, 1300);
  }

  async function toggleRecord(id: number) {
    if (recording === id && recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current.stream.getTracks().forEach((track) => track.stop());
      setRecording(null);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { setMessage('Этот браузер не поддерживает запись. Попробуйте Chrome или Edge.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const recorder = new MediaRecorder(stream);
      recordingChunks.current = [];
      recordingSegment.current = id;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunks.current, { type: recorder.mimeType });
        const audioUrl = URL.createObjectURL(blob);
        const segmentId = recordingSegment.current;
        setSegments((items) => items.map((item) => item.id === segmentId ? { ...item, state: 'ready', audioUrl } : item));
        setMessage('Дубль сохранён и автоматически выровнен по громкости.');
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(id);
      setActiveSegment(id);
      setMessage('Идёт запись. Нажмите ещё раз, чтобы закончить дубль.');
    } catch { setMessage('Не получилось включить микрофон. Разрешите доступ в браузере.'); }
  }

  function playTake(item: Segment) {
    if (!item.audioUrl) { setMessage('Это демонстрационный дубль. Запишите свой, чтобы прослушать.'); return; }
    void new Audio(item.audioUrl).play();
  }

  function setOriginal(id: number) {
    setSegments((items) => items.map((item) => item.id === id ? { ...item, state: item.state === 'original' ? 'pending' : 'original' } : item));
  }

  function updateText(id: number, text: string) {
    setSegments((items) => items.map((item) => item.id === id ? { ...item, text } : item));
  }

  function assembleVideo() {
    if (!analyzed) { setMessage('Сначала подготовьте реплики из выбранного отрывка.'); return; }
    setAssembly('processing');
    setAssemblyProgress(7);
    setMessage('Собираем дорожки, нормализуем голос и возвращаем музыку…');
  }

  function downloadResult() {
    if (videoUrl && videoUrl.startsWith('blob:')) {
      const link = document.createElement('a');
      link.href = videoUrl;
      link.download = `dublika-${sourceName}`;
      link.click();
      setMessage('Черновик исходного ролика скачан. Серверный рендер подключается отдельно.');
      return;
    }
    const project = { title: sourceName, clip: { start: trim[0], end: trim[1] }, segments: segments.map(({ audioUrl: _audioUrl, ...item }) => item), status: 'demo-render' };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'dublika-project.json';
    link.click();
    URL.revokeObjectURL(link.href);
    setMessage('Демо-проект скачан. Для MP4 нужен подключённый сервер обработки.');
  }

  function demoLogin(provider: string) {
    setSignedIn(true);
    setAuthOpen(false);
    setMessage(`Демо-вход через ${provider} выполнен.`);
  }

  function choosePlan(name: string) {
    setPlan(name);
    setPricingOpen(false);
    setMessage(`Тариф «${name}» выбран. Подключение оплаты выполняется после добавления ключей.`);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Дублика — на главную">
          <span className="brand-mark"><span>Д</span></span><span className="brand-word">дублика</span><span className="beta">beta</span>
        </a>
        <nav className="main-nav" aria-label="Основная навигация">
          <a className="nav-active" href="#studio">Студия</a><a href="#projects">Проекты</a><button type="button" onClick={() => setPricingOpen(true)}>Тарифы</button>
        </nav>
        <div className="header-actions">
          <button className="credit-pill" type="button" onClick={() => setPricingOpen(true)}><Sparkles size={15} />{plan === 'Пробный' ? '1 проба' : plan}</button>
          <button className="icon-button help-button" type="button" aria-label="Помощь"><CircleHelp size={19} /></button>
          <button className="account-button" type="button" onClick={() => setAuthOpen(true)}><UserRound size={17} /><span>{signedIn ? 'Алексей' : 'Войти'}</span></button>
        </div>
      </header>

      <main id="top" className="main-area">
        <section className="page-heading">
          <div><p className="eyebrow"><span /> новый проект</p><h1>Озвучьте видео<br /><em>своим голосом</em></h1></div>
          <div className="privacy-note"><ShieldCheck size={22} /><p><strong>Ваш контент защищён</strong><span>Шифрование и автоудаление через 24 часа</span></p></div>
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
                <div><span className="section-index">01</span><div><h2>Добавьте видео</h2><p>Файл, ссылка или готовый пример</p></div></div>
                {sourceReady && <span className="success-chip"><Check size={14} /> Загружено</span>}
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
                  <p className="legal-hint">Импортируйте только видео, на использование которых у вас есть права.</p>
                </TabsContent>
                <TabsContent value="demo">
                  <div className="demo-panel"><div className="demo-cover"><Play size={24} fill="currentColor" /></div><div><strong>Город после дождя</strong><span>00:33 · 4 реплики · русский</span></div><button className="secondary-button" type="button" onClick={loadDemo}>Открыть демо</button></div>
                </TabsContent>
              </Tabs>
            </section>

            <section className={`surface editor-card ${!sourceReady ? 'is-muted' : ''}`}>
              <div className="section-header">
                <div><span className="section-index">02</span><div><h2>Выберите отрывок</h2><p>До 4 минут — этого хватит для сцены или ролика</p></div></div>
                <span className="duration-chip"><Clock3 size={14} /> {formatTime(clipLength)}</span>
              </div>
              <div className="video-stage">
                {videoUrl ? <video ref={videoRef} src={videoUrl} controls onLoadedMetadata={handleMetadata} /> : (
                  <button type="button" className="stage-placeholder" onClick={() => setIsPlaying(!isPlaying)}>
                    <span className="scene-light one" /><span className="scene-light two" /><span className="city-line" />
                    <span className="stage-play">{isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</span><span className="stage-caption">{sourceReady ? 'Демо-превью' : 'Загрузите видео, чтобы открыть превью'}</span>
                  </button>
                )}
                <div className="stage-topline"><span><FileVideo size={14} /> {sourceReady ? sourceName : 'Видео не выбрано'}</span><button aria-label="Действия с видео"><MoreHorizontal size={18} /></button></div>
              </div>
              <div className="timeline">
                <div className="timeline-toolbar"><span>{formatTime(trim[0])}</span><div><Scissors size={15} /> Выбранный фрагмент</div><span>{formatTime(trim[1])}</span></div>
                <div className="filmstrip" aria-hidden="true">{timelineBlocks.map((block) => <span key={block.id} style={{ '--hue': block.hue, '--light': `${block.lightness}%` } as React.CSSProperties} />)}<div className="selection-box" /></div>
                <div className="waveform" aria-hidden="true">{waveform.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
                <Slider className="trim-slider" value={trim} min={0} max={Math.max(duration, 1)} step={0.1} onValueChange={handleTrim} disabled={!sourceReady} aria-label="Границы отрывка" />
                <div className="timeline-scale"><span>0:00</span><span>{formatTime(duration / 2)}</span><span>{formatTime(duration)}</span></div>
              </div>
              <div className="editor-footer">
                <div className="quality-note"><WandSparkles size={18} /><p><strong>Умная обработка</strong><span>Отделим голоса от музыки и сохраним фон</span></p></div>
                <button className="primary-button" type="button" onClick={analyzeClip} disabled={!sourceReady || analyzing}>{analyzing ? <><span className="loader" /> Анализируем…</> : <>Подготовить реплики <ArrowRight size={18} /></>}</button>
              </div>
            </section>

            {analyzed && (
              <section className="surface lines-card">
                <div className="section-header"><div><span className="section-index">03</span><div><h2>Запишите реплики</h2><p>Мы уже расставили таймкоды и подготовили субтитры</p></div></div><span className="duration-chip">{finishedSegments}/{segments.length} готово</span></div>
                <div className="lines-layout">
                  <div className="line-list">
                    {segments.map((item) => (
                      <article className={`line-item ${activeSegment === item.id ? 'is-current' : ''}`} key={item.id} onClick={() => setActiveSegment(item.id)}>
                        <button className="line-play" type="button" aria-label={`Воспроизвести реплику ${item.id}`}><Play size={15} fill="currentColor" /></button>
                        <div className="line-copy"><span className="timecode">{formatTime(item.start)} — {formatTime(item.end)}</span><input value={item.text} onChange={(event) => updateText(item.id, event.target.value)} aria-label={`Субтитр реплики ${item.id}`} /><div className="mini-wave">{waveform.slice(0, 18).map((height, index) => <i key={index} style={{ height: `${Math.max(14, height - item.id * 6)}%` }} />)}</div></div>
                        <div className="line-actions">
                          {item.state === 'ready' && <button className="take-button" type="button" onClick={(event) => { event.stopPropagation(); playTake(item); }}><Headphones size={15} /> Дубль</button>}
                          {item.state === 'original' && <span className="original-badge">Оригинал</span>}
                          <button className={`record-button ${recording === item.id ? 'is-recording' : ''}`} type="button" onClick={(event) => { event.stopPropagation(); void toggleRecord(item.id); }} aria-label={recording === item.id ? 'Остановить запись' : 'Записать реплику'}>{recording === item.id ? <span /> : <Mic size={17} />}</button>
                          <button className="reset-button" type="button" onClick={(event) => { event.stopPropagation(); setOriginal(item.id); }} aria-label="Оставить оригинальную реплику"><RotateCcw size={15} /></button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <aside className="record-panel">
                    <span className="record-kicker">Реплика {activeSegment} из {segments.length}</span>
                    <div className={`mic-visual ${recording ? 'is-live' : ''}`}><span><Mic size={30} /></span>{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>
                    <strong>{recording ? 'Говорите…' : 'Готовы к записи?'}</strong><p>Перед записью прозвучит короткий отсчёт. Шум и эхо уберём автоматически.</p>
                    <button className="record-cta" type="button" onClick={() => void toggleRecord(activeSegment)}>{recording === activeSegment ? 'Остановить запись' : 'Начать запись'}</button><span className="shortcut"><kbd>R</kbd> быстрая запись</span>
                  </aside>
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
                <div><span><BadgeCheck size={17} /> Качество</span><strong>Full HD <ChevronDown size={14} /></strong></div>
              </div>
              {assembly === 'processing' && <div className="render-state"><div><span>Собираем видео</span><strong>{assemblyProgress}%</strong></div><Progress value={assemblyProgress} /><small>Сводим голос, музыку и субтитры</small></div>}
              {assembly === 'done' ? <button className="download-button" type="button" onClick={downloadResult}><Download size={18} /> Скачать результат</button> : <button className="assemble-button" type="button" disabled={assembly === 'processing'} onClick={assembleVideo}><Sparkles size={18} /> {assembly === 'processing' ? 'Обрабатываем…' : 'Собрать видео'}</button>}
              <p className="price-line"><span>{plan === 'Пробный' ? 'Первая обработка бесплатно' : `Тариф «${plan}» активен`}</span><ShieldCheck size={14} /> Без водяного знака</p>
            </section>
            <section className="aside-tip"><span className="tip-icon"><LockKeyhole size={20} /></span><div><strong>Приватный проект</strong><p>Ссылку на результат увидите только вы.</p></div></section>
            <section id="projects" className="quota-card"><div><span>Лимит тарифа</span><strong>{plan === 'Пробный' ? '0 из 1' : '0 из 5'}</strong></div><Progress value={plan === 'Пробный' ? 8 : 2} /><button type="button" onClick={() => setPricingOpen(true)}>Получить ещё обработки <ArrowRight size={15} /></button></section>
          </aside>
        </div>

        {message && <div className="toast-message" role="status"><Check size={17} /><span>{message}</span><button onClick={() => setMessage('')} aria-label="Закрыть сообщение"><X size={15} /></button></div>}
      </main>

      <Dialog open={authOpen} onOpenChange={setAuthOpen}>
        <DialogContent className="product-dialog auth-dialog">
          <DialogHeader><span className="dialog-mark">Д</span><DialogTitle>Войти в Дублику</DialogTitle><DialogDescription>Сохраняйте проекты и продолжайте запись с любого устройства.</DialogDescription></DialogHeader>
          <div className="provider-grid">{['VK', 'Яндекс', 'Google', 'GitHub', 'LinkedIn'].map((provider) => <button key={provider} type="button" onClick={() => demoLogin(provider)}><ProviderIcon name={provider} /><span>{provider}</span></button>)}</div>
          <p className="dialog-legal">Продолжая, вы принимаете условия сервиса и политику конфиденциальности. Сейчас работает демонстрационный вход.</p>
        </DialogContent>
      </Dialog>

      <Dialog open={pricingOpen} onOpenChange={setPricingOpen}>
        <DialogContent className="product-dialog pricing-dialog">
          <DialogHeader><span className="dialog-overline">простые тарифы</span><DialogTitle>Платите только за готовые видео</DialogTitle><DialogDescription>Одна бесплатная обработка для нового пользователя. Без скрытых списаний.</DialogDescription></DialogHeader>
          <div className="plans">
            <button type="button" onClick={() => choosePlan('Старт')}><span className="plan-top"><strong>Старт</strong><em>популярный</em></span><span className="plan-price"><b>150 ₽</b><small>за пакет</small></span><span className="plan-features"><i><Check /> 5 видео до 4 минут</i><i><Check /> Full HD без водяного знака</i><i><Check /> Хранение 7 дней</i></span><span className="plan-cta">Выбрать пакет <ArrowRight /></span></button>
            <button type="button" onClick={() => choosePlan('Автор')}><span className="plan-top"><strong>Автор</strong></span><span className="plan-price"><b>490 ₽</b><small>в месяц</small></span><span className="plan-features"><i><Check /> 25 видео каждый месяц</i><i><Check /> Приоритетная обработка</i><i><Check /> Хранение 30 дней</i></span><span className="plan-cta muted">Оформить подписку <ArrowRight /></span></button>
          </div>
          <p className="dialog-legal">Экран оплаты подготовлен как демо. Для списаний потребуется подключить ЮKassa или CloudPayments.</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
