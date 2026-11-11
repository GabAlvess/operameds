const fs = require('node:fs');
const path = require('node:path');

const apiBaseUrl = process.env.OPERAMEDS_API_BASE_URL;
if (!apiBaseUrl) {
  console.error('Defina OPERAMEDS_API_BASE_URL no ambiente do build para conectar o front-end à API externa.');
  process.exit(1);
}

let apiOrigin;
try {
  const parsed = new URL(apiBaseUrl);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error();
  }
  apiOrigin = parsed.origin;
} catch {
  console.error('OPERAMEDS_API_BASE_URL deve ser uma origem HTTPS, por exemplo https://api.exemplo.com.');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
for (const file of ['operameds-logo.png', 'operameds-icon.png']) {
  fs.copyFileSync(path.join(root, 'assets', file), path.join(output, 'assets', file));
}
fs.writeFileSync(path.join(output, 'config.js'), `window.OPERAMEDS_API_BASE_URL = ${JSON.stringify(apiOrigin)};\n`);
console.log('Front-end estático preparado para API em ' + apiOrigin);
