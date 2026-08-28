import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const DATA_ROOT = path.join(ROOT, 'data');
const TMA_ROOT = path.join(DATA_ROOT, 'tmas');
const GENERATED_MARKER = 'data-architecture-v1';

const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const writeJson = (relativePath, value) => {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const ascii = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const slug = value => ascii(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
const normalizeName = value => ascii(value).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const shortHash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 10);
const finite = value => Number.isFinite(Number(value));
const upper = value => String(value || '').trim().toUpperCase();

const previousCatalogPath = path.join(TMA_ROOT, 'catalog.json');
if (fs.existsSync(previousCatalogPath)) {
  const previousCatalog = JSON.parse(fs.readFileSync(previousCatalogPath, 'utf8'));
  if (previousCatalog.generatedBy === 'scripts/migrate-data-architecture.mjs') {
    for (const entry of previousCatalog.tmas || []) {
      const generatedDirectory = path.resolve(ROOT, path.dirname(entry.file || ''));
      if (generatedDirectory !== TMA_ROOT && generatedDirectory.startsWith(`${TMA_ROOT}${path.sep}`)) fs.rmSync(generatedDirectory, { recursive: true, force: true });
    }
  }
}

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [currentLon, currentLat] = ring[current];
    const [previousLon, previousLat] = ring[previous];
    const intersects = (currentLat > latitude) !== (previousLat > latitude)
      && longitude < (previousLon - currentLon) * (latitude - currentLat) / ((previousLat - currentLat) || 1e-12) + currentLon;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInFeature(latitude, longitude, feature) {
  const geometry = feature?.geometry;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(polygon => polygon[0] && pointInRing(longitude, latitude, polygon[0])
    && !polygon.slice(1).some(ring => pointInRing(longitude, latitude, ring)));
}

function haversineMeters(first, second) {
  const radians = value => value * Math.PI / 180;
  const lat1 = radians(first.latitude), lat2 = radians(second.latitude);
  const deltaLat = lat2 - lat1, deltaLon = radians(second.longitude - first.longitude);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function altitudeModel(lower, upper) {
  const result = { at: null, min: null, max: null };
  const apply = value => {
    if (!value || !finite(value.valueFt)) return;
    const feet = Number(value.valueFt);
    if (value.meaning === 'at') result.at = feet;
    else if (['at-or-above', 'recommended', 'expected'].includes(value.meaning)) result.min = feet;
    else if (value.meaning === 'at-or-below') result.max = feet;
    else if (value.meaning === 'between-bound') {
      if (result.min === null) result.min = feet;
      else result.max = feet;
    }
  };
  apply(lower);
  apply(upper);
  if (result.min !== null && result.max !== null && result.min > result.max) [result.min, result.max] = [result.max, result.min];
  return result;
}

function sourceModel(record) {
  const source = record.source || {};
  return {
    authority: source.authority || (record.__origin === 'legacy-curitiba' ? 'Dados legados do projeto' : 'AISWEB/DECEA'),
    chart_code: source.chartCode || source.chart || null,
    amendment: source.amendment || source.airac || null,
    effective_date: source.effectiveDate || record.effectiveDate || null,
    document: source.document || null,
    page: source.page || source.chartPage || null,
    origin_dataset: record.__origin,
  };
}

const waypoints = readJson('data/waypoints.json');
const baseWaypointFeatures = (waypoints.features || []).filter(feature => feature.properties?.generated_by !== GENERATED_MARKER);
const waypointByIdent = new Map();
const waypointById = new Map();
for (const feature of baseWaypointFeatures) {
  const ident = upper(feature.properties?.ident);
  if (!waypointByIdent.has(ident)) waypointByIdent.set(ident, []);
  waypointByIdent.get(ident).push(feature);
  waypointById.set(feature.id, feature);
}
const generatedWaypointFeatures = [];
const generatedByStableKey = new Map();

function pointCoordinates(feature) {
  return {
    latitude: Number(feature.properties.latitude),
    longitude: Number(feature.properties.longitude),
  };
}

function nearestBaseWaypoint(ident, point) {
  const candidates = waypointByIdent.get(upper(ident)) || [];
  if (!candidates.length) return null;
  if (!point || !finite(point.latitude) || !finite(point.longitude)) return candidates.length === 1 ? candidates[0] : null;
  const nearest = candidates.map(feature => ({ feature, distance: haversineMeters(pointCoordinates(feature), point) }))
    .sort((first, second) => first.distance - second.distance)[0];
  return nearest?.distance <= 250 ? nearest.feature : null;
}

function generatedPoint(ident, latitude, longitude, options = {}) {
  const stableKey = options.stableKey || `${upper(ident)}|${Number(latitude).toFixed(8)}|${Number(longitude).toFixed(8)}`;
  if (generatedByStableKey.has(stableKey)) return generatedByStableKey.get(stableKey);
  const id = `procedure-point:${options.pointRef || shortHash(stableKey)}`;
  if (waypointById.has(id)) return waypointById.get(id);
  const feature = {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
    properties: {
      ident: upper(ident) || `GEO-${shortHash(stableKey).slice(0, 7).toUpperCase()}`,
      latitude: Number(latitude),
      latitude_gms: null,
      longitude: Number(longitude),
      longitude_gms: null,
      tipo: options.pointType || 'PROCEDURE_POINT',
      point_ref: options.pointRef || null,
      hidden_on_map: Boolean(options.hidden),
      generated_by: GENERATED_MARKER,
      source: options.source || 'Dados estruturados já existentes no projeto',
    },
  };
  generatedWaypointFeatures.push(feature);
  generatedByStableKey.set(stableKey, feature);
  waypointById.set(id, feature);
  return feature;
}

function coordinateReference(ident, point, context) {
  const normalizedIdent = upper(ident || point?.ident);
  const base = nearestBaseWaypoint(normalizedIdent, point);
  if (base) return base.id;
  if (!point || !finite(point.latitude) || !finite(point.longitude)) return null;
  return generatedPoint(normalizedIdent, point.latitude, point.longitude, {
    stableKey: point.pointRef || `${normalizedIdent}|${Number(point.latitude).toFixed(8)}|${Number(point.longitude).toFixed(8)}`,
    pointRef: point.pointRef || null,
    pointType: point.pointType || 'PROCEDURE_POINT',
    source: point.source || context,
  }).id;
}

const tmaDataset = readJson('data/tmas/brazil-tmas-aixm.json');
const aerodromeDataset = readJson('data/tmas/brazil-aerodromes-aixm.json');
const nationalDataset = readJson('data/tmas/brazil-procedures-aixm.json');
const tmaManifest = readJson('data/tmas/manifest.json');
const legacyDataset = readJson('data/procedures.json');

const moduleRecords = [];
for (const moduleEntry of tmaManifest.modules || []) {
  if (moduleEntry.enabled === false || !moduleEntry.file) continue;
  const module = readJson(moduleEntry.file);
  const airportData = moduleEntry.aerodromesFile ? readJson(moduleEntry.aerodromesFile) : { aerodromes: [] };
  moduleRecords.push({ entry: moduleEntry, module, airports: airportData.aerodromes || [] });
}

const aerodromeById = new Map();
for (const item of aerodromeDataset.aerodromes || []) aerodromeById.set(upper(item.id), { ...item, id: upper(item.id) });
for (const item of readJson('aeronautical_data.json').aerodromes || []) {
  const id = upper(item.id);
  aerodromeById.set(id, { ...(aerodromeById.get(id) || {}), ...item, id });
}
for (const moduleRecord of moduleRecords) {
  for (const item of moduleRecord.airports) {
    const id = upper(item.id || item.icao);
    aerodromeById.set(id, { ...(aerodromeById.get(id) || {}), ...item, id });
  }
  for (const item of moduleRecord.module.airports || []) {
    const id = upper(item.id || item.icao);
    aerodromeById.set(id, { ...(aerodromeById.get(id) || {}), ...item, id });
  }
}

const familyFeatures = new Map();
for (const feature of tmaDataset.features || []) {
  const family = feature.properties?.family || feature.properties?.name;
  if (!familyFeatures.has(family)) familyFeatures.set(family, []);
  familyFeatures.get(family).push(feature);
}

const explicitAirportFamilies = new Map();
for (const moduleRecord of moduleRecords) {
  const family = moduleRecord.entry.operational?.family || moduleRecord.module.operational?.family || moduleRecord.entry.name;
  for (const item of moduleRecord.module.airports || []) explicitAirportFamilies.set(upper(item.id || item.icao), family);
}

function familyForAirport(airportId) {
  if (explicitAirportFamilies.has(airportId)) return explicitAirportFamilies.get(airportId);
  const airport = aerodromeById.get(airportId);
  if (!airport || !finite(airport.lat) || !finite(airport.lon)) return null;
  return [...familyFeatures].find(([, features]) => features.some(feature => pointInFeature(Number(airport.lat), Number(airport.lon), feature)))?.[0] || null;
}

function legacyVariants() {
  const output = [];
  for (const procedure of legacyDataset.procedures || []) {
    if (procedure.id !== 'SBCT-STAR-RNAV-DALIG-RAXIT-UMGUL-1A-RWY15') {
      output.push({ ...procedure, __origin: 'legacy-curitiba' });
      continue;
    }
    const groups = [
      { token: 'DALIG', name: 'STAR RNAV DALIG 1A RWY 15', transitions: ['DALIG', 'GEGOB', 'PAPIP'] },
      { token: 'RAXIT', name: 'STAR RNAV RAXIT 1A RWY 15', transitions: ['RAXIT'] },
      { token: 'UMGUL', name: 'STAR RNAV UMGUL 1A RWY 15', transitions: ['UMGUL'] },
    ];
    for (const group of groups) {
      output.push({
        ...procedure,
        id: `SBCT-STAR-RNAV-${group.token}-1A-RWY15`,
        name: group.name,
        transitions: procedure.transitions.filter(transition => group.transitions.includes(transition.id)),
        notes: [`Migrado do registro combinado “${procedure.name}”; conteúdo e fonte preservados.`],
        __origin: 'legacy-curitiba',
      });
    }
  }
  return output;
}

const sourceProcedures = [
  ...(nationalDataset.procedures || []).map(record => ({ ...record, __origin: 'aixm-national' })),
  ...moduleRecords.flatMap(record => (record.module.procedures || []).map(procedure => ({ ...procedure, __origin: record.entry.id || 'module' }))),
  ...legacyVariants(),
];

const canonicalProcedures = new Map();
for (const record of sourceProcedures) {
  const normalizedType = upper(record.type), normalizedName = normalizeName(record.name).replace(new RegExp(`^${normalizedType}\\s+`), '');
  const key = `${upper(record.airport)}|${normalizedType}|${normalizedName}`;
  if (!canonicalProcedures.has(key)) canonicalProcedures.set(key, []);
  canonicalProcedures.get(key).push(record);
}

function primaryRecord(records) {
  return [...records].sort((first, second) => {
    const priority = value => value.__origin === 'tma-sp' ? 0 : value.__origin === 'aixm-national' ? 1 : 2;
    return priority(first) - priority(second);
  })[0];
}

function procedureCoordinate(record, ident, referencePoint) {
  if (referencePoint && finite(referencePoint.latitude) && finite(referencePoint.longitude)) return referencePoint;
  const published = record.publishedPoints?.[ident];
  if (published && finite(published.latitude) && finite(published.longitude)) {
    return { ...published, ident, pointType: 'PublishedCodingPoint', source: `${record.__origin} · ${record.source?.chartCode || record.source?.chart || record.id}` };
  }
  const national = nationalDataset.publishedPoints?.[ident];
  const values = Array.isArray(national) ? national : national ? [national] : [];
  if (values.length === 1) return values[0];
  return null;
}

function legacyAltitudeLabel(label) {
  if (!label) return null;
  const role = String(label).match(/\(([^)]+)\)/)?.[1] || null;
  return { published_label: String(label), role };
}

function convertCanonical(records) {
  const primary = primaryRecord(records);
  const points = {};
  const pointState = new Map();
  const warnings = new Set(primary.notes || []);
  const legs = [];
  const transitions = [];
  const missedApproach = [];
  const usedLegIds = new Set();

  function localPoint(ident, point = null, metadata = {}) {
    if (!ident && !point) return null;
    const displayIdent = upper(ident || point?.ident);
    const existingKey = !point && Object.keys(points).find(key => points[key].ident === displayIdent);
    if (existingKey) {
      const existing = points[existingKey];
      if (metadata.role && !existing.role) existing.role = metadata.role;
      if (metadata.published_label && !existing.published_label) existing.published_label = metadata.published_label;
      return existingKey;
    }
    const coordinateRef = metadata.coordinate_ref || coordinateReference(displayIdent, point, `${primary.airport} · ${primary.name}`);
    let key = displayIdent || `POINT-${shortHash(coordinateRef || JSON.stringify(point))}`;
    if (pointState.has(key) && pointState.get(key) !== coordinateRef) key = `${key}@${shortHash(coordinateRef || JSON.stringify(point)).slice(0, 6).toUpperCase()}`;
    pointState.set(key, coordinateRef);
    const existing = points[key] || {
      ident: displayIdent || key,
      coordinate_ref: coordinateRef,
      role: null,
      altitude: { at: null, min: null, max: null },
    };
    if (!existing.coordinate_ref && coordinateRef) existing.coordinate_ref = coordinateRef;
    if (metadata.role && !existing.role) existing.role = metadata.role;
    const altitude = metadata.altitude || {};
    for (const field of ['at', 'min', 'max']) if (finite(altitude[field]) && existing.altitude[field] === null) existing.altitude[field] = Number(altitude[field]);
    if (metadata.published_label && !existing.published_label) existing.published_label = metadata.published_label;
    if (!existing.coordinate_ref) warnings.add(`FIX ${displayIdent || key} não encontrado em data/waypoints.json.`);
    points[key] = existing;
    return key;
  }

  function geometryKeys(segment, routePrefix) {
    const geometry = Array.isArray(segment.geometry) ? segment.geometry : [];
    if (geometry.length <= 2) return [];
    return geometry.slice(1, -1).map((coordinate, index) => {
      const [latitude, longitude] = coordinate;
      if (!finite(latitude) || !finite(longitude)) return null;
      const stableKey = `${primary.airport}|${segment.id || routePrefix}|${index}|${Number(latitude).toFixed(9)}|${Number(longitude).toFixed(9)}`;
      const feature = generatedPoint(`GEO-${shortHash(stableKey).slice(0, 7).toUpperCase()}`, latitude, longitude, {
        stableKey: `geometry:${stableKey}`,
        pointType: 'PROCEDURE_GEOMETRY',
        source: `${recordSourceLabel(segment.__record || primary)} · trajetória AIXM existente`,
        hidden: true,
      });
      return localPoint(feature.properties.ident, pointCoordinates(feature), { role: 'GEOMETRY', coordinate_ref: feature.id });
    }).filter(Boolean);
  }

  function recordSourceLabel(record) {
    return `${record.__origin} · ${record.source?.chartCode || record.source?.chart || record.id}`;
  }

  function uniqueLegId(base) {
    let value = slug(base);
    let suffix = 2;
    while (usedLegIds.has(value)) value = `${slug(base)}-${suffix++}`;
    usedLegIds.add(value);
    return value;
  }

  function convertSegment(segment, record, routePrefix, index) {
    const originPoint = procedureCoordinate(record, segment.origin, segment.originPoint);
    const destinationPoint = procedureCoordinate(record, segment.destination, segment.destinationPoint);
    const altitude = altitudeModel(segment.lowerLimitAltitude, segment.upperLimitAltitude);
    const from = segment.origin ? localPoint(segment.origin, originPoint) : null;
    const to = segment.destination ? localPoint(segment.destination, destinationPoint, { role: segment.fixRole, altitude }) : null;
    if (!from && !to && !(segment.geometry || []).length) return null;
    const course = finite(segment.course?.magnetic) ? Number(segment.course.magnetic) : finite(segment.course?.true) ? Number(segment.course.true) : null;
    const courseReference = finite(segment.course?.magnetic) ? 'MAG' : finite(segment.course?.true) ? 'TRUE' : null;
    const converted = {
      id: uniqueLegId(`${routePrefix}-${segment.id || segment.groupId || segment.sequenceNumber || index + 1}`),
      from,
      to,
      via: [],
      path_terminator: segment.pathTerminator || null,
      course,
      course_reference: courseReference,
      course_magnetic: finite(segment.course?.magnetic) ? Number(segment.course.magnetic) : null,
      course_true: finite(segment.course?.true) ? Number(segment.course.true) : null,
      distance_nm: finite(segment.distanceNm) ? Number(segment.distanceNm) : null,
      turn: segment.turn || null,
      fly_over: segment.flyOver || null,
      altitude,
      lower_limit: segment.lowerLimitAltitude || null,
      upper_limit: segment.upperLimitAltitude || null,
      speed_limit_kt: finite(segment.speedLimitKt) ? Number(segment.speedLimitKt) : null,
      speed_interpretation: segment.speedLimitDescription || null,
      vertical_angle: finite(segment.verticalAngle) ? Number(segment.verticalAngle) : null,
      fix_role: segment.fixRole || null,
      navigation_specification: segment.navigationSpecification || null,
      arc_center: segment.arcCenterFix ? localPoint(segment.arcCenterFix, procedureCoordinate(record, segment.arcCenterFix, null)) : null,
      arc_radius_nm: finite(segment.arcRadiusNm) ? Number(segment.arcRadiusNm) : null,
      source_page: segment.sourcePage || null,
      source_dataset: record.__origin,
    };
    converted.via = geometryKeys({ ...segment, __record: record }, routePrefix);
    return converted;
  }

  function routeSignature(route, routeLegs) {
    return JSON.stringify([route.kind, route.sequence, routeLegs.map(leg => ({
      from: leg.from,
      to: leg.to,
      via: leg.via,
      path_terminator: leg.path_terminator,
      course_magnetic: leg.course_magnetic,
      course_true: leg.course_true,
      distance_nm: leg.distance_nm,
      turn: leg.turn,
      fly_over: leg.fly_over,
      lower_limit: leg.lower_limit,
      upper_limit: leg.upper_limit,
      speed_limit_kt: leg.speed_limit_kt,
      speed_interpretation: leg.speed_interpretation,
      vertical_angle: leg.vertical_angle,
      fix_role: leg.fix_role,
      navigation_specification: leg.navigation_specification,
      arc_center: leg.arc_center,
      arc_radius_nm: leg.arc_radius_nm,
    }))]);
  }

  const signatures = new Set();
  records.forEach((record, recordIndex) => {
    const prefix = records.length > 1 ? `${slug(record.__origin)}-${recordIndex + 1}` : slug(record.__origin);
    const routes = Array.isArray(record.transitions) ? record.transitions : [];
    routes.forEach((route, routeIndex) => {
      const routePrefix = `${prefix}-${route.id || routeIndex + 1}`;
      let routeLegs = [];
      if (Array.isArray(route.segments)) {
        routeLegs = route.segments.map((segment, index) => convertSegment(segment, record, routePrefix, index)).filter(Boolean);
      } else {
        const sequence = route.sequence || [];
        sequence.forEach((ident, index) => {
          const legacy = legacyAltitudeLabel(route.pointLabels?.[ident]);
          localPoint(ident, procedureCoordinate(record, ident, null), { role: legacy?.role, published_label: legacy?.published_label });
          if (!index) return;
          routeLegs.push({
            id: uniqueLegId(`${routePrefix}-${index}`), from: sequence[index - 1], to: ident, via: [], path_terminator: null,
            course: null, course_reference: null, course_magnetic: null, course_true: null, distance_nm: null,
            turn: null, fly_over: null, altitude: { at: null, min: null, max: null }, lower_limit: null, upper_limit: null,
            speed_limit_kt: null, speed_interpretation: null, vertical_angle: null, fix_role: legacy?.role || null,
            navigation_specification: record.procedureType || null, arc_center: null, arc_radius_nm: null,
            source_page: record.source?.page || null, source_dataset: record.__origin,
          });
        });
      }
      const isMissed = /MISSED|PERDIDA/i.test(`${route.kind || ''} ${route.name || ''}`);
      const target = isMissed ? missedApproach : transitions;
      const convertedRoute = {
        id: `${prefix}-${slug(route.id || route.name || routeIndex + 1)}`,
        name: route.name || route.id || `Trajetória ${routeIndex + 1}`,
        kind: route.kind || (isMissed ? 'missed-approach' : 'transition'),
        sequence: (route.sequence || []).map(ident => localPoint(ident, procedureCoordinate(record, ident, null))).filter(Boolean),
        source_dataset: record.__origin,
      };
      if (isMissed) convertedRoute.legs = routeLegs;
      else convertedRoute.leg_ids = routeLegs.map(leg => leg.id);
      const signature = routeSignature(convertedRoute, routeLegs);
      if (!signatures.has(signature)) {
        signatures.add(signature);
        if (!isMissed) legs.push(...routeLegs);
        target.push(convertedRoute);
      }
    });

    const missedRoutes = Array.isArray(record.missedApproach) ? record.missedApproach : record.missedApproach ? [record.missedApproach] : [];
    missedRoutes.forEach((route, routeIndex) => {
      const routePrefix = `${prefix}-missed-${route.id || routeIndex + 1}`;
      let routeLegs = [];
      if (Array.isArray(route.segments)) routeLegs = route.segments.map((segment, index) => convertSegment(segment, record, routePrefix, index)).filter(Boolean);
      else {
        (route.sequence || []).forEach(ident => localPoint(ident, procedureCoordinate(record, ident, null), { role: 'MAHF' }));
      }
      missedApproach.push({
        id: routePrefix,
        name: route.name || 'Aproximação perdida',
        kind: 'missed-approach',
        sequence: (route.sequence || []).map(ident => localPoint(ident, procedureCoordinate(record, ident, null))).filter(Boolean),
        legs: routeLegs,
        published_text: route.publishedText || null,
        note: route.note || null,
        source_dataset: record.__origin,
      });
    });
  });

  const runways = [...new Set(records.flatMap(record => record.runways || (record.runway ? [record.runway] : [])))].filter(Boolean);
  const modes = [...new Set(records.flatMap(record => record.modes || (record.procedureType ? [record.procedureType] : [])))].filter(Boolean);
  const sourceHistory = records.map(sourceModel);
  return {
    schemaVersion: 1,
    procedure: {
      id: primary.id,
      airport: upper(primary.airport),
      name: primary.name,
      type: upper(primary.type),
      runway: runways[0] || null,
      runways,
      modes,
      status: primary.status || (primary.__origin === 'legacy-curitiba' ? 'legacy-preserved' : 'structured'),
      source: sourceHistory[0],
      source_history: sourceHistory,
    },
    points,
    legs,
    transitions,
    missed_approach: missedApproach,
    warnings: [...warnings],
  };
}

const convertedProcedures = [...canonicalProcedures.values()].map(convertCanonical);
const procedureByAirport = new Map();
for (const procedure of convertedProcedures) {
  const airport = procedure.procedure.airport;
  if (!procedureByAirport.has(airport)) procedureByAirport.set(airport, []);
  procedureByAirport.get(airport).push(procedure);
}

const allRelevantAirports = new Set(procedureByAirport.keys());
for (const [airport] of explicitAirportFamilies) allRelevantAirports.add(airport);
const airportFamily = new Map();
for (const airport of allRelevantAirports) airportFamily.set(airport, familyForAirport(airport) || 'SEM TMA ASSOCIADA');

const familyCatalog = [...familyFeatures.keys()].sort((first, second) => first.localeCompare(second, 'pt-BR'));
if ([...airportFamily.values()].includes('SEM TMA ASSOCIADA')) familyCatalog.push('SEM TMA ASSOCIADA');

const architectureEntries = [];
const migrationReport = {
  generatedAt: new Date().toISOString(),
  generator: 'scripts/migrate-data-architecture.mjs',
  coordinateSource: 'data/waypoints.json',
  input: {
    nationalProcedures: nationalDataset.procedures?.length || 0,
    moduleProcedures: moduleRecords.reduce((total, record) => total + (record.module.procedures?.length || 0), 0),
    legacyProcedures: legacyDataset.procedures?.length || 0,
  },
  output: {},
};

for (const family of familyCatalog) {
  const isUnassigned = family === 'SEM TMA ASSOCIADA';
  const familySlug = isUnassigned ? 'sem-tma-associada' : slug(family.replace(/^TMA\s+/i, ''));
  const familyId = isUnassigned ? 'UNASSIGNED' : ascii(family.replace(/^TMA\s+/i, '')).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const familyAirports = [...airportFamily].filter(([, value]) => value === family).map(([airport]) => airport).sort();
  const sectorFeatures = isUnassigned ? [] : familyFeatures.get(family) || [];
  const tmaPath = `data/tmas/${familySlug}/tma.json`;
  const airportIndexPath = `data/tmas/${familySlug}/airports/index.json`;
  const airportIndex = [];
  let familyProcedureCount = 0;

  for (const airportId of familyAirports) {
    const airport = aerodromeById.get(airportId) || { id: airportId, name: airportId };
    const airportProcedures = (procedureByAirport.get(airportId) || []).sort((first, second) =>
      `${first.procedure.type}|${first.procedure.name}`.localeCompare(`${second.procedure.type}|${second.procedure.name}`, 'pt-BR'));
    familyProcedureCount += airportProcedures.length;
    const airportRoot = `data/tmas/${familySlug}/airports/${airportId}`;
    const procedureIndexPath = `${airportRoot}/procedures/index.json`;
    const byType = { SID: [], STAR: [], IAC: [] };
    const usedFilenames = new Set();

    for (const procedure of airportProcedures) {
      const type = procedure.procedure.type;
      let filename = `${slug(procedure.procedure.name)}.json`;
      if (usedFilenames.has(`${type}/${filename}`)) filename = `${slug(procedure.procedure.name)}-${shortHash(procedure.procedure.id)}.json`;
      usedFilenames.add(`${type}/${filename}`);
      const relativePath = `${airportRoot}/procedures/${type}/${filename}`;
      writeJson(relativePath, procedure);
      byType[type].push({
        id: procedure.procedure.id,
        name: procedure.procedure.name,
        file: relativePath,
        runways: procedure.procedure.runways,
        modes: procedure.procedure.modes,
        transitionCount: procedure.transitions.length,
        missedApproachCount: procedure.missed_approach.length,
        warningCount: procedure.warnings.length,
      });
    }

    writeJson(procedureIndexPath, {
      schemaVersion: 1,
      airport: airportId,
      coordinateSource: 'data/waypoints.json',
      types: byType,
    });
    const airportPath = `${airportRoot}/airport.json`;
    writeJson(airportPath, {
      schemaVersion: 1,
      icao: airportId,
      name: airport.name || airportId,
      city: airport.city || null,
      tma: familyId,
      latitude: finite(airport.lat) ? Number(airport.lat) : null,
      longitude: finite(airport.lon) ? Number(airport.lon) : null,
      elevation_ft: finite(airport.elevation_ft) ? Number(airport.elevation_ft) : null,
      runways: airport.runways || [],
      aliases: airport.aliases || [],
      source: airport.source || null,
      source_url: airport.source_url || null,
      effective_date: airport.effective_date || null,
      proceduresIndex: procedureIndexPath,
    });
    const counts = Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, values.length]));
    airportIndex.push({ icao: airportId, name: airport.name || airportId, file: airportPath, proceduresIndex: procedureIndexPath, procedureCounts: counts });
  }

  writeJson(airportIndexPath, { schemaVersion: 1, tma: familyId, airports: airportIndex });
  writeJson(tmaPath, {
    schemaVersion: 1,
    id: familyId,
    name: isUnassigned ? 'Aeródromos sem TMA associada na geometria local' : family,
    airports: familyAirports,
    airportsIndex: airportIndexPath,
    boundarySource: isUnassigned ? null : 'data/tmas/brazil-tmas-aixm.json',
    sectorIds: sectorFeatures.map(feature => feature.properties?.sector_id || feature.properties?.sector_name || feature.properties?.name).filter(Boolean),
    source: isUnassigned ? 'Agrupamento técnico; não representa um espaço aéreo publicado.' : 'AISWEB/DECEA — AIXM completo AMDT 2608A1',
  });
  architectureEntries.push({
    id: familyId,
    slug: familySlug,
    name: isUnassigned ? 'Sem TMA associada' : family,
    file: tmaPath,
    airportCount: familyAirports.length,
    procedureCount: familyProcedureCount,
    selectable: familyAirports.length > 0,
    technicalGroup: isUnassigned,
  });
}

