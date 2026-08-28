import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const read = relativePath => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const exists = relativePath => fs.existsSync(path.join(ROOT, relativePath));

const catalog = read('data/tmas/catalog.json');
const waypoints = read('data/waypoints.json');
const globalProcedureIndex = read('data/tmas/procedures-index.json');
const waypointIds = new Set((waypoints.features || []).map(feature => feature.id));
const procedureNames = new Set();
const procedureFiles = new Set();
const expectedGlobalProcedures = [];
let airportCount = 0;
let procedureCount = 0;
let pointCount = 0;
let legCount = 0;
const forbiddenCoordinateKeys = new Set(['latitude', 'longitude', 'lat', 'lon', 'lng', 'geometry']);

function assertNoInlineCoordinates(value, location) {
  if (!value || typeof value !== 'object') return;
  const isPointMap = location.endsWith('.points');
  for (const [key, child] of Object.entries(value)) {
    assert.ok(isPointMap || !forbiddenCoordinateKeys.has(key.toLowerCase()), `Coordenada duplicada no procedimento: ${location}.${key}`);
    assertNoInlineCoordinates(child, `${location}.${key}`);
  }
}

function pointIdentifiers(points) {
  return new Set(Object.entries(points || {}).flatMap(([key, point]) => [key, point?.ident]).filter(Boolean).map(value => String(value).toUpperCase()));
}

function referenceName(value) {
  if (typeof value === 'object' && value) return value.ident || value.name || value.id;
  return value;
}

assert.equal(catalog.coordinateSource, 'data/waypoints.json');
assert.equal(catalog.tmas.filter(item => !item.technicalGroup).length, 40, 'O catálogo deve preservar as 40 famílias TMA da base AIXM.');
assert.equal(catalog.tmas.filter(item => item.technicalGroup).length, 1, 'Aeródromos sem associação devem ficar em um único agrupamento técnico.');
assert.equal(waypoints.baseRecordCount, 7938, 'Os 7.938 registros originais de waypoints devem ser preservados.');
assert.equal(waypoints.recordCount, waypoints.features.length);

