const map = L.map('map', { center: [-14.2, -51.9], zoom: 4, minZoom: 3, maxZoom: 15 });
const compactViewport = window.matchMedia('(max-width: 900px)');
const darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 20 }).addTo(map);
const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' });
const aerodromesGroup = L.layerGroup().addTo(map), navaidsGroup = L.layerGroup().addTo(map), allFixesGroup = L.layerGroup(), testAreasGroup = L.layerGroup(), measurementVectorsGroup = L.layerGroup().addTo(map), waypointSelectionsGroup = L.layerGroup().addTo(map), proceduresGroup = L.layerGroup().addTo(map), operationalLayoutGroup = L.featureGroup().addTo(map), tmaGroup = L.layerGroup().addTo(map), routesGroup = L.layerGroup().addTo(map);
const activeMarkers = {}, selectedWaypointMarkers = new Map();
let aeronauticalData = { aerodromes: [], navaids: [], fixes: [], tmas: [] }, waypointFeatures = [], searchEntries = [], procedures = [], procedureModules = [], tmaBoundaries = [], testAreas = [];
const procedurePointIndex = new Map();
const activeProcedures = new Map();
const measurementVectors = new Map();
const nationalPointRenderer = L.canvas({ padding: 0.5 });
let allFixesRendered = false, pointerLatLng = null, draftVector = null, selectedVectorId = null, nextVectorId = 1;
let tmaFocusRecords = [], dominantTmaRecord = null, spOperationalFocusBounds = null, layoutLabelsPermanent = false, cafeEasterEggTimer = null;
const operationalRunways = { SBSP: '17', SBGR: '28', SBKP: '33' };
const operationalColors = { SID: '#ffb347', STAR: '#75e36d', ILS: '#39c8ff', RNP: '#b388ff' };
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const icon = (id, selected = false) => L.divIcon({ className: 'custom-icon fix-icon', html: selected ? `<div class="selected-waypoint-dot"></div><span class="icon-label">${esc(id)}</span>` : `<div class="icon-shape diamond"></div><span class="icon-label-small">${esc(id)}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
const aerodromeIcon = id => L.divIcon({ className: 'custom-icon aerodrome-icon', html: `<div class="aerodrome-symbol"><span>✈</span></div><span class="icon-label aerodrome-label">${esc(id)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
const moduleAerodromes = () => procedureModules.flatMap(module => module.aerodromes || []);

Promise.all([fetch('aeronautical_data.json').then(r => r.ok ? r.json() : Promise.reject(Error('aeronautical_data.json indisponível'))), fetch('data/waypoints.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/waypoints.json indisponível — execute scripts/import-waypoints.py'))), fetch('data/tmas/manifest.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/tmas/manifest.json indisponível'))), fetch('all_tmas_boundaries.json').then(r => r.ok ? r.json() : Promise.reject(Error('all_tmas_boundaries.json indisponível'))), fetch('data/areas-ensaio.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/areas-ensaio.json indisponível')))])
    .then(async ([base, waypoints, moduleManifest, tmaData, testAreaData]) => {
        aeronauticalData = base;
        waypointFeatures = waypoints.features || [];
        procedureModules = await Promise.all((moduleManifest.modules || []).filter(item => item.enabled !== false).map(async item => {
            const [response, aerodromeResponse, boundaryResponse] = await Promise.all([fetch(item.file), item.aerodromesFile ? fetch(item.aerodromesFile) : Promise.resolve(null), item.boundariesFile ? fetch(item.boundariesFile) : Promise.resolve(null)]);
            if (!response.ok) throw Error(`${item.file} indisponível`);
            if (aerodromeResponse && !aerodromeResponse.ok) throw Error(`${item.aerodromesFile} indisponível`);
            if (boundaryResponse && !boundaryResponse.ok) throw Error(`${item.boundariesFile} indisponível`);
            const [module, aerodromeData, boundaryData] = await Promise.all([response.json(), aerodromeResponse ? aerodromeResponse.json() : Promise.resolve({ aerodromes: [] }), boundaryResponse ? boundaryResponse.json() : Promise.resolve(null)]);
            return { ...module, aerodromes: aerodromeData.aerodromes || module.aerodromes || [], boundaries: boundaryData ? tmaSectorFeatures(boundaryData) : [], manifestName: item.name, manifestFile: item.file, aerodromesFile: item.aerodromesFile, boundariesFile: item.boundariesFile };
        }));
        procedures = procedureModules.flatMap(module => (module.procedures || []).map(procedure => ({ ...procedure, tmaId: module.id })));
        const moduleBoundaries = procedureModules.flatMap(module => module.boundaries || []), overriddenFamilies = new Set(moduleBoundaries.map(feature => tmaFamilyName(feature.properties?.name)));
        tmaBoundaries = [...(tmaData.features || []).filter(feature => !overriddenFamilies.has(tmaFamilyName(feature.properties?.name))), ...moduleBoundaries];
        testAreas = testAreaData.areas || [];
        buildProcedurePointIndex();
        renderBaseData();
        renderTestAreas();
        buildSearchIndex();
        setupSearch();
        setupProcedureControls();
        setupMeasurementVectors();
        setupTmaFocusPanel();
        console.info(`Base nacional carregada: ${waypointFeatures.length} pontos, ${aerodromesGroup.getLayers().length} aeródromos e ${testAreas.length} áreas de ensaio. Procedimentos TMA SP: ${procedures.length}.`);
    })
    .catch(error => { console.error(error); document.getElementById('details-content').innerHTML = `<div class="panel-placeholder"><p>Não foi possível carregar a base: ${esc(error.message)}</p></div>`; });

