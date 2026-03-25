// Simple health check — useful for uptime monitoring
export async function GET() {
  return Response.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gemini_configured: !!process.env.GEMINI_API_KEY,
  });
}
