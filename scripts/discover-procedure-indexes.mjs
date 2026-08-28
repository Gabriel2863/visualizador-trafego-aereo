import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const PROCEDURE_TYPES = ['SID', 'STAR', 'IAC'];

const relative = absolute => path.relative(ROOT, absolute).replaceAll(path.sep, '/');
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const writeJsonIfChanged = (relativePath, value) => {
  const absolute = path.join(ROOT, relativePath);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
  if (current === next) return false;
  fs.writeFileSync(absolute, next, 'utf8');
  return true;
};
const slugify = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function graphRouteCount(legs = []) {
  const normalized = legs.map((leg, index) => ({ id: leg.id || `LEG-${index + 1}`, from: typeof leg.from === 'object' ? leg.from.ident || leg.from.name || leg.from.id : leg.from, to: typeof leg.to === 'object' ? leg.to.ident || leg.to.name || leg.to.id : leg.to }));
  if (!normalized.length) return 0;
  const outgoing = new Map(), destinations = new Set(), emitted = new Set();
  normalized.forEach(leg => {
    if (leg.from) {
      if (!outgoing.has(leg.from)) outgoing.set(leg.from, []);
      outgoing.get(leg.from).push(leg);
    }
    if (leg.to) destinations.add(leg.to);
  });
  let count = 0;
  const walk = (leg, visited) => {
    emitted.add(leg.id);
    const next = (outgoing.get(leg.to) || []).filter(candidate => !visited.has(candidate.id));
    if (!next.length) count += 1;
    else next.forEach(candidate => walk(candidate, new Set([...visited, candidate.id])));
  };
  normalized.filter(leg => !leg.from || !destinations.has(leg.from)).forEach(leg => walk(leg, new Set([leg.id])));
  normalized.forEach(leg => { if (!emitted.has(leg.id)) walk(leg, new Set([leg.id])); });
  return count;
}

function procedureEntry(file, type, airport) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const metadata = raw.procedure || {};
  const filename = path.basename(file, path.extname(file));
  const name = metadata.name || filename;
  const nameUpper = name.toUpperCase();
  const runways = Array.isArray(metadata.runways) ? metadata.runways : metadata.runways ? [metadata.runways] : metadata.runway ? [metadata.runway] : [];
  const modes = Array.isArray(metadata.modes) ? metadata.modes : metadata.modes ? [metadata.modes] : /\bRNP\b/.test(nameUpper) ? ['RNP'] : /\bILS\b|\bLOC\b/.test(nameUpper) ? ['ILS'] : [];
  const relativeFile = relative(file);
  return {
    id: metadata.id || `FILE-${slugify(relativeFile).replaceAll('-', '_')}`,
    name,
    file: relativeFile,
    runways,
    modes,
    transitionCount: Array.isArray(raw.transitions) && raw.transitions.length ? raw.transitions.length : graphRouteCount(raw.legs || []),
    missedApproachCount: Array.isArray(raw.missed_approach) ? raw.missed_approach.length : 0,
    warningCount: Array.isArray(raw.warnings) ? raw.warnings.length : 0,
    airport: metadata.airport || airport,
    type: metadata.type || type,
  };
}

function procedureFilesFor(airportDir, type) {
  const directory = path.join(airportDir, 'procedures', type);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json') && entry.name.toLowerCase() !== 'index.json')
    .map(entry => path.join(directory, entry.name))
    .sort((first, second) => first.localeCompare(second, 'en'));
}

function keepExistingOrder(entries, previous = []) {
  const byFile = new Map(entries.map(entry => [entry.file, entry]));
  const ordered = previous.map(entry => byFile.get(entry.file)).filter(Boolean);
  const known = new Set(ordered.map(entry => entry.file));
  return [...ordered, ...entries.filter(entry => !known.has(entry.file))];
}

