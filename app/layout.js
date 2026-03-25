export const metadata = {
  title: 'Sleeper Analytics — Fantasy Football Intelligence Platform',
  description: 'Power rankings, player-level recaps, what-if scenarios, optimal lineups, AI-powered trade advice — the deepest fantasy football analytics tool ever built.',
  openGraph: {
    title: 'Sleeper Analytics',
    description: 'The deepest fantasy football analytics platform. Power rankings, AI trade advice, what-if scenarios, and more.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Sleeper Analytics',
    description: 'The deepest fantasy football analytics platform ever built.',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
