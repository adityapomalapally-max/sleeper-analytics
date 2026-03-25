# Sleeper Analytics

The deepest fantasy football analytics platform — power rankings, AI-powered trade advice, what-if scenarios, optimal lineups, and full league history.

## Features

- **10 Analysis Tabs**: Standings, Power Rankings, Scoring, Luck Index, Matchups, H2H Matrix, My Team, Season Recap, What-If, League History
- **AI Assistant**: Gemini-powered fantasy analyst that knows your roster, grades, and league context
- **Dynasty Rankings**: KTC-style keeper values with superflex positional weighting
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
- **Data**: All fantasy data from Sleeper's public API (no key needed)
- **AI**: Google Gemini 2.0 Flash via server-side proxy (key hidden from users)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key ([get one free](https://aistudio.google.com/apikey)) |