function buildProcedureIndex(airportDir, airport, previousIndex = {}) {
  const types = {};
  for (const type of PROCEDURE_TYPES) {
    const entries = procedureFilesFor(airportDir, type).map(file => procedureEntry(file, type, airport));
    types[type] = keepExistingOrder(entries, previousIndex.types?.[type] || []).map(({ airport: _airport, type: _type, ...entry }) => entry);
  }
  return { schemaVersion: 1, airport, coordinateSource: 'data/waypoints.json', types };
}

function airportDirectories(tmaDir) {
  const directory = path.join(tmaDir, 'airports');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'airport.json')))
    .map(entry => path.join(directory, entry.name))
    .sort((first, second) => first.localeCompare(second, 'en'));
}

function rebuildAirportIndex(tmaDir, tma, previousIndex) {
  const directories = airportDirectories(tmaDir);
  const directoryByIcao = new Map(directories.map(directory => [path.basename(directory).toUpperCase(), directory]));
  const previousAirports = previousIndex?.airports || [];
  const airportCodes = [...new Set([...previousAirports.map(item => item.icao), ...directoryByIcao.keys()])].filter(Boolean);
  const airports = airportCodes.map(icao => {
    const directory = directoryByIcao.get(String(icao).toUpperCase());
    const previous = previousAirports.find(item => item.icao === icao) || {};
    const airport = directory ? readJson(relative(path.join(directory, 'airport.json'))) : null;
    const airportData = airport || { icao: previous.icao, name: previous.name };
    const proceduresIndex = directory ? relative(path.join(directory, 'procedures', 'index.json')) : previous.proceduresIndex;
    const oldProcedureIndex = previous.proceduresIndex && fs.existsSync(path.join(ROOT, previous.proceduresIndex)) ? readJson(previous.proceduresIndex) : {};
    const procedureIndex = directory ? buildProcedureIndex(directory, airportData.icao, oldProcedureIndex) : oldProcedureIndex;
    if (directory) writeJsonIfChanged(proceduresIndex, procedureIndex);
    const procedureCounts = Object.fromEntries(PROCEDURE_TYPES.map(type => [type, (procedureIndex.types?.[type] || []).length]));
    return {
      icao: airportData.icao,
      name: airportData.name || previous.name || airportData.icao,
      file: directory ? relative(path.join(directory, 'airport.json')) : previous.file,
      proceduresIndex,
      procedureCounts,
    };
  });
  const nextIndex = { schemaVersion: 1, tma: tma.id, airports };
  return { nextIndex, airports };
}

const catalogPath = 'data/tmas/catalog.json';
const catalog = readJson(catalogPath);
let changed = 0, totalProcedures = 0, totalAirports = 0;
for (const catalogEntry of catalog.tmas || []) {
  const tma = readJson(catalogEntry.file);
  const tmaDir = path.dirname(path.join(ROOT, catalogEntry.file));
  const previousAirportIndex = tma.airportsIndex && fs.existsSync(path.join(ROOT, tma.airportsIndex)) ? readJson(tma.airportsIndex) : {};
  const { nextIndex, airports } = rebuildAirportIndex(tmaDir, tma, previousAirportIndex);
  changed += writeJsonIfChanged(tma.airportsIndex, nextIndex) ? 1 : 0;
  totalAirports += airports.length;
  const airportCodes = airports.map(item => item.icao);
  const nextTma = { ...tma, airports: airportCodes };
  changed += writeJsonIfChanged(catalogEntry.file, nextTma) ? 1 : 0;
  const procedureCount = airports.reduce((sum, airport) => sum + Object.values(airport.procedureCounts).reduce((subtotal, value) => subtotal + value, 0), 0);
  totalProcedures += procedureCount;
  if (catalogEntry.airportCount !== airports.length || catalogEntry.procedureCount !== procedureCount) {
    catalogEntry.airportCount = airports.length;
    catalogEntry.procedureCount = procedureCount;
  }
}
changed += writeJsonIfChanged(catalogPath, catalog) ? 1 : 0;
console.log(`[discover-procedures] ${totalProcedures} procedimentos em ${totalAirports} aeródromos; ${changed} índice(s) atualizado(s).`);