function buildProcedurePointIndex() {
    procedurePointIndex.clear();
    waypointFeatures.forEach(feature => procedurePointIndex.set(String(feature.properties.ident).toUpperCase(), feature));
    [...(aeronauticalData.aerodromes || []), ...(aeronauticalData.navaids || []), ...(aeronauticalData.fixes || [])].forEach(point => {
        if (!point.id || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
        const ident = String(point.id).toUpperCase();
        if (procedurePointIndex.has(ident)) return;
        procedurePointIndex.set(ident, {
            type: 'Feature',
            id: `aeronautical:${ident}`,
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
            properties: { ident, latitude: point.lat, longitude: point.lon, tipo: point.type || 'Dado aeronáutico' }
        });
    });
    moduleAerodromes().forEach(point => {
        if (!point.id || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
        [point.id, ...(point.aliases || [])].forEach(code => {
            const ident = String(code).toUpperCase();
            procedurePointIndex.set(ident, {
                type: 'Feature',
                id: `tma-aerodrome:${ident}`,
                geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                properties: { ident, latitude: point.lat, longitude: point.lon, latitude_gms: point.lat_dms, longitude_gms: point.lon_dms, tipo: point.type, source: point.source }
            });
        });
    });
    procedureModules.forEach(module => Object.values(module.terminalPoints || {}).forEach(point => {
        const ident = String(point.ident).toUpperCase();
        procedurePointIndex.set(ident, {
            type: 'Feature',
            id: `terminal:${module.id}:${ident}`,
            geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
            properties: {
                ident,
                latitude: point.latitude,
                longitude: point.longitude,
                latitude_gms: point.published,
                longitude_gms: '',
                tipo: 'Ponto terminal publicado',
                source: point.source
            }
        });
    }));
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
    waypointFeatures.filter(feature => String(feature.properties.tipo).toUpperCase() === 'OTHER:ADHP').forEach(feature => {
        const point = feature.properties, ident = String(point.ident).toUpperCase();
        if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || renderedAerodromes.has(ident)) return;
        renderedAerodromes.add(ident);
        const marker = L.marker([point.latitude, point.longitude], { icon: icon(ident) }).bindPopup(`<b>${esc(ident)}</b><br>Aeródromo`).on('click', () => showDetails(feature, 'waypoint')).addTo(aerodromesGroup);
        activeMarkers[`aerodrome:${ident}`] = marker;
    });
    tmaBoundaries.forEach(feature => {
        const properties = feature.properties || {}, isSpSector = properties.dataset === 'tma-sp-official-sectorization', isFlexible = /\dF$/i.test(properties.sector_id || '');
        const style = { color: isSpSector ? '#ef5bff' : '#9c27b0', weight: isSpSector ? 2.2 : 2, dashArray: isFlexible ? '8 5' : null, fillColor: '#9c27b0', fillOpacity: isSpSector ? .055 : .12 };
        const primary = properties.frequencies?.primary?.join(', ') || 'não informada', secondary = properties.frequencies?.secondary?.join(', ') || '—';
        const popup = `<b>${esc(properties.name)}</b><br>Limites: ${esc(properties.lower_limit)} — ${esc(properties.upper_limit)}<br>Classe: ${esc(properties.airspace_class || 'N/I')}${isSpSector ? `<br>Primária: ${esc(primary)}<br>Secundária: ${esc(secondary)}<br><small>Vigência da base: ${esc(properties.effective_date)}</small>` : ''}`;
        const layer = L.geoJSON(feature, { style }).bindPopup(popup).bindTooltip(esc(properties.name), { sticky: true, className: 'tma-sector-tooltip' }).addTo(tmaGroup);
        if (isSpSector) layer.on('mouseover', () => layer.setStyle({ weight: 4, fillOpacity: .14 })).on('mouseout', () => layer.setStyle(style));
    });
}

function ensureAllFixesRendered() {
    if (allFixesRendered) return;
    waypointFeatures.filter(feature => String(feature.properties.tipo).toUpperCase() !== 'OTHER:ADHP').forEach(feature => {
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

function tmaSectorFeatures(dataset) {
    return (dataset.sectors || []).map(sector => {
        const coordinates = (sector.coordinatesDms || []).map(([latitude, longitude]) => [compactDmsToDecimal(longitude), compactDmsToDecimal(latitude)]).filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));
        if (coordinates.length < 3) return null;
        const first = coordinates[0], last = coordinates[coordinates.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
        return {
            type: 'Feature',
            id: `tma-sp-sector:${sector.id}`,
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
                dataset: 'tma-sp-official-sectorization'
            },
            geometry: { type: 'Polygon', coordinates: [coordinates] }
        };
    }).filter(Boolean);
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
    waypointFeatures.forEach(feature => { const p = feature.properties; base.push({ key: feature.id, ident: String(p.ident), type: String(p.tipo ?? ''), lat: p.latitude, lon: p.longitude, gms: `${p.latitude_gms ?? ''} ${p.longitude_gms ?? ''}`.trim(), item: feature, category: 'waypoint' }); });
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
    return String(name || 'TMA').replace(/\s+SECT\b.*$/i, '').replace(/\s+\d+$/i, '').replace(/\s+\(Circular.*$/i, '').trim();
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
function setupTmaFocusPanel() {
    const panel = document.getElementById('tma-focus-panel'), toggle = document.getElementById('tma-focus-toggle');
    if (!panel || !toggle) return;
    tmaFocusRecords = tmaBoundaries.map(feature => ({ feature, bounds: L.geoJSON(feature).getBounds(), family: tmaFamilyName(feature.properties?.name) })).filter(record => record.bounds.isValid());
    const spAerodromeCoordinates = moduleAerodromes().map(item => [item.lat, item.lon]).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    spOperationalFocusBounds = spAerodromeCoordinates.length ? L.latLngBounds(spAerodromeCoordinates).pad(.55) : null;
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
    map.on('moveend zoomend', updateDominantTma);
    updateDominantTma();
}
function updateDominantTma() {
    const name = document.getElementById('tma-focus-name'), subtitle = document.getElementById('tma-focus-subtitle'), limits = document.getElementById('tma-focus-limits'), airspaceClass = document.getElementById('tma-focus-class'), presence = document.getElementById('tma-focus-presence'), details = document.getElementById('tma-focus-details'), spControls = document.getElementById('sp-layout-controls');
    if (!name || !tmaFocusRecords.length) return;
    if (map.getZoom() < 5) {
        dominantTmaRecord = null;
        name.textContent = 'Aproxime o mapa';
        subtitle.textContent = 'A identificação automática começa no zoom 5.';
        limits.textContent = airspaceClass.textContent = presence.textContent = '—';
        details.innerHTML = '<p>A TMA com maior presença estimada na janela será selecionada automaticamente.</p>';
        spControls.hidden = true;
        return;
    }
    const view = map.getBounds(), viewArea = boundsArea(view), officialSpRecords = tmaFocusRecords.filter(item => /TMA São Paulo/i.test(item.family)), hasCompleteSpSectorization = officialSpRecords.length >= 15;
    const ranked = tmaFocusRecords.filter(record => overlapArea(record.bounds, view) > 0).map(record => ({ ...record, score: featureVisibleArea(record.feature, view) })).filter(record => record.score > 0).sort((a, b) => b.score - a.score);
    const familyScores = new Map();
    ranked.forEach(record => familyScores.set(record.family, (familyScores.get(record.family) || 0) + record.score));
    const spOfficialFocus = map.getZoom() >= 6 && spOperationalFocusBounds?.contains(map.getCenter()) && ranked.some(record => /TMA São Paulo/i.test(record.family));
    const dominantFamily = spOfficialFocus ? officialSpRecords[0]?.family : [...familyScores.entries()].sort((first, second) => second[1] - first[1])[0]?.[0], dominantOfficialRecord = ranked.find(record => record.family === dominantFamily);
    const spOperationalFocus = !hasCompleteSpSectorization && map.getZoom() >= 6 && spOperationalFocusBounds?.contains(map.getCenter());
    if (!ranked.length && !spOperationalFocus) {
        dominantTmaRecord = null;
        name.textContent = 'Nenhuma TMA na janela';
        subtitle.textContent = 'Desloque ou afaste o mapa para localizar um limite disponível.';
        limits.textContent = airspaceClass.textContent = presence.textContent = '—';
        details.innerHTML = '<p>A camada nacional possui somente os setores publicados no arquivo local.</p>';
        spControls.hidden = true;
        return;
    }
    const officialSpRecord = officialSpRecords[0];
    const record = spOperationalFocus ? { ...(officialSpRecord || {}), family: 'TMA São Paulo', score: 0, operationalFocus: true, feature: officialSpRecord?.feature || { properties: {}, geometry: null } } : dominantOfficialRecord, properties = record.feature.properties || {}, familyRecords = tmaFocusRecords.filter(item => item.family === record.family), visibleFamilyRecords = familyRecords.filter(item => overlapArea(item.bounds, view) > 0 && featureVisibleArea(item.feature, view) > 0), familyScore = familyScores.get(record.family) || record.score, percentage = record.operationalFocus ? null : Math.min(100, familyScore / viewArea * 100), vertices = geometryVertexCount(record.feature.geometry), circular = Number.isFinite(properties.radius_nm), isSaoPaulo = /TMA São Paulo/i.test(record.family);
    dominantTmaRecord = record;
    name.textContent = record.operationalFocus ? 'TMA São Paulo — foco IFR' : properties.name || record.family;
    subtitle.textContent = record.operationalFocus ? 'Contexto definido pelos aeródromos do módulo; não representa um novo limite oficial.' : `${record.family} · setor com maior presença na tela`;
    limits.textContent = record.operationalFocus ? 'Variam por setor' : `${properties.lower_limit || 'N/I'} / ${properties.upper_limit || 'N/I'}`;
    airspaceClass.textContent = record.operationalFocus ? 'A/C por setor' : properties.airspace_class || 'N/I';
    presence.textContent = record.operationalFocus ? 'FOCO IFR' : `${percentage < 1 ? '<1' : Math.round(percentage)}%`;
    const geometryText = record.operationalFocus ? 'Área contextual calculada pela distribuição dos oito aeródromos do módulo IFR.' : circular ? `Setor circular com raio publicado de ${properties.radius_nm} NM.` : `Setor poligonal com ${Math.max(0, vertices - 1)} lados/pontos de contorno.`;
    const moduleAirports = isSaoPaulo ? moduleAerodromes().map(item => item.id).join(', ') : '';
    const primary = properties.frequencies?.primary?.join(', '), secondary = properties.frequencies?.secondary?.join(', '), frequencyInfo = primary ? `<p><strong>Frequência:</strong> PRI ${esc(primary)}${secondary ? ` · SRY ${esc(secondary)}` : ''} · EMERG ${esc(properties.frequencies.emergency || '121.500 MHz')}.</p>` : '';
    const sectorizationInfo = isSaoPaulo && hasCompleteSpSectorization ? `<p><strong>Setorização:</strong> conjunto oficial completo com ${familyRecords.length} setores; 02F e 03F aparecem tracejados. Base vigente em ${esc(properties.effective_date || '2026-08-06')}.</p><p><strong>Particularidade:</strong> ${esc(properties.remarks || 'Os limites e frequências variam por setor.')}</p>` : isSaoPaulo ? '<p><strong>Particularidade da base:</strong> a malha IFR não amplia nem infere limites oficiais ausentes.</p>' : '<p><strong>Leitura:</strong> presença calculada pela interseção real do polígono com a tela; consulte a publicação vigente para uso operacional.</p>';
    details.innerHTML = `<p><strong>Tipo:</strong> ${esc(properties.type || 'TMA')} · ${esc(geometryText)}</p><p><strong>Cobertura local:</strong> ${visibleFamilyRecords.length} de ${familyRecords.length} setor(es) oficiais aparecem na janela.</p>${frequencyInfo}${moduleAirports ? `<p><strong>Aeródromos do módulo IFR:</strong> ${esc(moduleAirports)}.</p>` : ''}${sectorizationInfo}`;
    spControls.hidden = !isSaoPaulo;
}

function selectedOperationalTypes() {
    return new Set([...document.querySelectorAll('.layout-type-filter:checked')].map(input => input.value));
}
function currentOperationalCode() {
    return `${operationalRunways.SBSP}–${operationalRunways.SBGR}–${operationalRunways.SBKP}`;
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
    const selectors = { SBSP: document.getElementById('sp-runway-sbsp'), SBGR: document.getElementById('sp-runway-sbgr'), SBKP: document.getElementById('sp-runway-sbkp') }, enabled = document.getElementById('sp-layout-enabled'), fit = document.getElementById('sp-layout-fit'), clear = document.getElementById('sp-layout-clear'), presets = document.getElementById('sp-layout-presets');
    const combinations = ['17-10-15', '17-10-33', '17-28-15', '17-28-33', '35-10-15', '35-10-33', '35-28-15', '35-28-33'];
    presets.replaceChildren(...combinations.map(code => { const button = document.createElement('button'); button.type = 'button'; button.textContent = code; button.dataset.config = code; button.onclick = () => { const [sbsp, sbgr, sbkp] = code.split('-'); selectors.SBSP.value = sbsp; selectors.SBGR.value = sbgr; selectors.SBKP.value = sbkp; operationalRunways.SBSP = sbsp; operationalRunways.SBGR = sbgr; operationalRunways.SBKP = sbkp; enabled.checked = true; renderOperationalLayout(); }; return button; }));
    Object.entries(selectors).forEach(([airport, select]) => select.onchange = () => { operationalRunways[airport] = select.value; renderOperationalLayout(); });
    document.querySelectorAll('.layout-type-filter').forEach(input => input.onchange = renderOperationalLayout);
    enabled.onchange = () => {
        if (enabled.checked) { if (!map.hasLayer(operationalLayoutGroup)) operationalLayoutGroup.addTo(map); renderOperationalLayout(); }
        else clearOperationalLayout('Malha IFR ocultada.');
    };
    fit.onclick = () => { const bounds = operationalLayoutGroup.getBounds(); if (bounds.isValid()) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 9 }); };
    clear.onclick = () => { enabled.checked = false; clearOperationalLayout('Malha IFR removida do mapa.'); };
    map.on('zoomend', () => { const permanent = map.getZoom() >= 9; if (enabled.checked && permanent !== layoutLabelsPermanent) renderOperationalLayout(); });
    map.on('overlayremove', event => { if (event.layer === operationalLayoutGroup) { enabled.checked = false; clearOperationalLayout('Malha IFR ocultada pelo controle de camadas.', false); } });
    map.on('overlayadd', event => { if (event.layer === operationalLayoutGroup && operationalLayoutGroup.getLayers().length) enabled.checked = true; });
    clearOperationalLayout('Selecione as pistas e ative a malha IFR.');
}
function updateOperationalControls() {
    const code = currentOperationalCode(), codeTarget = document.getElementById('sp-layout-code');
    if (codeTarget) codeTarget.textContent = code;
    document.querySelectorAll('#sp-layout-presets button').forEach(button => button.classList.toggle('is-active', button.dataset.config === code.replaceAll('–', '-')));
}
function clearOperationalLayout(message, removeLayer = true) {
    operationalLayoutGroup.clearLayers();
    if (removeLayer && map.hasLayer(operationalLayoutGroup)) map.removeLayer(operationalLayoutGroup);
    document.getElementById('sp-layout-fit').disabled = true;
    document.getElementById('sp-layout-status').textContent = message;
    updateOperationalControls();
}
function renderOperationalLayout() {
    updateOperationalControls();
    const enabled = document.getElementById('sp-layout-enabled');
    if (!enabled?.checked) return clearOperationalLayout('Selecione as pistas e ative a malha IFR.');
    if (!map.hasLayer(operationalLayoutGroup)) operationalLayoutGroup.addTo(map);
    operationalLayoutGroup.clearLayers();
    layoutLabelsPermanent = map.getZoom() >= 9;
    const types = selectedOperationalTypes(), matchedProcedures = procedures.filter(procedure => procedure.tmaId === 'tma-sp' && procedureMatchesOperationalConfig(procedure, types)), segmentKeys = new Set(), pointData = new Map();
    const pointRecord = (ident, category) => { if (!pointData.has(ident)) pointData.set(ident, { categories: new Set(), restrictions: new Map() }); const record = pointData.get(ident); record.categories.add(category); return record; };
    let routeCount = 0, segmentCount = 0;
    matchedProcedures.forEach(procedure => (procedure.transitions || []).forEach(transition => {
        const category = operationalCategory(procedure);
        routeCount += 1;
        (transition.sequence || []).forEach(ident => pointRecord(ident, category));
        (transition.segments || []).forEach(segment => {
            if (segment.destination) {
                const restriction = segmentRestriction(segment), record = pointRecord(segment.destination, category);
                if (restriction !== 'Sem restrição adicional publicada') record.restrictions.set(`${procedure.id}|${restriction}`, { text: restriction, procedure, transition });
            }
            if (!segment.origin || !segment.destination) return;
            const origin = waypointForProcedure(segment.origin), destination = waypointForProcedure(segment.destination);
            if (!origin || !destination) return;
            const key = [procedure.type, segment.origin, segment.destination, segment.pathTerminator, segment.arcCenterFix, segment.turn].join('|');
            if (segmentKeys.has(key)) return;
            segmentKeys.add(key);
            segmentCount += 1;
            L.polyline(segmentLatLngs(segment, origin, destination), { color: operationalColors[category], weight: ['ILS', 'RNP'].includes(category) ? 2.6 : 2.1, opacity: .82, dashArray: category === 'SID' ? '8 5' : category === 'RNP' ? '10 3 2 3' : category === 'ILS' ? '3 4' : null, interactive: true })
                .bindTooltip(`${category} · ${procedure.airport} · ${procedure.name}<br>${segment.origin} → ${segment.destination}<br>${esc(segmentRestriction(segment))}`)
                .on('click', () => showSegmentDetails(segment, procedure, transition))
                .addTo(operationalLayoutGroup);
        });
    }));
    let restrictedFixes = 0;
    pointData.forEach((record, ident) => {
        const point = waypointForProcedure(ident);
        if (!point) return;
        const category = [...record.categories][0], restrictions = [...new Set([...record.restrictions.values()].map(item => item.text))];
        if (restrictions.length) restrictedFixes += 1;
        const restrictionLabel = restrictions.length ? `<span class="layout-fix-restriction">${esc(restrictions.slice(0, 2).join(' / '))}${restrictions.length > 2 ? ` +${restrictions.length - 2}` : ''}</span>` : '';
        L.circleMarker([point.properties.latitude, point.properties.longitude], { radius: restrictions.length ? 3.2 : 2.3, color: operationalColors[category], weight: restrictions.length ? 1.8 : 1, fillColor: restrictions.length ? '#ffd166' : '#111', fillOpacity: .9 })
            .bindTooltip(`<strong>${esc(ident)}</strong>${restrictionLabel}`, { permanent: layoutLabelsPermanent, direction: 'top', className: 'layout-fix-label', offset: [0, -2] })
            .on('click', () => showOperationalFixDetails(point, ident, record))
            .addTo(operationalLayoutGroup);
    });
    const bounds = operationalLayoutGroup.getBounds(), status = document.getElementById('sp-layout-status');
    document.getElementById('sp-layout-fit').disabled = !bounds.isValid();
    status.textContent = `${currentOperationalCode()} · ${matchedProcedures.length} cartas · ${routeCount} trajetórias · ${segmentCount} trechos únicos · ${pointData.size} FIX · ${restrictedFixes} com restrição.`;
}
function setupProcedureControls() {
    const tma = document.getElementById('procedure-tma'), airport = document.getElementById('procedure-airport'), type = document.getElementById('procedure-type'), procedure = document.getElementById('procedure-select'), transition = document.getElementById('procedure-transition'), missedOption = document.getElementById('include-missed-approach'), addButton = document.getElementById('add-procedure');
    tma.replaceChildren(...procedureModules.map(module => new Option(module.manifestName || module.name, module.id)));
    const refreshTransition = () => {
        const selected = procedures.find(item => item.id === procedure.value);
        const options = selected?.transitions || [];
        transition.replaceChildren(...(options.length ? options.map(item => new Option(item.name, item.id)) : [new Option('Sem trajetória codificada', '')]));
        transition.disabled = !options.length;
        missedOption.closest('label').hidden = selected?.type !== 'IAC';
        addButton.disabled = !selected;
        addButton.textContent = options.length ? 'Adicionar procedimento' : 'Consultar procedimento';
        if (selected) showProcedureSummary(selected);
    };
    const refreshProcedures = () => {
        const options = procedures.filter(item => item.tmaId === tma.value && item.airport === airport.value && item.type === type.value);
        procedure.replaceChildren(...(options.length ? options.map(item => new Option(item.name, item.id)) : [new Option('Nenhum procedimento publicado', '')]));
        refreshTransition();
    };
    const refreshAirports = () => {
        const module = procedureModules.find(item => item.id === tma.value);
        airport.replaceChildren(...(module?.airports || []).map(item => new Option(`${item.icao} — ${item.name}${item.status === 'no-current-procedure-found' ? ' (sem procedimento vigente)' : ''}`, item.icao)));
        const firstWithProcedures = (module?.airports || []).find(item => Object.values(item.procedureCounts || {}).some(Boolean));
        if (firstWithProcedures) airport.value = firstWithProcedures.icao;
        refreshProcedures();
    };
    tma.onchange = refreshAirports;
    airport.onchange = refreshProcedures;
    type.onchange = refreshProcedures;
    procedure.onchange = refreshTransition;
    addButton.onclick = () => {
        const selectedProcedure = procedures.find(item => item.id === procedure.value);
        const selectedTransition = selectedProcedure?.transitions.find(item => item.id === transition.value);
        if (!selectedProcedure) return;
        if (!selectedTransition) return showProcedureSummary(selectedProcedure);
        addProcedure(selectedProcedure, selectedTransition, missedOption.checked);
    };
    refreshAirports();
}

function waypointForProcedure(ident) { return procedurePointIndex.get(String(ident).toUpperCase()); }
function altitudeText(value) {
    if (!value || !Number.isFinite(value.valueFt)) return null;
    const altitude = `${Math.abs(value.valueFt)} FT`;
    return ({ 'at-or-above': `≥ ${altitude}`, 'at-or-below': `≤ ${altitude}`, at: `@ ${altitude}`, recommended: `REC ${altitude}` })[value.meaning] || altitude;
}
function speedText(segment) {
    if (!Number.isFinite(segment.speedLimitKt)) return null;
    return `${segment.speedLimitDescription === '+' ? '≥' : segment.speedLimitDescription === '@' ? '@' : '≤'} ${segment.speedLimitKt} KT`;
}
function segmentRestriction(segment) {
    const lower = segment.lowerLimitAltitude, upper = segment.upperLimitAltitude;
    const altitude = lower?.meaning === 'between-bound' && upper?.meaning === 'between-bound' && Number.isFinite(lower.valueFt) && Number.isFinite(upper.valueFt) ? `${Math.min(Math.abs(lower.valueFt), Math.abs(upper.valueFt))}–${Math.max(Math.abs(lower.valueFt), Math.abs(upper.valueFt))} FT` : [altitudeText(lower), altitudeText(upper)].filter(Boolean).join(' · ');
    return [altitude, speedText(segment)].filter(Boolean).join(' · ') || 'Sem restrição adicional publicada';
}
function courseText(course) { return course ? [Number.isFinite(course.magnetic) ? `${course.magnetic}° MAG` : null, Number.isFinite(course.true) ? `${course.true}° TRUE` : null].filter(Boolean).join(' / ') : 'N/A'; }
function segmentLatLngs(segment, origin, destination) {
    const start = [origin.properties.latitude, origin.properties.longitude], end = [destination.properties.latitude, destination.properties.longitude];
    if (segment.pathTerminator !== 'RF' || !segment.arcCenterFix) return [start, end];
    const centerPoint = waypointForProcedure(segment.arcCenterFix);
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
    const module = procedureModules.find(item => item.id === procedure.tmaId), relatedConnections = (module?.connections || []).filter(item => item.fromProcedure === procedure.id || item.toProcedure === procedure.id), source = procedure.source || {}, status = procedure.status === 'structured' ? 'Estruturado pela tabela oficial' : 'Carta textual — nenhuma geometria foi inferida', textBlock = procedure.publishedText ? `<details><summary>Texto publicado extraído</summary><pre class="procedure-text">${esc(procedure.publishedText)}</pre></details>` : '';
    document.getElementById('details-content').innerHTML = `<div class="panel-header fix-header"><h3>${esc(procedure.name)}</h3><p class="subtitle">${esc(procedure.type)} — ${esc(procedure.airport)}</p></div><div class="panel-body"><div class="info-row"><span class="info-label">Pistas:</span><span class="info-val">${esc(procedure.runways.join(', ') || 'Não informadas')}</span></div><div class="info-row"><span class="info-label">Modalidade:</span><span class="info-val">${esc(procedure.modes.join(', ') || 'Não informada')}</span></div><div class="info-row"><span class="info-label">Situação:</span><span class="info-val">${esc(status)}</span></div><div class="info-row"><span class="info-label">Transições:</span><span class="info-val">${procedure.transitions.length}</span></div><div class="info-row"><span class="info-label">Conexões STAR → IAC:</span><span class="info-val">${relatedConnections.length}</span></div><div class="source-tag"><strong>Fonte oficial:</strong> AISWEB/DECEA · ${esc(source.chartCode || 'carta OMNI')} · ${esc(source.amendment)} · efetiva em ${esc(source.effectiveDate)}</div>${textBlock}</div>`;
}
function addProcedure(procedure, transition, includeMissedApproach = true) {
    const key = `${procedure.id}:${transition.id}`;
    if (activeProcedures.has(key)) return focusProcedure(key);
    const color = ['#00e5ff', '#ff9800', '#e91e63', '#8bc34a', '#ab47bc'][activeProcedures.size % 5];
    const group = L.featureGroup();
    const unresolved = new Set();
    transition.segments.forEach(segment => {
        const origin = segment.origin ? waypointForProcedure(segment.origin) : null, destination = segment.destination ? waypointForProcedure(segment.destination) : null;
        if (segment.origin && !origin) unresolved.add(segment.origin);
        if (segment.destination && !destination) unresolved.add(segment.destination);
        if (!origin || !destination) return;
        L.polyline(segmentLatLngs(segment, origin, destination), { color, weight: 4, opacity: .9 }).bindTooltip(`${segment.pathTerminator || 'LEG'} · ${courseText(segment.course)} · ${segment.distanceNm ?? 'N/A'} NM`).on('click', () => showSegmentDetails(segment, procedure, transition)).addTo(group);
    });
    transition.sequence.forEach(ident => {
        const point = waypointForProcedure(ident);
        if (!point) return unresolved.add(ident);
        const destinationSegments = transition.segments.filter(segment => segment.destination === ident), restriction = destinationSegments.map(segmentRestriction).find(value => value !== 'Sem restrição adicional publicada') || 'Sem restrição adicional publicada';
        L.marker([point.properties.latitude, point.properties.longitude], { icon: icon(ident, true), zIndexOffset: 1200 }).bindTooltip(`${ident} — ${restriction}`, { permanent: true, direction: 'top', offset: [0, -10] }).on('click', () => showProcedurePoint(point, procedure, transition, restriction)).addTo(group);
    });
    if (includeMissedApproach && procedure.type === 'IAC') procedure.missedApproach.forEach(route => addMissedRoute(group, route, procedure));
    group.addTo(proceduresGroup); activeProcedures.set(key, { group, procedure, transition, unresolved: [...unresolved], includeMissedApproach }); renderActiveProcedures(); showProcedureSummary(procedure); if (unresolved.size) document.getElementById('details-content').insertAdjacentHTML('beforeend', `<div class="source-tag warning-tag"><strong>Sem coordenada na base:</strong> ${esc([...unresolved].join(', '))}. Nenhum segmento foi conectado por proximidade.</div>`); focusProcedure(key);
}
function addMissedRoute(group, route, procedure) {
    route.segments.forEach(segment => {
        const origin = segment.origin ? waypointForProcedure(segment.origin) : null, destination = segment.destination ? waypointForProcedure(segment.destination) : null;
        if (!origin || !destination) return;
        L.polyline(segmentLatLngs(segment, origin, destination), { color: '#ff5252', weight: 3, opacity: .95, dashArray: '8, 7' }).bindTooltip(`Aproximação perdida · ${segment.pathTerminator || 'LEG'} · ${courseText(segment.course)}`).on('click', () => showSegmentDetails(segment, procedure, route)).addTo(group);
    });
    route.sequence.forEach(ident => { const point = waypointForProcedure(ident); if (point) L.circleMarker([point.properties.latitude, point.properties.longitude], { radius: 5, color: '#ff5252', fillColor: '#ff5252', fillOpacity: .9 }).bindTooltip(`APCH perdida · ${ident}`).addTo(group); });
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
function showSegmentDetails(segment, procedure, transition) { const arc = segment.arcCenterFix ? `<div class="info-row"><span class="info-label">Centro/arco RF:</span><span class="info-val">${esc(segment.arcCenterFix)} · ${esc(segment.arcRadiusNm ?? 'N/A')} NM</span></div>` : ''; document.getElementById('details-content').innerHTML = `<div class="panel-header fix-header"><h3>${esc(segment.origin || 'Ponto não publicado')} → ${esc(segment.destination || 'Ponto não publicado')}</h3><p class="subtitle">${esc(procedure.name)} — ${esc(transition.name)}</p></div><div class="panel-body"><div class="info-row"><span class="info-label">Perna:</span><span class="info-val">${esc(segment.pathTerminator || 'N/A')}</span></div><div class="info-row"><span class="info-label">Curso:</span><span class="info-val">${esc(courseText(segment.course))}</span></div><div class="info-row"><span class="info-label">Distância:</span><span class="info-val">${esc(segment.distanceNm ?? 'N/A')} NM</span></div>${arc}<div class="info-row"><span class="info-label">Restrição:</span><span class="info-val">${esc(segmentRestriction(segment))}</span></div><div class="info-row"><span class="info-label">Papel do FIX:</span><span class="info-val">${esc(segment.fixRole || 'N/A')}</span></div><div class="info-row"><span class="info-label">Navegação:</span><span class="info-val">${esc(segment.navigationSpecification || 'N/A')}</span></div><div class="source-tag"><strong>Fonte:</strong> tabela de codificação ${esc(procedure.source.chartCode)}, página ${esc(segment.sourcePage)}</div></div>`; }
function focusProcedure(key) { const item = activeProcedures.get(key); if (item && item.group.getBounds().isValid()) map.fitBounds(item.group.getBounds(), { padding: [45, 45], maxZoom: 10 }); }
function removeProcedure(key) { const item = activeProcedures.get(key); if (item) proceduresGroup.removeLayer(item.group); activeProcedures.delete(key); renderActiveProcedures(); }
function renderActiveProcedures() { const target = document.getElementById('active-procedures'); target.replaceChildren(); if (!activeProcedures.size) { target.innerHTML = '<span class="empty-selection">Nenhum procedimento ativo.</span>'; return; } activeProcedures.forEach((item, key) => { const row = document.createElement('div'); row.className = 'selected-point-row'; row.innerHTML = `<span><strong>${esc(item.procedure.type)} — ${esc(item.procedure.name)}</strong><br><span class="mono-small">${esc(item.transition.name)} · ${esc(item.procedure.source.chartCode || 'OMNI')} · ${esc(item.procedure.source.effectiveDate)}${item.includeMissedApproach && item.procedure.type === 'IAC' ? ' · APCH perdida' : ''}</span></span><button type="button">Remover</button>`; row.querySelector('span').onclick = () => focusProcedure(key); row.querySelector('button').onclick = () => removeProcedure(key); target.appendChild(row); }); }
L.control.layers({ 'Cartografia Escura': darkMatter, 'Mapa Padrão (OSM)': openStreetMap }, { 'Todos os aeródromos (Brasil)': aerodromesGroup, 'Todos os fixos (Brasil)': allFixesGroup, 'Áreas de ensaio em voo': testAreasGroup, 'Vetores de medição': measurementVectorsGroup, 'Auxílios Rádio': navaidsGroup, 'Waypoints selecionados': waypointSelectionsGroup, 'Procedimentos IFR': proceduresGroup, 'Layout operacional TMA SP': operationalLayoutGroup, 'Áreas TMA': tmaGroup, 'Simulações de Rota': routesGroup }, { collapsed: compactViewport.matches, position: 'topright' }).addTo(map);

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
