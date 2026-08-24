const map = L.map('map', { center: [-14.2, -51.9], zoom: 4, minZoom: 3, maxZoom: 15 });
const darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 20 }).addTo(map);
const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' });
const aerodromesGroup = L.layerGroup().addTo(map), navaidsGroup = L.layerGroup().addTo(map), allFixesGroup = L.layerGroup(), testAreasGroup = L.layerGroup(), measurementVectorsGroup = L.layerGroup().addTo(map), waypointSelectionsGroup = L.layerGroup().addTo(map), proceduresGroup = L.layerGroup().addTo(map), tmaGroup = L.layerGroup().addTo(map), routesGroup = L.layerGroup().addTo(map);
const activeMarkers = {}, selectedWaypointMarkers = new Map();
let aeronauticalData = { aerodromes: [], navaids: [], fixes: [], tmas: [] }, waypointFeatures = [], searchEntries = [], procedures = [], procedureModules = [], tmaBoundaries = [], testAreas = [];
const procedurePointIndex = new Map();
const activeProcedures = new Map();
const measurementVectors = new Map();
const nationalPointRenderer = L.canvas({ padding: 0.5 });
let allFixesRendered = false, pointerLatLng = null, draftVector = null, selectedVectorId = null, nextVectorId = 1;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const icon = (id, selected = false) => L.divIcon({ className: 'custom-icon fix-icon', html: selected ? `<div class="selected-waypoint-dot"></div><span class="icon-label">${esc(id)}</span>` : `<div class="icon-shape diamond"></div><span class="icon-label-small">${esc(id)}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
const aerodromeIcon = id => L.divIcon({ className: 'custom-icon aerodrome-icon', html: `<div class="aerodrome-symbol"><span>✈</span></div><span class="icon-label aerodrome-label">${esc(id)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
const moduleAerodromes = () => procedureModules.flatMap(module => module.aerodromes || []);

Promise.all([fetch('aeronautical_data.json').then(r => r.ok ? r.json() : Promise.reject(Error('aeronautical_data.json indisponível'))), fetch('data/waypoints.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/waypoints.json indisponível — execute scripts/import-waypoints.py'))), fetch('data/tmas/manifest.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/tmas/manifest.json indisponível'))), fetch('all_tmas_boundaries.json').then(r => r.ok ? r.json() : Promise.reject(Error('all_tmas_boundaries.json indisponível'))), fetch('data/areas-ensaio.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/areas-ensaio.json indisponível')))])
    .then(async ([base, waypoints, moduleManifest, tmaData, testAreaData]) => {
        aeronauticalData = base;
        waypointFeatures = waypoints.features || [];
        procedureModules = await Promise.all((moduleManifest.modules || []).filter(item => item.enabled !== false).map(async item => {
            const [response, aerodromeResponse] = await Promise.all([fetch(item.file), item.aerodromesFile ? fetch(item.aerodromesFile) : Promise.resolve(null)]);
            if (!response.ok) throw Error(`${item.file} indisponível`);
            if (aerodromeResponse && !aerodromeResponse.ok) throw Error(`${item.aerodromesFile} indisponível`);
            const [module, aerodromeData] = await Promise.all([response.json(), aerodromeResponse ? aerodromeResponse.json() : Promise.resolve({ aerodromes: [] })]);
            return { ...module, aerodromes: aerodromeData.aerodromes || module.aerodromes || [], manifestName: item.name, manifestFile: item.file, aerodromesFile: item.aerodromesFile };
        }));
        procedures = procedureModules.flatMap(module => (module.procedures || []).map(procedure => ({ ...procedure, tmaId: module.id })));
        tmaBoundaries = tmaData.features || [];
        testAreas = testAreaData.areas || [];
        buildProcedurePointIndex();
        renderBaseData();
        renderTestAreas();
        buildSearchIndex();
        setupSearch();
        setupProcedureControls();
        setupMeasurementVectors();
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
    tmaBoundaries.forEach(feature => L.geoJSON(feature, { style: { color: '#9c27b0', weight: 2, fillColor: '#9c27b0', fillOpacity: .12 } }).bindPopup(`<b>${esc(feature.properties.name)}</b><br>${esc(feature.properties.lower_limit)} — ${esc(feature.properties.upper_limit)}`).addTo(tmaGroup));
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
    input.addEventListener('input', () => { const q = input.value.trim().toUpperCase(); box.replaceChildren(); if (!q) return void (box.style.display = 'none'); const matches = searchEntries.filter(e => e.ident.toUpperCase().includes(q)).slice(0, 12); matches.forEach(e => box.appendChild(suggestion(e, input, box))); box.style.display = matches.length ? 'block' : 'none'; });
    document.addEventListener('click', e => { if (!e.target.closest('.search-container')) box.style.display = 'none'; });
}
function suggestion(entry, input, box) { const el = document.createElement('button'); el.type = 'button'; el.className = 'suggestion-item'; el.innerHTML = `<span><strong>${esc(entry.ident)}</strong> — ${esc(entry.type)}</span><span class="coord-tag">${esc(entry.gms || `${entry.lat}, ${entry.lon}`)}</span>`; el.onclick = () => { selectEntry(entry); input.value = entry.ident; box.style.display = 'none'; }; return el; }
function selectEntry(entry) { map.setView([entry.lat, entry.lon], 8, { animate: true, duration: .5 }); if (entry.category === 'waypoint') addWaypoint(entry); else { activeMarkers[entry.key]?.openPopup(); showDetails(entry.item, entry.category); } }
function addWaypoint(entry) { let marker = selectedWaypointMarkers.get(entry.key); if (!marker) { marker = L.marker([entry.lat, entry.lon], { icon: icon(entry.ident, true), zIndexOffset: 1000 }).bindPopup(`<b>${esc(entry.ident)}</b><br>${esc(entry.type)}<br>${esc(entry.gms || `${entry.lat}, ${entry.lon}`)}`).on('click', () => showDetails(entry.item, 'waypoint')).addTo(waypointSelectionsGroup); selectedWaypointMarkers.set(entry.key, marker); renderSelectedPoints(); } marker.openPopup(); showDetails(entry.item, 'waypoint'); }
function removeWaypoint(key) { selectedWaypointMarkers.get(key)?.remove(); selectedWaypointMarkers.delete(key); renderSelectedPoints(); }
function renderSelectedPoints() { const target = document.getElementById('selected-points'); target.replaceChildren(); if (!selectedWaypointMarkers.size) { target.innerHTML = '<span class="empty-selection">Nenhum waypoint selecionado.</span>'; return; } selectedWaypointMarkers.forEach((marker, key) => { const entry = searchEntries.find(e => e.key === key), row = document.createElement('div'); row.className = 'selected-point-row'; row.innerHTML = `<span><strong>${esc(entry.ident)}</strong><br><span class="mono-small">${esc(entry.gms)}</span></span><button type="button">Remover</button>`; row.querySelector('span').onclick = () => selectEntry(entry); row.querySelector('button').onclick = () => removeWaypoint(key); target.appendChild(row); }); }
function addMultiplePoints() { const ids = document.getElementById('multiple-input').value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean), entries = ids.map(id => searchEntries.find(e => e.ident.toUpperCase() === id)).filter(Boolean); if (!entries.length) return alert('Nenhum ponto válido encontrado com os identificadores fornecidos.'); entries.forEach(selectEntry); routesGroup.clearLayers(); const coords = entries.map(e => [e.lat, e.lon]); if (coords.length > 1) { const line = L.polyline(coords, { color: '#00e5ff', weight: 3, dashArray: '5, 10' }).addTo(routesGroup); map.fitBounds(line.getBounds(), { padding: [50, 50] }); } }
function showDetails(item, category) { const panel = document.getElementById('details-content'); if (category === 'waypoint') { const p = item.properties, fields = Object.entries(p).filter(([key, v]) => key !== 'source' && v !== null && v !== undefined && v !== '').map(([k, v]) => `<div class="info-row"><span class="info-label">${esc(k)}:</span><span class="info-val">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span></div>`).join(''), source = item.sourceRow ? `waypoint.xlsx, linha ${item.sourceRow}` : p.source ? `${p.source.chart || p.source.procedure || 'tabela de codificação'}, página ${p.source.codingTablePage || 'não informada'}` : 'não informada'; panel.innerHTML = `<div class="panel-header fix-header"><h3>${esc(p.ident)}</h3><p class="subtitle">WAYPOINT — ${esc(p.tipo)}</p></div><div class="panel-body"><div class="coords-box"><strong>COORDENADAS DA FONTE</strong><br><span class="mono">${esc(p.latitude_gms)} ${esc(p.longitude_gms)}</span><br><span class="mono-small">Decimal: ${esc(p.latitude)}, ${esc(p.longitude)}</span></div>${fields}<div class="source-tag"><strong>Fonte:</strong> ${esc(source)}</div></div>`; return; } const details = category === 'aerodrome' ? `<div class="info-row"><span class="info-label">Nome:</span><span class="info-val">${esc(item.name || '')}</span></div><div class="info-row"><span class="info-label">Localidade:</span><span class="info-val">${esc(item.city || '')}</span></div><div class="info-row"><span class="info-label">Elevação:</span><span class="info-val">${Number.isFinite(item.elevation_ft) ? `${esc(item.elevation_ft)} FT` : 'não informada'}</span></div>${item.aliases?.length ? `<div class="info-row"><span class="info-label">Código alternativo:</span><span class="info-val">${esc(item.aliases.join(', '))}</span></div>` : ''}` : ''; const source = item.source_url ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener">${esc(item.source || 'Consultar fonte')}</a>` : esc(item.source || 'não informada'); panel.innerHTML = `<div class="panel-header fix-header"><h3>${esc(item.id || item.name)}</h3><p class="subtitle">${esc(item.type || category)}</p></div><div class="panel-body"><div class="coords-box"><strong>COORDENADAS DA FONTE</strong><br><span class="mono">${esc(item.lat_dms || '')} ${esc(item.lon_dms || '')}</span><br><span class="mono-small">Decimal: ${esc(item.lat)}, ${esc(item.lon)}</span></div>${details}<div class="source-tag"><strong>Fonte:</strong> ${source}</div></div>`; }
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
function altitudeText(value) { return value?.raw || null; }
function segmentRestriction(segment) {
    return [altitudeText(segment.lowerLimitAltitude), altitudeText(segment.upperLimitAltitude), segment.speedLimitKt ? `${segment.speedLimitKt} KT` : null].filter(Boolean).join(' · ') || 'Sem restrição adicional publicada';
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
function showSegmentDetails(segment, procedure, transition) { const arc = segment.arcCenterFix ? `<div class="info-row"><span class="info-label">Centro/arco RF:</span><span class="info-val">${esc(segment.arcCenterFix)} · ${esc(segment.arcRadiusNm ?? 'N/A')} NM</span></div>` : ''; document.getElementById('details-content').innerHTML = `<div class="panel-header fix-header"><h3>${esc(segment.origin || 'Ponto não publicado')} → ${esc(segment.destination || 'Ponto não publicado')}</h3><p class="subtitle">${esc(procedure.name)} — ${esc(transition.name)}</p></div><div class="panel-body"><div class="info-row"><span class="info-label">Perna:</span><span class="info-val">${esc(segment.pathTerminator || 'N/A')}</span></div><div class="info-row"><span class="info-label">Curso:</span><span class="info-val">${esc(courseText(segment.course))}</span></div><div class="info-row"><span class="info-label">Distância:</span><span class="info-val">${esc(segment.distanceNm ?? 'N/A')} NM</span></div>${arc}<div class="info-row"><span class="info-label">Restrição:</span><span class="info-val">${esc(segmentRestriction(segment))}</span></div><div class="info-row"><span class="info-label">Papel do FIX:</span><span class="info-val">${esc(segment.fixRole || 'N/A')}</span></div><div class="info-row"><span class="info-label">Navegação:</span><span class="info-val">${esc(segment.navigationSpecification || 'N/A')}</span></div><div class="source-tag"><strong>Fonte:</strong> tabela de codificação ${esc(procedure.source.chartCode)}, página ${esc(segment.sourcePage)}</div></div>`; }
function focusProcedure(key) { const item = activeProcedures.get(key); if (item && item.group.getBounds().isValid()) map.fitBounds(item.group.getBounds(), { padding: [45, 45], maxZoom: 10 }); }
function removeProcedure(key) { const item = activeProcedures.get(key); if (item) proceduresGroup.removeLayer(item.group); activeProcedures.delete(key); renderActiveProcedures(); }
function renderActiveProcedures() { const target = document.getElementById('active-procedures'); target.replaceChildren(); if (!activeProcedures.size) { target.innerHTML = '<span class="empty-selection">Nenhum procedimento ativo.</span>'; return; } activeProcedures.forEach((item, key) => { const row = document.createElement('div'); row.className = 'selected-point-row'; row.innerHTML = `<span><strong>${esc(item.procedure.type)} — ${esc(item.procedure.name)}</strong><br><span class="mono-small">${esc(item.transition.name)} · ${esc(item.procedure.source.chartCode || 'OMNI')} · ${esc(item.procedure.source.effectiveDate)}${item.includeMissedApproach && item.procedure.type === 'IAC' ? ' · APCH perdida' : ''}</span></span><button type="button">Remover</button>`; row.querySelector('span').onclick = () => focusProcedure(key); row.querySelector('button').onclick = () => removeProcedure(key); target.appendChild(row); }); }
L.control.layers({ 'Cartografia Escura': darkMatter, 'Mapa Padrão (OSM)': openStreetMap }, { 'Todos os aeródromos (Brasil)': aerodromesGroup, 'Todos os fixos (Brasil)': allFixesGroup, 'Áreas de ensaio em voo': testAreasGroup, 'Vetores de medição': measurementVectorsGroup, 'Auxílios Rádio': navaidsGroup, 'Waypoints selecionados': waypointSelectionsGroup, 'Procedimentos IFR': proceduresGroup, 'Áreas TMA': tmaGroup, 'Simulações de Rota': routesGroup }, { collapsed: false, position: 'topright' }).addTo(map);
