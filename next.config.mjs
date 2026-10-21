import { fileURLToPath } from 'node:url';
import path from 'node:path';
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
};
export default nextConfig;
