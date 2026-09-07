/** @type {import('next').NextConfig} */
const nextConfig = {
  // SERVE THE APP AT "/" WITHOUT A REDIRECT.
  //
  // app/page.js used to call redirect('/index.html'). What that actually
  // produced in production was a 307 with NO Location header and Next's error
  // shell as the body — the hop was completed client-side by the Next runtime.
  // A browser therefore got there, after loading an error page and running
  // JavaScript to leave it; anything without JavaScript, a crawler included,
  // got a 307 pointing nowhere. Every manual test of this app used
  // /index.html directly, so nobody ever exercised the front door.
  //
  // A rewrite has no hop at all: "/" serves the file. It has to be
  // `beforeFiles`, because a plain array of rewrites is checked AFTER the
  // filesystem and pages — so it would lose to any page at "/".
  async rewrites() {
    return {
      beforeFiles: [{ source: '/', destination: '/index.html' }],
    };
  },

  // Security headers applied at the Vercel edge (covers static files too)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // X-XSS-Protection is set by middleware.js, to '0', deliberately —
          // the legacy auditor it enables has been used to CREATE injections by
          // stripping part of a response. It was also being set here to
          // '1; mode=block', so the two contradicted each other and which one
          // won came down to ordering. One place, one value.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      // Extra strict headers on the API route
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },

  // Disable the X-Powered-By header (leaks Next.js version info)
  poweredByHeader: false,
};

export default nextConfig;
