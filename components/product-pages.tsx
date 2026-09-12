'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Check,
  ChevronRight,
  Clapperboard,
  Clock3,
  Compass,
  Crown,
  FileVideo,
  Film,
  FolderOpen,
  Headphones,
  Heart,
  LayoutDashboard,
  Mail,
  Menu,
  MessageCircle,
  Mic2,
  Moon,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  UploadCloud,
  Users,
  WandSparkles,
} from 'lucide-react';

import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Progress } from '@/components/ui/progress';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { apiFetch, mediaUrl } from '@/lib/local-api';

export type Navigate = (path: string) => void;

type PageProps = {
  route: string;
  navigate: Navigate;
  darkMode: boolean;
  toggleTheme: () => void;
  signedIn: boolean;
  onSignedIn: (email: string) => void;
  notify: (message: string) => void;
};

type Template = {
  id: number;
  title: string;
  category: string;
  author: string;
  duration: string;
  lines: number;
  accent: string;
  trend?: string;
  community?: boolean;
};

export const templates: Template[] = [
  { id: 1, title: 'Созвон пошёл не по плану', category: 'Комедия', author: 'Дублика', duration: '0:42', lines: 8, accent: 'lime', trend: '#офис' },
  { id: 2, title: 'Кот спорит с роботом', category: 'Мем', author: 'Маша К.', duration: '0:28', lines: 6, accent: 'aqua', community: true },
  { id: 3, title: 'Финальная речь героя', category: 'Фэнтези', author: 'Дублика', duration: '1:14', lines: 12, accent: 'violet', trend: '#эпик' },
  { id: 4, title: 'Трейлер моего стартапа', category: 'Трейлер', author: 'Илья Б.', duration: '0:36', lines: 5, accent: 'orange', community: true },
  { id: 5, title: 'Очень серьёзный прогноз', category: 'Пародия', author: 'Дублика', duration: '0:51', lines: 9, accent: 'blue' },
  { id: 6, title: 'Когда забыл выключить микрофон', category: 'Комедия', author: 'Лера С.', duration: '0:33', lines: 7, accent: 'pink', community: true },
  { id: 7, title: 'Погоня в час пик', category: 'Экшен', author: 'Дублика', duration: '1:08', lines: 10, accent: 'red', trend: '#экшен' },
  { id: 8, title: 'Интервью с пришельцем', category: 'Фантастика', author: 'Кирилл Д.', duration: '0:57', lines: 11, accent: 'mint', community: true },
  { id: 9, title: 'Неловкое первое свидание', category: 'Романтика', author: 'Дублика', duration: '0:46', lines: 9, accent: 'rose' },
  { id: 10, title: 'Босс финального уровня', category: 'Игры', author: 'Аня Р.', duration: '1:02', lines: 13, accent: 'yellow', community: true },
  { id: 11, title: 'Документалка про холодильник', category: 'Пародия', author: 'Дублика', duration: '0:38', lines: 6, accent: 'ice' },
  { id: 12, title: 'Новости из параллельной вселенной', category: 'Мем', author: 'Саша Т.', duration: '0:49', lines: 8, accent: 'purple', community: true },
];

const menuItems = [
  { path: '/studio', label: 'Сделать видео', icon: Plus },
  { path: '/dashboard', label: 'Обзор', icon: LayoutDashboard },
  { path: '/videos', label: 'Мои видео', icon: FolderOpen },
  { path: '/community', label: 'Витрина', icon: Compass },
  { path: '/guide', label: 'Инструкция', icon: BookOpen },
];

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="product-logo">
      <span className="product-logo-mark">Д</span>
      {!compact && <span>дублика</span>}
    </span>
  );
}

function useProfileName() {
  const [profileName, setProfileName] = useState('Профиль');
  useEffect(() => {
    const email = String(window.localStorage.getItem('dublika-user') || '').trim();
    setProfileName(email ? email.split('@')[0] : 'Профиль');
  }, []);
  return profileName;
}

