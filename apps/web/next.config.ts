import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@brawlhub/shared',
    '@brawlhub/logging',
    '@brawlhub/database',
    '@brawlhub/brawl-stars',
  ],
  reactStrictMode: true,
};

export default nextConfig;
