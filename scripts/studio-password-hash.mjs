#!/usr/bin/env node
// Generate the scrypt hash for the Studio owner password. The plaintext is read interactively
// from the terminal (never from arguments, so it stays out of shell history and process lists),
// and the complete `scrypt$…` output is what belongs in `.env.web` as WARGR_STUDIO_PASSWORD_HASH.
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout, argv, exit } from 'node:process';

const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

if (argv.length > 2) {
  console.error(
    'studio-password-hash reads the password interactively; do not pass it as an argument.',
  );
  exit(64);
}

const password = await readHidden('Studio password: ');
if (!password || password.length > 256 || /[\u0000-\u001f\u007f]/u.test(password)) {
  console.error('The password must contain between 1 and 256 characters without control codes.');
  exit(65);
}
const confirmation = await readHidden('Repeat password: ');
if (confirmation !== password) {
  console.error('The passwords do not match.');
  exit(65);
}

const salt = randomBytes(SALT_BYTES);
const hash = scryptSync(password, salt, KEY_BYTES, {
  N: COST,
  r: BLOCK_SIZE,
  p: PARALLELIZATION,
  maxmem: 128 * COST * BLOCK_SIZE * 2,
});
console.log(
  [
    'scrypt',
    String(COST),
    String(BLOCK_SIZE),
    String(PARALLELIZATION),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$'),
);

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const readline = createInterface({ input: stdin, output: stdout, terminal: true });
    const write = stdout.write.bind(stdout);
    stdout.write(prompt);
    stdout.write = (chunk, ...rest) => {
      // Suppress the echoed characters while the password is typed.
      if (typeof chunk === 'string' && chunk !== '\n' && chunk !== '\r\n') return true;
      return write(chunk, ...rest);
    };
    readline.question('', (answer) => {
      stdout.write = write;
      stdout.write('\n');
      readline.close();
      resolve(answer);
    });
    readline.on('error', (error) => {
      stdout.write = write;
      reject(error);
    });
  });
}
