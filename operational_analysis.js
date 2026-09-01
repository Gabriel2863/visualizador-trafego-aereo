/*
 * Laboratório de análise operacional.
 * Módulo isolado: não altera camadas, procedimentos, waypoints ou carregamento do mapa.
 */
(() => {
    const DATA_FILE = 'data/operational-analysis/default-scenario.json';
    const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const format = (value, digits = 0) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

    let model = null;
    let lastFocus = null;
    let closeTimer = null;

    const el = id => document.getElementById(id);
    const inputs = () => ({
        scenarioName: el('analysis-scenario-name')?.value.trim() || 'Cenário de planejamento',
        origin: el('analysis-origin')?.value.trim().toUpperCase() || '—',
        destination: el('analysis-destination')?.value.trim().toUpperCase() || '—',
        routeDistanceNm: clamp(number(el('analysis-route-distance')?.value, 180), 1, 5000),
        cruiseSpeedKt: clamp(number(el('analysis-cruise-speed')?.value, 430), 90, 700),
        windComponentKt: clamp(number(el('analysis-wind-component')?.value, 0), -150, 150),
        groundDelayMin: clamp(number(el('analysis-ground-delay')?.value, 0), 0, 360),
        sectorLoadPercent: clamp(number(el('analysis-sector-load')?.value, 0), 0, 100),
        weatherComplexity: clamp(number(el('analysis-weather-complexity')?.value, 0), 0, 5),
        passengerLoadPercent: clamp(number(el('analysis-passenger-load')?.value, 0), 0, 100),
        safetyMargin: clamp(number(el('analysis-safety-margin')?.value, 3), 1, 5),
        weights: {
            time: number(el('analysis-weight-time')?.value, 25),
            fuel: number(el('analysis-weight-fuel')?.value, 25),
            safety: number(el('analysis-weight-safety')?.value, 35),
            flow: number(el('analysis-weight-flow')?.value, 15)
        }
    });

    function populateForm(defaults) {
        const fields = {
            'analysis-scenario-name': defaults.scenarioName,
            'analysis-origin': defaults.origin,
            'analysis-destination': defaults.destination,
            'analysis-route-distance': defaults.routeDistanceNm,
            'analysis-cruise-speed': defaults.cruiseSpeedKt,
            'analysis-wind-component': defaults.windComponentKt,
            'analysis-ground-delay': defaults.groundDelayMin,
            'analysis-sector-load': defaults.sectorLoadPercent,
            'analysis-weather-complexity': defaults.weatherComplexity,
            'analysis-passenger-load': defaults.passengerLoadPercent,
            'analysis-safety-margin': defaults.safetyMargin,
            'analysis-weight-time': defaults.weights.time,
            'analysis-weight-fuel': defaults.weights.fuel,
            'analysis-weight-safety': defaults.weights.safety,
            'analysis-weight-flow': defaults.weights.flow
        };
        Object.entries(fields).forEach(([id, value]) => { if (el(id)) el(id).value = value; });
    }

    function updateWeightOutputs() {
        ['time', 'fuel', 'safety', 'flow'].forEach(key => {
            const input = el(`analysis-weight-${key}`);
            const output = input?.closest('label')?.querySelector('output');
            if (input && output) output.textContent = `${input.value}%`;
        });
    }

    function calculateCandidates(values) {
        const groundSpeed = Math.max(90, values.cruiseSpeedKt + values.windComponentKt);
        return (model.alternatives || []).map(alternative => {
            const distanceNm = values.routeDistanceNm * number(alternative.distanceFactor, 1);
            const airborneMin = distanceNm / groundSpeed * 60;
            const blockMin = airborneMin + values.groundDelayMin + number(alternative.delayAdjustmentMin);
            const sectorLoad = clamp(values.sectorLoadPercent + number(alternative.sectorLoadAdjustment), 0, 100);
            const fuelIndex = distanceNm * (1 + Math.max(0, -values.windComponentKt) / 500) * (1 + values.passengerLoadPercent / 1000);
            const safety = clamp(100 - sectorLoad * .28 - values.weatherComplexity * 7 + values.safetyMargin * 4 + number(alternative.safetyAdjustment), 0, 100);
            return { ...alternative, distanceNm, airborneMin, blockMin, sectorLoad, fuelIndex, safety };
        });
    }

    function scoreCandidates(candidates, weights) {
        const minBlock = Math.min(...candidates.map(candidate => candidate.blockMin));
        const minFuel = Math.min(...candidates.map(candidate => candidate.fuelIndex));
        const totalWeight = Math.max(1, Object.values(weights).reduce((sum, value) => sum + value, 0));
        return candidates.map(candidate => {
            const timeScore = clamp(minBlock / candidate.blockMin * 100, 0, 100);
            const fuelScore = clamp(minFuel / candidate.fuelIndex * 100, 0, 100);
            const flowScore = 100 - candidate.sectorLoad;
            const score = (timeScore * weights.time + fuelScore * weights.fuel + candidate.safety * weights.safety + flowScore * weights.flow) / totalWeight;
            return { ...candidate, timeScore, fuelScore, flowScore, score };
        }).sort((left, right) => right.score - left.score);
    }

    function renderResults() {
        if (!model) return;
        const values = inputs();
        updateWeightOutputs();
        const candidates = scoreCandidates(calculateCandidates(values), values.weights);
        const recommended = candidates[0];
        const baseline = candidates.find(candidate => candidate.id === 'reference') || candidates[0];
        const kpis = el('operational-analysis-kpis');
        const recommendation = el('operational-analysis-recommendation');
        const routes = el('operational-analysis-routes');
        if (!recommended || !kpis || !recommendation || !routes) return;

        kpis.innerHTML = [
            ['Melhor tempo estimado', `${format(Math.min(...candidates.map(candidate => candidate.blockMin)))} min`, 'Inclui atraso em solo informado'],
            ['Melhor índice relativo', `${format(recommended.score, 1)} / 100`, 'Peso dos critérios definidos acima'],
            ['Maior margem simulada', `${format(Math.max(...candidates.map(candidate => candidate.safety)))} / 100`, 'Carga, meteo e margem informadas']
        ].map(([label, value, detail]) => `<article><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join('');

        const comparison = recommended.id === baseline.id ? 'A rota de referência apresentou o melhor equilíbrio com os pesos informados.' : `${recommended.label} superou a rota de referência por ${format(recommended.score - baseline.score, 1)} ponto(s) no índice relativo.`;
        recommendation.innerHTML = `<span>Resultado do cenário ${escapeHtml(values.scenarioName)}</span><strong>${escapeHtml(recommended.label)}</strong><p>${comparison} Origem: ${escapeHtml(values.origin)} · Destino: ${escapeHtml(values.destination)}.</p>`;
        routes.innerHTML = candidates.map((candidate, index) => `<article class="analysis-route-card${index === 0 ? ' is-recommended' : ''}">
            <div><span>${index === 0 ? 'MELHOR EQUILÍBRIO' : 'ALTERNATIVA'}</span><h4>${escapeHtml(candidate.label)}</h4><p>${escapeHtml(candidate.description || '')}</p></div>
            <strong>${format(candidate.score, 1)}<small>/100</small></strong>
            <dl><div><dt>Bloco</dt><dd>${format(candidate.blockMin)} min</dd></div><div><dt>Distância</dt><dd>${format(candidate.distanceNm)} NM</dd></div><div><dt>Carga</dt><dd>${format(candidate.sectorLoad)}%</dd></div><div><dt>Margem</dt><dd>${format(candidate.safety)}%</dd></div></dl>
        </article>`).join('');
    }

    function renderDataSources() {
        const target = el('operational-analysis-data-sources');
        if (!target || !model) return;
        target.innerHTML = (model.dataSources || []).map(source => `<article><div><strong>${escapeHtml(source.label)}</strong><p>${escapeHtml(source.description)}</p></div><span class="${source.status === 'Disponível na base' ? 'is-available' : ''}">${escapeHtml(source.status)}</span></article>`).join('');
    }

    function openDrawer() {
        const drawer = el('operational-analysis-drawer'), backdrop = el('operational-analysis-backdrop'), fab = el('operational-analysis-fab');
        if (!drawer || !backdrop) return;
        clearTimeout(closeTimer);
        lastFocus = document.activeElement;
        backdrop.hidden = false;
        drawer.removeAttribute('inert');
        drawer.setAttribute('aria-hidden', 'false');
        fab?.setAttribute('aria-expanded', 'true');
        document.body.classList.add('operational-analysis-open');
        requestAnimationFrame(() => { backdrop.classList.add('is-open'); drawer.classList.add('is-open'); el('analysis-scenario-name')?.focus(); });
    }

    function closeDrawer() {
        const drawer = el('operational-analysis-drawer'), backdrop = el('operational-analysis-backdrop'), fab = el('operational-analysis-fab');
        if (!drawer || !backdrop || drawer.getAttribute('aria-hidden') === 'true') return;
        drawer.classList.remove('is-open');
        backdrop.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
        drawer.setAttribute('inert', '');
        fab?.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('operational-analysis-open');
        closeTimer = setTimeout(() => { backdrop.hidden = true; }, 280);
        if (lastFocus instanceof HTMLElement) lastFocus.focus();
    }

    function trapFocus(event) {
        const drawer = el('operational-analysis-drawer');
        if (!drawer?.classList.contains('is-open')) return;
        if (event.key === 'Escape') { closeDrawer(); return; }
        if (event.key !== 'Tab') return;
        const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(item => !item.hidden && item.getClientRects().length);
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
            const response = await fetch(DATA_FILE);
            if (!response.ok) throw Error('cenário-base indisponível');
            model = await response.json();
            populateForm(model.defaults || {});
            el('operational-analysis-title').textContent = model.title || 'Análise operacional';
            el('operational-analysis-subtitle').textContent = model.subtitle || 'Simule cenários antes de comparar rotas.';
            el('operational-analysis-notice').textContent = model.notice || '';
            el('operational-analysis-source-status').textContent = model.sourceStatus || 'MODELO LOCAL';
            document.querySelectorAll('#operational-analysis-drawer input').forEach(input => input.addEventListener('input', renderResults));
            el('operational-analysis-reset').onclick = () => { populateForm(model.defaults || {}); renderResults(); };
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
