import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // MyCL hedef-proje DIŞINDA başka lockfile görebildiği için workspace-root'u sabitliyoruz
  // → "multiple lockfiles" uyarısı susar, build temiz kalır.
  experimental: {
    outputFileTracingRoot: __dirname,
  },
  // Lint ayrı bir pipeline fazında (Faz 10) çalışır; build'i lint'e bağlamıyoruz.
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, { dev }) => {
    if (dev) {
      // CSP: webpack'in varsayılan 'eval' tabanlı devtool'u 'unsafe-eval' gerektirir.
      // Katı CSP'de (unsafe-eval YOK) dev'de de çalışabilmek için eval'siz source map kullanıyoruz.
      config.devtool = 'cheap-module-source-map';
    }
    return config;
  },
};

export default nextConfig;
