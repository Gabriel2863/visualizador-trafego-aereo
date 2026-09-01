const map = L.map('map', { center: [-14.2, -51.9], zoom: 4, minZoom: 3, maxZoom: 15 });
const compactViewport = window.matchMedia('(max-width: 900px)');
const darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 20 }).addTo(map);
const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' });
const aerodromesGroup = L.layerGroup().addTo(map), navaidsGroup = L.layerGroup().addTo(map), allFixesGroup = L.layerGroup(), testAreasGroup = L.layerGroup(), measurementVectorsGroup = L.layerGroup().addTo(map), waypointSelectionsGroup = L.layerGroup().addTo(map), proceduresGroup = L.layerGroup().addTo(map), operationalLayoutGroup = L.featureGroup().addTo(map), tmaGroup = L.layerGroup().addTo(map), routesGroup = L.layerGroup().addTo(map);
const activeMarkers = {}, selectedWaypointMarkers = new Map();
let aeronauticalData = { aerodromes: [], navaids: [], fixes: [], tmas: [] }, nationalAerodromes = [], waypointFeatures = [], searchEntries = [], procedures = [], procedureModules = [], procedureCatalog = { tmas: [] }, tmaBoundaries = [], testAreas = [];
const procedurePointIndex = new Map();
const procedurePointCandidates = new Map();
const procedurePointById = new Map();
const activeProcedures = new Map();
const measurementVectors = new Map();
const tmaArchitectureCache = new Map(), airportIndexCache = new Map(), procedureIndexCache = new Map(), procedureDataCache = new Map();
const nationalPointRenderer = L.canvas({ padding: 0.5 });
let allFixesRendered = false, pointerLatLng = null, draftVector = null, selectedVectorId = null, nextVectorId = 1;
let tmaFocusRecords = [], operationalCatalog = [], dominantTmaRecord = null, activeOperationalFamily = '', activeOperationalModule = null, manualOperationalFamily = '', layoutLabelsPermanent = false, cafeEasterEggTimer = null, operationalRenderToken = 0;
const operationalRunways = {};
const operationalColors = { SID: '#ffb347', STAR: '#75e36d', ILS: '#39c8ff', RNP: '#b388ff' };
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const icon = (id, selected = false) => L.divIcon({ className: 'custom-icon fix-icon', html: selected ? `<div class="selected-waypoint-dot"></div><span class="icon-label">${esc(id)}</span>` : `<div class="icon-shape diamond"></div><span class="icon-label-small">${esc(id)}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
const aerodromeIcon = id => L.divIcon({ className: 'custom-icon aerodrome-icon', html: `<div class="aerodrome-symbol"><span>✈</span></div><span class="icon-label aerodrome-label">${esc(id)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
const moduleAerodromes = () => procedureModules.flatMap(module => module.aerodromes || []);

Promise.all([fetch('aeronautical_data.json').then(r => r.ok ? r.json() : Promise.reject(Error('aeronautical_data.json indisponível'))), fetch('data/waypoints.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/waypoints.json indisponível — execute scripts/import-waypoints.py'))), fetch('data/tmas/manifest.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/tmas/manifest.json indisponível'))), fetch('data/tmas/catalog.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/tmas/catalog.json indisponível — execute npm run migrate:data'))), fetch('data/tmas/brazil-tmas-aixm.json').then(r => r.ok ? r.json() : Promise.reject(Error('base AIXM nacional de TMA indisponível'))), fetch('data/tmas/brazil-aerodromes-aixm.json').then(r => r.ok ? r.json() : Promise.reject(Error('base AIXM nacional de aeródromos indisponível'))), fetch('data/areas-ensaio.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/areas-ensaio.json indisponível')))])
    .then(async ([base, waypoints, moduleManifest, architectureCatalog, tmaData, nationalAerodromeData, testAreaData]) => {
        aeronauticalData = base;
        nationalAerodromes = nationalAerodromeData.aerodromes || [];
        waypointFeatures = waypoints.features || [];
        procedureCatalog = architectureCatalog;
        procedureModules = await Promise.all((moduleManifest.modules || []).filter(item => item.enabled !== false).map(async item => {
            const [aerodromeResponse, boundaryResponse] = await Promise.all([item.aerodromesFile ? fetch(item.aerodromesFile) : Promise.resolve(null), item.boundariesFile ? fetch(item.boundariesFile) : Promise.resolve(null)]);
            if (aerodromeResponse && !aerodromeResponse.ok) throw Error(`${item.aerodromesFile} indisponível`);
            if (boundaryResponse && !boundaryResponse.ok) throw Error(`${item.boundariesFile} indisponível`);
            const [aerodromeData, boundaryData] = await Promise.all([aerodromeResponse ? aerodromeResponse.json() : Promise.resolve({ aerodromes: [] }), boundaryResponse ? boundaryResponse.json() : Promise.resolve(null)]);
            return { id: item.id, name: item.name, aerodromes: aerodromeData.aerodromes || [], boundaries: boundaryData ? tmaSectorFeatures(boundaryData, item.id) : [], operational: item.operational || {}, manifestName: item.name, manifestFile: item.file, aerodromesFile: item.aerodromesFile, boundariesFile: item.boundariesFile };
        }));
        const moduleBoundaries = procedureModules.flatMap(module => module.boundaries || []);
        tmaBoundaries = mergeOperationalTmaMetadata(tmaData.features || [], moduleBoundaries);
        testAreas = testAreaData.areas || [];
        buildProcedurePointIndex();
        renderBaseData();
        renderTestAreas();
        buildSearchIndex();
        setupSearch();
        setupProcedureControls();
        setupMeasurementVectors();
        setupTmaFocusPanel();
        console.info(`Base operacional do Brasil carregada: ${waypointFeatures.length} pontos, ${aerodromesGroup.getLayers().length} aeródromos AIXM, ${tmaBoundaries.length} setores TMA e ${procedureCatalog.tmas.reduce((total, item) => total + (item.procedureCount || 0), 0)} procedimentos disponíveis sob demanda.`);
    })
    .catch(error => { console.error(error); document.getElementById('details-content').innerHTML = `<div class="panel-placeholder"><p>Não foi possível carregar a base: ${esc(error.message)}</p></div>`; });

function buildProcedurePointIndex() {
    procedurePointIndex.clear();
    procedurePointCandidates.clear();
    procedurePointById.clear();
    waypointFeatures.forEach(feature => addProcedurePointCandidate(feature, 0));
    [...(aeronauticalData.aerodromes || []), ...nationalAerodromes, ...(aeronauticalData.navaids || []), ...(aeronauticalData.fixes || [])].forEach(point => {
        if (!point.id || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
        const ident = String(point.id).toUpperCase();
        addProcedurePointCandidate({
            type: 'Feature',
            id: `aeronautical:${ident}`,
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
            properties: { ident, latitude: point.lat, longitude: point.lon, tipo: point.type || 'Dado aeronáutico' }
        }, 10);
    });
    moduleAerodromes().forEach(point => {
        if (!point.id || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
        [point.id, ...(point.aliases || [])].forEach(code => {
            const ident = String(code).toUpperCase();
            addProcedurePointCandidate({
                type: 'Feature',
                id: `tma-aerodrome:${ident}`,
                geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                properties: { ident, latitude: point.lat, longitude: point.lon, latitude_gms: point.lat_dms, longitude_gms: point.lon_dms, tipo: point.type, source: point.source }
            }, 10);
        });
    });
}

function addProcedurePointCandidate(feature, priority) {
    const ident = String(feature.properties?.ident || '').toUpperCase();
    if (!ident || !Number.isFinite(feature.properties?.latitude) || !Number.isFinite(feature.properties?.longitude)) return;
    if (!procedurePointCandidates.has(ident)) procedurePointCandidates.set(ident, []);
    procedurePointCandidates.get(ident).push({ feature, priority });
    if (feature.id) procedurePointById.set(feature.id, feature);
    const current = procedurePointIndex.get(ident);
    if (!current || priority < current.priority) procedurePointIndex.set(ident, { feature, priority });
}

function renderBaseData() {
    aeronauticalData.navaids.forEach(item => {
        if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
        const marker = L.marker([item.lat, item.lon], { icon: icon(item.id) }).bindPopup(`<b>${esc(item.id)}</b><br>Clique para detalhes`).on('click', () => showDetails(item, 'navaid')).addTo(navaidsGroup);
        activeMarkers[`navaid:${item.id}`] = marker;
    });
    const renderedAerodromes = new Set();
    moduleAerodromes().forEach(item => {
        const ident = String(item.id || '').toUpperCase();
        if (!ident || !Number.isFinite(item.lat) || !Number.isFinite(item.lon) || renderedAerodromes.has(ident)) return;
        renderedAerodromes.add(ident);
        const marker = L.marker([item.lat, item.lon], { icon: aerodromeIcon(ident), zIndexOffset: 500 })
            .bindPopup(`<b>${esc(ident)}</b><br>${esc(item.name)}<br>${esc(item.city || '')}`)
            .on('click', () => showDetails(item, 'aerodrome'))
            .addTo(aerodromesGroup);
        [ident, ...(item.aliases || []).map(alias => String(alias).toUpperCase())].forEach(code => { activeMarkers[`aerodrome:${code}`] = marker; });
    });
    aeronauticalData.aerodromes.forEach(item => {
        if (!item.id || !Number.isFinite(item.lat) || !Number.isFinite(item.lon) || renderedAerodromes.has(item.id)) return;
        renderedAerodromes.add(item.id);
        const marker = L.marker([item.lat, item.lon], { icon: icon(item.id) }).bindPopup(`<b>${esc(item.id)}</b><br>${esc(item.name || 'Aeródromo')}`).on('click', () => showDetails(item, 'aerodrome')).addTo(aerodromesGroup);
        activeMarkers[`aerodrome:${item.id}`] = marker;
    });
    nationalAerodromes.forEach(item => {
        const ident = String(item.id || '').toUpperCase();
        if (!ident || !Number.isFinite(item.lat) || !Number.isFinite(item.lon) || renderedAerodromes.has(ident)) return;
        renderedAerodromes.add(ident);
        const marker = L.circleMarker([item.lat, item.lon], { renderer: nationalPointRenderer, radius: 3, color: '#ffd166', weight: 1, fillColor: '#ffd166', fillOpacity: .72 })
            .bindTooltip(`${esc(ident)} — ${esc(item.name || 'Aeródromo')}`)
            .on('click', () => showDetails(item, 'aerodrome'))
            .addTo(aerodromesGroup);
        activeMarkers[`aerodrome:${ident}`] = marker;
    });
    waypointFeatures.filter(feature => String(feature.properties.tipo).toUpperCase() === 'OTHER:ADHP').forEach(feature => {
        const point = feature.properties, ident = String(point.ident).toUpperCase();
        if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || renderedAerodromes.has(ident)) return;
        renderedAerodromes.add(ident);
        const marker = L.marker([point.latitude, point.longitude], { icon: icon(ident) }).bindPopup(`<b>${esc(ident)}</b><br>Aeródromo`).on('click', () => showDetails(feature, 'waypoint')).addTo(aerodromesGroup);
        activeMarkers[`aerodrome:${ident}`] = marker;
    });
    tmaBoundaries.forEach(feature => {
        const properties = feature.properties || {}, hasOperationalMetadata = Boolean(properties.frequencies), isFlexible = /\dF$/i.test(properties.sector_id || properties.designator || properties.sector_name || '');
        const style = { color: hasOperationalMetadata ? '#ef5bff' : '#9c27b0', weight: hasOperationalMetadata ? 2.2 : 2, dashArray: isFlexible ? '8 5' : null, fillColor: '#9c27b0', fillOpacity: hasOperationalMetadata ? .055 : .12 };
        const primary = properties.frequencies?.primary?.join(', ') || 'não informada', secondary = properties.frequencies?.secondary?.join(', ') || '—';
        const popup = `<b>${esc(properties.name)}</b><br>Limites: ${esc(properties.lower_limit)} — ${esc(properties.upper_limit)}<br>Classe: ${esc(properties.airspace_class || 'N/I')}${hasOperationalMetadata ? `<br>Primária: ${esc(primary)}<br>Secundária: ${esc(secondary)}<br><small>Geometria AIXM vigente em ${esc(properties.effective_date)}</small>` : ''}`;
        const layer = L.geoJSON(feature, { style }).bindPopup(popup).bindTooltip(esc(properties.name), { sticky: true, className: 'tma-sector-tooltip' }).addTo(tmaGroup);
        if (hasOperationalMetadata) layer.on('mouseover', () => layer.setStyle({ weight: 4, fillOpacity: .14 })).on('mouseout', () => layer.setStyle(style));
    });
}

function ensureAllFixesRendered() {
    if (allFixesRendered) return;
    waypointFeatures.filter(feature => String(feature.properties.tipo).toUpperCase() !== 'OTHER:ADHP' && !feature.properties.hidden_on_map).forEach(feature => {
        const point = feature.properties;
        if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return;
        L.circleMarker([point.latitude, point.longitude], { renderer: nationalPointRenderer, radius: 2.5, color: '#00e5ff', weight: 1, fillColor: '#00e5ff', fillOpacity: .7 })
            .bindTooltip(`${esc(point.ident)} — ${esc(point.tipo)}`)
            .on('click', () => showDetails(feature, 'waypoint'))
            .addTo(allFixesGroup);
    });
    allFixesRendered = true;
}

function compactDmsToDecimal(value) {
    const match = String(value).toUpperCase().match(/^(\d{2,3})(\d{2})(\d{2})([NSEW])$/);
    if (!match) return NaN;
    const decimal = Number(match[1]) + Number(match[2]) / 60 + Number(match[3]) / 3600;
    return ['S', 'W'].includes(match[4]) ? -decimal : decimal;
}

function tmaSectorFeatures(dataset, moduleId = 'tma') {
    return (dataset.sectors || []).map(sector => {
        const coordinates = (sector.coordinatesDms || []).map(([latitude, longitude]) => [compactDmsToDecimal(longitude), compactDmsToDecimal(latitude)]).filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));
        if (coordinates.length < 3) return null;
        const first = coordinates[0], last = coordinates[coordinates.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
        return {
            type: 'Feature',
            id: `${moduleId}-sector:${sector.id}`,
            properties: {
                name: sector.name,
                sector_id: sector.id,
                type: 'TMA',
                lower_limit: sector.lowerLimit,
                upper_limit: sector.upperLimit,
                airspace_class: sector.airspaceClass,
                frequencies: sector.frequencies,
                responsible_unit: 'São Paulo APP',
                operation: 'H24',
                remarks: dataset.sharedRemarks,
                source: dataset.authority,
                source_url: dataset.source,
                effective_date: dataset.effectiveDate,
                class_summary: dataset.airspaceClassSummary,
                dataset: `${moduleId}-official-sectorization`
            },
            geometry: { type: 'Polygon', coordinates: [coordinates] }
        };
    }).filter(Boolean);
}