function ThemeButton({ darkMode, toggleTheme }: Pick<PageProps, 'darkMode' | 'toggleTheme'>) {
  return (
    <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={darkMode ? 'Включить светлую тему' : 'Включить тёмную тему'}>
      {darkMode ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function PublicHeader({ navigate, darkMode, toggleTheme, signedIn }: Pick<PageProps, 'navigate' | 'darkMode' | 'toggleTheme' | 'signedIn'>) {
  return (
    <header className="public-header">
      <button className="logo-button" type="button" onClick={() => navigate('/')}><Logo /></button>
      <nav aria-label="Навигация сайта">
        <button type="button" onClick={() => navigate('/#how')}>Как работает</button>
        <button type="button" onClick={() => navigate('/catalog')}>Сцены</button>
        <button type="button" onClick={() => navigate('/community')}>Витрина</button>
        <button type="button" onClick={() => navigate('/#pricing')}>Тарифы</button>
      </nav>
      <div className="public-actions">
        <ThemeButton darkMode={darkMode} toggleTheme={toggleTheme} />
        <button className="public-login" type="button" onClick={() => navigate(signedIn ? '/dashboard' : '/auth')}>{signedIn ? 'Кабинет' : 'Войти'}</button>
        <button className="header-cta" type="button" onClick={() => navigate('/catalog')}>Попробовать</button>
      </div>
    </header>
  );
}

function PublicFooter({ navigate }: Pick<PageProps, 'navigate'>) {
  return (
    <footer className="public-footer">
      <div><Logo /><p>Говорите за любимых героев.<br />Мы позаботимся обо всём остальном.</p></div>
      <div><strong>Продукт</strong><button onClick={() => navigate('/catalog')}>Сцены</button><button onClick={() => navigate('/community')}>Витрина</button><button onClick={() => navigate('/guide')}>Инструкция</button></div>
      <div><strong>Документы</strong><button>Условия</button><button>Конфиденциальность</button><button>Правообладателям</button></div>
      <div className="footer-status"><span><i /> Все системы работают</span><small>© 2026 Дублика</small></div>
    </footer>
  );
}

function TemplateCard({ item, onSelect }: { item: Template; onSelect: () => void }) {
  return (
    <article className="template-card">
      <button className={`template-poster accent-${item.accent}`} type="button" onClick={onSelect} aria-label={`Открыть сцену «${item.title}»`}>
        <span className="poster-grid" />
        <span className="poster-category">{item.category}</span>
        <span className="poster-play"><Play size={19} fill="currentColor" /></span>
        <span className="poster-wave">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ height: `${20 + ((i * 17 + item.id * 13) % 62)}%` }} />)}</span>
        {item.community && <span className="community-badge"><Users size={12} /> общий проект</span>}
      </button>
      <div className="template-copy">
        <button type="button" onClick={onSelect}>{item.title}</button>
        <div><span className="creator-avatar">{item.author.slice(0, 1)}</span><span>{item.author}</span><i /><span>{item.duration}</span><i /><span>{item.lines} реплик</span></div>
      </div>
      <button className="card-heart" type="button" aria-label="Добавить в избранное"><Heart size={17} /></button>
    </article>
  );
}

