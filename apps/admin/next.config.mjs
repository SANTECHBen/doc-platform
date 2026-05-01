/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Workspace TS packages consumed at runtime — Next must transpile them
  // because they ship as .ts/.tsx source. Without this, webpack tries to
  // resolve `./pdf-kernel.js` literally and fails — the actual file is
  // `.ts`. Same fix as the PWA's next.config.mjs.
  transpilePackages: ['@platform/viewer'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.tsx', '.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};
