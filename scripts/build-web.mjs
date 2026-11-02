// Copy the web app into www/ for the native (Capacitor) builds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const items = ['index.html', 'patterns.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'samples'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const item of items) {
  fs.cpSync(path.join(root, item), path.join(out, item), {
    recursive: true,
    filter: (src) => !src.endsWith('.py'), // the sample generator is not part of the app
  });
}
console.log('web app copied to www/');