function tmaSectorMetadataKey(feature) {
    const properties = feature.properties || {};
    const sectorName = properties.sector_name || properties.name || '';
    return normalizedOperationalName(sectorName).replace(/^TMA\s+/, '');
}

function mergeOperationalTmaMetadata(officialFeatures, moduleFeatures) {
    const metadataBySector = new Map(moduleFeatures.map(feature => [tmaSectorMetadataKey(feature), feature.properties || {}]));
    return officialFeatures.map(feature => {
        const operational = metadataBySector.get(tmaSectorMetadataKey(feature));
        if (!operational) return feature;
        return {
            ...feature,
            properties: {
                ...feature.properties,
                airspace_class: feature.properties?.airspace_class && feature.properties.airspace_class !== 'N/I' ? feature.properties.airspace_class : operational.airspace_class,
                frequencies: operational.frequencies,
                responsible_unit: operational.responsible_unit,
                operation: operational.operation,
                remarks: operational.remarks,
                class_summary: operational.class_summary,
                operational_metadata_source: operational.source,
                operational_metadata_effective_date: operational.effective_date,
            }
        };
    });
}

function renderTestAreas() {
    testAreas.forEach(area => {
        const popup = `<b>${esc(area.name)}</b><br>Limites: ${esc(area.verticalLimits)}<br>Órgão responsável: ${esc(area.responsibleUnit)}<br><small>Fonte: CIRCEA 100-104/2023, Anexo A</small>`;
        if (area.geometryType === 'circle') {
            L.circle(area.center, { radius: area.radiusNm * 1852, color: '#ffb300', weight: 2, dashArray: '8 5', fillColor: '#ffb300', fillOpacity: .14 }).bindPopup(popup).addTo(testAreasGroup);
            return;
        }
        const coordinates = area.coordinatesDms.map(([latitude, longitude]) => [compactDmsToDecimal(latitude), compactDmsToDecimal(longitude)]);
        L.polygon(coordinates, { color: '#ffb300', weight: 2, dashArray: '8 5', fillColor: '#ffb300', fillOpacity: .14 }).bindPopup(popup).addTo(testAreasGroup);
    });
}

