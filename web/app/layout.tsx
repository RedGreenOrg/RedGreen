export const metadata = {
  title: 'RedGreen',
  description: 'Reclaim your coding flow state with Type-First Ping-Pong TDD',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}