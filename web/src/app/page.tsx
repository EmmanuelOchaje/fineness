/**
 * The feed — "Newly struck".
 *
 * Server-renders the current snapshot so the first paint is never empty, then
 * hands off to LiveFeed which subscribes to the API's SSE stream. If the stream
 * cannot connect, the server snapshot remains on screen and the header says
 * SNAPSHOT rather than pretending to be live.
 */
import { getFeed } from '@/lib/api';
import { LiveFeed } from '@/components/LiveFeed';

export const dynamic = 'force-dynamic';

export default async function FeedPage() {
  const rows = await getFeed(100);
  // The browser talks to the API directly for the stream, so it needs a URL
  // reachable from the client, not from the server process.
  const apiBase = process.env.NEXT_PUBLIC_FINENESS_API ?? 'http://127.0.0.1:8080';

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', minHeight: '100vh' }}>
      <LiveFeed initial={rows} apiBase={apiBase} />
    </main>
  );
}