function vectorUnit() { return document.getElementById('vector-unit')?.value || 'NM'; }
function vectorDistance(start, end) { const meters = map.distance(start, end), unit = vectorUnit(); return unit === 'KM' ? meters / 1000 : meters / 1852; }
function vectorDistanceText(start, end) { const distance = vectorDistance(start, end); return `${distance < 10 ? distance.toFixed(2) : distance.toFixed(1)} ${vectorUnit()}`; }
function vectorMidpoint(start, end) { return L.latLng((start.lat + end.lat) / 2, (start.lng + end.lng) / 2); }
function setVectorStatus(message, drawing = false) { const status = document.getElementById('vector-status'); status.textContent = message; status.classList.toggle('is-drawing', drawing); }
function updateVectorLabel(vector) {
    if (!vector?.end) return;
    vector.line.setTooltipContent(vectorDistanceText(vector.start, vector.end));
    vector.line.openTooltip(vectorMidpoint(vector.start, vector.end));
}
function selectMeasurementVector(id) {
    selectedVectorId = id;
    measurementVectors.forEach((vector, vectorId) => vector.line.setStyle({ color: vectorId === id ? '#ffd54f' : '#00e5ff', weight: vectorId === id ? 5 : 3 }));
    const selected = measurementVectors.get(id);
    setVectorStatus(selected ? `Vetor ${id} selecionado — ${vectorDistanceText(selected.start, selected.end)}. Pressione X para apagar.` : 'Mova o mouse sobre o mapa e pressione O para iniciar.');
}
function beginMeasurementVector() {
    if (!pointerLatLng) return setVectorStatus('Posicione o mouse sobre o mapa antes de pressionar O.');
    if (draftVector) deleteSelectedMeasurementVector();
    selectedVectorId = null;
    const start = L.latLng(pointerLatLng), line = L.polyline([start, start], { color: '#ffd54f', weight: 4, dashArray: '7 6', bubblingMouseEvents: false }).bindTooltip('0.00 NM', { permanent: true, direction: 'top', className: 'vector-distance-label' }).addTo(measurementVectorsGroup);
    const startMarker = L.circleMarker(start, { radius: 5, color: '#ffd54f', weight: 2, fillColor: '#121212', fillOpacity: 1, bubblingMouseEvents: false }).bindTooltip('O', { permanent: true, direction: 'left' }).addTo(measurementVectorsGroup);
    draftVector = { start, end: start, line, startMarker };
    updateVectorLabel(draftVector);
    setVectorStatus('Vetor em andamento: mova o mouse e pressione F para fixar.', true);
}
function finishMeasurementVector() {
    if (!draftVector || !pointerLatLng) return;
    const id = nextVectorId++, end = L.latLng(pointerLatLng), vector = { ...draftVector, id, end };
    vector.line.setLatLngs([vector.start, end]).setStyle({ color: '#00e5ff', weight: 3, dashArray: null });
    vector.endMarker = L.circleMarker(end, { radius: 5, color: '#00e5ff', weight: 2, fillColor: '#121212', fillOpacity: 1, bubblingMouseEvents: false }).bindTooltip('F', { permanent: true, direction: 'right' }).addTo(measurementVectorsGroup);
    vector.line.on('click', event => { if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent); selectMeasurementVector(id); });
    vector.startMarker.on('click', event => { if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent); selectMeasurementVector(id); });
    vector.endMarker.on('click', event => { if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent); selectMeasurementVector(id); });
    measurementVectors.set(id, vector);
    draftVector = null;
    updateVectorLabel(vector);
    selectMeasurementVector(id);
}
function removeMeasurementVectorLayers(vector) {
    if (!vector) return;
    vector.line.closeTooltip();
    vector.line.unbindTooltip();
    [vector.line, vector.startMarker, vector.endMarker].filter(Boolean).forEach(layer => measurementVectorsGroup.removeLayer(layer));
}
function deleteSelectedMeasurementVector() {
    if (draftVector) {
        removeMeasurementVectorLayers(draftVector);
        draftVector = null;
        selectedVectorId = null;
        return setVectorStatus('Vetor em andamento apagado. Pressione O para iniciar outro.');
    }
    const vector = measurementVectors.get(selectedVectorId);
    if (!vector) return setVectorStatus('Clique em um vetor para selecioná-lo antes de pressionar X.');
    removeMeasurementVectorLayers(vector);
    measurementVectors.delete(selectedVectorId);
    selectedVectorId = null;
    setVectorStatus(`Vetor apagado. ${measurementVectors.size} vetor(es) restante(s).`);
}
function clearMeasurementVectors() {
    measurementVectors.forEach(removeMeasurementVectorLayers);
    removeMeasurementVectorLayers(draftVector);
    measurementVectorsGroup.clearLayers();
    measurementVectors.clear();
    draftVector = null;
    selectedVectorId = null;
    setVectorStatus('Todos os vetores foram apagados. Pressione O para iniciar.');
}
function setupMeasurementVectors() {
    map.on('mousemove', event => {
        pointerLatLng = event.latlng;
        if (!draftVector) return;
        draftVector.end = event.latlng;
        draftVector.line.setLatLngs([draftVector.start, event.latlng]);
        updateVectorLabel(draftVector);
    });
    map.on('click', () => { if (!draftVector) selectMeasurementVector(null); });
    map.on('overlayadd', event => { if (event.layer === allFixesGroup) ensureAllFixesRendered(); });
    document.getElementById('vector-unit').addEventListener('change', () => {
        measurementVectors.forEach(updateVectorLabel);
        updateVectorLabel(draftVector);
        if (selectedVectorId) selectMeasurementVector(selectedVectorId);
    });
    document.addEventListener('keydown', event => {
        if (event.ctrlKey || event.altKey || event.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
        const key = event.key.toUpperCase();
        if (!['O', 'F', 'X', 'Z'].includes(key)) return;
        event.preventDefault();
        if (key === 'O') beginMeasurementVector();
        if (key === 'F') finishMeasurementVector();
        if (key === 'X') deleteSelectedMeasurementVector();
        if (key === 'Z') clearMeasurementVectors();
    });
}
function buildSearchIndex() {
    const base = [];
    [['aerodromes', 'aerodrome', 'Aeródromo'], ['navaids', 'navaid', 'Auxílio']].forEach(([collection, category, fallback]) => aeronauticalData[collection].forEach(item => base.push({ key: `${category}:${item.id}`, ident: String(item.id), type: item.type || fallback, lat: item.lat, lon: item.lon, gms: `${item.lat_dms || ''} ${item.lon_dms || ''}`.trim(), item, category })));
    moduleAerodromes().forEach(item => {
        [item.id, ...(item.aliases || [])].forEach(code => base.push({ key: `aerodrome:${String(code).toUpperCase()}`, ident: String(code).toUpperCase(), type: code === item.id ? item.type : `Código alternativo de ${item.id}`, lat: item.lat, lon: item.lon, gms: `${item.lat_dms || ''} ${item.lon_dms || ''}`.trim(), item, category: 'aerodrome' }));
    });
    const knownAerodromeCodes = new Set(base.filter(item => item.category === 'aerodrome').map(item => item.ident.toUpperCase()));
    nationalAerodromes.forEach(item => {
        const ident = String(item.id || '').toUpperCase();
        if (!ident || knownAerodromeCodes.has(ident)) return;
        knownAerodromeCodes.add(ident);
        base.push({ key: `aerodrome:${ident}`, ident, type: item.type || 'Aeródromo AIXM', lat: item.lat, lon: item.lon, gms: '', item, category: 'aerodrome' });
    });
    waypointFeatures.filter(feature => !feature.properties.hidden_on_map).forEach(feature => { const p = feature.properties; base.push({ key: feature.id, ident: String(p.ident), type: String(p.tipo ?? ''), lat: p.latitude, lon: p.longitude, gms: `${p.latitude_gms ?? ''} ${p.longitude_gms ?? ''}`.trim(), item: feature, category: 'waypoint' }); });
    searchEntries = base.sort((a, b) => a.ident.localeCompare(b.ident));
}
function setupSearch() {
    const input = document.getElementById('search-input'), box = document.getElementById('suggestions-box');
    input.addEventListener('input', () => { const q = input.value.trim().toUpperCase(); box.replaceChildren(); if (q === 'CAFEDOSCRIAS') { box.style.display = 'none'; showCafeEasterEgg(); return; } if (!q) return void (box.style.display = 'none'); const matches = searchEntries.filter(e => e.ident.toUpperCase().includes(q)).slice(0, 12); matches.forEach(e => box.appendChild(suggestion(e, input, box))); box.style.display = matches.length ? 'block' : 'none'; });
    document.addEventListener('click', e => { if (!e.target.closest('.search-container')) box.style.display = 'none'; });
}
function showCafeEasterEgg() {
    const overlay = document.getElementById('cafe-easter-egg');
    if (!overlay) return;
    clearTimeout(cafeEasterEggTimer);
    overlay.hidden = false;
    overlay.classList.remove('is-visible');
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    cafeEasterEggTimer = setTimeout(() => {
        overlay.classList.remove('is-visible');
        setTimeout(() => { if (!overlay.classList.contains('is-visible')) overlay.hidden = true; }, 280);
    }, 3000);
}
function suggestion(entry, input, box) { const el = document.createElement('button'); el.type = 'button'; el.className = 'suggestion-item'; el.innerHTML = `<span><strong>${esc(entry.ident)}</strong> — ${esc(entry.type)}</span><span class="coord-tag">${esc(entry.gms || `${entry.lat}, ${entry.lon}`)}</span>`; el.onclick = () => { selectEntry(entry); input.value = entry.ident; box.style.display = 'none'; }; return el; }
function selectEntry(entry) { map.setView([entry.lat, entry.lon], 8, { animate: true, duration: .5 }); if (entry.category === 'waypoint') addWaypoint(entry); else { activeMarkers[entry.key]?.openPopup(); showDetails(entry.item, entry.category); } }
function addWaypoint(entry) { let marker = selectedWaypointMarkers.get(entry.key); if (!marker) { marker = L.marker([entry.lat, entry.lon], { icon: icon(entry.ident, true), zIndexOffset: 1000 }).bindPopup(`<b>${esc(entry.ident)}</b><br>${esc(entry.type)}<br>${esc(entry.gms || `${entry.lat}, ${entry.lon}`)}`).on('click', () => showDetails(entry.item, 'waypoint')).addTo(waypointSelectionsGroup); selectedWaypointMarkers.set(entry.key, marker); renderSelectedPoints(); } marker.openPopup(); showDetails(entry.item, 'waypoint'); }
function removeWaypoint(key) { selectedWaypointMarkers.get(key)?.remove(); selectedWaypointMarkers.delete(key); renderSelectedPoints(); }
function renderSelectedPoints() { const target = document.getElementById('selected-points'); target.replaceChildren(); if (!selectedWaypointMarkers.size) { target.innerHTML = '<span class="empty-selection">Nenhum waypoint selecionado.</span>'; return; } selectedWaypointMarkers.forEach((marker, key) => { const entry = searchEntries.find(e => e.key === key), row = document.createElement('div'); row.className = 'selected-point-row'; row.innerHTML = `<span><strong>${esc(entry.ident)}</strong><br><span class="mono-small">${esc(entry.gms)}</span></span><button type="button">Remover</button>`; row.querySelector('span').onclick = () => selectEntry(entry); row.querySelector('button').onclick = () => removeWaypoint(key); target.appendChild(row); }); }
function addMultiplePoints() { const ids = document.getElementById('multiple-input').value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean), entries = ids.map(id => searchEntries.find(e => e.ident.toUpperCase() === id)).filter(Boolean); if (!entries.length) return alert('Nenhum ponto válido encontrado com os identificadores fornecidos.'); entries.forEach(selectEntry); routesGroup.clearLayers(); const coords = entries.map(e => [e.lat, e.lon]); if (coords.length > 1) { const line = L.polyline(coords, { color: '#00e5ff', weight: 3, dashArray: '5, 10' }).addTo(routesGroup); map.fitBounds(line.getBounds(), { padding: [50, 50] }); } }
function showDetails(item, category) { const panel = document.getElementById('details-content'); if (category === 'waypoint') { const p = item.properties, fields = Object.entries(p).filter(([key, v]) => key !== 'source' && v !== null && v !== undefined && v !== '').map(([k, v]) => `<div class="info-row"><span class="info-label">${esc(k)}:</span><span class="info-val">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span></div>`).join(''), source = item.sourceRow ? `waypoint.xlsx, linha ${item.sourceRow}` : p.source ? `${p.source.chart || p.source.procedure || 'tabela de codificação'}, página ${p.source.codingTablePage || 'não informada'}` : 'não informada'; panel.innerHTML = `<div class="panel-header fix-header"><h3>${esc(p.ident)}</h3><p class="subtitle">WAYPOINT — ${esc(p.tipo)}</p></div><div class="panel-body"><div class="coords-box"><strong>COORDENADAS DA FONTE</strong><br><span class="mono">${esc(p.latitude_gms)} ${esc(p.longitude_gms)}</span><br><span class="mono-small">Decimal: ${esc(p.latitude)}, ${esc(p.longitude)}</span></div>${fields}<div class="source-tag"><strong>Fonte:</strong> ${esc(source)}</div></div>`; return; } const details = category === 'aerodrome' ? `<div class="info-row"><span class="info-label">Nome:</span><span class="info-val">${esc(item.name || '')}</span></div><div class="info-row"><span class="info-label">Localidade:</span><span class="info-val">${esc(item.city || '')}</span></div><div class="info-row"><span class="info-label">Elevação:</span><span class="info-val">${Number.isFinite(item.elevation_ft) ? `${esc(item.elevation_ft)} FT` : 'não informada'}</span></div>${item.aliases?.length ? `<div class="info-row"><span class="info-label">Código alternativo:</span><span class="info-val">${esc(item.aliases.join(', '))}</span></div>` : ''}` : ''; const source = item.source_url ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener">${esc(item.source || 'Consultar fonte')}</a>` : esc(item.source || 'não informada'); panel.innerHTML = `<div class="panel-header fix-header"><h3>${esc(item.id || item.name)}</h3><p class="subtitle">${esc(item.type || category)}</p></div><div class="panel-body"><div class="coords-box"><strong>COORDENADAS DA FONTE</strong><br><span class="mono">${esc(item.lat_dms || '')} ${esc(item.lon_dms || '')}</span><br><span class="mono-small">Decimal: ${esc(item.lat)}, ${esc(item.lon)}</span></div>${details}<div class="source-tag"><strong>Fonte:</strong> ${source}</div></div>`; }

function tmaFamilyName(name) {
    return String(name || 'TMA').split('·')[0].replace(/\s+SECT\b.*$/i, '').replace(/\s+\d+$/i, '').replace(/\s+\(Circular.*$/i, '').trim();
}
function overlapArea(first, second) {
    const west = Math.max(first.getWest(), second.getWest()), east = Math.min(first.getEast(), second.getEast()), south = Math.max(first.getSouth(), second.getSouth()), north = Math.min(first.getNorth(), second.getNorth());
    if (west >= east || south >= north) return 0;
    return (east - west) * (north - south) * Math.cos(((north + south) / 2) * Math.PI / 180);
}
function boundsArea(bounds) {
    return Math.max(0.000001, (bounds.getEast() - bounds.getWest()) * (bounds.getNorth() - bounds.getSouth()) * Math.cos(bounds.getCenter().lat * Math.PI / 180));
}
function clipPolygonToBounds(coordinates, bounds) {
    let points = coordinates.map(([lon, lat]) => ({ x: lon, y: lat }));
    const verticalIntersection = (x, first, second) => ({ x, y: first.y + (second.y - first.y) * (x - first.x) / ((second.x - first.x) || 1e-12) });
    const horizontalIntersection = (y, first, second) => ({ x: first.x + (second.x - first.x) * (y - first.y) / ((second.y - first.y) || 1e-12), y });
    const edges = [
        { inside: point => point.x >= bounds.getWest(), intersect: (first, second) => verticalIntersection(bounds.getWest(), first, second) },
        { inside: point => point.x <= bounds.getEast(), intersect: (first, second) => verticalIntersection(bounds.getEast(), first, second) },
        { inside: point => point.y >= bounds.getSouth(), intersect: (first, second) => horizontalIntersection(bounds.getSouth(), first, second) },
        { inside: point => point.y <= bounds.getNorth(), intersect: (first, second) => horizontalIntersection(bounds.getNorth(), first, second) }
    ];
    edges.forEach(edge => {
        const input = points;
        points = [];
        if (!input.length) return;
        let previous = input[input.length - 1];
        input.forEach(current => {
            const currentInside = edge.inside(current), previousInside = edge.inside(previous);
            if (currentInside) {
                if (!previousInside) points.push(edge.intersect(previous, current));
                points.push(current);
            } else if (previousInside) points.push(edge.intersect(previous, current));
            previous = current;
        });
    });
    return points;
}
function clippedPolygonArea(coordinates, bounds) {
    const points = clipPolygonToBounds(coordinates, bounds);
    if (points.length < 3) return 0;
    let area = 0;
    points.forEach((point, index) => { const next = points[(index + 1) % points.length]; area += point.x * next.y - next.x * point.y; });
    return Math.abs(area / 2) * Math.cos(bounds.getCenter().lat * Math.PI / 180);
}
function featureVisibleArea(feature, bounds) {
    if (!feature?.geometry?.coordinates) return 0;
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
    return polygons.reduce((total, polygon) => total + (polygon[0] ? clippedPolygonArea(polygon[0], bounds) : 0) - polygon.slice(1).reduce((holes, ring) => holes + clippedPolygonArea(ring, bounds), 0), 0);
}
function geometryVertexCount(geometry) {
    if (!geometry?.coordinates) return 0;
    if (geometry.type === 'Polygon') return geometry.coordinates.reduce((total, ring) => total + ring.length, 0);
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.reduce((total, polygon) => total + polygon.reduce((sum, ring) => sum + ring.length, 0), 0);
    return 0;
}
function normalizedOperationalName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
function pointInRing(longitude, latitude, ring) {
    let inside = false;
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
        const [currentLon, currentLat] = ring[current], [previousLon, previousLat] = ring[previous];
        const intersects = (currentLat > latitude) !== (previousLat > latitude) && longitude < (previousLon - currentLon) * (latitude - currentLat) / ((previousLat - currentLat) || 1e-12) + currentLon;
        if (intersects) inside = !inside;
    }
    return inside;
}
function pointInFeature(latitude, longitude, feature) {
    const geometry = feature?.geometry;
    if (!geometry?.coordinates) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygons.some(polygon => polygon[0] && pointInRing(longitude, latitude, polygon[0]) && !polygon.slice(1).some(ring => pointInRing(longitude, latitude, ring)));
}
function moduleForOperationalFamily(family) {
    const key = normalizedOperationalName(family);
    return procedureModules.find(module => normalizedOperationalName(module.operational?.family || module.manifestName || module.name) === key) || null;
}
function architectureForFamily(family) {
    const key = normalizedOperationalName(family);
    return (procedureCatalog.tmas || []).find(item => !item.technicalGroup && normalizedOperationalName(item.name) === key) || null;
}
async function fetchJson(file, label = file) {
    const response = await fetch(file, { cache: 'no-cache' });
    if (!response.ok) throw Error(`${label} indisponível`);
    return response.json();
}
async function loadTmaArchitecture(entry) {
    if (!entry) return null;
    if (!tmaArchitectureCache.has(entry.file)) tmaArchitectureCache.set(entry.file, fetchJson(entry.file, `TMA ${entry.name}`));
    return tmaArchitectureCache.get(entry.file);
}
async function loadAirportIndex(entry) {
    const tma = await loadTmaArchitecture(entry);
    if (!tma) return { airports: [] };
    if (!airportIndexCache.has(tma.airportsIndex)) airportIndexCache.set(tma.airportsIndex, fetchJson(tma.airportsIndex, `aeródromos de ${tma.name}`));
    return airportIndexCache.get(tma.airportsIndex);
}
async function loadProcedureIndex(airportEntry) {
    if (!airportEntry?.proceduresIndex) return { types: { SID: [], STAR: [], IAC: [] } };
    if (!procedureIndexCache.has(airportEntry.proceduresIndex)) procedureIndexCache.set(airportEntry.proceduresIndex, fetchJson(airportEntry.proceduresIndex, `procedimentos de ${airportEntry.icao}`));
    return procedureIndexCache.get(airportEntry.proceduresIndex);
}
function normalizeProcedureRef(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value.ident || value.name || value.id || null;
    return value == null ? null : String(value);
}
function sanitizeProcedureObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const copy = { ...value };
    ['latitude', 'longitude', 'lat', 'lon', 'lng'].forEach(key => delete copy[key]);
    return copy;
}
function procedureCourseValues(rawLeg) {
    const course = rawLeg?.course && typeof rawLeg.course === 'object' ? rawLeg.course : {}, reference = String(rawLeg?.course_reference || '').toUpperCase();
    let magnetic = Number.isFinite(rawLeg?.course_magnetic) ? rawLeg.course_magnetic : Number.isFinite(course.magnetic) ? course.magnetic : null;
    let trueCourse = Number.isFinite(rawLeg?.course_true) ? rawLeg.course_true : Number.isFinite(course.true) ? course.true : null;
    if (Number.isFinite(rawLeg?.course)) {
        if (reference.includes('TRUE')) trueCourse = rawLeg.course;
        else if (reference.includes('MAG')) magnetic = rawLeg.course;
        else if (magnetic == null) magnetic = rawLeg.course;
    }
    return { magnetic, true: trueCourse };
}
function normalizeProcedureLeg(rawLeg, index, prefix = 'LEG') {
    const source = sanitizeProcedureObject(rawLeg || {}), course = procedureCourseValues(source), courseReference = source.course_reference || (Number.isFinite(course.magnetic) ? 'MAG' : Number.isFinite(course.true) ? 'TRUE' : null);
    const normalized = {
        ...source,
        id: source.id || `${prefix}-${index + 1}`,
        from: normalizeProcedureRef(source.from),
        to: normalizeProcedureRef(source.to),
        via: Array.isArray(source.via) ? source.via.map(normalizeProcedureRef).filter(Boolean) : [],
        path_terminator: source.path_terminator || source.pathTerminator || source.terminator || null,
        course: Number.isFinite(source.course) ? source.course : source.course ?? null,
        course_reference: courseReference,
        course_magnetic: course.magnetic,
        course_true: course.true,
        distance_nm: Number.isFinite(source.distance_nm) ? source.distance_nm : Number.isFinite(source.distanceNm) ? source.distanceNm : null,
        turn: source.turn ?? source.turn_direction ?? source.direction ?? null,
        arc_center: normalizeProcedureRef(source.arc_center ?? source.arcCenterFix),
        arc_radius_nm: Number.isFinite(source.arc_radius_nm) ? source.arc_radius_nm : Number.isFinite(source.arcRadiusNm) ? source.arcRadiusNm : null,
        lower_limit: source.lower_limit ?? source.lowerLimit ?? null,
        upper_limit: source.upper_limit ?? source.upperLimit ?? null,
        speed_limit_kt: source.speed_limit_kt ?? source.speedLimitKt ?? null,
        speed_interpretation: source.speed_interpretation ?? source.speedLimitDescription ?? null,
        fix_role: source.fix_role ?? source.fixRole ?? null,
        navigation_specification: source.navigation_specification ?? source.navigationSpecification ?? null,
    };
    return {
        ...normalized,
        origin: normalized.from,
        destination: normalized.to,
        pathTerminator: normalized.path_terminator,
        course: course,
        course_value: Number.isFinite(source.course) ? source.course : null,
        distanceNm: normalized.distance_nm,
        flyOver: normalized.fly_over,
        lowerLimitAltitude: normalized.lower_limit,
        upperLimitAltitude: normalized.upper_limit,
        speedLimitKt: normalized.speed_limit_kt,
        speedLimitDescription: normalized.speed_interpretation,
        verticalAngle: normalized.vertical_angle,
        fixRole: normalized.fix_role,
        navigationSpecification: normalized.navigation_specification,
        arcCenterFix: normalized.arc_center,
        arcRadiusNm: normalized.arc_radius_nm,
        sourcePage: normalized.source_page,
    };
}
function procedureRouteSequence(segments) {
    const sequence = [], append = value => { const ref = normalizeProcedureRef(value); if (ref && sequence[sequence.length - 1] !== ref) sequence.push(ref); };
    (segments || []).forEach(segment => { append(segment.from); (segment.via || []).forEach(append); append(segment.to); });
    return sequence;
}
function generatedProcedureTransitions(legs) {
    const outgoing = new Map(), destinations = new Set(), legById = new Map(legs.map(leg => [leg.id, leg])), routes = [], emitted = new Set();
    legs.forEach(leg => {
        if (leg.from) {
            if (!outgoing.has(leg.from)) outgoing.set(leg.from, []);
            outgoing.get(leg.from).push(leg);
        }
        if (leg.to) destinations.add(leg.to);
    });
    const pushRoute = path => {
        if (!path.length) return;
        path.forEach(leg => emitted.add(leg.id));
        const number = routes.length + 1;
        routes.push({ id: `AUTO-${number}`, name: `Trajetória ${number}`, kind: 'AUTO', generated: true, sequence: procedureRouteSequence(path), leg_ids: path.map(leg => leg.id), segments: path });
    };
    const walk = (path, currentRef, visited) => {
        const next = (outgoing.get(currentRef) || []).filter(leg => !visited.has(leg.id));
        if (!next.length) return pushRoute(path);
        next.forEach(leg => walk([...path, leg], leg.to, new Set([...visited, leg.id])));
    };
    const roots = legs.filter(leg => !leg.from || !destinations.has(leg.from));
    roots.forEach(leg => walk([leg], leg.to, new Set([leg.id])));
    legs.forEach(leg => { if (!emitted.has(leg.id)) walk([leg], leg.to, new Set([leg.id])); });
    return routes;
}
function normalizeProcedureRoute(route, legById, prefix) {
    const rawRoute = sanitizeProcedureObject(route || {}), routeLegs = Array.isArray(rawRoute.leg_ids) ? rawRoute.leg_ids.map(id => legById.get(id)).filter(Boolean) : Array.isArray(rawRoute.legs) ? rawRoute.legs.map((leg, index) => normalizeProcedureLeg(leg, index, `${prefix}-LEG`)) : [];
    const segments = routeLegs.map((leg, index) => leg.origin !== undefined ? leg : normalizeProcedureLeg(leg, index, prefix));
    const sequence = Array.isArray(rawRoute.sequence) ? rawRoute.sequence.map(normalizeProcedureRef).filter(Boolean) : procedureRouteSequence(segments);
    return { ...rawRoute, id: rawRoute.id || prefix, name: rawRoute.name || rawRoute.id || prefix, sequence, segments, leg_ids: segments.map(leg => leg.id) };
}
function normalizeProcedure(rawProcedure, catalogEntry = {}, tmaId = '') {
    const document = rawProcedure || {}, metadata = document.procedure || {}, source = metadata.source && typeof metadata.source === 'object' ? metadata.source : { authority: metadata.source || null }, rawPoints = document.points && typeof document.points === 'object' ? document.points : {}, format = document.schemaVersion && Array.isArray(document.transitions) && document.transitions.some(route => Array.isArray(route.leg_ids)) ? 'architecture-v1' : 'simplified-legs';
    const points = Object.fromEntries(Object.entries(rawPoints).map(([key, value]) => {
        const point = sanitizeProcedureObject(value || {}), ident = normalizeProcedureRef(point.ident) || key;
        return [key, { ...point, ident, coordinate_ref: point.coordinate_ref || null }];
    }));
    const legs = (document.legs || []).map((leg, index) => normalizeProcedureLeg(leg, index, `${metadata.id || catalogEntry.id || 'PROCEDURE'}-LEG`)), legById = new Map(legs.map(leg => [leg.id, leg]));
    const rawRoutes = Array.isArray(document.transitions) && document.transitions.length ? document.transitions : [], normalizedRoutes = rawRoutes.map((route, index) => normalizeProcedureRoute(route, legById, `${metadata.id || 'ROUTE'}-${index + 1}`)), transitions = normalizedRoutes.length && (format === 'architecture-v1' || normalizedRoutes.some(route => route.segments.length)) ? normalizedRoutes : generatedProcedureTransitions(legs);
    const rawMissedApproach = Array.isArray(document.missed_approach) ? document.missed_approach : [], missedEntriesAreLegs = rawMissedApproach.length > 0 && rawMissedApproach.every(entry => entry && !Array.isArray(entry.legs) && (entry.from || entry.to || entry.action || entry.course != null || entry.direct || entry.holding || entry.climb_to != null || entry.until_altitude != null)), missedRoutes = missedEntriesAreLegs ? [{ id: 'MISSED-1', name: 'Aproximação perdida', kind: 'MISSED', legs: rawMissedApproach }] : rawMissedApproach;
    const missedApproach = missedRoutes.map((route, index) => {
        const normalizedRoute = sanitizeProcedureObject(route || {}), routeLegs = (route.legs || []).map((leg, legIndex) => normalizeProcedureLeg(leg, legIndex, `${normalizedRoute.id || 'MISSED'}-${index + 1}-LEG`));
        const sequence = Array.isArray(normalizedRoute.sequence) ? normalizedRoute.sequence.map(normalizeProcedureRef).filter(Boolean) : procedureRouteSequence(routeLegs);
        return { ...normalizedRoute, id: normalizedRoute.id || `MISSED-${index + 1}`, name: normalizedRoute.name || normalizedRoute.id || `Aproximação perdida ${index + 1}`, sequence, segments: routeLegs, legs: routeLegs };
    });
    const procedure = {
        id: metadata.id || catalogEntry.id || `${metadata.airport || catalogEntry.airport || 'UNKNOWN'}-${metadata.name || catalogEntry.name || 'PROCEDURE'}`,
        name: metadata.name || catalogEntry.name || 'Procedimento sem nome',
        type: String(metadata.type || catalogEntry.type || 'IAC').toUpperCase(),
        airport: metadata.airport || catalogEntry.airport || '',
        runways: Array.isArray(metadata.runways) ? metadata.runways : metadata.runways ? [metadata.runways] : metadata.runway ? [metadata.runway] : Array.isArray(catalogEntry.runways) ? catalogEntry.runways : catalogEntry.runways ? [catalogEntry.runways] : [],
        modes: Array.isArray(metadata.modes) ? metadata.modes : metadata.modes ? [metadata.modes] : Array.isArray(catalogEntry.modes) ? catalogEntry.modes : catalogEntry.modes ? [catalogEntry.modes] : [],
        status: metadata.status || (format === 'simplified-legs' ? 'simplified-normalized' : null),
        source: { ...source, authority: source.authority, chartCode: source.chart_code || source.chartCode, amendment: source.amendment, effectiveDate: source.effective_date || source.effectiveDate, document: source.document, page: source.page },
        sourceHistory: Array.isArray(metadata.source_history) ? metadata.source_history : Array.isArray(metadata.sourceHistory) ? metadata.sourceHistory : [],
        points,
        legs,
        transitions,
        missedApproach,
        warnings: Array.isArray(document.warnings) ? [...document.warnings] : [],
        tmaId,
        catalogFile: catalogEntry.file,
        format,
    };
    const pointDefinition = ident => {
        const key = Object.keys(procedure.points).find(candidate => candidate.toUpperCase() === String(ident).toUpperCase());
        return procedure.points[key] || Object.values(procedure.points).find(point => String(point.ident || '').toUpperCase() === String(ident).toUpperCase()) || null;
    };
    const requiredRefs = new Set(), collectLegRefs = leg => {
        [leg.from, leg.to, leg.arc_center, ...(leg.via || [])].forEach(ref => { if (ref) requiredRefs.add(ref); });
    };
    legs.forEach(collectLegRefs);
    missedApproach.forEach(route => route.segments.forEach(collectLegRefs));
    Object.keys(points).forEach(key => requiredRefs.add(points[key].ident || key));
    const missing = new Set();
    requiredRefs.forEach(ident => {
        if (waypointForProcedure(ident, pointDefinition(ident))) return;
        const normalized = String(ident).toUpperCase();
        if (missing.has(normalized)) return;
        missing.add(normalized);
        const warning = `FIX/WAYPOINT ${ident} não encontrado em data/waypoints.json; segmentos dependentes não serão desenhados.`;
        procedure.warnings.push(warning);
        console.warn(`[Procedimento ${procedure.name}] ${warning}`);
    });
    return procedure;
}
function hydrateProcedure(document, catalogEntry, tmaId) {
    return normalizeProcedure(document, catalogEntry, tmaId);
}
async function loadProcedureData(catalogEntry, tmaId) {
    if (!catalogEntry?.file) return null;
    if (!procedureDataCache.has(catalogEntry.file)) {
        procedureDataCache.set(catalogEntry.file, fetchJson(catalogEntry.file, catalogEntry.name).then(document => {
            const procedure = normalizeProcedure(document, catalogEntry, tmaId);
            procedures.push(procedure);
            return procedure;
        }));
    }
    return procedureDataCache.get(catalogEntry.file);
}
async function loadTmaProcedureEntries(architecture) {
    const airportIndex = await loadAirportIndex(architecture);
    const indexes = await Promise.all((airportIndex.airports || []).map(async airport => ({ airport, index: await loadProcedureIndex(airport) })));
    return indexes.flatMap(({ airport, index }) => ['SID', 'STAR', 'IAC'].flatMap(type => (index.types?.[type] || []).map(item => ({ ...item, airport: airport.icao, type, tmaId: architecture.id }))));
}
function knownOperationalAerodromes() {
    const unique = new Map();
    [...nationalAerodromes, ...(aeronauticalData.aerodromes || []), ...moduleAerodromes()].forEach(item => {
        const id = String(item.id || item.icao || '').toUpperCase();
        if (!id || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
        unique.set(id, { ...(unique.get(id) || {}), ...item, id });
    });
    return [...unique.values()];
}
function buildOperationalCatalog() {
    const families = new Map();
    tmaFocusRecords.forEach(record => {
        if (!families.has(record.family)) families.set(record.family, { family: record.family, records: [], bounds: L.latLngBounds([]), aerodromes: [] });
        const entry = families.get(record.family);
        entry.records.push(record);
        entry.bounds.extend(record.bounds);
    });
    const aerodromes = knownOperationalAerodromes();
    families.forEach(entry => {
        entry.module = moduleForOperationalFamily(entry.family);
        entry.architecture = architectureForFamily(entry.family);
        const moduleIds = new Set((entry.module?.aerodromes || []).map(item => String(item.id || '').toUpperCase()));
        entry.aerodromes = aerodromes.filter(item => moduleIds.has(item.id) || entry.records.some(record => record.bounds.contains([item.lat, item.lon]) && pointInFeature(item.lat, item.lon, record.feature)));
        entry.procedureEntries = [];
        entry.procedures = [];
        entry.procedureCount = entry.architecture?.procedureCount || 0;
        entry.status = entry.procedureCount ? 'structured' : 'context';
    });
    operationalCatalog = [...families.values()].sort((first, second) => first.family.localeCompare(second.family, 'pt-BR'));
}
function runwayFamily(value) {
    const match = String(value || '').toUpperCase().match(/^(\d{2})/);
    return match ? match[1] : String(value || '').toUpperCase();
}
function runwayOptionsForAirport(airport, entry) {
    const values = new Set();
    (entry?.procedureEntries || []).filter(procedure => procedure.airport === airport.id).forEach(procedure => (procedure.runways || [procedure.runway]).filter(Boolean).forEach(runway => values.add(runwayFamily(runway))));
    (airport.runways || []).forEach(pair => String(pair).split('/').forEach(runway => values.add(runwayFamily(runway))));
    return [...values].filter(Boolean).sort();
}
function operationalAirportsForEntry(entry) {
    const primary = entry?.module?.operational?.primaryAirports || [];
    if (!primary.length) {
        const aerodromes = entry?.aerodromes || [], principal = aerodromes.filter(item => /^SB[A-Z0-9]{2}$/.test(item.id));
        return (principal.length ? principal : aerodromes).slice(0, 6);
    }
    const byId = new Map([...(entry.module.aerodromes || []), ...(entry.aerodromes || [])].map(item => [String(item.id || item.icao).toUpperCase(), { ...item, id: String(item.id || item.icao).toUpperCase() }]));
    return primary.map(id => byId.get(String(id).toUpperCase())).filter(Boolean);
}
async function configureOperationalTma(family) {
    const entry = operationalCatalog.find(item => item.family === family);
    if (!entry) return;
    const changed = activeOperationalFamily !== entry.family;
    activeOperationalFamily = entry.family;
    activeOperationalModule = entry.module;
    if (entry.architecture && !entry.procedureEntriesLoaded) {
        document.getElementById('operational-layout-status').textContent = `Carregando índice IFR de ${entry.family}…`;
        try {
            entry.procedureEntries = await loadTmaProcedureEntries(entry.architecture);
            entry.procedureEntriesLoaded = true;
        } catch (error) {
            console.error(error);
            entry.procedureEntries = [];
            entry.procedureEntriesLoaded = false;
            document.getElementById('operational-layout-status').textContent = `Não foi possível carregar o índice IFR: ${error.message}`;
        }
        if (activeOperationalFamily !== entry.family) return;
    }
    const select = document.getElementById('operational-tma-select'), title = document.getElementById('operational-layout-title'), badge = document.getElementById('operational-coverage-badge'), summary = document.getElementById('operational-coverage-summary'), grid = document.getElementById('operational-runway-grid'), typeRow = document.getElementById('operational-type-row'), toggleLabel = document.getElementById('operational-layout-toggle-label'), presetsPanel = document.getElementById('operational-layout-presets-panel'), presets = document.getElementById('operational-layout-presets'), source = document.getElementById('operational-layout-source');
    if (select) select.value = entry.family;
    title.textContent = entry.family;
    badge.className = `operational-coverage-badge ${entry.status === 'structured' ? 'is-structured' : 'is-pending'}`;
    badge.textContent = entry.status === 'structured' ? 'IFR ESTRUTURADO' : 'CONTEXTO NACIONAL';
    summary.textContent = `${entry.records.length} setor(es) · ${entry.aerodromes.length} aeródromo(s) na base`;
    typeRow.querySelectorAll('input').forEach(input => { input.disabled = entry.status !== 'structured'; });
    typeRow.classList.toggle('is-disabled', entry.status !== 'structured');
    toggleLabel.textContent = entry.status === 'structured' ? 'Exibir malha IFR e contexto desta TMA' : 'Destacar setores e aeródromos desta TMA';
    Object.keys(operationalRunways).forEach(key => delete operationalRunways[key]);
    const airports = operationalAirportsForEntry(entry), defaults = entry.module?.operational?.defaultRunways || {};
    grid.replaceChildren(...airports.map(airport => {
        const options = runwayOptionsForAirport(airport, entry), label = document.createElement('label'), code = String(airport.id || airport.icao).toUpperCase();
        label.append(document.createTextNode(airport.name || airport.city || code));
        const small = document.createElement('small'); small.textContent = code; label.appendChild(small);
        if (options.length) {
            const runwaySelect = document.createElement('select'); runwaySelect.className = 'focus-select'; runwaySelect.dataset.airport = code;
            runwaySelect.replaceChildren(...options.map(value => new Option(value, value)));
            runwaySelect.value = options.includes(defaults[code]) ? defaults[code] : options[0];
            operationalRunways[code] = runwaySelect.value;
            runwaySelect.onchange = () => { operationalRunways[code] = runwaySelect.value; renderOperationalLayout(); };
            label.appendChild(runwaySelect);
        } else {
            const unavailable = document.createElement('span'); unavailable.className = 'runway-unavailable'; unavailable.textContent = 'pistas não cadastradas'; label.appendChild(unavailable);
        }
        return label;
    }));
    const presetCodes = entry.module?.operational?.presets || [];
    presetsPanel.hidden = !presetCodes.length;
    document.getElementById('operational-layout-presets-summary').textContent = entry.module?.operational?.presetsLabel || 'Configurações operacionais';
    presets.replaceChildren(...presetCodes.map(code => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = code; button.dataset.config = code;
        button.onclick = () => {
            const values = code.split('-'), selectors = [...grid.querySelectorAll('select[data-airport]')];
            selectors.forEach((runwaySelect, index) => { if (values[index] && [...runwaySelect.options].some(option => option.value === values[index])) { runwaySelect.value = values[index]; operationalRunways[runwaySelect.dataset.airport] = values[index]; } });
            document.getElementById('operational-layout-enabled').checked = true;
            renderOperationalLayout();
        };
        return button;
    }));
    source.textContent = entry.module?.operational?.sourceNote || (entry.procedureCount ? 'Procedimentos carregados sob demanda da arquitetura modular; todas as coordenadas são resolvidas pela base global de waypoints. Consulte cartas, AIP e NOTAM vigentes para uso real.' : 'Contexto baseado nos limites de TMA e aeródromos disponíveis no projeto. Nenhuma trajetória IFR é inferida sem tabela de codificação estruturada.');
    if (changed) {
        const enabled = document.getElementById('operational-layout-enabled');
        if (enabled.checked) renderOperationalLayout();
        else clearOperationalLayout(entry.status === 'structured' ? 'Selecione as pistas e ative a malha IFR.' : 'Ative o destaque para visualizar os setores e aeródromos desta terminal.');
    } else updateOperationalControls();
}
function setupTmaFocusPanel() {
    const panel = document.getElementById('tma-focus-panel'), toggle = document.getElementById('tma-focus-toggle');
    if (!panel || !toggle) return;
    tmaFocusRecords = tmaBoundaries.map(feature => {
        const rawFamily = tmaFamilyName(feature.properties?.family || feature.properties?.name), module = moduleForOperationalFamily(rawFamily);
        return { feature, bounds: L.geoJSON(feature).getBounds(), family: module?.operational?.family || rawFamily };
    }).filter(record => record.bounds.isValid());
    buildOperationalCatalog();
    const selector = document.getElementById('operational-tma-select');
    selector.replaceChildren(new Option('Escolha uma terminal…', ''), ...operationalCatalog.map(entry => new Option(`${entry.family}${entry.status === 'structured' ? ' · IFR' : ''}`, entry.family)));
    document.getElementById('operational-coverage-summary').textContent = `${operationalCatalog.length} TMA disponíveis na base`;
    L.DomEvent.disableClickPropagation(panel);
    L.DomEvent.disableScrollPropagation(panel);
    const setCollapsed = collapsed => {
        panel.classList.toggle('is-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.title = collapsed ? 'Abrir informações da TMA' : 'Recolher informações da TMA';
    };
    toggle.onclick = () => setCollapsed(!panel.classList.contains('is-collapsed'));
    if (compactViewport.matches) setCollapsed(true);
    compactViewport.addEventListener('change', event => { if (event.matches) setCollapsed(true); });
    setupOperationalLayoutControls();
    map.on('dragstart', () => { manualOperationalFamily = ''; });
    map.on('moveend zoomend', updateDominantTma);
    updateDominantTma();
}
function updateDominantTma() {
    const name = document.getElementById('tma-focus-name'), subtitle = document.getElementById('tma-focus-subtitle'), limits = document.getElementById('tma-focus-limits'), airspaceClass = document.getElementById('tma-focus-class'), presence = document.getElementById('tma-focus-presence'), details = document.getElementById('tma-focus-details');
    if (!name || !tmaFocusRecords.length) return;
    if (map.getZoom() < 5) {
        dominantTmaRecord = null;
        name.textContent = 'Mapa operacional do Brasil';
        subtitle.textContent = 'Escolha uma terminal no seletor ou aproxime o mapa.';
        limits.textContent = airspaceClass.textContent = presence.textContent = '—';
        details.innerHTML = `<p>A base atual reúne ${operationalCatalog.length} famílias de TMA. A identificação automática começa no zoom 5.</p>`;
        return;
    }
    const view = map.getBounds(), viewArea = boundsArea(view);
    const ranked = tmaFocusRecords.filter(record => overlapArea(record.bounds, view) > 0).map(record => ({ ...record, score: featureVisibleArea(record.feature, view) })).filter(record => record.score > 0).sort((first, second) => second.score - first.score);
    const familyScores = new Map();
    ranked.forEach(record => familyScores.set(record.family, (familyScores.get(record.family) || 0) + record.score));
    const automaticFamily = [...familyScores.entries()].sort((first, second) => second[1] - first[1])[0]?.[0], dominantFamily = manualOperationalFamily && ranked.some(item => item.family === manualOperationalFamily) ? manualOperationalFamily : automaticFamily, record = ranked.find(item => item.family === dominantFamily);
    if (!record) {
        dominantTmaRecord = null;
        name.textContent = 'Nenhuma TMA na janela';
        subtitle.textContent = 'Use o seletor nacional para localizar outra terminal.';
        limits.textContent = airspaceClass.textContent = presence.textContent = '—';
        details.innerHTML = '<p>A camada mostra somente os limites presentes na base nacional do projeto.</p>';
        return;
    }
    const properties = record.feature.properties || {}, entry = operationalCatalog.find(item => item.family === record.family), familyRecords = entry?.records || [], visibleFamilyRecords = familyRecords.filter(item => overlapArea(item.bounds, view) > 0 && featureVisibleArea(item.feature, view) > 0), familyScore = familyScores.get(record.family) || record.score, percentage = Math.min(100, familyScore / viewArea * 100), vertices = geometryVertexCount(record.feature.geometry), circular = Number.isFinite(properties.radius_nm), module = entry?.module;
    dominantTmaRecord = record;
    name.textContent = properties.name || record.family;
    subtitle.textContent = `${record.family} · setor com maior presença na tela`;
    limits.textContent = `${properties.lower_limit || 'N/I'} / ${properties.upper_limit || 'N/I'}`;
    airspaceClass.textContent = properties.airspace_class || 'N/I';
    presence.textContent = `${percentage < 1 ? '<1' : Math.round(percentage)}%`;
    const geometryText = circular ? `Setor circular com raio publicado de ${properties.radius_nm} NM.` : `Setor poligonal com ${Math.max(0, vertices - 1)} lados/pontos de contorno.`, primary = properties.frequencies?.primary?.join(', '), secondary = properties.frequencies?.secondary?.join(', '), frequencyInfo = primary ? `<p><strong>Frequência:</strong> PRI ${esc(primary)}${secondary ? ` · SRY ${esc(secondary)}` : ''} · EMERG ${esc(properties.frequencies.emergency || '121.500 MHz')}.</p>` : '', airportCodes = (entry?.aerodromes || []).map(item => item.id).join(', '), coverageInfo = entry?.procedureCount ? `<p><strong>Mapa IFR:</strong> ${entry.procedureCount} carta(s) disponíveis sob demanda, com trajetórias e restrições associadas aos FIX.</p>` : '<p><strong>Mapa IFR:</strong> cartas ainda não estruturadas para esta terminal; o sistema exibe apenas o contexto nacional confirmado.</p>';
    details.innerHTML = `<p><strong>Tipo:</strong> ${esc(properties.type || 'TMA')} · ${esc(geometryText)}</p><p><strong>Cobertura local:</strong> ${visibleFamilyRecords.length} de ${familyRecords.length} setor(es) aparecem na janela.</p>${frequencyInfo}${airportCodes ? `<p><strong>Aeródromos na base:</strong> ${esc(airportCodes)}.</p>` : '<p><strong>Aeródromos na base:</strong> nenhum ponto associado a este polígono.</p>'}${coverageInfo}<p><strong>Segurança:</strong> consulte a publicação aeronáutica vigente antes de qualquer uso real.</p>`;
    configureOperationalTma(record.family);
}

function selectedOperationalTypes() {
    return new Set([...document.querySelectorAll('.layout-type-filter:checked')].map(input => input.value));
}
function currentOperationalCode() {
    const values = Object.values(operationalRunways);
    return values.length ? values.join('–') : 'CTX';
}
function operationalCategory(procedure) {
    if (procedure.type !== 'IAC') return procedure.type;
    const descriptor = `${procedure.name || ''} ${(procedure.modes || []).join(' ')}`;
    if (/RNP/i.test(descriptor)) return 'RNP';
    if (/ILS|LOC/i.test(descriptor)) return 'ILS';
    return 'OTHER_IAC';
}
function procedureMatchesOperationalConfig(procedure, enabledTypes) {
    if (!enabledTypes.has(operationalCategory(procedure))) return false;
    const runway = operationalRunways[procedure.airport];
    return Boolean(runway && (procedure.runways || []).some(value => String(value).startsWith(runway)));
}
function setupOperationalLayoutControls() {
    const selector = document.getElementById('operational-tma-select'), enabled = document.getElementById('operational-layout-enabled'), fit = document.getElementById('operational-layout-fit'), clear = document.getElementById('operational-layout-clear');
    selector.onchange = () => {
        const entry = operationalCatalog.find(item => item.family === selector.value);
        if (!entry) return;
        manualOperationalFamily = entry.family;
        configureOperationalTma(entry.family);
        map.fitBounds(entry.bounds, { padding: [45, 45], maxZoom: 8 });
    };
    document.querySelectorAll('.layout-type-filter').forEach(input => input.onchange = renderOperationalLayout);
    enabled.onchange = () => {
        if (enabled.checked) { if (!map.hasLayer(operationalLayoutGroup)) operationalLayoutGroup.addTo(map); renderOperationalLayout(); }
        else clearOperationalLayout('Contexto operacional ocultado.');
    };
    fit.onclick = () => {
        const bounds = operationalLayoutGroup.getBounds(), entry = operationalCatalog.find(item => item.family === activeOperationalFamily);
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 9 });
        else if (entry?.bounds.isValid()) map.fitBounds(entry.bounds, { padding: [45, 45], maxZoom: 8 });
    };
    clear.onclick = () => { enabled.checked = false; clearOperationalLayout('Mapa operacional removido da tela.'); };
    map.on('zoomend', () => { const permanent = map.getZoom() >= 9; if (enabled.checked && permanent !== layoutLabelsPermanent) renderOperationalLayout(); });
    map.on('overlayremove', event => { if (event.layer === operationalLayoutGroup) { enabled.checked = false; clearOperationalLayout('Mapa operacional ocultado pelo controle de camadas.', false); } });
    map.on('overlayadd', event => { if (event.layer === operationalLayoutGroup && operationalLayoutGroup.getLayers().length) enabled.checked = true; });
    clearOperationalLayout('Selecione uma terminal brasileira para abrir seu contexto.');
}
function updateOperationalControls() {
    const code = currentOperationalCode(), codeTarget = document.getElementById('operational-layout-code');
    if (codeTarget) codeTarget.textContent = code;
    document.querySelectorAll('#operational-layout-presets button').forEach(button => button.classList.toggle('is-active', button.dataset.config === code.replaceAll('–', '-')));
}
function clearOperationalLayout(message, removeLayer = true) {
    operationalRenderToken += 1;
    operationalLayoutGroup.clearLayers();
    if (removeLayer && map.hasLayer(operationalLayoutGroup)) map.removeLayer(operationalLayoutGroup);
    document.getElementById('operational-layout-fit').disabled = !activeOperationalFamily;
    document.getElementById('operational-layout-status').textContent = message;
    updateOperationalControls();
}
function renderOperationalContext(entry) {
    entry.records.forEach(record => L.geoJSON(record.feature, { style: { color: '#00e5ff', weight: 3.4, opacity: .9, fillColor: '#00e5ff', fillOpacity: .035, dashArray: '10 5' } }).bindTooltip(record.feature.properties?.name || entry.family, { sticky: true, className: 'tma-sector-tooltip' }).addTo(operationalLayoutGroup));
    entry.aerodromes.forEach(airport => {
        L.circleMarker([airport.lat, airport.lon], { radius: 7, color: '#ffd166', weight: 2.2, fillColor: '#111820', fillOpacity: .95 })
            .bindTooltip(`<strong>${esc(airport.id)}</strong><br>${esc(airport.name || airport.city || 'Aeródromo')}${airport.runways?.length ? `<br>Pistas ${esc(airport.runways.join(', '))}` : ''}`, { permanent: map.getZoom() >= 9 && entry.aerodromes.length <= 30, direction: 'top', className: 'layout-fix-label' })
            .on('click', () => showDetails(airport, 'aerodrome'))
            .addTo(operationalLayoutGroup);
    });
}
async function renderOperationalLayout() {
    updateOperationalControls();
    const enabled = document.getElementById('operational-layout-enabled'), entry = operationalCatalog.find(item => item.family === activeOperationalFamily);
    if (!entry) return clearOperationalLayout('Selecione uma terminal brasileira para abrir seu contexto.');
    if (!enabled?.checked) return clearOperationalLayout(entry.status === 'structured' ? 'Selecione as pistas e ative a malha IFR.' : 'Ative o destaque para visualizar os setores e aeródromos desta terminal.');
    if (!map.hasLayer(operationalLayoutGroup)) operationalLayoutGroup.addTo(map);
    operationalLayoutGroup.clearLayers();
    layoutLabelsPermanent = map.getZoom() >= 9;
    renderOperationalContext(entry);
    if (!entry.procedureCount) {
        document.getElementById('operational-layout-fit').disabled = !entry.bounds.isValid();
        document.getElementById('operational-layout-status').textContent = `${entry.family} · ${entry.records.length} setor(es) · ${entry.aerodromes.length} aeródromo(s). Cartas IFR ainda não estruturadas; nenhuma rota foi inferida.`;
        return;
    }
    if (!entry.procedureEntriesLoaded && entry.architecture) {
        document.getElementById('operational-layout-status').textContent = `Carregando índice IFR de ${entry.family}…`;
        try {
            entry.procedureEntries = await loadTmaProcedureEntries(entry.architecture);
            entry.procedureEntriesLoaded = true;
        } catch (error) {
            console.error(error);
            return void (document.getElementById('operational-layout-status').textContent = `Falha ao carregar o índice IFR: ${error.message}`);
        }
    }
    const types = selectedOperationalTypes(), selectedEntries = entry.procedureEntries.filter(procedure => procedureMatchesOperationalConfig(procedure, types)), token = ++operationalRenderToken;
    document.getElementById('operational-layout-status').textContent = `Carregando ${selectedEntries.length} carta(s) de ${entry.family} sob demanda…`;
    let matchedProcedures;
    try {
        matchedProcedures = (await Promise.all(selectedEntries.map(item => loadProcedureData(item, entry.architecture?.id)))).filter(Boolean);
    } catch (error) {
        console.error(error);
        return void (document.getElementById('operational-layout-status').textContent = `Falha ao carregar cartas IFR: ${error.message}`);
    }
    if (token !== operationalRenderToken || !enabled.checked || activeOperationalFamily !== entry.family) return;
    operationalLayoutGroup.clearLayers();
    renderOperationalContext(entry);
    const segmentKeys = new Set(), pointData = new Map();
    const pointRecord = (point, ident, category) => {
        if (!pointData.has(point.id)) pointData.set(point.id, { point, ident, categories: new Set(), restrictions: new Map() });
        const record = pointData.get(point.id); record.categories.add(category); return record;
    };
    let routeCount = 0, segmentCount = 0;
    matchedProcedures.forEach(procedure => (procedure.transitions || []).forEach(transition => {
        const category = operationalCategory(procedure);
        routeCount += 1;
        (transition.sequence || []).forEach(key => {
            const point = waypointForProcedure(key, procedure.points?.[key]);
            if (point) pointRecord(point, procedurePointLabel(procedure, key), category);
        });
        (transition.segments || []).forEach(segment => {
            if (segment.destination) {
                const point = waypointForProcedure(segment.destination, procedure.points?.[segment.destination]);
                if (point) {
                    const restriction = segmentRestriction(segment), record = pointRecord(point, procedurePointLabel(procedure, segment.destination), category);
                    if (restriction !== 'Sem restrição adicional publicada') record.restrictions.set(`${procedure.id}|${restriction}`, { text: restriction, procedure, transition });
                }
            }
            const origin = waypointForProcedure(segment.origin, procedure.points?.[segment.origin]), destination = waypointForProcedure(segment.destination, procedure.points?.[segment.destination]);
            const geometry = segmentLatLngs(segment, origin, destination, procedure);
            if (geometry.length < 2) return;
            const key = [procedure.type, origin?.id, destination?.id, segment.pathTerminator, segment.arcCenterFix, segment.turn, ...(segment.via || [])].join('|');
            if (segmentKeys.has(key)) return;
            segmentKeys.add(key);
            segmentCount += 1;
            L.polyline(geometry, { color: operationalColors[category], weight: ['ILS', 'RNP'].includes(category) ? 2.6 : 2.1, opacity: .82, dashArray: category === 'SID' ? '8 5' : category === 'RNP' ? '10 3 2 3' : category === 'ILS' ? '3 4' : null, interactive: true })
                .bindTooltip(`${category} · ${procedure.airport} · ${procedure.name}<br>${procedurePointLabel(procedure, segment.origin)} → ${procedurePointLabel(procedure, segment.destination)}<br>${esc(segmentRestriction(segment))}`)
                .on('click', () => showSegmentDetails(segment, procedure, transition))
                .addTo(operationalLayoutGroup);
        });
    }));
    let restrictedFixes = 0;
    pointData.forEach(record => {
        const point = record.point, ident = record.ident;
        const category = [...record.categories][0], restrictions = [...new Set([...record.restrictions.values()].map(item => item.text))];
        if (restrictions.length) restrictedFixes += 1;
        const restrictionLabel = restrictions.length ? `<span class="layout-fix-restriction">${esc(restrictions.slice(0, 2).join(' / '))}${restrictions.length > 2 ? ` +${restrictions.length - 2}` : ''}</span>` : '';
        L.circleMarker([point.properties.latitude, point.properties.longitude], { radius: restrictions.length ? 3.2 : 2.3, color: operationalColors[category], weight: restrictions.length ? 1.8 : 1, fillColor: restrictions.length ? '#ffd166' : '#111', fillOpacity: .9 })
            .bindTooltip(`<strong>${esc(ident)}</strong>${restrictionLabel}`, { permanent: layoutLabelsPermanent, direction: 'top', className: 'layout-fix-label', offset: [0, -2] })
            .on('click', () => showOperationalFixDetails(point, ident, record))
            .addTo(operationalLayoutGroup);
    });
    const bounds = operationalLayoutGroup.getBounds(), status = document.getElementById('operational-layout-status');
    document.getElementById('operational-layout-fit').disabled = !bounds.isValid();
    status.textContent = `${entry.family} · ${currentOperationalCode()} · ${matchedProcedures.length} cartas · ${routeCount} trajetórias · ${segmentCount} trechos únicos · ${pointData.size} FIX · ${restrictedFixes} com restrição.`;
}
function setupProcedureControls() {
    const tma = document.getElementById('procedure-tma'), airport = document.getElementById('procedure-airport'), type = document.getElementById('procedure-type'), procedure = document.getElementById('procedure-select'), transition = document.getElementById('procedure-transition'), missedOption = document.getElementById('include-missed-approach'), addButton = document.getElementById('add-procedure');
    let airportEntries = [], procedureEntries = [], selectedProcedure = null, refreshToken = 0;
    const tmaEntries = (procedureCatalog.tmas || []).filter(item => item.selectable !== false && item.airportCount > 0);
    tma.replaceChildren(...tmaEntries.map(item => new Option(`${item.name}${item.technicalGroup ? ' · grupo técnico' : ''} (${item.procedureCount} cartas)`, item.id)));
    const showSelectMessage = (select, message) => { select.replaceChildren(new Option(message, '')); select.disabled = true; };
    const refreshTransition = async () => {
        const token = ++refreshToken, entry = procedureEntries.find(item => item.file === procedure.value);
        selectedProcedure = null;
        showSelectMessage(transition, entry ? 'Carregando trajetórias…' : 'Sem procedimento selecionado');
        addButton.disabled = true;
        if (!entry) return;
        try {
            const loaded = await loadProcedureData(entry, tma.value);
            if (token !== refreshToken) return;
            selectedProcedure = loaded;
            const options = loaded.transitions || [];
            transition.replaceChildren(...(options.length ? options.map(item => new Option(item.name, item.id)) : [new Option('Sem trajetória codificada', '')]));
            transition.disabled = !options.length;
            missedOption.closest('label').hidden = loaded.type !== 'IAC';
            addButton.disabled = false;
            addButton.textContent = options.length ? 'Adicionar procedimento' : 'Consultar procedimento';
            showProcedureSummary(loaded);
        } catch (error) {
            console.error(error);
            showSelectMessage(transition, 'Falha ao carregar procedimento');
        }
    };
    const refreshProcedures = async () => {
        const airportEntry = airportEntries.find(item => item.icao === airport.value);
        selectedProcedure = null;
        showSelectMessage(procedure, airportEntry ? 'Carregando catálogo…' : 'Nenhum aeródromo disponível');
        showSelectMessage(transition, 'Aguardando procedimento');
        if (!airportEntry) return;
        try {
            const index = await loadProcedureIndex(airportEntry);
            procedureEntries = (index.types?.[type.value] || []).map(item => ({ ...item, airport: airportEntry.icao, type: type.value }));
            procedure.replaceChildren(...(procedureEntries.length ? procedureEntries.map(item => new Option(item.name, item.file)) : [new Option(`Nenhum ${type.value} publicado`, '')]));
            procedure.disabled = !procedureEntries.length;
            await refreshTransition();
        } catch (error) {
            console.error(error);
            showSelectMessage(procedure, 'Falha ao carregar catálogo');
        }
    };
    const refreshAirports = async () => {
        const entry = tmaEntries.find(item => item.id === tma.value);
        airportEntries = [];
        showSelectMessage(airport, entry ? 'Carregando aeródromos…' : 'Nenhuma TMA disponível');
        showSelectMessage(procedure, 'Aguardando aeródromo');
        showSelectMessage(transition, 'Aguardando procedimento');
        if (!entry) return;
        try {
            const index = await loadAirportIndex(entry);
            airportEntries = index.airports || [];
            airport.replaceChildren(...airportEntries.map(item => {
                const count = Object.values(item.procedureCounts || {}).reduce((total, value) => total + Number(value || 0), 0);
                return new Option(`${item.icao} — ${item.name}${count ? ` (${count})` : ' · sem carta estruturada'}`, item.icao);
            }));
            airport.disabled = !airportEntries.length;
            const firstWithProcedures = airportEntries.find(item => Number(item.procedureCounts?.[type.value] || 0) > 0) || airportEntries.find(item => Object.values(item.procedureCounts || {}).some(Boolean));
            if (firstWithProcedures) airport.value = firstWithProcedures.icao;
            await refreshProcedures();
        } catch (error) {
            console.error(error);
            showSelectMessage(airport, 'Falha ao carregar aeródromos');
        }
    };
    tma.onchange = () => void refreshAirports();
    airport.onchange = () => void refreshProcedures();
    type.onchange = () => void refreshProcedures();
    procedure.onchange = () => void refreshTransition();
    addButton.onclick = () => {
        const selectedTransition = selectedProcedure?.transitions.find(item => item.id === transition.value);
        if (!selectedProcedure) return;
        if (!selectedTransition) return showProcedureSummary(selectedProcedure);
        addProcedure(selectedProcedure, selectedTransition, missedOption.checked);
    };
    void refreshAirports();
}

