const map = L.map('map', { center: [-15.7801, -47.9292], zoom: 4, minZoom: 3, maxZoom: 15 });
const darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 20 }).addTo(map);
const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' });
const aerodromesGroup = L.layerGroup().addTo(map), navaidsGroup = L.layerGroup().addTo(map), waypointSelectionsGroup = L.layerGroup().addTo(map), proceduresGroup = L.layerGroup().addTo(map), tmaGroup = L.layerGroup().addTo(map), routesGroup = L.layerGroup().addTo(map);
const activeMarkers = {}, selectedWaypointMarkers = new Map();
let aeronauticalData = { aerodromes: [], navaids: [], fixes: [], tmas: [] }, waypointFeatures = [], searchEntries = [], procedures = [], tmaBoundaries = [];
const activeProcedures = new Map();
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const icon = (id, selected = false) => L.divIcon({ className: 'custom-icon fix-icon', html: selected ? `<div class="selected-waypoint-dot"></div><span class="icon-label">${esc(id)}</span>` : `<div class="icon-shape diamond"></div><span class="icon-label-small">${esc(id)}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });

Promise.all([fetch('aeronautical_data.json').then(r => r.ok ? r.json() : Promise.reject(Error('aeronautical_data.json indisponível'))), fetch('data/waypoints.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/waypoints.json indisponível — execute scripts/import-waypoints.py'))), fetch('data/procedures.json').then(r => r.ok ? r.json() : Promise.reject(Error('data/procedures.json indisponível'))), fetch('all_tmas_boundaries.json').then(r => r.ok ? r.json() : Promise.reject(Error('all_tmas_boundaries.json indisponível')))])
    .then(([base, waypoints, procedureData, tmaData]) => { aeronauticalData = base; waypointFeatures = waypoints.features || []; procedures = procedureData.procedures || []; tmaBoundaries = tmaData.features || []; renderBaseData(); buildSearchIndex(); setupSearch(); setupProcedureControls(); console.info(`Base de waypoints carregada: ${waypointFeatures.length} registros.`); })
    .catch(error => { console.error(error); document.getElementById('details-content').innerHTML = `<div class="panel-placeholder"><p>Não foi possível carregar a base: ${esc(error.message)}</p></div>`; });

function renderBaseData() {
    [['aerodromes', 'aerodrome', aerodromesGroup], ['navaids', 'navaid', navaidsGroup]].forEach(([collection, category, group]) => aeronauticalData[collection].forEach(item => {
        if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
        const marker = L.marker([item.lat, item.lon], { icon: icon(item.id) }).bindPopup(`<b>${esc(item.id)}</b><br>Clique para detalhes`).on('click', () => showDetails(item, category)).addTo(group);
        activeMarkers[`${category}:${item.id}`] = marker;
    }));
    tmaBoundaries.forEach(feature => L.geoJSON(feature, { style: { color: '#9c27b0', weight: 2, fillColor: '#9c27b0', fillOpacity: .12 } }).bindPopup(`<b>${esc(feature.properties.name)}</b><br>${esc(feature.properties.lower_limit)} — ${esc(feature.properties.upper_limit)}`).addTo(tmaGroup));
}
function buildSearchIndex() {
    const base = [];
    [['aerodromes', 'aerodrome', 'Aeródromo'], ['navaids', 'navaid', 'Auxílio']].forEach(([collection, category, fallback]) => aeronauticalData[collection].forEach(item => base.push({ key: `${category}:${item.id}`, ident: String(item.id), type: item.type || fallback, lat: item.lat, lon: item.lon, gms: `${item.lat_dms || ''} ${item.lon_dms || ''}`.trim(), item, category })));
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
function showDetails(item, category) { const panel = document.getElementById('details-content'); if (category === 'waypoint') { const p = item.properties, fields = Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<div class="info-row"><span class="info-label">${esc(k)}:</span><span class="info-val">${esc(v)}</span></div>`).join(''); panel.innerHTML = `<div class="panel-header fix-header"><h3>${esc(p.ident)}</h3><p class="subtitle">WAYPOINT — ${esc(p.tipo)}</p></div><div class="panel-body"><div class="coords-box"><strong>COORDENADAS DA FONTE</strong><br><span class="mono">${esc(p.latitude_gms)} ${esc(p.longitude_gms)}</span><br><span class="mono-small">Decimal: ${esc(p.latitude)}, ${esc(p.longitude)}</span></div>${fields}<div class="source-tag"><strong>Fonte:</strong> waypoint.xlsx, linha ${item.sourceRow}</div></div>`; return; } panel.innerHTML = `<div class="panel-header fix-header"><h3>${esc(item.id || item.name)}</h3><p class="subtitle">${esc(item.type || category)}</p></div><div class="panel-body"><div class="coords-box"><strong>COORDENADAS DA FONTE</strong><br><span class="mono">${esc(item.lat_dms || '')} ${esc(item.lon_dms || '')}</span><br><span class="mono-small">Decimal: ${esc(item.lat)}, ${esc(item.lon)}</span></div></div>`; }
function setupProcedureControls() {
    const airport = document.getElementById('procedure-airport'), type = document.getElementById('procedure-type'), procedure = document.getElementById('procedure-select'), transition = document.getElementById('procedure-transition');
    const refreshProcedures = () => { const options = procedures.filter(p => p.airport === airport.value && p.type === type.value); procedure.replaceChildren(...options.map(p => new Option(p.name, p.id))); transition.replaceChildren(); const selected = options.find(p => p.id === procedure.value); if (selected) transition.replaceChildren(...selected.transitions.map(t => new Option(t.name, t.id))); document.getElementById('add-procedure').disabled = !selected; };
    airport.onchange = refreshProcedures; type.onchange = refreshProcedures; procedure.onchange = refreshProcedures;
    document.getElementById('add-procedure').onclick = () => { const p = procedures.find(x => x.id === procedure.value), t = p?.transitions.find(x => x.id === transition.value); if (p && t) addProcedure(p, t); };
    refreshProcedures();
}
function waypointForProcedure(ident) { return waypointFeatures.find(f => f.properties.ident === ident); }
function addProcedure(procedure, transition) {
    const key = `${procedure.id}:${transition.id}`;
    if (activeProcedures.has(key)) return focusProcedure(key);
    const points = transition.sequence.map(waypointForProcedure);
    const missing = transition.sequence.filter((id, index) => !points[index]);
    if (missing.length) return alert(`Procedimento não ativado: waypoint(s) ausente(s): ${missing.join(', ')}`);
    const color = ['#00e5ff', '#ff9800', '#e91e63', '#8bc34a', '#ab47bc'][activeProcedures.size % 5];
    const group = L.featureGroup();
    const coords = points.map(point => [point.properties.latitude, point.properties.longitude]);
    L.polyline(coords, { color, weight: 4, opacity: .9 }).addTo(group);
    points.forEach((point, index) => {
        const ident = point.properties.ident, restriction = transition.pointLabels?.[ident] || 'Sem restrição adicional transcrita';
        L.marker([point.properties.latitude, point.properties.longitude], { icon: icon(ident, true), zIndexOffset: 1200 }).bindTooltip(`${ident} — ${restriction}`, { permanent: true, direction: 'top', offset: [0, -10] }).on('click', () => showProcedurePoint(point, procedure, transition, restriction)).addTo(group);
    });
    group.addTo(proceduresGroup); activeProcedures.set(key, { group, procedure, transition }); renderActiveProcedures(); focusProcedure(key);
}
function showProcedurePoint(feature, procedure, transition, restriction) {
    showDetails(feature, 'waypoint');
    const panel = document.getElementById('details-content');
    panel.insertAdjacentHTML('afterbegin', `<div class="source-tag"><strong>Procedimento:</strong> ${esc(procedure.name)} — ${esc(transition.name)}<br><strong>Restrição publicada:</strong> ${esc(restriction)}<br><strong>Carta:</strong> ${esc(procedure.source.chart)}, p. ${esc(procedure.source.page)}</div>`);
}
function focusProcedure(key) { const item = activeProcedures.get(key); if (item) map.fitBounds(item.group.getBounds(), { padding: [45, 45], maxZoom: 10 }); }
function removeProcedure(key) { const item = activeProcedures.get(key); if (item) proceduresGroup.removeLayer(item.group); activeProcedures.delete(key); renderActiveProcedures(); }
function renderActiveProcedures() { const target = document.getElementById('active-procedures'); target.replaceChildren(); if (!activeProcedures.size) { target.innerHTML = '<span class="empty-selection">Nenhum procedimento ativo.</span>'; return; } activeProcedures.forEach((item, key) => { const row = document.createElement('div'); row.className = 'selected-point-row'; row.innerHTML = `<span><strong>${esc(item.procedure.type)} — ${esc(item.procedure.name)}</strong><br><span class="mono-small">${esc(item.transition.name)} · ${esc(item.procedure.source.chart)}, p. ${esc(item.procedure.source.page)}</span></span><button type="button">Remover</button>`; row.querySelector('span').onclick = () => focusProcedure(key); row.querySelector('button').onclick = () => removeProcedure(key); target.appendChild(row); }); }
L.control.layers({ 'Cartografia Escura': darkMatter, 'Mapa Padrão (OSM)': openStreetMap }, { 'Aeródromos (AIP)': aerodromesGroup, 'Auxílios Rádio': navaidsGroup, 'Waypoints selecionados': waypointSelectionsGroup, 'Procedimentos IFR': proceduresGroup, 'Áreas TMA': tmaGroup, 'Simulações de Rota': routesGroup }, { collapsed: false, position: 'topright' }).addTo(map);
