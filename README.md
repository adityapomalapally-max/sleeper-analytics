# Sleeper Analytics

The deepest fantasy football analytics platform — power rankings, AI-powered trade advice, what-if scenarios, optimal lineups, and full league history.

## Features

- **10 Analysis Tabs**: Standings, Power Rankings, Scoring, Luck Index, Matchups, H2H Matrix, My Team, Season Recap, What-If, League History
- **AI Assistant**: Gemini-powered fantasy analyst that knows your roster, grades, and league context
- **Keeper values**: VORP read from The Signal — the projected points of the slot a player was ranked into, above the replacement player at his position. The order is a hand ranking, the scale is a projection set, and both travel with the number. A player the data does not rank carries **no** value rather than an estimated one, and draft picks are not priced at all.
- **Optimal Lineup Analysis**: See what your record would be if you set perfect lineups
- **Full League History**: Automatic loading of all past seasons via Sleeper's API

## Quick Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) and import the repo
3. Add environment variable: `GEMINI_API_KEY` = your Gemini API key
4. Deploy — done!

## Local Development

```bash
npm install
cp .env.example .env.local
# Edit .env.local with your Gemini API key from https://aistudio.google.com/apikey
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Architecture

- **Frontend**: Single self-contained HTML file (`public/index.html`) — vanilla JS, no framework
- **Backend**: Next.js API route (`app/api/chat/route.js`) — Gemini proxy with IP-based rate limiting (30 req/day)
- **Data**: League data from Sleeper's public API (no key needed). Player values, ranks, projections and the assistant's facts come from The Signal's published JSON, read server-side (`lib/moat.js`, `lib/values.js`) and served by `/api/values` — the browser cannot fetch it directly, because it is another origin and this app's CSP allows only itself and Sleeper.
- **AI**: Gemini via a server-side proxy (key hidden from users). The model is a FALLBACK CHAIN, not a pinned name — `gemini-2.5-flash` first, then newer flash releases — because `gemini-2.0-flash`, which this file used to name, was retired and every chat request failed while `/api/health` still reported the key as configured. A pinned model name is a dependency with an expiry date on it.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key ([get one free](https://aistudio.google.com/apikey)) |