function waypointForProcedure(ident, pointDefinition = null) {
    if (!ident) return null;
    if (pointDefinition?.coordinate_ref) {
        const referenced = procedurePointById.get(pointDefinition.coordinate_ref);
        if (referenced) return referenced;
    }
    const normalizedIdent = String(ident).toUpperCase(), candidates = procedurePointCandidates.get(normalizedIdent) || [];
    if (!candidates.length) return null;
    const bestPriority = Math.min(...candidates.map(candidate => candidate.priority));
    const preferred = candidates.filter(candidate => candidate.priority === bestPriority);
    return preferred.length === 1 ? preferred[0].feature : null;
}
function procedurePointLabel(procedure, key) { return procedure?.points?.[key]?.ident || key || 'Ponto não publicado'; }
function altitudeText(value) {
    if (!value || !Number.isFinite(value.valueFt)) return null;
    const altitude = `${Math.abs(value.valueFt)} FT`;
    return ({ 'at-or-above': `≥ ${altitude}`, 'at-or-below': `≤ ${altitude}`, at: `@ ${altitude}`, recommended: `REC ${altitude}`, expected: `ESP ${altitude}`, 'as-assigned': 'Conforme autorizado' })[value.meaning] || altitude;
}
function speedText(segment) {
    if (!Number.isFinite(segment.speedLimitKt)) return null;
    const interpretation = String(segment.speedLimitDescription || 'BELOW_UPPER').toUpperCase();
    if (interpretation === 'AS_ASSIGNED') return `Conforme autorizado (${segment.speedLimitKt} KT publicado)`;
    const symbol = ({ BELOW_UPPER: '≤', ABOVE_LOWER: '≥', AT_LOWER: '@', '-': '≤', '+': '≥', '@': '@' })[interpretation] || 'PUB';
    return `${symbol} ${segment.speedLimitKt} KT`;
}
function segmentRestriction(segment) {
    const lower = segment.lowerLimitAltitude, upper = segment.upperLimitAltitude;
    const publishedAltitude = segment.altitude && typeof segment.altitude === 'object' ? [
        Number.isFinite(segment.altitude.at) ? `AT ${segment.altitude.at} FT` : null,
        Number.isFinite(segment.altitude.min) ? `MIN ${segment.altitude.min} FT` : null,
        Number.isFinite(segment.altitude.max) ? `MAX ${segment.altitude.max} FT` : null,
    ].filter(Boolean).join(' · ') : '';
    const altitude = lower?.meaning === 'between-bound' && upper?.meaning === 'between-bound' && Number.isFinite(lower.valueFt) && Number.isFinite(upper.valueFt) ? `${Math.min(Math.abs(lower.valueFt), Math.abs(upper.valueFt))}–${Math.max(Math.abs(lower.valueFt), Math.abs(upper.valueFt))} FT` : [altitudeText(lower), altitudeText(upper)].filter(Boolean).join(' · ') || publishedAltitude;
    return [altitude, speedText(segment)].filter(Boolean).join(' · ') || 'Sem restrição adicional publicada';
}
function courseText(course) { const values = course ? [Number.isFinite(course.magnetic) ? `${course.magnetic}° MAG` : null, Number.isFinite(course.true) ? `${course.true}° TRUE` : null].filter(Boolean) : []; return values.join(' / ') || 'N/A'; }
function segmentLatLngs(segment, origin, destination, procedure = null) {
    const via = (segment.via || []).map(key => waypointForProcedure(key, procedure?.points?.[key])).filter(Boolean).map(point => [point.properties.latitude, point.properties.longitude]);
    const start = origin ? [origin.properties.latitude, origin.properties.longitude] : null, end = destination ? [destination.properties.latitude, destination.properties.longitude] : null;
    if (via.length) return [start, ...via, end].filter(Boolean);
    if (!start || !end) return [];
    if (segment.pathTerminator !== 'RF' || !segment.arcCenterFix) return [start, end];
    const centerPoint = waypointForProcedure(segment.arcCenterFix, procedure?.points?.[segment.arcCenterFix]);
    if (!centerPoint) return [start, end];
    const center = [centerPoint.properties.latitude, centerPoint.properties.longitude], lonScale = Math.cos(center[0] * Math.PI / 180);
    const angle = point => Math.atan2((point[1] - center[1]) * lonScale, point[0] - center[0]);
    const startAngle = angle(start), endAngle = angle(end), full = Math.PI * 2;
    let sweep = segment.turn === 'L' ? -((startAngle - endAngle + full) % full) : ((endAngle - startAngle + full) % full);
    if (Math.abs(sweep) < 1e-6) return [start, end];
    const startRadius = Math.hypot(start[0] - center[0], (start[1] - center[1]) * lonScale), endRadius = Math.hypot(end[0] - center[0], (end[1] - center[1]) * lonScale), radius = (startRadius + endRadius) / 2;
    const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 36))), points = [start];
    for (let index = 1; index < steps; index++) { const value = startAngle + sweep * index / steps; points.push([center[0] + Math.cos(value) * radius, center[1] + Math.sin(value) * radius / lonScale]); }
    points.push(end);
    return points;
}
function showProcedureSummary(procedure) {
    const source = procedure.source || {}, status = procedure.status === 'structured' || procedure.status === 'structured-aixm' ? 'Estruturado por dados publicados' : procedure.status === 'legacy-preserved' ? 'Registro legado preservado' : procedure.status === 'simplified-normalized' ? 'Normalizado de JSON simplificado' : 'Estruturado com ressalvas', warningBlock = procedure.warnings?.length ? `<div class="source-tag warning-tag"><strong>Avisos:</strong><ul class="restriction-list">${procedure.warnings.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : '';
    document.getElementById('details-content').innerHTML = `<div class="panel-header fix-header"><h3>${esc(procedure.name)}</h3><p class="subtitle">${esc(procedure.type)} — ${esc(procedure.airport)}</p></div><div class="panel-body"><div class="info-row"><span class="info-label">Pistas:</span><span class="info-val">${esc(procedure.runways.join(', ') || 'Não informadas')}</span></div><div class="info-row"><span class="info-label">Modalidade:</span><span class="info-val">${esc(procedure.modes.join(', ') || 'Não informada')}</span></div><div class="info-row"><span class="info-label">Situação:</span><span class="info-val">${esc(status)}</span></div><div class="info-row"><span class="info-label">Transições:</span><span class="info-val">${procedure.transitions.length}</span></div><div class="info-row"><span class="info-label">Aproximações perdidas:</span><span class="info-val">${procedure.missedApproach.length}</span></div><div class="source-tag"><strong>Fonte:</strong> ${esc(source.authority || 'não informada')} · ${esc(source.chartCode || 'carta/AIXM')} · ${esc(source.amendment || 'emenda não informada')} · ${esc(source.effectiveDate || 'data não informada')}<br><strong>Coordenadas:</strong> resolvidas exclusivamente por data/waypoints.json.</div>${warningBlock}</div>`;
}
function addProcedure(procedure, transition, includeMissedApproach = true) {
    const key = `${procedure.id}:${transition.id}`;
    if (activeProcedures.has(key)) return focusProcedure(key);
    const color = ['#00e5ff', '#ff9800', '#e91e63', '#8bc34a', '#ab47bc'][activeProcedures.size % 5];
    const group = L.featureGroup();
    const unresolved = new Set();
    transition.segments.forEach(segment => {
        const origin = segment.origin ? waypointForProcedure(segment.origin, procedure.points?.[segment.origin]) : null, destination = segment.destination ? waypointForProcedure(segment.destination, procedure.points?.[segment.destination]) : null;
        if (segment.origin && !origin) unresolved.add(procedurePointLabel(procedure, segment.origin));
        if (segment.destination && !destination) unresolved.add(procedurePointLabel(procedure, segment.destination));
        const geometry = segmentLatLngs(segment, origin, destination, procedure);
        if (geometry.length < 2) return;
        L.polyline(geometry, { color, weight: 4, opacity: .9 }).bindTooltip(`${segment.pathTerminator || 'LEG'} · ${courseText(segment.course)} · ${segment.distanceNm ?? 'N/A'} NM`).on('click', () => showSegmentDetails(segment, procedure, transition)).addTo(group);
    });
    transition.sequence.forEach(key => {
        const point = waypointForProcedure(key, procedure.points?.[key]), ident = procedurePointLabel(procedure, key);
        if (!point) return unresolved.add(ident);
        const destinationSegments = transition.segments.filter(segment => segment.destination === key), restriction = destinationSegments.map(segmentRestriction).find(value => value !== 'Sem restrição adicional publicada') || procedure.points?.[key]?.published_label || 'Sem restrição adicional publicada';
        L.marker([point.properties.latitude, point.properties.longitude], { icon: icon(ident, true), zIndexOffset: 1200 }).bindTooltip(`${ident} — ${restriction}`, { permanent: true, direction: 'top', offset: [0, -10] }).on('click', () => showProcedurePoint(point, procedure, transition, restriction)).addTo(group);
    });
    if (includeMissedApproach && procedure.type === 'IAC') procedure.missedApproach.forEach(route => addMissedRoute(group, route, procedure));
    group.addTo(proceduresGroup); activeProcedures.set(key, { group, procedure, transition, unresolved: [...unresolved], includeMissedApproach }); renderActiveProcedures(); showProcedureSummary(procedure); if (unresolved.size) document.getElementById('details-content').insertAdjacentHTML('beforeend', `<div class="source-tag warning-tag"><strong>Sem coordenada na base:</strong> ${esc([...unresolved].join(', '))}. Nenhum segmento foi conectado por proximidade.</div>`); focusProcedure(key);
}
function addMissedRoute(group, route, procedure) {
    route.segments.forEach(segment => {
        const origin = segment.origin ? waypointForProcedure(segment.origin, procedure.points?.[segment.origin]) : null, destination = segment.destination ? waypointForProcedure(segment.destination, procedure.points?.[segment.destination]) : null, geometry = segmentLatLngs(segment, origin, destination, procedure);
        if (geometry.length < 2) return;
        L.polyline(geometry, { color: '#ff5252', weight: 3, opacity: .95, dashArray: '8, 7' }).bindTooltip(`Aproximação perdida · ${segment.pathTerminator || 'LEG'} · ${courseText(segment.course)}`).on('click', () => showSegmentDetails(segment, procedure, route)).addTo(group);
    });
    route.sequence.forEach(key => { const point = waypointForProcedure(key, procedure.points?.[key]); if (point) L.circleMarker([point.properties.latitude, point.properties.longitude], { radius: 5, color: '#ff5252', fillColor: '#ff5252', fillOpacity: .9 }).bindTooltip(`APCH perdida · ${procedurePointLabel(procedure, key)}`).addTo(group); });
}
function showProcedurePoint(feature, procedure, transition, restriction) {
    showDetails(feature, 'waypoint');
    const panel = document.getElementById('details-content');
    panel.insertAdjacentHTML('afterbegin', `<div class="source-tag"><strong>Procedimento:</strong> ${esc(procedure.name)} — ${esc(transition.name)}<br><strong>Restrição publicada:</strong> ${esc(restriction)}<br><strong>Carta:</strong> ${esc(procedure.source.chartCode || 'OMNI')} · ${esc(procedure.source.amendment)}</div>`);
}
function showOperationalFixDetails(feature, ident, record) {
    showDetails(feature, 'waypoint');
    const entries = [...record.restrictions.values()], panel = document.getElementById('details-content');
    const restrictionList = entries.length ? `<ul class="restriction-list">${entries.map(item => `<li><strong>${esc(item.text)}</strong><br>${esc(operationalCategory(item.procedure))} · ${esc(item.procedure.airport)} · ${esc(item.procedure.name)} · ${esc(item.transition.name)}</li>`).join('')}</ul>` : '<p>Sem restrição adicional publicada nas cartas ativas deste layout.</p>';
    panel.insertAdjacentHTML('afterbegin', `<div class="source-tag"><strong>FIX operacional ${esc(ident)}</strong><br>Restrições reunidas somente das cartas e pistas atualmente selecionadas.${restrictionList}</div>`);
}
function showSegmentDetails(segment, procedure, transition) { const arc = segment.arcCenterFix ? `<div class="info-row"><span class="info-label">Centro/arco RF:</span><span class="info-val">${esc(procedurePointLabel(procedure, segment.arcCenterFix))} · ${esc(segment.arcRadiusNm ?? 'N/A')} NM</span></div>` : ''; document.getElementById('details-content').innerHTML = `<div class="panel-header fix-header"><h3>${esc(procedurePointLabel(procedure, segment.origin))} → ${esc(procedurePointLabel(procedure, segment.destination))}</h3><p class="subtitle">${esc(procedure.name)} — ${esc(transition.name)}</p></div><div class="panel-body"><div class="info-row"><span class="info-label">Perna:</span><span class="info-val">${esc(segment.pathTerminator || 'N/A')}</span></div><div class="info-row"><span class="info-label">Curso:</span><span class="info-val">${esc(courseText(segment.course))}</span></div><div class="info-row"><span class="info-label">Distância:</span><span class="info-val">${esc(segment.distanceNm ?? 'N/A')} NM</span></div>${arc}<div class="info-row"><span class="info-label">Restrição:</span><span class="info-val">${esc(segmentRestriction(segment))}</span></div><div class="info-row"><span class="info-label">Papel do FIX:</span><span class="info-val">${esc(segment.fixRole || 'N/A')}</span></div><div class="info-row"><span class="info-label">Navegação:</span><span class="info-val">${esc(segment.navigationSpecification || 'N/A')}</span></div><div class="source-tag"><strong>Fonte:</strong> ${esc(procedure.source.chartCode || 'AIXM/carta')} · página ${esc(segment.sourcePage || 'não informada')}</div></div>`; }
function focusProcedure(key) { const item = activeProcedures.get(key); if (item && item.group.getBounds().isValid()) map.fitBounds(item.group.getBounds(), { padding: [45, 45], maxZoom: 10 }); }
function removeProcedure(key) { const item = activeProcedures.get(key); if (item) proceduresGroup.removeLayer(item.group); activeProcedures.delete(key); renderActiveProcedures(); }
function renderActiveProcedures() { const target = document.getElementById('active-procedures'); target.replaceChildren(); if (!activeProcedures.size) { target.innerHTML = '<span class="empty-selection">Nenhum procedimento ativo.</span>'; return; } activeProcedures.forEach((item, key) => { const row = document.createElement('div'); row.className = 'selected-point-row'; row.innerHTML = `<span><strong>${esc(item.procedure.type)} — ${esc(item.procedure.name)}</strong><br><span class="mono-small">${esc(item.transition.name)} · ${esc(item.procedure.source.chartCode || 'OMNI')} · ${esc(item.procedure.source.effectiveDate)}${item.includeMissedApproach && item.procedure.type === 'IAC' ? ' · APCH perdida' : ''}</span></span><button type="button">Remover</button>`; row.querySelector('span').onclick = () => focusProcedure(key); row.querySelector('button').onclick = () => removeProcedure(key); target.appendChild(row); }); }
L.control.layers({ 'Cartografia Escura': darkMatter, 'Mapa Padrão (OSM)': openStreetMap }, { 'Todos os aeródromos (Brasil)': aerodromesGroup, 'Todos os fixos (Brasil)': allFixesGroup, 'Áreas de ensaio em voo': testAreasGroup, 'Vetores de medição': measurementVectorsGroup, 'Auxílios Rádio': navaidsGroup, 'Waypoints selecionados': waypointSelectionsGroup, 'Procedimentos IFR': proceduresGroup, 'Mapa operacional Brasil': operationalLayoutGroup, 'Áreas TMA — AIXM Brasil': tmaGroup, 'Simulações de Rota': routesGroup }, { collapsed: compactViewport.matches, position: 'topright' }).addTo(map);

let mapResizeTimer = null;
function scheduleMapResize() {
    clearTimeout(mapResizeTimer);
    mapResizeTimer = setTimeout(() => map.invalidateSize({ pan: false }), 120);
}
window.addEventListener('resize', scheduleMapResize);
window.visualViewport?.addEventListener('resize', scheduleMapResize);

/* Área de estudos — os conteúdos são carregados por manifesto para facilitar expansões futuras. */
let studyManifest = null, studyCategories = [], activeStudyCategory = 'visao-geral', studyLastFocus = null, studyCloseTimer = null;

function normalizedStudyText(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function studyTopicMatches(topic, query) {
    if (!query) return true;
    const searchable = [topic.title, topic.summary, ...(topic.tags || []), ...(topic.items || []).flatMap(item => typeof item === 'string' ? [item] : [item.label, item.text]), topic.note, ...(topic.sourceRefs || [])];
    return normalizedStudyText(searchable.join(' ')).includes(query);
}

function studyTopicMarkup(topic, expanded = false) {
    const tags = (topic.tags || []).length ? `<div class="study-topic-tags">${topic.tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</div>` : '';
    const points = (topic.items || []).map(item => {
        const label = typeof item === 'string' ? 'Ponto-chave' : item.label;
        const text = typeof item === 'string' ? item : item.text;
        return `<div class="study-point"><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`;
    }).join('');
    const note = topic.note ? `<p class="study-topic-note"><strong>Atenção:</strong> ${esc(topic.note)}</p>` : '';
    const sources = (topic.sourceRefs || []).length ? `<p class="study-source-refs"><strong>Fonte de estudo:</strong> ${topic.sourceRefs.map(esc).join(' · ')}</p>` : '';
    return `<details class="study-topic-card"${expanded ? ' open' : ''}><summary><strong class="study-topic-title">${esc(topic.title)}</strong><span class="study-topic-summary">${esc(topic.summary || '')}</span></summary><div class="study-topic-body">${tags}<dl class="study-points">${points}</dl>${note}${sources}</div></details>`;
}

function renderStudyTabs() {
    const tabs = document.getElementById('study-tabs');
    if (!tabs) return;
    const options = [{ id: 'all', shortLabel: 'Todos' }, ...studyCategories];
    tabs.innerHTML = options.map(category => `<button class="study-tab${category.id === activeStudyCategory ? ' is-active' : ''}" type="button" data-study-category="${esc(category.id)}" aria-pressed="${category.id === activeStudyCategory}">${esc(category.shortLabel || category.label)}</button>`).join('');
    tabs.querySelectorAll('[data-study-category]').forEach(button => button.onclick = () => {
        activeStudyCategory = button.dataset.studyCategory;
        renderStudyTabs();
        renderStudyContent();
    });
}

function renderStudyContent() {
    const target = document.getElementById('study-content'), search = document.getElementById('study-search'), count = document.getElementById('study-result-count'), title = document.getElementById('study-category-title'), clear = document.getElementById('study-search-clear');
    if (!target || !studyManifest) return;
    const rawQuery = search?.value.trim() || '', query = normalizedStudyText(rawQuery);
    const selectedCategories = query || activeStudyCategory === 'all' ? studyCategories : studyCategories.filter(category => category.id === activeStudyCategory);
    let resultCount = 0;
    const blocks = selectedCategories.map(category => {
        const topics = (category.topics || []).filter(topic => studyTopicMatches(topic, query));
        resultCount += topics.length;
        if (!topics.length) return '';
        const heading = activeStudyCategory === 'all' || query ? `<header class="study-category-heading"><div><h3>${esc(category.label)}</h3><p>${esc(category.description || '')}</p></div></header>` : '';
        return `<section class="study-category-block" aria-labelledby="study-category-${esc(category.id)}">${heading}${topics.map((topic, index) => studyTopicMarkup(topic, Boolean(query) || (activeStudyCategory !== 'all' && index === 0))).join('')}</section>`;
    }).join('');
    const active = studyCategories.find(category => category.id === activeStudyCategory);
    title.textContent = rawQuery ? `Resultados para “${rawQuery}”` : (activeStudyCategory === 'all' ? 'Todos os tópicos' : active?.label || 'Resumos');
    count.textContent = `${resultCount} ${resultCount === 1 ? 'tópico' : 'tópicos'}`;
    if (clear) clear.hidden = !rawQuery;
    target.innerHTML = blocks || `<div class="study-empty"><strong>Nenhum tópico encontrado.</strong><span>Tente outro termo ou selecione “Todos”.</span></div>`;
    target.scrollTop = 0;
}

function openStudyDrawer() {
    const drawer = document.getElementById('study-drawer'), backdrop = document.getElementById('study-drawer-backdrop'), fab = document.getElementById('study-fab'), app = document.getElementById('app-layout');
    if (!drawer || !backdrop) return;
    clearTimeout(studyCloseTimer);
    studyLastFocus = document.activeElement;
    backdrop.hidden = false;
    drawer.removeAttribute('inert');
    drawer.setAttribute('aria-hidden', 'false');
    fab?.setAttribute('aria-expanded', 'true');
    app?.setAttribute('inert', '');
    document.body.classList.add('study-drawer-open');
    requestAnimationFrame(() => {
        backdrop.classList.add('is-open');
        drawer.classList.add('is-open');
        document.getElementById('study-search')?.focus();
    });
}

function closeStudyDrawer() {
    const drawer = document.getElementById('study-drawer'), backdrop = document.getElementById('study-drawer-backdrop'), fab = document.getElementById('study-fab'), app = document.getElementById('app-layout');
    if (!drawer || !backdrop || drawer.getAttribute('aria-hidden') === 'true') return;
    drawer.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('inert', '');
    fab?.setAttribute('aria-expanded', 'false');
    app?.removeAttribute('inert');
    document.body.classList.remove('study-drawer-open');
    studyCloseTimer = setTimeout(() => { backdrop.hidden = true; }, 290);
    if (studyLastFocus instanceof HTMLElement) studyLastFocus.focus();
}

function trapStudyDrawerFocus(event) {
    const drawer = document.getElementById('study-drawer');
    if (!drawer?.classList.contains('is-open')) return;
    if (event.key === 'Escape') return closeStudyDrawer();
    if (event.key !== 'Tab') return;
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter(element => !element.hidden && element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

async function setupStudyDrawer() {
    const fab = document.getElementById('study-fab'), close = document.getElementById('study-drawer-close'), backdrop = document.getElementById('study-drawer-backdrop'), search = document.getElementById('study-search'), clear = document.getElementById('study-search-clear'), content = document.getElementById('study-content');
    if (!fab || !content) return;
    fab.onclick = openStudyDrawer;
    close.onclick = closeStudyDrawer;
    backdrop.onclick = closeStudyDrawer;
    search.oninput = renderStudyContent;
    clear.onclick = () => { search.value = ''; renderStudyContent(); search.focus(); };
    document.addEventListener('keydown', trapStudyDrawerFocus);
    try {
        const response = await fetch('data/studies/manifest.json');
        if (!response.ok) throw Error('manifesto da área de estudos indisponível');
        studyManifest = await response.json();
        studyCategories = await Promise.all((studyManifest.categories || []).map(async category => {
            const categoryResponse = await fetch(category.file);
            if (!categoryResponse.ok) throw Error(`${category.file} indisponível`);
            return { ...category, ...await categoryResponse.json() };
        }));
        if (!studyCategories.some(category => category.id === activeStudyCategory)) activeStudyCategory = studyCategories[0]?.id || 'all';
        document.getElementById('study-drawer-title').textContent = studyManifest.title || 'Área de estudos';
        document.getElementById('study-drawer-subtitle').textContent = studyManifest.subtitle || 'Resumos organizados por assunto';
        document.getElementById('study-notice').textContent = studyManifest.notice || '';
        document.getElementById('study-updated-at').textContent = studyManifest.updatedAt ? `Atualizado em ${studyManifest.updatedAt}` : '';
        renderStudyTabs();
        renderStudyContent();
    } catch (error) {
        console.error(error);
        content.innerHTML = `<div class="study-error"><strong>Não foi possível carregar a área de estudos.</strong><span>${esc(error.message)}</span></div>`;
        document.getElementById('study-result-count').textContent = 'indisponível';
    }
}

setupStudyDrawer();
