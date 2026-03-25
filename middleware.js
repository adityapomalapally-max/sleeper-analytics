import { NextResponse } from 'next/server';

export function middleware(request) {
  const response = NextResponse.next();

  // --- Security Headers ---

  // Prevent clickjacking — your app should not be iframed by others
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Control referrer information leakage
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy — disable features you don't use
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );

  // XSS Protection (legacy browsers)
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Content Security Policy
  // - 'self' for scripts/styles/fonts from your own domain
  // - Google Fonts for the font imports
  // - Sleeper API + Gemini API for fetch calls
  // - data: and blob: for inline images/avatars from Sleeper
  // - 'unsafe-inline' for styles (needed since the app uses inline styles heavily)
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://sleepercdn.com https://*.sleepercdn.com https://api.sleeper.app",
      "connect-src 'self' https://api.sleeper.app https://generativelanguage.googleapis.com",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  // Strict Transport Security — force HTTPS (Vercel handles TLS, but this tells browsers to always use HTTPS)
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload'
  );

  return response;
}

// Apply to all routes
export const config = {
  matcher: [
    // Match all paths except static files and Next.js internals
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
