/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@fineness/shared'],
  env: {
    FINENESS_API: process.env.FINENESS_API ?? 'http://127.0.0.1:8080',
    // Read by the browser for the SSE stream, so it must be reachable from the
    // client rather than from the server process.
    NEXT_PUBLIC_FINENESS_API:
      process.env.NEXT_PUBLIC_FINENESS_API ?? 'http://127.0.0.1:8080',
  },
};
