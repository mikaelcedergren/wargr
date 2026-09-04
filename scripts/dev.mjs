#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createDevelopmentEnvironments(ambient = process.env, root = process.cwd()) {
  const server = {
    ...ambient,
    APP_BASE_URL: 'http://127.0.0.1:4260',
    DATA_DIR: '.run/dev/data',
    DB_PATH: '.run/dev/data/wargr.db',
    HOST: '127.0.0.1',
    NODE_ENV: 'development',
    PORT: '4261',
  };
  // The web role never reads the worker's key file, so it cannot infer availability on its own.
  // A present .env.worker is the development signal that polishing is configured for both roles.
  if (server.ARTICLE_POLISH_ENABLED === undefined && existsSync(resolve(root, '.env.worker'))) {
    server.ARTICLE_POLISH_ENABLED = '1';
  }
  const browser = { ...server };
  delete browser.PORT;
  return Object.freeze({
    browser: Object.freeze(browser),
    server: Object.freeze(server),
  });
}

export function prepareDevelopmentDataDirectory(root = process.cwd()) {
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== resolve(root)) {
    throw new Error('Wargr development must run from its canonical repository path.');
  }
  const directories = [
    resolve(canonicalRoot, '.run'),
    resolve(canonicalRoot, '.run', 'dev'),
    resolve(canonicalRoot, '.run', 'dev', 'data'),
  ];
  for (const directory of directories) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
    }
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      realpathSync(directory) !== directory
    ) {
      throw new Error(`Unsafe Wargr development directory: ${directory}`);
    }
    chmodSync(directory, 0o700);
  }
  return directories.at(-1);
}

export function startDevelopment() {
  prepareDevelopmentDataDirectory();
  const environments = createDevelopmentEnvironments();
  const children = [
    spawn('server/node_modules/.bin/tsx', ['watch', 'server/src/index.ts'], {
      env: environments.server,
      stdio: 'inherit',
    }),
    spawn('server/node_modules/.bin/tsx', ['watch', 'server/src/worker.ts'], {
      env: environments.server,
      stdio: 'inherit',
    }),
    spawn(
      'node_modules/.bin/ng',
      [
        'serve',
        '--configuration',
        'local',
        '--host',
        '127.0.0.1',
        '--port',
        '4260',
        '--proxy-config',
        'proxy.conf.json',
      ],
      { env: environments.browser, stdio: 'inherit' },
    ),
  ];
  let stopping = false;
  let remaining = children.length;
  let forceTimer;

  function stop(signal = 'SIGTERM') {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
    forceTimer = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    }, 10_000);
  }

  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  for (const child of children) {
    child.on('close', (code, signal) => {
      if (!stopping) {
        stop();
        process.exitCode = signal || code === 0 ? 1 : (code ?? 1);
      }
      remaining -= 1;
      if (remaining === 0) {
        if (forceTimer !== undefined) {
          clearTimeout(forceTimer);
        }
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      }
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startDevelopment();
}
