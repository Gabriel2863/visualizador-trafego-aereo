import fs from 'node:fs';
import path from 'node:path';
import { minify } from 'terser';
import CleanCSS from 'clean-css';
import JavaScriptObfuscator from 'javascript-obfuscator';

const ROOT = path.resolve(process.cwd());
const DIST = path.join(ROOT, 'dist');
const DIST_ASSETS = path.join(DIST, 'assets');

const fail = message => {
  console.error(`[build-secure] ${message}`);
  process.exit(1);
};

if (DIST !== path.join(ROOT, 'dist')) fail('Destino de build inválido.');

const required = ['index.html', 'map_interface.js', 'styles.css'];
for (const file of required) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`Arquivo obrigatório ausente: ${file}`);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST_ASSETS, { recursive: true });

function safeProjectPath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) fail(`Caminho público inválido: ${relativePath}`);
  const resolved = path.resolve(ROOT, relativePath);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) fail(`Caminho fora do projeto: ${relativePath}`);
  return resolved;
}

function copyRuntimeFile(relativePath) {
  const source = safeProjectPath(relativePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`Recurso de runtime ausente: ${relativePath}`);
  const destination = path.join(DIST, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function loadJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(safeProjectPath(relativePath), 'utf8'));
  } catch (error) {
    fail(`JSON inválido em ${relativePath}: ${error.message}`);
  }
}

function copyPublicAssets(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) return;
  const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg', '.ico', '.woff', '.woff2']);
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isSymbolicLink()) fail(`Link simbólico não permitido em assets: ${entry.name}`);
    if (entry.isDirectory()) copyPublicAssets(source, destination);
    else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) fs.copyFileSync(source, destination);
    else fail(`Tipo de arquivo não permitido em assets: ${entry.name}`);
  }
}

// Somente recursos efetivamente carregados pelo navegador entram em produção.
for (const file of [
  'aeronautical_data.json',
  'all_tmas_boundaries.json',
  'data/waypoints.json',
  'data/areas-ensaio.json',
  'data/tmas/manifest.json',
  'data/studies/manifest.json'
]) copyRuntimeFile(file);

const tmaManifest = loadJson('data/tmas/manifest.json');
for (const module of tmaManifest.modules || []) {
  for (const file of [module.file, module.aerodromesFile, module.boundariesFile].filter(Boolean)) copyRuntimeFile(file);
}

const studyManifest = loadJson('data/studies/manifest.json');
for (const category of studyManifest.categories || []) copyRuntimeFile(category.file);

copyPublicAssets(path.join(ROOT, 'assets'), path.join(DIST, 'assets'));

const cssSource = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const cssResult = new CleanCSS({ level: 2 }).minify(cssSource);
if (cssResult.errors?.length) fail(`Falha ao minificar CSS: ${cssResult.errors.join('; ')}`);
if (!cssResult.styles) fail('Minificador não gerou CSS.');
fs.writeFileSync(path.join(DIST_ASSETS, 'app.min.css'), cssResult.styles, 'utf8');

const jsSource = fs.readFileSync(path.join(ROOT, 'map_interface.js'), 'utf8');
const minified = await minify(jsSource, {
  compress: { passes: 2, drop_console: false },
  mangle: { toplevel: false },
  format: { comments: false },
  sourceMap: false
});

if (!minified.code) fail('Terser não gerou saída JavaScript.');

const obfuscated = JavaScriptObfuscator.obfuscate(minified.code, {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false,
  sourceMap: false
});

fs.writeFileSync(path.join(DIST_ASSETS, 'app.min.js'), obfuscated.getObfuscatedCode(), 'utf8');

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html
  .replace(/href=["']styles\.css["']/g, 'href="assets/app.min.css"')
  .replace(/src=["']map_interface\.js["']/g, 'src="assets/app.min.js"');

if (!/name=["']referrer["']/i.test(html)) {
  html = html.replace(/<head>/i, '<head>\n    <meta name="referrer" content="strict-origin-when-cross-origin">');
}

fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');
fs.writeFileSync(path.join(DIST, '.nojekyll'), '', 'utf8');

const publishedFiles = [];
function collectFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(item);
    else publishedFiles.push(path.relative(DIST, item).replaceAll(path.sep, '/'));
  }
}
collectFiles(DIST);

if (publishedFiles.some(file => file.endsWith('.map'))) fail('Source map encontrada no artefato.');
if (publishedFiles.some(file => ['map_interface.js', 'styles.css', 'package.json'].includes(file) || file.startsWith('scripts/') || file.startsWith('.github/'))) fail('Arquivo-fonte encontrado no artefato.');

console.log(`[build-secure] Build concluído: ${publishedFiles.length} arquivos em dist/`);
console.log('[build-secure] Source maps: desativados');
console.log('[build-secure] JavaScript: minificado e ofuscado');
console.log('[build-secure] CSS: minificado');
