const fs = require('node:fs');
const path = require('node:path');

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
fs.writeFileSync(path.join(output, 'config.js'), "window.OPERAMEDS_API_BASE_URL = '';\n");
console.log('Front-end estático preparado para acessar a API pelo proxy same-origin do Vercel.');