function LandingPage(props: PageProps) {
  const { navigate } = props;
  const gate = (scene?: number) => navigate(props.signedIn ? `/studio${scene ? `?scene=${scene}` : ''}` : `/auth?next=/studio${scene ? `&scene=${scene}` : ''}`);
  return (
    <div className="public-page landing-page">
      <PublicHeader {...props} />
      <main>
        <section className="landing-hero">
          <div className="hero-copy">
            <div className="hero-kicker"><span><Sparkles size={14} /> 3 видео бесплатно</span><em>без карты</em></div>
            <h1>Ваш голос.<br /><span>Любая сцена.</span></h1>
            <p>Запишите реплики — Дублика уберёт оригинальный голос, сохранит музыку и соберёт готовое видео.</p>
            <div className="hero-actions">
              <button className="hero-primary" type="button" onClick={() => navigate('/catalog')}>Попробовать бесплатно <ArrowRight size={19} /></button>
              <button className="hero-secondary" type="button" onClick={() => document.getElementById('demo-video')?.scrollIntoView({ behavior: 'smooth' })}><Play size={17} fill="currentColor" /> Смотреть пример</button>
            </div>
            <div className="hero-trust"><span><Check /> Не нужна студия</span><span><Check /> До 4 минут</span><span><Check /> Без водяного знака</span></div>
          </div>
          <div id="demo-video" className="hero-video-wrap">
            <div className="video-orbit orbit-one" /><div className="video-orbit orbit-two" />
            <div className="hero-video-card">
              <div className="video-chrome"><span><i /> пример дубляжа</span><span>00:18</span></div>
              <video src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" autoPlay muted loop playsInline />
              <div className="video-caption"><span>Реплика 2 / 5</span><strong>«Давайте попробуем ещё раз»</strong></div>
              <div className="voice-pill"><span><Mic2 size={15} /></span><div><strong>Ваш голос</strong><small>шум удалён</small></div><div className="tiny-wave">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ height: `${25 + (i * 23) % 66}%` }} />)}</div></div>
            </div>
            <div className="floating-score"><span>совпадение</span><strong>94%</strong><Progress value={94} /></div>
          </div>
        </section>

        <section className="proof-strip"><span>Видео</span><i /><strong>Реплики</strong><i /><span>Ваш голос</span><i /><strong>Готовый дубляж</strong></section>

        <section id="how" className="how-section">
          <div className="section-intro"><span>как это работает</span><h2>От видео до дубляжа<br />за четыре шага</h2><p>Никаких сложных дорожек и ручного монтажа. Ведём по сцене реплика за репликой.</p></div>
          <div className="how-grid">
            {[['01', UploadCloud, 'Загрузите видео', 'С компьютера, по прямой ссылке, из YouTube или VK Видео.'], ['02', WandSparkles, 'Получите реплики', 'Распознаем речь, таймкоды и подготовим редактируемые субтитры.'], ['03', Mic2, 'Запишите голос', 'Перезаписывайте сколько угодно — шум и эхо уберём автоматически.'], ['04', Film, 'Скачайте результат', 'Вернём музыку и эффекты, сведём дорожки и соберём Full HD.']].map(([num, Icon, title, text]) => {
              const StepIcon = Icon as typeof UploadCloud;
              return <article key={String(num)}><span className="how-number">{num as string}</span><span className="how-icon"><StepIcon /></span><h3>{title as string}</h3><p>{text as string}</p></article>;
            })}
          </div>
        </section>

        <section className="home-showcase">
          <div className="showcase-heading"><div><span>выбирают сейчас</span><h2>Сцены для первого дубля</h2></div><button type="button" onClick={() => navigate('/catalog')}>Все 12 сцен <ArrowRight size={17} /></button></div>
          <div className="template-grid home-template-grid">{templates.slice(0, 4).map((item) => <TemplateCard key={item.id} item={item} onSelect={() => gate(item.id)} />)}</div>
        </section>

        <section id="pricing" className="landing-pricing">
          <div><span className="price-eyebrow">начните бесплатно</span><h2>Три дубля — наши.<br />Дальше от 30 ₽ за видео.</h2><p>Без подписки по умолчанию. Пакет из 5 обработок стоит 150 ₽.</p></div>
          <div className="price-ticket"><span>Старт</span><strong>150 ₽</strong><small>5 видео · Full HD · 7 дней хранения</small><button type="button" onClick={() => gate()}>Попробовать 3 бесплатно <ArrowRight /></button></div>
        </section>
      </main>
      <PublicFooter navigate={navigate} />
    </div>
  );
}

