import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
try {
  writeFileSync('.dev.vars', `APP_TOKEN=${randomBytes(32).toString('hex')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Created .dev.vars. Read APP_TOKEN there for your local password.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.dev.vars already exists; retained your existing settings.');
}
