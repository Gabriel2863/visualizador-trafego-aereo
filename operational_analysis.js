/*
 * Laboratório de análise operacional.
 * Módulo isolado: não modifica camadas, procedimentos, waypoints ou o carregamento do mapa.
 * Não utiliza tráfego em tempo real e mantém históricos importados somente na memória do navegador.
 */
(() => {
    const FILES = Object.freeze({
        model: 'data/operational-analysis/default-scenario.json',
        profiles: 'data/operational-analysis/aircraft-profiles.json',
        catalog: 'data/tmas/catalog.json'
    });
    const STORAGE_KEY = 'visualizador-trafego-aereo.operational-analysis.scenarios.v1';
    const jsonCache = new Map();
    const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const format = (value, digits = 0) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
    const normalize = value => String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    const el = id => document.getElementById(id);

    const state = {
        model: null,
        profiles: [],
        catalog: [],
        context: { tma: null, airport: null, procedureIndex: null, procedure: null, transition: null },
        historyRows: [],
        savedScenarios: [],
        currentEvaluation: null,
        lastFocus: null,
        closeTimer: null
    };

    async function fetchJson(file) {
        if (!jsonCache.has(file)) {
            jsonCache.set(file, fetch(file).then(async response => {
                if (!response.ok) throw Error(`${file} indisponível`);
                return response.json();
            }));
        }
        return jsonCache.get(file);
    }

    function selectedProfile(id = el('analysis-aircraft-profile')?.value) {
        return state.profiles.find(profile => profile.id === id) || state.profiles[0] || {
            id: 'GENERIC', label: 'Perfil não informado', cruiseSpeedKt: 430, fuelFactor: 1, minimumSafetyMargin: 60, confidence: 'Baixa', source: 'Não informado'
        };
    }

    function valuesFromForm() {
        const profile = selectedProfile();
        return {
            scenarioName: el('analysis-scenario-name')?.value.trim() || 'Cenário de planejamento',
            origin: normalize(el('analysis-origin')?.value),
            destination: normalize(el('analysis-destination')?.value),
            routeDistanceNm: clamp(number(el('analysis-route-distance')?.value, 180), 1, 5000),
            cruiseSpeedKt: clamp(number(el('analysis-cruise-speed')?.value, profile.cruiseSpeedKt), 90, 700),
            windComponentKt: clamp(number(el('analysis-wind-component')?.value, 0), -150, 150),
            groundDelayMin: clamp(number(el('analysis-ground-delay')?.value, 0), 0, 360),
            sectorLoadPercent: clamp(number(el('analysis-sector-load')?.value, 0), 0, 100),
            weatherComplexity: clamp(number(el('analysis-weather-complexity')?.value, 0), 0, 5),
            passengerLoadPercent: clamp(number(el('analysis-passenger-load')?.value, 0), 0, 100),
            safetyMargin: clamp(number(el('analysis-safety-margin')?.value, 3), 1, 5),
            sectorCapacityLimit: clamp(number(el('analysis-sector-capacity-limit')?.value, 85), 1, 100),
            safetyMinimum: clamp(number(el('analysis-safety-minimum')?.value, profile.minimumSafetyMargin), 1, 100),
            connectionRisk: clamp(number(el('analysis-connection-risk')?.value, 0), 0, 5),
            publicationVerified: Boolean(el('analysis-publication-verified')?.checked),
            weatherProhibited: Boolean(el('analysis-weather-prohibited')?.checked),
            profileId: profile.id,
            weights: {
                time: number(el('analysis-weight-time')?.value, 25),
                fuel: number(el('analysis-weight-fuel')?.value, 25),
                safety: number(el('analysis-weight-safety')?.value, 35),
                flow: number(el('analysis-weight-flow')?.value, 15),
                passenger: number(el('analysis-weight-passenger')?.value, 20)
            }
        };
    }

    function populateForm(defaults = {}) {
        const fallback = state.model?.defaults || {};
        const source = { ...fallback, ...defaults, weights: { ...(fallback.weights || {}), ...(defaults.weights || {}) } };
        const fields = {
            'analysis-scenario-name': source.scenarioName,
            'analysis-origin': source.origin,
            'analysis-destination': source.destination,
            'analysis-route-distance': source.routeDistanceNm,
            'analysis-cruise-speed': source.cruiseSpeedKt,
            'analysis-wind-component': source.windComponentKt,
            'analysis-ground-delay': source.groundDelayMin,
            'analysis-sector-load': source.sectorLoadPercent,
            'analysis-weather-complexity': source.weatherComplexity,
            'analysis-passenger-load': source.passengerLoadPercent,
            'analysis-safety-margin': source.safetyMargin,
            'analysis-sector-capacity-limit': source.sectorCapacityLimit,
            'analysis-safety-minimum': source.safetyMinimum,
            'analysis-connection-risk': source.connectionRisk,
            'analysis-weight-time': source.weights?.time,
            'analysis-weight-fuel': source.weights?.fuel,
            'analysis-weight-safety': source.weights?.safety,
            'analysis-weight-flow': source.weights?.flow,
            'analysis-weight-passenger': source.weights?.passenger
        };
        Object.entries(fields).forEach(([id, value]) => { if (el(id) && value !== undefined) el(id).value = value; });
        if (el('analysis-aircraft-profile') && source.aircraftProfile) el('analysis-aircraft-profile').value = source.aircraftProfile;
        if (el('analysis-publication-verified')) el('analysis-publication-verified').checked = Boolean(source.publicationVerified);
        if (el('analysis-weather-prohibited')) el('analysis-weather-prohibited').checked = Boolean(source.weatherProhibited);
    }

    function updateWeightOutputs() {
        ['time', 'fuel', 'safety', 'flow', 'passenger'].forEach(key => {
            const input = el(`analysis-weight-${key}`);
            const output = input?.closest('label')?.querySelector('output');
            if (input && output) output.textContent = `${input.value}%`;
        });
    }

    function setOptions(target, entries, placeholder, selected = '') {
        if (!target) return;
        target.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${entries.map(entry => `<option value="${escapeHtml(entry.value)}"${entry.value === selected ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`).join('')}`;
        target.disabled = !entries.length;
    }

    async function loadTma(tmaId, preferred = {}) {
        if (!tmaId) {
            setOptions(el('analysis-airport'), [], 'Selecione uma TMA');
            setOptions(el('analysis-procedure-type'), [], 'Selecione um aeródromo');
            setOptions(el('analysis-procedure'), [], 'Selecione um tipo');
            setOptions(el('analysis-transition'), [], 'Selecione um procedimento');
            state.context = { tma: null, airport: null, procedureIndex: null, procedure: null, transition: null };
            updateProcedureContext();
            renderResults();
            return;
        }
        const catalogEntry = state.catalog.find(entry => entry.id === tmaId);
        if (!catalogEntry) return;
        try {
            const tma = await fetchJson(catalogEntry.file);
            const airportIndex = await fetchJson(tma.airportsIndex);
            state.context = { tma: { ...catalogEntry, ...tma }, airport: null, procedureIndex: null, procedure: null, transition: null };
            setOptions(el('analysis-airport'), (airportIndex.airports || []).map(airport => ({ value: airport.icao, label: `${airport.icao} — ${airport.name}` })), 'Selecione um aeródromo', preferred.airport || '');
            setOptions(el('analysis-procedure-type'), [], 'Selecione um aeródromo');
            setOptions(el('analysis-procedure'), [], 'Selecione um tipo');
            setOptions(el('analysis-transition'), [], 'Selecione um procedimento');
            updateProcedureContext();
            if (preferred.airport) await loadAirport(preferred.airport, preferred);
        } catch (error) {
            console.error(error);
            updateProcedureContext(`Não foi possível carregar a TMA: ${error.message}`);
        }
    }

    async function loadAirport(icao, preferred = {}) {
        if (!state.context.tma?.airportsIndex) return;
        const airports = await fetchJson(state.context.tma.airportsIndex);
        const airportEntry = (airports.airports || []).find(item => item.icao === icao);
        if (!airportEntry) return;
        try {
            const [airport, procedureIndex] = await Promise.all([fetchJson(airportEntry.file), fetchJson(airportEntry.proceduresIndex)]);
            state.context = { ...state.context, airport: { ...airportEntry, ...airport }, procedureIndex, procedure: null, transition: null };
            const types = ['SID', 'STAR', 'IAC'].filter(type => (procedureIndex.types?.[type] || []).length).map(type => ({ value: type, label: type }));
            setOptions(el('analysis-procedure-type'), types, 'Selecione um tipo', preferred.type || '');
            setOptions(el('analysis-procedure'), [], 'Selecione um tipo');
            setOptions(el('analysis-transition'), [], 'Selecione um procedimento');
            updateProcedureContext();
            if (preferred.type) await loadProcedureType(preferred.type, preferred);
        } catch (error) {
            console.error(error);
            updateProcedureContext(`Não foi possível carregar o aeródromo: ${error.message}`);
        }
    }

    async function loadProcedureType(type, preferred = {}) {
        const procedures = state.context.procedureIndex?.types?.[type] || [];
        setOptions(el('analysis-procedure'), procedures.map(item => ({ value: item.file, label: item.name })), 'Selecione um procedimento', preferred.procedureFile || '');
        setOptions(el('analysis-transition'), [], 'Selecione um procedimento');
        state.context = { ...state.context, procedure: null, transition: null };
        updateProcedureContext();
        if (preferred.procedureFile) await loadProcedure(preferred.procedureFile, preferred.transitionId);
    }

    async function loadProcedure(file, transitionId = '') {
        if (!file) { state.context = { ...state.context, procedure: null, transition: null }; updateProcedureContext(); renderResults(); return; }
        try {
            const procedure = await fetchJson(file);
            state.context = { ...state.context, procedure, transition: null };
            const transitions = procedure.transitions?.length ? procedure.transitions.map(item => ({ value: item.id, label: item.name || item.id })) : [{ value: '__ALL_LEGS__', label: 'Todos os segmentos disponíveis' }];
            setOptions(el('analysis-transition'), transitions, 'Selecione uma transição', transitionId || transitions[0]?.value || '');
            await setTransition(el('analysis-transition')?.value);
        } catch (error) {
            console.error(error);
            updateProcedureContext(`Não foi possível carregar o procedimento: ${error.message}`);
        }
    }

    function selectedLegs() {
        const procedure = state.context.procedure;
        if (!procedure) return [];
        const transition = state.context.transition;
        if (!transition || transition.id === '__ALL_LEGS__') return procedure.legs || [];
        const legIds = new Set(transition.leg_ids || []);
        return (procedure.legs || []).filter(leg => legIds.has(leg.id));
    }

    async function setTransition(id) {
        const procedure = state.context.procedure;
        if (!procedure) return;
        const transition = id === '__ALL_LEGS__' ? { id, name: 'Todos os segmentos disponíveis', leg_ids: (procedure.legs || []).map(leg => leg.id) } : (procedure.transitions || []).find(item => item.id === id) || null;
        state.context = { ...state.context, transition };
        const legs = selectedLegs();
        const publishedDistance = legs.reduce((sum, leg) => sum + Math.max(0, number(leg.distance_nm)), 0);
        if (publishedDistance > 0) el('analysis-route-distance').value = Math.round(publishedDistance * 10) / 10;
        const type = procedure.procedure?.type;
        const airport = procedure.procedure?.airport || state.context.airport?.icao;
        if (type === 'SID' && !el('analysis-origin').value) el('analysis-origin').value = airport || '';
        if (['STAR', 'IAC'].includes(type) && !el('analysis-destination').value) el('analysis-destination').value = airport || '';
        updateProcedureContext();
        renderResults();
    }

    function updateProcedureContext(errorMessage = '') {
        const target = el('analysis-procedure-context');
        if (!target) return;
        if (errorMessage) { target.textContent = errorMessage; target.classList.add('is-error'); return; }
        target.classList.remove('is-error');
        const procedure = state.context.procedure;
        if (!procedure) { target.textContent = 'Nenhuma rota publicada selecionada. A distância permanece manual.'; return; }
        const legs = selectedLegs();
        const distance = legs.reduce((sum, leg) => sum + Math.max(0, number(leg.distance_nm)), 0);
        const restricted = legs.filter(leg => number(leg.speed_limit_kt) > 0 || leg.lower_limit || leg.upper_limit || leg.altitude?.min || leg.altitude?.max || leg.altitude?.at).length;
        const warningCount = procedure.warnings?.length || 0;
        const source = procedure.procedure?.source || {};
        target.innerHTML = `<strong>${escapeHtml(procedure.procedure?.name || 'Procedimento IFR')}</strong><span>${escapeHtml(state.context.transition?.name || 'Segmentos disponíveis')} · ${format(distance, 1)} NM publicados · ${legs.length} pernas · ${restricted} restrições identificadas${warningCount ? ` · ${warningCount} aviso(s) de dados` : ''}</span><small>Fonte: ${escapeHtml(source.authority || 'Não informada')} · Vigência: ${escapeHtml(source.effective_date || 'não informada')}</small>`;
    }

    function parseLocaleNumber(value) {
        const text = String(value ?? '').trim();
        if (!text) return null;
        const normalized = text.includes(',') && text.includes('.')
            ? (text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replaceAll('.', '').replace(',', '.') : text.replaceAll(',', ''))
            : text.replace(',', '.');
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function splitCsv(text, delimiter) {
        const rows = [], row = [];
        let value = '', quoted = false;
        for (let index = 0; index < text.length; index += 1) {
            const character = text[index], next = text[index + 1];
            if (character === '"' && quoted && next === '"') { value += '"'; index += 1; }
            else if (character === '"') quoted = !quoted;
            else if (character === delimiter && !quoted) { row.push(value); value = ''; }
            else if ((character === '\n' || character === '\r') && !quoted) {
                if (character === '\r' && next === '\n') index += 1;
                row.push(value);
                if (row.some(cell => cell.trim())) rows.push(row.splice(0));
                value = '';
            } else value += character;
        }
        row.push(value);
        if (row.some(cell => cell.trim())) rows.push(row);
        return rows;
    }

    function parseHistoryCsv(text) {
        const clean = String(text || '').replace(/^\uFEFF/, '');
        const headerLine = clean.split(/\r?\n/, 1)[0] || '';
        const delimiter = (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ';' : ',';
        const rows = splitCsv(clean, delimiter);
        if (rows.length < 2) throw Error('o arquivo precisa conter cabeçalho e ao menos uma linha');
        const canonical = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const headers = rows.shift().map(canonical);
        if (!headers.includes('block_minutes')) throw Error('coluna obrigatória ausente: block_minutes');
        const read = (row, name) => row[headers.indexOf(name)] || '';
        const parsed = rows.map((row, index) => ({
            index: index + 2,
            recordedAt: read(row, 'recorded_at'),
            origin: normalize(read(row, 'origin')),
            destination: normalize(read(row, 'destination')),
            procedure: normalize(read(row, 'procedure')),
            aircraftProfile: normalize(read(row, 'aircraft_profile')),
            routeDistanceNm: parseLocaleNumber(read(row, 'route_distance_nm')),
            blockMinutes: parseLocaleNumber(read(row, 'block_minutes')),
            departureDelayMin: parseLocaleNumber(read(row, 'departure_delay_min')),
            sectorLoadPercent: parseLocaleNumber(read(row, 'sector_load_percent')),
            weatherComplexity: parseLocaleNumber(read(row, 'weather_complexity'))
        })).filter(row => Number.isFinite(row.blockMinutes) && row.blockMinutes >= 0);
        if (!parsed.length) throw Error('nenhuma linha possui block_minutes válido');
        return { rows: parsed, ignored: rows.length - parsed.length };
    }

    function matchingHistory(values) {
        const procedureName = normalize(state.context.procedure?.procedure?.name);
        const activeProfile = normalize(values.profileId);
        return state.historyRows.filter(row => {
            const originMatches = !values.origin || !row.origin || row.origin === values.origin;
            const destinationMatches = !values.destination || !row.destination || row.destination === values.destination;
            const procedureMatches = !procedureName || !row.procedure || row.procedure === procedureName;
            const profileMatches = !activeProfile || !row.aircraftProfile || row.aircraftProfile === activeProfile;
            return originMatches && destinationMatches && procedureMatches && profileMatches;
        });
    }

    function historySummary(values, baselineBlock) {
        const rows = matchingHistory(values);
        if (!rows.length) return { count: 0, rows: [], adjustment: 0, averageBlock: null, mae: null, bias: null };
        const averageBlock = rows.reduce((sum, row) => sum + row.blockMinutes, 0) / rows.length;
        const mae = rows.reduce((sum, row) => sum + Math.abs(row.blockMinutes - baselineBlock), 0) / rows.length;
        const bias = averageBlock - baselineBlock;
        return { count: rows.length, rows, adjustment: rows.length >= 3 ? clamp(bias * .5, -30, 30) : 0, averageBlock, mae, bias };
    }

    function calculateCandidates(values) {
        const profile = selectedProfile(values.profileId);
        const groundSpeed = Math.max(90, values.cruiseSpeedKt + values.windComponentKt);
        const candidates = (state.model.alternatives || []).map(alternative => {
            const distanceNm = values.routeDistanceNm * number(alternative.distanceFactor, 1);
            const airborneMin = distanceNm / groundSpeed * 60;
            const blockMin = Math.max(1, airborneMin + values.groundDelayMin + number(alternative.delayAdjustmentMin));
            const sectorLoad = clamp(values.sectorLoadPercent + number(alternative.sectorLoadAdjustment), 0, 100);
            const fuelIndex = distanceNm * number(profile.fuelFactor, 1) * (1 + Math.max(0, -values.windComponentKt) / 500) * (1 + values.passengerLoadPercent / 1000);
            const safety = clamp(100 - sectorLoad * .28 - values.weatherComplexity * 7 + values.safetyMargin * 4 + number(alternative.safetyAdjustment), 0, 100);
            return { ...alternative, distanceNm, airborneMin, blockMin, sectorLoad, fuelIndex, safety, blocks: [] };
        });
        const reference = candidates.find(candidate => candidate.id === 'reference') || candidates[0];
        const history = historySummary(values, reference?.blockMin || 0);
        candidates.forEach(candidate => {
            candidate.blockMin = Math.max(1, candidate.blockMin + history.adjustment);
            candidate.passengerScore = clamp(100 - candidate.blockMin * values.connectionRisk * .6 - candidate.sectorLoad * .1, 0, 100);
        });
        return { candidates, profile, history };
    }

    function safetyGates(values, candidates, profile) {
        const procedure = state.context.procedure;
        const global = [];
        if (values.weatherProhibited) global.push({ level: 'block', text: 'Cenário bloqueado por condição meteorológica ou restrição declarada.' });
        if (procedure && !values.publicationVerified) global.push({ level: 'block', text: 'Publicação e vigência da rota selecionada precisam ser confirmadas.' });
        if (procedure?.procedure?.status && procedure.procedure.status !== 'structured') global.push({ level: 'block', text: 'O procedimento selecionado não possui geometria estruturada suficiente para esta análise.' });
        if (procedure?.warnings?.length) global.push({ level: 'warning', text: `${procedure.warnings.length} aviso(s) de qualidade foram registrados para esta carta; revise antes de usar os resultados.` });
        if (profile.confidence === 'Baixa') global.push({ level: 'warning', text: 'O perfil de performance é didático; substitua-o por fonte validada antes de qualquer uso analítico avançado.' });

        candidates.forEach(candidate => {
            if (candidate.sectorLoad >= values.sectorCapacityLimit) candidate.blocks.push(`Carga estimada de ${format(candidate.sectorLoad)}% atinge o limite de ${format(values.sectorCapacityLimit)}%.`);
            const requiredMargin = Math.max(values.safetyMinimum, number(profile.minimumSafetyMargin, 0));
            if (candidate.safety < requiredMargin) candidate.blocks.push(`Margem simulada de ${format(candidate.safety)} é inferior ao mínimo exigido de ${format(requiredMargin)}.`);
            candidate.eligible = !global.some(gate => gate.level === 'block') && !candidate.blocks.length;
        });
        return global;
    }

    function scoreCandidates(candidates, weights) {
        const eligible = candidates.filter(candidate => candidate.eligible);
        if (!eligible.length) return [];
        const minBlock = Math.min(...eligible.map(candidate => candidate.blockMin));
        const minFuel = Math.min(...eligible.map(candidate => candidate.fuelIndex));
        const totalWeight = Math.max(1, Object.values(weights).reduce((sum, value) => sum + value, 0));
        return eligible.map(candidate => {
            const timeScore = clamp(minBlock / candidate.blockMin * 100, 0, 100);
            const fuelScore = clamp(minFuel / candidate.fuelIndex * 100, 0, 100);
            const flowScore = 100 - candidate.sectorLoad;
            const score = (timeScore * weights.time + fuelScore * weights.fuel + candidate.safety * weights.safety + flowScore * weights.flow + candidate.passengerScore * weights.passenger) / totalWeight;
            return { ...candidate, timeScore, fuelScore, flowScore, score };
        }).sort((left, right) => right.score - left.score);
    }

    function confidenceFor(values, history, profile) {
        const factors = [];
        let score = 25;
        if (state.context.procedure && selectedLegs().length) { score += 25; factors.push('distância derivada de procedimento estruturado'); }
        else factors.push('distância informada manualmente');
        if (history.count >= 3) { score += Math.min(25, 8 + history.count * 2); factors.push(`${history.count} registro(s) histórico(s) compatível(eis)`); }
        else factors.push('histórico compatível insuficiente');
        if (profile.confidence !== 'Baixa') { score += 15; factors.push('perfil de performance com fonte declarada'); }
        else factors.push('perfil de performance didático');
        if (values.publicationVerified && state.context.procedure) { score += 10; factors.push('vigência confirmada pelo usuário'); }
        if (state.context.procedure?.warnings?.length) score -= 10;
        score = clamp(score, 0, 100);
        return { score, label: score >= 75 ? 'Alta' : score >= 50 ? 'Média' : 'Baixa', factors };
    }

    function evaluate(values = valuesFromForm()) {
        const { candidates, profile, history } = calculateCandidates(values);
        const gates = safetyGates(values, candidates, profile);
        const ranked = scoreCandidates(candidates, values.weights);
        const recommended = ranked[0] || null;
        const confidence = confidenceFor(values, history, profile);
        return { values, profile, history, gates, candidates, ranked, recommended, confidence };
    }

    function renderHistoryValidation(evaluation) {
        const target = el('analysis-history-validation'), status = el('analysis-history-status');
        if (!target || !status) return;
        const history = evaluation.history;
        if (!state.historyRows.length) { status.textContent = 'Nenhum histórico carregado. O cenário usa somente as variáveis informadas.'; target.innerHTML = ''; return; }
        if (!history.count) { status.textContent = `${state.historyRows.length} registro(s) carregado(s), mas nenhum coincide com os filtros atuais.`; target.innerHTML = '<span>Altere origem, destino, procedimento ou perfil para validar o cenário com o histórico importado.</span>'; return; }
        status.textContent = `${history.count} registro(s) compatível(eis) usado(s) somente nesta sessão do navegador.`;
        target.innerHTML = `<article><span>Bloco histórico médio</span><strong>${format(history.averageBlock, 1)} min</strong></article><article><span>Erro absoluto médio</span><strong>${format(history.mae, 1)} min</strong></article><article><span>Viés do cenário</span><strong>${history.bias >= 0 ? '+' : ''}${format(history.bias, 1)} min</strong></article>`;
    }

    function renderSafetyGates(evaluation) {
        const target = el('operational-analysis-safety-gates');
        if (!target) return;
        const candidateBlocks = evaluation.candidates.flatMap(candidate => candidate.blocks.map(text => ({ level: 'block', text: `${candidate.label}: ${text}` })));
        const gates = [...evaluation.gates, ...candidateBlocks];
        target.innerHTML = gates.length ? gates.map(gate => `<article class="is-${escapeHtml(gate.level)}"><strong>${gate.level === 'block' ? 'BLOQUEIO' : 'REVISÃO'}</strong><span>${escapeHtml(gate.text)}</span></article>`).join('') : '<article class="is-clear"><strong>SEM BLOQUEIOS</strong><span>As regras informadas não bloquearam as alternativas deste cenário. A análise continua sendo de estudo.</span></article>';
    }

    function renderConfidence(evaluation) {
        const target = el('operational-analysis-confidence');
        if (!target) return;
        target.innerHTML = `<div><span>Confiança do resultado</span><strong>${evaluation.confidence.label} · ${format(evaluation.confidence.score)}%</strong></div><p>${escapeHtml(evaluation.confidence.factors.join(' · '))}</p>`;
    }

    function renderResults() {
        if (!state.model) return;
        updateWeightOutputs();
        const evaluation = evaluate();
        state.currentEvaluation = evaluation;
        const kpis = el('operational-analysis-kpis');
        const recommendation = el('operational-analysis-recommendation');
        const routes = el('operational-analysis-routes');
        if (!kpis || !recommendation || !routes) return;
        renderConfidence(evaluation);
        renderSafetyGates(evaluation);
        renderHistoryValidation(evaluation);
        const displayCandidates = [...evaluation.ranked, ...evaluation.candidates.filter(candidate => !candidate.eligible)];
        const bestBlock = evaluation.ranked.length ? Math.min(...evaluation.ranked.map(candidate => candidate.blockMin)) : null;
        const bestSafety = evaluation.ranked.length ? Math.max(...evaluation.ranked.map(candidate => candidate.safety)) : null;
        const bestPassengerScore = evaluation.ranked.length ? Math.max(...evaluation.ranked.map(candidate => candidate.passengerScore)) : null;
        kpis.innerHTML = [
            ['Melhor tempo estimado', bestBlock === null ? '—' : `${format(bestBlock)} min`, 'Inclui atraso em solo e ajuste histórico, quando disponível'],
            ['Melhor índice relativo', evaluation.recommended ? `${format(evaluation.recommended.score, 1)} / 100` : 'BLOQUEADO', 'Somente alternativas elegíveis recebem índice'],
            ['Maior margem simulada', bestSafety === null ? '—' : `${format(bestSafety)} / 100`, 'Aplicada como restrição mínima, não como troca de segurança'],
            ['Menor impacto em conexões', bestPassengerScore === null ? '—' : `${format(bestPassengerScore)} / 100`, 'Estimativa baseada em tempo, carga e risco de conexão informado']
        ].map(([label, value, detail]) => `<article><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join('');
        if (!evaluation.recommended) recommendation.innerHTML = '<span>Resultado do cenário</span><strong>Cenário sem alternativa elegível</strong><p>Corrija os bloqueios acima ou ajuste as premissas. O sistema não sugere rota quando uma regra de segurança falha.</p>';
        else {
            const baseline = evaluation.ranked.find(candidate => candidate.id === 'reference') || evaluation.recommended;
            const difference = evaluation.recommended.score - baseline.score;
            const comparison = evaluation.recommended.id === baseline.id ? 'A rota de referência apresentou o melhor equilíbrio com os pesos informados.' : `${evaluation.recommended.label} superou a rota de referência por ${format(difference, 1)} ponto(s) no índice relativo.`;
            recommendation.innerHTML = `<span>Resultado do cenário ${escapeHtml(evaluation.values.scenarioName)}</span><strong>${escapeHtml(evaluation.recommended.label)}</strong><p>${comparison} Origem: ${escapeHtml(evaluation.values.origin || '—')} · Destino: ${escapeHtml(evaluation.values.destination || '—')}.</p>`;
        }
        routes.innerHTML = displayCandidates.map((candidate, index) => `<article class="analysis-route-card${candidate.eligible && index === 0 ? ' is-recommended' : ''}${!candidate.eligible ? ' is-blocked' : ''}"><div><span>${!candidate.eligible ? 'BLOQUEADA' : index === 0 ? 'MELHOR EQUILÍBRIO' : 'ALTERNATIVA'}</span><h4>${escapeHtml(candidate.label)}</h4><p>${escapeHtml(candidate.blocks.join(' ') || candidate.description || '')}</p></div><strong>${candidate.eligible ? `${format(candidate.score, 1)}<small>/100</small>` : '—'}</strong><dl><div><dt>Bloco</dt><dd>${format(candidate.blockMin)} min</dd></div><div><dt>Distância</dt><dd>${format(candidate.distanceNm)} NM</dd></div><div><dt>Carga</dt><dd>${format(candidate.sectorLoad)}%</dd></div><div><dt>Margem</dt><dd>${format(candidate.safety)}%</dd></div><div><dt>Passageiros</dt><dd>${format(candidate.passengerScore)}</dd></div></dl></article>`).join('');
        renderSavedScenarios();
    }

    function renderDataSources() {
        const target = el('operational-analysis-data-sources');
        if (!target || !state.model) return;
        target.innerHTML = (state.model.dataSources || []).map(source => `<article><div><strong>${escapeHtml(source.label)}</strong><p>${escapeHtml(source.description)}</p></div><span class="${source.status === 'Disponível na base' ? 'is-available' : ''}">${escapeHtml(source.status)}</span></article>`).join('');
    }

    function scenarioRouteSnapshot() { return { tmaId: el('analysis-tma')?.value || '', airport: el('analysis-airport')?.value || '', type: el('analysis-procedure-type')?.value || '', procedureFile: el('analysis-procedure')?.value || '', transitionId: el('analysis-transition')?.value || '' }; }
    function summaryFromEvaluation(evaluation) { return { recommended: evaluation.recommended?.label || 'Sem alternativa elegível', score: evaluation.recommended?.score ?? null, bestBlockMin: evaluation.recommended?.blockMin ?? null, passengerScore: evaluation.recommended?.passengerScore ?? null, confidence: evaluation.confidence.score, blockers: evaluation.gates.filter(gate => gate.level === 'block').length + evaluation.candidates.filter(candidate => candidate.blocks.length).length }; }

    function loadSavedScenarios() {
        try { const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); state.savedScenarios = Array.isArray(parsed) ? parsed.filter(item => item?.id && item?.values) : []; }
        catch { state.savedScenarios = []; }
    }
    function persistSavedScenarios() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.savedScenarios)); }
    function comparisonEntry(id) { if (id === '__CURRENT__') return { label: valuesFromForm().scenarioName, summary: summaryFromEvaluation(state.currentEvaluation || evaluate()) }; const scenario = state.savedScenarios.find(item => item.id === id); return scenario ? { label: scenario.values.scenarioName, summary: scenario.summary } : null; }

    function renderComparison() {
        const target = el('analysis-scenario-comparison');
        const left = comparisonEntry(el('analysis-compare-left')?.value), right = comparisonEntry(el('analysis-compare-right')?.value);
        if (!target) return;
        if (!left || !right) { target.innerHTML = '<span>Salve ao menos um cenário para compará-lo com o cenário atual.</span>'; return; }
        const metric = (entry, key, suffix = '') => entry.summary[key] === null || entry.summary[key] === undefined ? '—' : `${format(entry.summary[key], key === 'score' || key === 'confidence' ? 1 : 0)}${suffix}`;
        target.innerHTML = `<table><thead><tr><th>Indicador</th><th>${escapeHtml(left.label)}</th><th>${escapeHtml(right.label)}</th></tr></thead><tbody><tr><th>Melhor alternativa</th><td>${escapeHtml(left.summary.recommended)}</td><td>${escapeHtml(right.summary.recommended)}</td></tr><tr><th>Índice relativo</th><td>${metric(left, 'score')}</td><td>${metric(right, 'score')}</td></tr><tr><th>Tempo estimado</th><td>${metric(left, 'bestBlockMin', ' min')}</td><td>${metric(right, 'bestBlockMin', ' min')}</td></tr><tr><th>Impacto em conexões</th><td>${metric(left, 'passengerScore')}</td><td>${metric(right, 'passengerScore')}</td></tr><tr><th>Confiança</th><td>${metric(left, 'confidence', '%')}</td><td>${metric(right, 'confidence', '%')}</td></tr><tr><th>Bloqueios</th><td>${metric(left, 'blockers')}</td><td>${metric(right, 'blockers')}</td></tr></tbody></table>`;
    }

    function renderSavedScenarios() {
        const target = el('analysis-saved-scenarios'), left = el('analysis-compare-left'), right = el('analysis-compare-right');
        if (!target || !left || !right) return;
        target.innerHTML = state.savedScenarios.length ? state.savedScenarios.map(scenario => `<article><div><strong>${escapeHtml(scenario.values.scenarioName)}</strong><span>${new Date(scenario.savedAt).toLocaleString('pt-BR')} · ${escapeHtml(scenario.summary.recommended)}</span></div><div><button type="button" data-analysis-load="${escapeHtml(scenario.id)}">Carregar</button><button type="button" data-analysis-delete="${escapeHtml(scenario.id)}">Remover</button></div></article>`).join('') : '<span>Nenhum cenário salvo neste navegador.</span>';
        target.querySelectorAll('[data-analysis-load]').forEach(button => { button.onclick = () => restoreScenario(button.dataset.analysisLoad); });
        target.querySelectorAll('[data-analysis-delete]').forEach(button => { button.onclick = () => deleteScenario(button.dataset.analysisDelete); });
        const options = [{ id: '__CURRENT__', label: 'Cenário atual' }, ...state.savedScenarios.map(item => ({ id: item.id, label: item.values.scenarioName }))];
        const leftValue = options.some(item => item.id === left.value) ? left.value : '__CURRENT__';
        const rightValue = options.some(item => item.id === right.value) ? right.value : (state.savedScenarios.at(-1)?.id || '__CURRENT__');
        [left, right].forEach((select, index) => { select.innerHTML = options.map(item => `<option value="${escapeHtml(item.id)}"${item.id === (index ? rightValue : leftValue) ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join(''); });
        renderComparison();
    }

    function saveScenario() {
        const evaluation = state.currentEvaluation || evaluate();
        state.savedScenarios = [...state.savedScenarios, { id: `scenario-${Date.now()}-${Math.random().toString(16).slice(2)}`, savedAt: new Date().toISOString(), values: valuesFromForm(), route: scenarioRouteSnapshot(), summary: summaryFromEvaluation(evaluation) }].slice(-20);
        persistSavedScenarios();
        renderSavedScenarios();
    }

    async function restoreScenario(id) {
        const scenario = state.savedScenarios.find(item => item.id === id);
        if (!scenario) return;
        const route = scenario.route || {};
        if (route.tmaId) { el('analysis-tma').value = route.tmaId; await loadTma(route.tmaId, route); }
        populateForm(scenario.values);
        renderResults();
    }

    function deleteScenario(id) { state.savedScenarios = state.savedScenarios.filter(item => item.id !== id); persistSavedScenarios(); renderSavedScenarios(); }

    function downloadHistoryTemplate() {
        const template = 'recorded_at,origin,destination,procedure,aircraft_profile,route_distance_nm,block_minutes,departure_delay_min,sector_load_percent,weather_complexity\n2026-01-15T12:00:00Z,SBGR,SBKP,EXEMPLO,GENERIC_JET_STUDY,180,42,8,65,2\n';
        const url = URL.createObjectURL(new Blob([template], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'modelo-historico-operacional.csv';
        anchor.click();
        URL.revokeObjectURL(url);
    }

    async function importHistory(file) {
        if (!file) return;
        try {
            const parsed = parseHistoryCsv(await file.text());
            state.historyRows = parsed.rows;
            el('analysis-history-clear').disabled = false;
            const ignored = parsed.ignored ? ` ${parsed.ignored} linha(s) inválida(s) foram ignoradas.` : '';
            el('analysis-history-status').textContent = `${parsed.rows.length} registro(s) importado(s) localmente.${ignored}`;
            renderResults();
        } catch (error) {
            console.error(error);
            state.historyRows = [];
            el('analysis-history-clear').disabled = true;
            el('analysis-history-status').textContent = `Não foi possível importar o histórico: ${error.message}.`;
            renderResults();
        }
    }

    function clearHistory() { state.historyRows = []; el('analysis-history-file').value = ''; el('analysis-history-clear').disabled = true; renderResults(); }
    function renderProfiles() { setOptions(el('analysis-aircraft-profile'), state.profiles.map(profile => ({ value: profile.id, label: profile.label })), 'Selecione um perfil', state.model.defaults?.aircraftProfile); }

    function openDrawer() {
        const drawer = el('operational-analysis-drawer'), backdrop = el('operational-analysis-backdrop'), fab = el('operational-analysis-fab'), app = el('app-layout');
        if (!drawer || !backdrop) return;
        clearTimeout(state.closeTimer);
        state.lastFocus = document.activeElement;
        backdrop.hidden = false;
        drawer.removeAttribute('inert');
        drawer.setAttribute('aria-hidden', 'false');
        fab?.setAttribute('aria-expanded', 'true');
        app?.setAttribute('inert', '');
        document.body.classList.add('operational-analysis-open');
        requestAnimationFrame(() => { backdrop.classList.add('is-open'); drawer.classList.add('is-open'); el('analysis-scenario-name')?.focus(); });
    }

    function closeDrawer() {
        const drawer = el('operational-analysis-drawer'), backdrop = el('operational-analysis-backdrop'), fab = el('operational-analysis-fab'), app = el('app-layout');
        if (!drawer || !backdrop || drawer.getAttribute('aria-hidden') === 'true') return;
        drawer.classList.remove('is-open');
        backdrop.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
        drawer.setAttribute('inert', '');
        fab?.setAttribute('aria-expanded', 'false');
        app?.removeAttribute('inert');
        document.body.classList.remove('operational-analysis-open');
        state.closeTimer = setTimeout(() => { backdrop.hidden = true; }, 280);
        if (state.lastFocus instanceof HTMLElement) state.lastFocus.focus();
    }

    function trapFocus(event) {
        const drawer = el('operational-analysis-drawer');
        if (!drawer?.classList.contains('is-open')) return;
        if (event.key === 'Escape') { closeDrawer(); return; }
        if (event.key !== 'Tab') return;
        const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(item => !item.hidden && item.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (!first) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    async function setupOperationalAnalysis() {
        const fab = el('operational-analysis-fab');
        if (!fab) return;
        fab.onclick = openDrawer;
        el('operational-analysis-close').onclick = closeDrawer;
        el('operational-analysis-backdrop').onclick = closeDrawer;
        document.addEventListener('keydown', trapFocus);
        try {
            const [model, profiles, catalog] = await Promise.all([fetchJson(FILES.model), fetchJson(FILES.profiles), fetchJson(FILES.catalog)]);
            state.model = model;
            state.profiles = profiles.profiles || [];
            state.catalog = (catalog.tmas || []).filter(item => !item.technicalGroup).sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
            loadSavedScenarios();
            renderProfiles();
            setOptions(el('analysis-tma'), state.catalog.map(item => ({ value: item.id, label: item.name })), 'Selecione uma TMA');
            populateForm(model.defaults || {});
            el('operational-analysis-title').textContent = model.title || 'Análise operacional';
            el('operational-analysis-subtitle').textContent = model.subtitle || 'Simule cenários antes de comparar rotas.';
            el('operational-analysis-notice').textContent = model.notice || '';
            el('operational-analysis-source-status').textContent = model.sourceStatus || 'MODELO LOCAL';
            document.querySelectorAll('#operational-analysis-drawer input').forEach(input => input.addEventListener('input', renderResults));
            document.querySelectorAll('#operational-analysis-drawer input[type="checkbox"]').forEach(input => input.addEventListener('change', renderResults));
            el('analysis-aircraft-profile').onchange = () => { const profile = selectedProfile(); el('analysis-cruise-speed').value = profile.cruiseSpeedKt; el('analysis-safety-minimum').value = profile.minimumSafetyMargin; renderResults(); };
            el('analysis-tma').onchange = () => loadTma(el('analysis-tma').value);
            el('analysis-airport').onchange = () => loadAirport(el('analysis-airport').value);
            el('analysis-procedure-type').onchange = () => loadProcedureType(el('analysis-procedure-type').value);
            el('analysis-procedure').onchange = () => loadProcedure(el('analysis-procedure').value);
            el('analysis-transition').onchange = () => setTransition(el('analysis-transition').value);
            el('analysis-history-file').onchange = event => importHistory(event.target.files?.[0]);
            el('analysis-history-template').onclick = downloadHistoryTemplate;
            el('analysis-history-clear').onclick = clearHistory;
            el('analysis-save-scenario').onclick = saveScenario;
            el('analysis-compare-left').onchange = renderComparison;
            el('analysis-compare-right').onchange = renderComparison;
            el('operational-analysis-reset').onclick = () => { populateForm(model.defaults || {}); clearHistory(); renderResults(); };
            renderDataSources();
            renderResults();
        } catch (error) {
            console.error(error);
            const drawer = el('operational-analysis-drawer');
            if (drawer) drawer.querySelector('.operational-analysis-body').innerHTML = `<div class="analysis-load-error"><strong>Não foi possível preparar a análise.</strong><span>${escapeHtml(error.message)}</span></div>`;
        }
    }

    setupOperationalAnalysis();
})();