for (const catalogEntry of catalog.tmas) {
  assert.ok(exists(catalogEntry.file), `TMA ausente: ${catalogEntry.file}`);
  const tma = read(catalogEntry.file);
  assert.deepEqual(Object.keys(tma).includes('airports'), true);
  assert.ok(exists(tma.airportsIndex), `Índice de aeródromos ausente: ${tma.airportsIndex}`);
  const airportIndex = read(tma.airportsIndex);
  assert.deepEqual(airportIndex.airports.map(item => item.icao).sort(), [...tma.airports].sort(), `Lista de aeródromos divergente em ${tma.name}`);
  assert.equal(airportIndex.airports.length, catalogEntry.airportCount);
  airportCount += airportIndex.airports.length;

  let tmaProcedureCount = 0;
  for (const airportEntry of airportIndex.airports) {
    assert.ok(exists(airportEntry.file), `Aeródromo ausente: ${airportEntry.file}`);
    assert.ok(exists(airportEntry.proceduresIndex), `Índice IFR ausente: ${airportEntry.proceduresIndex}`);
    const airport = read(airportEntry.file);
    const index = read(airportEntry.proceduresIndex);
    assert.equal(airport.icao, airportEntry.icao);
    assert.equal(airport.tma, tma.id);
    assert.equal(index.airport, airportEntry.icao);

    for (const type of ['SID', 'STAR', 'IAC']) {
      assert.ok(Array.isArray(index.types[type]), `Tipo ${type} ausente em ${airportEntry.icao}`);
      assert.equal(index.types[type].length, airportEntry.procedureCounts[type]);
      for (const item of index.types[type]) {
        assert.ok(exists(item.file), `Procedimento ausente: ${item.file}`);
        assert.equal(item.name, path.basename(item.file, path.extname(item.file)), `Nome exibido deve vir do arquivo: ${item.file}`);
        assert.ok(!procedureFiles.has(item.file), `Arquivo de procedimento duplicado no catálogo: ${item.file}`);
        procedureFiles.add(item.file);
        expectedGlobalProcedures.push({ tma: catalogEntry.slug, airport: airport.icao, type, name: item.name, file: item.file });
        const raw = fs.readFileSync(path.join(ROOT, item.file), 'utf8');
        const procedure = JSON.parse(raw);
        assertNoInlineCoordinates(procedure, item.file);
        assert.equal(procedure.procedure.airport, airport.icao);
        assert.equal(procedure.procedure.type, type);
        assert.ok(Array.isArray(procedure.legs));
        if (procedure.schemaVersion) assert.ok(Array.isArray(procedure.transitions), `Transições ausentes no schema estruturado: ${item.file}`);
        else assert.ok(!procedure.transitions || Array.isArray(procedure.transitions), `Transições inválidas: ${item.file}`);
        assert.ok(Array.isArray(procedure.missed_approach));
        assert.ok(!procedure.warnings || Array.isArray(procedure.warnings), `Avisos inválidos: ${item.file}`);
        const pointKeys = pointIdentifiers(procedure.points);
        for (const [key, point] of Object.entries(procedure.points || {})) {
          pointCount += 1;
          if (point.coordinate_ref) assert.ok(waypointIds.has(point.coordinate_ref), `coordinate_ref inexistente: ${item.file}#${key}`);
          else assert.ok(point.ident || key, `Ponto sem identificador: ${item.file}#${key}`);
        }
        const missedLegs = procedure.missed_approach.flatMap(route => Array.isArray(route.legs) ? route.legs : [route]);
        for (const leg of [...procedure.legs, ...missedLegs]) {
          legCount += 1;
          for (const value of [leg.from, leg.to, ...(leg.via || []), leg.arc_center].filter(Boolean)) {
            const key = referenceName(value);
            assert.ok(pointKeys.has(String(key).toUpperCase()), `Perna referencia ponto inexistente: ${item.file}#${leg.id}:${key}`);
          }
        }
        procedureNames.add(`${airport.icao}|${type}|${procedure.procedure.name}`);
        procedureCount += 1;
        tmaProcedureCount += 1;
      }
    }
  }
  assert.equal(tmaProcedureCount, catalogEntry.procedureCount, `Total IFR divergente em ${tma.name}`);
}

const sortProcedures = entries => [...entries].sort((first, second) => first.tma.localeCompare(second.tma, 'en') || first.airport.localeCompare(second.airport, 'en') || first.type.localeCompare(second.type, 'en') || first.name.localeCompare(second.name, 'en'));
assert.deepEqual(sortProcedures(globalProcedureIndex.procedures || []), sortProcedures(expectedGlobalProcedures), 'Índice global de procedimentos divergente');

for (const required of [
  'SBCT|STAR|STAR RNAV DALIG 1A RWY 15',
  'SBCT|STAR|STAR RNAV RAXIT 1A RWY 15',
  'SBCT|STAR|STAR RNAV UMGUL 1A RWY 15',
  'SBCT|IAC|IAC VOR Z RWY 15',
]) assert.ok(procedureNames.has(required), `Procedimento legado obrigatório ausente: ${required}`);

for (const legacyFile of [
  'all_tmas_coordinates.json',
  'all_tmas_boundaries.json',
  'curitiba_tma_waypoints.json',
  'data/procedures.json',
  'data/tmas/brazil-procedures-aixm.json',
  'data/tmas/tma-sp.json',
]) assert.ok(exists(legacyFile), `Arquivo de compatibilidade removido: ${legacyFile}`);

for (const forbidden of ['live_traffic.js', 'live_traffic_config.js', 'worker/src/index.js']) {
  assert.ok(!exists(forbidden), `Tráfego ao vivo não deve fazer parte desta entrega: ${forbidden}`);
}

console.log(`OK: ${catalog.tmas.length} grupos, ${airportCount} aeródromos hierárquicos, ${procedureCount} procedimentos, ${pointCount} referências de ponto e ${legCount} pernas sem coordenadas duplicadas.`);