const allWaypointFeatures = [...baseWaypointFeatures, ...generatedWaypointFeatures];
writeJson('data/waypoints.json', {
  ...waypoints,
  recordCount: allWaypointFeatures.length,
  baseRecordCount: baseWaypointFeatures.length,
  procedurePointCount: generatedWaypointFeatures.length,
  coordinateExtensions: {
    generatedBy: 'scripts/migrate-data-architecture.mjs',
    purpose: 'Pontos de procedimento e vértices de trajetória já publicados nas bases estruturadas do projeto.',
    rule: 'Procedimentos referenciam somente feature.id; nenhuma coordenada é duplicada nos arquivos de procedimento.',
  },
  features: allWaypointFeatures,
});

writeJson('data/tmas/catalog.json', {
  schemaVersion: 1,
  coordinateSource: 'data/waypoints.json',
  generatedBy: 'scripts/migrate-data-architecture.mjs',
  tmas: architectureEntries,
});

migrationReport.output = {
  tmas: architectureEntries.filter(entry => !entry.technicalGroup).length,
  technicalGroups: architectureEntries.filter(entry => entry.technicalGroup).length,
  airports: allRelevantAirports.size,
  procedures: convertedProcedures.length,
  baseWaypoints: baseWaypointFeatures.length,
  generatedProcedurePoints: generatedWaypointFeatures.length,
  totalCoordinateFeatures: allWaypointFeatures.length,
  mergedDuplicateProcedureRecords: sourceProcedures.length - convertedProcedures.length,
};
writeJson('data/tmas/migration-report.json', migrationReport);

console.log(JSON.stringify(migrationReport.output, null, 2));