function CatalogPage(props: PageProps) {
  const [filter, setFilter] = useState('Все');
  const { navigate } = props;
  const shown = filter === 'Все' ? templates : templates.filter((item) => item.category === filter || (filter === 'Общие' && item.community));
  const gate = (scene?: number) => navigate(props.signedIn ? `/studio${scene ? `?scene=${scene}` : ''}` : `/auth?next=/studio${scene ? `&scene=${scene}` : ''}`);
  return (
    <div className="public-page catalog-page">
      <PublicHeader {...props} />
      <main className="catalog-main">
        <button className="back-link" type="button" onClick={() => navigate('/')}><ArrowLeft size={17} /> На главную</button>
        <section className="catalog-heading"><div><span>студия начинается здесь</span><h1>Выберите, что<br /><em>озвучить</em></h1><p>Загрузите свой ролик или возьмите готовую сцену. Перед записью попросим войти.</p></div><div className="catalog-count"><strong>12</strong><span>сцен готовы<br />к записи</span></div></section>

        <button className="own-video-card" type="button" onClick={() => gate()}>
          <span className="own-video-icon"><UploadCloud /></span>
          <span><strong>Загрузить своё видео</strong><small>MP4, MOV, WebM или ссылка на YouTube / VK Видео · до 4 минут</small></span>
          <span className="own-video-action">Начать <ArrowRight /></span>
        </button>

        <section className="catalog-browser">
          <div className="catalog-tools"><div><span>готовые сцены</span><h2>Популярное для дубляжа</h2></div><label><Search size={17} /><input placeholder="Найти сцену" aria-label="Найти сцену" /></label></div>
          <div className="filter-row">{['Все', 'Общие', 'Комедия', 'Мем', 'Экшен', 'Пародия'].map((item) => <button className={filter === item ? 'is-active' : ''} type="button" key={item} onClick={() => setFilter(item)}>{item}</button>)}</div>
          <div className="template-grid">{shown.map((item) => <TemplateCard key={item.id} item={item} onSelect={() => gate(item.id)} />)}</div>
        </section>

        <section className="community-callout"><span><Users /></span><div><strong>Есть идея для общей сцены?</strong><p>Опубликуйте проект, распределите реплики и соберите дубляж вместе.</p></div><button type="button" onClick={() => gate()}>Создать общий проект <ArrowRight /></button></section>
      </main>
      <PublicFooter navigate={navigate} />
    </div>
  );
}

