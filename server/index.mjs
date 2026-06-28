import compression from 'compression';
import express from 'express';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticSiteServer } from '../../server-ops/lib/site-server.mjs';

// Served entirely by the shared static-site server. Articles are imported from ../ghostwriter at
// build time; this server only serves the prerendered result (home + /<slug>/ essays).
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
createStaticSiteServer({
  express,
  compression,
  appName: 'wargr.com',
  browserDir: join(ROOT, 'dist', 'browser'),
  host: process.env.HOST ?? '127.0.0.1',
  port: Number.parseInt(process.env.PORT ?? '3060', 10),
  frameOptions: 'SAMEORIGIN',
});
