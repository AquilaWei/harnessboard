// SPDX-License-Identifier: Apache-2.0
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` proxies the API to a running `hb serve`. changeOrigin rewrites the Host
// header to the loopback address the server's host check expects.
const apiPort = process.env.HARNESSBOARD_PORT ?? '4317';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
});
