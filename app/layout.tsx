import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Дублика — студия дубляжа в браузере',
  description:
    'Загрузите видео, выберите отрывок, запишите реплики и соберите готовый дубляж.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
