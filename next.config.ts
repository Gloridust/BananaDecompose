import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Layer payloads are data URIs; keep server action / route body limits generous.
  experimental: { serverActions: { bodySizeLimit: '24mb' } },
}

export default nextConfig
