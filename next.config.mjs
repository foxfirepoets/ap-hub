/** @type {import('next').NextConfig} */
// Next.js App Router config for the human UX layer.
// - `typescript.tsconfigPath` points `next build` at a WEB-ONLY tsconfig so the app/
//   tree is typechecked WITHOUT touching the src/** gate's tsconfig.json (which stays
//   scoped to src+test). This is how the otherwise-outside-the-gate app/ code gets
//   real type coverage (see ralph guardrails).
// - ESLint during build is skipped: the gate lints src/** with the repo eslint config;
//   the app/ tree's correctness is covered by `next build` typechecking + the Playwright E2E.
const nextConfig = {
  reactStrictMode: true,
  // Windows + Node 24 build-trace collection for `_not-found`/500 hits an ENOENT during
  // `next build` (collect-build-traces.js can't find/rename its own .nft.json/export
  // files) — a Next 14.2.x env quirk, not app code (compile + typecheck + all 33 pages
  // still succeed first). This app is served via `next start`, never Vercel serverless
  // bundling, so the trace manifests this skips are unused here anyway.
  outputFileTracing: false,
  typescript: {
    tsconfigPath: './tsconfig.web.json',
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // The src/** pipeline (and the CHUNK_3/4 route handlers) use extensionless-ESM `.js`
  // import specifiers that resolve to `.ts` files under TS "Bundler" resolution. Teach
  // webpack the same mapping so `next build` can resolve `../src/**/*.js` → the `.ts` source.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