function AuthPage(props: PageProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [oauthStarting, setOauthStarting] = useState<string | null>(null);
  const next = new URLSearchParams(props.route.split('?')[1] ?? '').get('next') || '/studio';

  useEffect(() => {
    void apiFetch<{ providers: Array<{ id: string; label: string }> }>('/auth/providers')
      .then((result) => setOauthProviders(result.providers || []))
      .catch(() => setOauthProviders([]));
  }, []);

  useEffect(() => {
    const ticket = new URLSearchParams(props.route.split('?')[1] ?? '').get('oauth_ticket');
    if (!ticket) return;
    setSubmitting(true);
    void apiFetch<{ token: string; user: { email: string; credits: number }; next?: string }>('/auth/oauth/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    }).then((result) => {
      window.localStorage.setItem('dublika-token', result.token);
      window.localStorage.setItem('dublika-credits', String(result.user.credits));
      props.onSignedIn(result.user.email);
      props.navigate(result.next || next);
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Не удалось завершить вход.');
      setSubmitting(false);
    });
  // The ticket is one-time and disappears after navigation; reacting to the
  // route alone avoids re-consuming it when parent callbacks are recreated.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [props.route]);

  async function sendCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Введите корректную почту'); return; }
    setSubmitting(true);
    try {
      const result = await apiFetch<{ devCode?: string }>('/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      // A code is shown only by the loopback-only local development server.
      // Production delivery happens by email and never reveals the OTP in UI.
      setDevCode(result.devCode || null);
      setError('');
      setStep('code');
      props.notify('Код для входа готов.');
    } catch (cause) {
      setDevCode(null);
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить код. Попробуйте ещё раз.');
    } finally { setSubmitting(false); }
  }

  async function verify() {
    setSubmitting(true);
    try {
      const result = await apiFetch<{ token: string; user: { credits: number } }>('/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) });
      window.localStorage.setItem('dublika-token', result.token);
      window.localStorage.setItem('dublika-credits', String(result.user.credits));
      props.onSignedIn(email);
      props.navigate(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Неверный код');
    } finally { setSubmitting(false); }
  }

  async function startOauth(provider: string) {
    setOauthStarting(provider);
    setError('');
    try {
      const result = await apiFetch<{ authorizationUrl: string }>('/auth/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, next }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось открыть вход через провайдера.');
      setOauthStarting(null);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-brand"><button type="button" onClick={() => props.navigate('/')}><Logo /></button><ThemeButton darkMode={props.darkMode} toggleTheme={props.toggleTheme} /></div>
      <div className="auth-visual">
        <div className="auth-visual-copy"><span><Sparkles /> 3 видео в подарок</span><h1>Один вход.<br />Все ваши <em>голоса.</em></h1><p>Проекты, записи и готовые видео будут доступны на любом устройстве.</p></div>
        <div className="auth-reel"><span className="reel-one" /><span className="reel-two" /><div className="auth-wave">{Array.from({ length: 36 }, (_, i) => <i key={i} style={{ height: `${18 + ((i * 29) % 78)}%` }} />)}</div><div className="auth-quote">«А теперь — вашим голосом»</div></div>
      </div>
      <main className="auth-panel">
        <div className="auth-card">
          <button className="auth-back" type="button" onClick={() => step === 'code' ? setStep('email') : props.navigate('/catalog')}><ArrowLeft /> Назад</button>
          {step === 'email' ? (
            <>
              <div className="auth-title"><span>добро пожаловать</span><h2>Войдите или создайте аккаунт</h2><p>Никаких паролей — пришлём короткий код на почту.</p></div>
              <label className="email-field"><span>Электронная почта</span><div><Mail /><input value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && sendCode()} placeholder="name@example.ru" autoComplete="email" /></div></label>
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-submit" type="button" disabled={submitting} onClick={() => void sendCode()}>{submitting ? 'Создаём код…' : 'Получить код'} <ArrowRight /></button>
              {oauthProviders.length > 0 && <><div className="auth-divider"><span>или</span></div><div className="oauth-provider-list">{oauthProviders.map((provider) => <button className="telegram-button oauth-provider" type="button" key={provider.id} disabled={Boolean(oauthStarting) || submitting} onClick={() => void startOauth(provider.id)}><MessageCircle fill="currentColor" /> {oauthStarting === provider.id ? 'Открываем…' : `Продолжить через ${provider.label}`}</button>)}</div></>}
            </>
          ) : (
            <>
              <div className="auth-title"><span>проверьте почту</span><h2>Введите код из письма</h2><p>Отправили шесть цифр на <strong>{email}</strong></p></div>
              <InputOTP maxLength={6} value={code} onChange={setCode} containerClassName="otp-input">
                <InputOTPGroup>{Array.from({ length: 6 }, (_, index) => <InputOTPSlot index={index} key={index} className="otp-slot" />)}</InputOTPGroup>
              </InputOTP>
              {devCode && <div className="demo-code"><BadgeCheck /> Код для локальной проверки: <strong>{devCode}</strong></div>}
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-submit" type="button" disabled={submitting} onClick={() => void verify()}>{submitting ? 'Проверяем…' : 'Войти в Дублику'} <ArrowRight /></button>
              <button className="resend-button" type="button" onClick={() => void sendCode()}>Отправить код ещё раз</button>
            </>
          )}
          <p className="auth-legal">Продолжая, вы принимаете условия использования и политику конфиденциальности.</p>
        </div>
      </main>
    </div>
  );
}

export function AppSidebar({ route, navigate }: { route: string; navigate: Navigate }) {
  const profileName = useProfileName();
  return (
    <Sidebar collapsible="icon" className="app-sidebar">
      <SidebarHeader><button className="sidebar-logo" type="button" onClick={() => navigate('/')}><Logo /></button></SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => <SidebarMenuItem key={item.path}><SidebarMenuButton tooltip={item.label} isActive={route === item.path} onClick={() => navigate(item.path)}><item.icon /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton tooltip="Настройки" isActive={route === '/settings'} onClick={() => navigate('/settings')}><Settings /><span>Настройки</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        <button className="sidebar-user" type="button" onClick={() => navigate('/settings')}><span>{profileName.slice(0, 1).toUpperCase()}</span><div><strong>{profileName}</strong></div><ChevronRight /></button>
      </SidebarFooter>
    </Sidebar>
  );
}

function DashboardHeader(props: PageProps) {
  const profileName = useProfileName();
  return <header className="dashboard-topbar"><SidebarTrigger><Menu /></SidebarTrigger><div className="dashboard-crumb"><span>Дублика</span><ChevronRight /><strong>{menuItems.find((item) => item.path === props.route)?.label || 'Кабинет'}</strong></div><div><ThemeButton darkMode={props.darkMode} toggleTheme={props.toggleTheme} /><button className="dashboard-avatar" type="button" aria-label="Открыть настройки">{profileName.slice(0, 1).toUpperCase()}</button></div></header>;
}

function DashboardHome({ navigate }: Pick<PageProps, 'navigate'>) {
  return (
    <div className="dashboard-content">
      <section className="dash-welcome"><div><span>ваша студия</span><h1>Что озвучим сегодня?</h1><p>У вас три бесплатные обработки — карты и подписка не нужны.</p></div><button type="button" onClick={() => navigate('/catalog')}><Plus /> Сделать видео</button></section>
      <div className="stats-grid">
        <article><span className="stat-icon lime"><Clapperboard /></span><div><small>Бесплатные обработки</small><strong>3 <em>из 3</em></strong></div><Progress value={100} /></article>
        <article><span className="stat-icon aqua"><Clock3 /></span><div><small>Минут озвучено</small><strong>0:00</strong></div><span className="stat-note">Начните первый проект</span></article>
        <article><span className="stat-icon violet"><Users /></span><div><small>Общие проекты</small><strong>0</strong></div><span className="stat-note">Пригласите друзей</span></article>
      </div>
      <section className="recent-projects"><div className="dash-section-title"><div><span>мои видео</span><h2>Последние проекты</h2></div><button type="button" onClick={() => navigate('/videos')}>Смотреть все <ArrowRight /></button></div><div className="project-empty"><span><FileVideo /></span><h3>Здесь появятся ваши дубляжи</h3><p>Загрузите видео или возьмите сцену из каталога.</p><button type="button" onClick={() => navigate('/catalog')}>Создать первый проект</button></div></section>
      <section className="dash-scenes"><div className="dash-section-title"><div><span>быстрый старт</span><h2>Популярные сцены</h2></div><button type="button" onClick={() => navigate('/catalog')}>Весь каталог <ArrowRight /></button></div><div className="template-grid dash-template-grid">{templates.slice(0, 3).map((item) => <TemplateCard item={item} key={item.id} onSelect={() => navigate(`/studio?scene=${item.id}`)} />)}</div></section>
    </div>
  );
}

type LibraryProject = {
  id: string;
  title: string;
  status: 'uploaded' | 'ready' | 'processing' | 'done' | 'failed';
  progress?: number;
  clips?: Array<{ start: number; end: number }>;
  trim?: { start: number; end: number } | null;
  segments?: unknown[];
  outputUrl?: string | null;
  updatedAt?: string;
};

function libraryDuration(project: LibraryProject) {
  const seconds = project.clips?.length ? project.clips.reduce((total, clip) => total + clip.end - clip.start, 0) : project.trim ? project.trim.end - project.trim.start : 0;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function VideosPage({ navigate }: Pick<PageProps, 'navigate'>) {
  const [projects, setProjects] = useState<LibraryProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'done'>('all');

  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ projects: LibraryProject[] }>('/projects')
      .then((result) => { if (!cancelled) setProjects(result.projects.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить библиотеку'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const visible = projects.filter((project) => filter === 'all' || filter === 'done' ? filter !== 'done' || project.status === 'done' : project.status !== 'done');
  const drafts = projects.filter((project) => project.status !== 'done').length;
  const completed = projects.filter((project) => project.status === 'done').length;
  const statusLabel: Record<LibraryProject['status'], string> = { uploaded: 'Видео загружено', ready: 'Черновик', processing: 'Собирается', done: 'Готово', failed: 'Нужна проверка' };
  return <div className="dashboard-content"><section className="inner-heading"><div><span>ваша библиотека</span><h1>Мои видео</h1><p>Черновики, готовые дубляжи и общие проекты.</p></div><button onClick={() => navigate('/studio')}><Plus /> Новое видео</button></section><div className="library-tabs"><button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Все <span>{projects.length}</span></button><button className={filter === 'draft' ? 'is-active' : ''} onClick={() => setFilter('draft')}>Черновики <span>{drafts}</span></button><button className={filter === 'done' ? 'is-active' : ''} onClick={() => setFilter('done')}>Готовые <span>{completed}</span></button></div>{loading ? <section className="library-empty"><div className="empty-reel"><Film /><span /></div><h2>Загружаем библиотеку…</h2><p>Собираем ваши проекты.</p></section> : error ? <section className="library-empty"><div className="empty-reel"><FileVideo /><span /></div><h2>Библиотека пока недоступна</h2><p>{error}</p><button onClick={() => window.location.reload()}>Повторить <ArrowRight /></button></section> : visible.length ? <section className="video-library">{visible.map((project) => <article key={project.id}><div className="video-library-thumb"><Film /><span>{project.status === 'done' ? <BadgeCheck /> : <FileVideo />}</span></div><div className="video-library-copy"><span>{statusLabel[project.status]}</span><h2>{project.title.replace(/\.[^.]+$/, '')}</h2><p>{libraryDuration(project)} · {project.segments?.length || 0} реплик · {project.clips?.length || 1} фрагм.</p>{project.status === 'processing' && <Progress value={project.progress || 0} />}</div><div className="video-library-actions">{project.status === 'done' && project.outputUrl && <a href={mediaUrl(project.outputUrl)} target="_blank" rel="noreferrer"><Play /> Открыть MP4</a>}<button type="button" onClick={() => navigate(`/studio?project=${project.id}`)}>{project.status === 'done' ? 'Открыть проект' : 'Продолжить'} <ArrowRight /></button></div></article>)}</section> : <section className="library-empty"><div className="empty-reel"><Film /><span /></div><h2>Пока ни одного видео</h2><p>Первый дубляж займёт несколько минут. Выберите готовую сцену или загрузите свою.</p><button onClick={() => navigate('/studio')}>Создать видео <ArrowRight /></button></section>}</div>;
}

function GuidePage({ navigate }: Pick<PageProps, 'navigate'>) {
  return <div className="dashboard-content"><section className="inner-heading"><div><span>начните за 5 минут</span><h1>Как сделать дубляж</h1><p>Короткая инструкция от загрузки до готового ролика.</p></div><button onClick={() => navigate('/catalog')}>Попробовать <ArrowRight /></button></section><div className="guide-layout"><nav><strong>В этой инструкции</strong>{['Подготовьте видео', 'Выберите отрывок', 'Проверьте реплики', 'Запишите голос', 'Скачайте результат'].map((item, i) => <a href={`#guide-${i + 1}`} key={item}><span>0{i + 1}</span>{item}</a>)}</nav><div className="guide-steps">{[['Подготовьте видео', 'Загрузите файл MP4, MOV или WebM. Можно вставить прямую ссылку, ссылку на YouTube или VK Видео. Используйте только контент, на который у вас есть права.'], ['Выберите отрывок', 'Передвиньте границы на таймлайне. Один проект может содержать до четырёх минут видео — этого хватает для полноценной сцены.'], ['Проверьте реплики', 'Дублика распознает речь и делит её по паузам. Исправьте текст субтитров, если герой говорит имя, сленг или редкое слово.'], ['Запишите голос', 'Слушайте оригинал и записывайте свою версию. Каждый дубль можно повторить. Шумоподавление и выравнивание громкости включены автоматически.'], ['Скачайте результат', 'После записи Дублика вернёт фоновую музыку и эффекты, сведёт дорожки и подготовит MP4 без водяного знака.']].map(([title, text], i) => <article id={`guide-${i + 1}`} key={title}><span>0{i + 1}</span><div><h2>{title}</h2><p>{text}</p>{i === 3 && <div className="guide-tip"><Headphones /><span><strong>Совет</strong>Используйте наушники, чтобы оригинальная реплика не попала в запись.</span></div>}</div></article>)}</div></div></div>;
}

function CommunityPage({ navigate }: Pick<PageProps, 'navigate'>) {
  return <div className="dashboard-content"><section className="inner-heading community-heading"><div><span>делайте вместе</span><h1>Витрина сообщества</h1><p>Открытые сцены: выберите героя, запишите реплики и станьте частью общего дубляжа.</p></div><button onClick={() => navigate('/studio')}><Users /> Создать общий проект</button></section><div className="community-stats"><span><strong>48</strong> открытых ролей</span><span><strong>126</strong> дубляжей за неделю</span><span><strong>2 840</strong> участников</span></div><div className="template-grid community-grid">{templates.filter((item) => item.community).map((item) => <TemplateCard item={item} key={item.id} onSelect={() => navigate(`/studio?scene=${item.id}`)} />)}</div></div>;
}

function SettingsPage(props: PageProps) {
  const profileName = useProfileName();
  const email = typeof window === 'undefined' ? '' : String(window.localStorage.getItem('dublika-user') || '');
  return <div className="dashboard-content"><section className="inner-heading"><div><span>аккаунт</span><h1>Настройки</h1><p>Профиль, уведомления и приватность проектов.</p></div></section><div className="settings-grid"><section><h2>Профиль</h2><div className="settings-profile"><span>{profileName.slice(0, 1).toUpperCase()}</span><div><strong>{profileName}</strong><small>{email || 'Войдите по почте'}</small></div><button>Изменить фото</button></div><label>Имя<input defaultValue={profileName === 'Профиль' ? '' : profileName} placeholder="Как вас называть" /></label><label>Электронная почта<input defaultValue={email} placeholder="you@example.com" /></label><button className="settings-save" onClick={() => props.notify('Настройки сохранены')}>Сохранить изменения</button></section><section><h2>Приватность</h2><div className="security-row"><ShieldCheck /><div><strong>Приватные проекты по умолчанию</strong><small>Только вы видите исходники и готовые видео.</small></div><span className="fake-switch is-on"><i /></span></div><div className="security-row"><Mail /><div><strong>Письма о готовности</strong><small>Сообщим, когда обработка закончится.</small></div><span className="fake-switch is-on"><i /></span></div><div className="security-row"><Crown /><div><strong>Автоудаление исходников</strong><small>Через 24 часа после готовности видео.</small></div><span className="fake-switch is-on"><i /></span></div></section></div></div>;
}

function DashboardPage(props: PageProps) {
  return (
    <SidebarProvider defaultOpen>
      <AppSidebar route={props.route} navigate={props.navigate} />
      <SidebarInset className="dashboard-inset">
        <DashboardHeader {...props} />
        {props.route === '/videos' ? <VideosPage navigate={props.navigate} /> : props.route === '/guide' ? <GuidePage navigate={props.navigate} /> : props.route === '/community' ? <CommunityPage navigate={props.navigate} /> : props.route === '/settings' ? <SettingsPage {...props} /> : <DashboardHome navigate={props.navigate} />}
      </SidebarInset>
    </SidebarProvider>
  );
}

export function ProductPages(props: PageProps) {
  const path = props.route.split('?')[0].split('#')[0] || '/';
  if (path === '/catalog') return <CatalogPage {...props} route={path} />;
  if (path === '/auth') return <AuthPage {...props} />;
  if (['/dashboard', '/videos', '/guide', '/community', '/settings'].includes(path)) return <DashboardPage {...props} route={path} />;
  return <LandingPage {...props} route={path} />;
}
