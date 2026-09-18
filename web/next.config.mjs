/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@fineness/shared'],
  env: {
    FINENESS_API: process.env.FINENESS_API ?? 'http://127.0.0.1:8080',
  },
};
