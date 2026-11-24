/* ========================================================================
   ARQUIVO: js/analytics.js
   DESCRIÇÃO: Tela de estatísticas (cálculo local) e tela de IA
   (leitura do acervo, repertório e chat com a biblioteca).
   ======================================================================== */

/* ===================== ABERTURAS ===================== */
/**
 * Renderiza a aba de aberturas. Cada linha combina uma abertura e uma cor,
 * porque o mesmo nome pode render resultados muito diferentes com brancas e
 * com pretas. "Precisão" e "Rating" são médias das partidas analisadas e das
 * que trazem rating no PGN; "—" aparece quando não há dado.
 */
function renderOpeningsView() {
    const identityBox = $('openingsIdentity');
    const tableBox = $('openingsViewTable');
    if (!tableBox) return;
    const identity = Stats.identifyPlayer(State.games, Settings.playerNameList());
    State.openingsIdentity = identity;

    if (identityBox) {
        if (identity.name) {
            identityBox.className = identity.inferred ? 'notice' : 'notice accent';
            identityBox.innerHTML = identity.inferred
                ? `Identifiquei você como <strong>${escapeHtml(identity.name)}</strong>. Se estiver errado, defina seu nome nas Configurações.`
                : `Analisando as partidas de <strong>${escapeHtml(identity.name)}</strong>.`;
            identityBox.classList.remove('hidden');
        } else {
            identityBox.className = 'notice';
            identityBox.innerHTML = 'Ainda não sei qual jogador é você. <button class="link-btn" data-open-settings>Defina seu nome nas Configurações</button> para separar as aberturas por cor.';
            identityBox.classList.remove('hidden');
        }
    }

    const colorFilter = $('openingsColor') ? $('openingsColor').value : '';
    const allRows = identity.name ? Openings.compute(State.games, identity) : [];
    const rows = colorFilter ? allRows.filter(row => row.color === colorFilter) : allRows;
    const countBox = $('openingsCount');
    if (countBox) countBox.textContent = rows.length ? `${rows.length} combinação(ões)` : '';

    if (!identity.name) {
        tableBox.innerHTML = '<p class="chart-empty">Defina seu nome para ver o desempenho por abertura.</p>';
        return;
    }
    if (!rows.length) {
        tableBox.innerHTML = '<p class="chart-empty">Nenhuma abertura reconhecida ainda. Importe partidas com lances válidos.</p>';
        return;
    }

    const body = rows.map(row => {
        const pct = row.pct == null ? '—' : row.pct.toFixed(1).replace('.', ',') + '%';
        const accuracy = row.accuracy == null ? '—' : row.accuracy.toFixed(1).replace('.', ',') + '%';
        const last = row.lastDate
            ? `<button class="link-btn" data-game="${escapeHtml(row.lastGameId)}" title="Abrir ${escapeHtml(row.lastOpponent)}">${formatDate(row.lastDate)}</button>`
            : '—';
        return `<tr>
            <td><span class="eco-badge">${escapeHtml(row.eco)}</span> ${escapeHtml(row.name)}</td>
            <td>${row.color === 'w' ? 'Brancas' : 'Pretas'}</td>
            <td class="num">${row.games}</td>
            <td class="num">${row.win}</td>
            <td class="num">${row.draw}</td>
            <td class="num">${row.loss}</td>
            <td class="num">${pct}</td>
            <td class="num">${accuracy}</td>
            <td class="num">${row.rating == null ? '—' : row.rating}</td>
            <td class="num">${last}</td>
        </tr>`;
    }).join('');

    tableBox.innerHTML = `<table class="mini-table openings-table">
        <thead><tr>
            <th>Abertura</th><th>Cor</th><th class="num">Jogos</th>
            <th class="num">V</th><th class="num">E</th><th class="num">D</th>
            <th class="num">Aproveit.</th><th class="num">Precisão</th>
            <th class="num">Rating</th><th class="num">Último jogo</th>
        </tr></thead>
        <tbody>${body}</tbody>
    </table>`;
}

/* ===================== ESTATÍSTICAS ===================== */
function statCard(label, value, sub) {
    return `<div class="stat-card"><div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value">${escapeHtml(value)}</div>
            <div class="stat-sub">${escapeHtml(sub || '')}</div></div>`;
}

function pctText(value) {
    return value == null ? '—' : value.toFixed(1).replace('.', ',') + '%';
}

function selectedStatsFilters() {
    return {
        source: $('statsSourceFilter').value,
        timeControl: $('statsTimeControlFilter').value,
        period: $('statsPeriodFilter').value,
        dateFrom: $('statsDateFrom').value,
        dateTo: $('statsDateTo').value,
    };
}

function updateStatsDateControls() {
    const custom = $('statsPeriodFilter').value === 'custom';
    const from = $('statsDateFrom');
    const to = $('statsDateTo');
    from.disabled = !custom;
    to.disabled = !custom;
    from.max = to.value || '';
    to.min = from.value || '';
}

function renderStatsView() {
    const names = Settings.playerNameList();
    const identity = Stats.identifyPlayer(State.games, names);
    const filters = selectedStatsFilters();
    const games = Stats.filterGames(State.games, filters);
    const stats = Stats.compute(games, names, { identity, includeRating: false });
    State.stats = stats;
    State.statsFilters = filters;

    const identityBox = $('statsIdentity');
    if (stats.identity.name) {
        identityBox.className = stats.identity.inferred ? 'notice' : 'notice accent';
        identityBox.innerHTML = stats.identity.inferred
            ? `Identifiquei você como <strong>${escapeHtml(stats.identity.name)}</strong> (${stats.identity.games || ''} partidas). Se estiver errado, <button class="link-btn" data-open-settings>corrija seu nome</button>.`
            : `Perfil: <strong>${escapeHtml(stats.identity.name)}</strong>.`;
        identityBox.classList.remove('hidden');
    } else if (stats.total) {
        identityBox.className = 'notice';
        identityBox.innerHTML = `Ainda não sei qual jogador é você. <button class="link-btn" data-open-settings>Defina seu nome nas Configurações</button> para ver aproveitamento por cor e repertório.`;
        identityBox.classList.remove('hidden');
    } else {
        identityBox.classList.add('hidden');
    }

    if (!stats.total) {
        $('statsCards').innerHTML = State.games.length
            ? '<div class="notice accent">Nenhuma partida corresponde aos filtros selecionados.</div>'
            : '<div class="notice accent">Importe partidas para ver as estatísticas.</div>';
        $('openingsTable').innerHTML = '';
        $('colorTable').innerHTML = '';
        $('timeControlTable').innerHTML = '';
        $('phaseChart').innerHTML = '';
        $('precisionPanel').innerHTML = '';
        $('annotationDistribution').innerHTML = '';
        $('phaseAccuracy').innerHTML = '';
        $('brilliantPhase').innerHTML = '';
        $('accuracyChart').innerHTML = '<div class="chart-empty">Sem dados.</div>';
        return;
    }

    const hasIdentity = !!stats.identity.name;
    const accuracyList = [stats.accuracy.w, stats.accuracy.b].filter(value => value != null);
    const avgAccuracy = hasIdentity
        ? pctText(stats.precision.user.accuracy)
        : accuracyList.length
            ? (accuracyList.reduce((sum, value) => sum + value, 0) / accuracyList.length).toFixed(1).replace('.', ',') + '%'
            : '—';

    if (hasIdentity) {
        $('statsCards').innerHTML = [
            statCard('Partidas', String(stats.total), `${stats.resultCounts['1/2-1/2']} empates`),
            statCard('Aproveitamento', pctText(stats.overall.pct), `${stats.overall.win}V · ${stats.overall.draw}E · ${stats.overall.loss}D`),
            statCard('Como brancas', pctText(stats.byColor.w.pct), `${stats.byColor.w.games} partidas`),
            statCard('Como pretas', pctText(stats.byColor.b.pct), `${stats.byColor.b.games} partidas`),
            statCard('Precisão média', avgAccuracy, `${stats.precision.user.games} analisada(s) · SF19 v3`),
            statCard('ACPL médio', stats.precision.user.acpl == null ? '—' : String(stats.precision.user.acpl),
                `${stats.precision.user.acplGames} analisada(s) · SF19 v3`),
        ].join('');
    } else {
        $('statsCards').innerHTML = [
            statCard('Partidas', String(stats.total), `${stats.resultCounts['*']} sem resultado`),
            statCard('Brancas venceram', String(stats.resultCounts['1-0']), 'resultado 1–0'),
            statCard('Empates', String(stats.resultCounts['1/2-1/2']), 'resultado ½–½'),
            statCard('Pretas venceram', String(stats.resultCounts['0-1']), 'resultado 0–1'),
            statCard('Analisadas', String(stats.analyzed), 'SF19 v3'),
            statCard('Precisão média', avgAccuracy, 'Brancas e pretas · SF19 v3'),
        ].join('');
    }

    const openingRows = stats.topOpenings.map(item => {
        if (hasIdentity) {
            return `<tr><td>${escapeHtml(item.name)}${item.eco ? ` <span class="muted small">${escapeHtml(item.eco)}</span>` : ''}</td>
                <td class="num">${item.games}</td><td class="num">${item.win}</td><td class="num">${item.draw}</td>
                <td class="num">${item.loss}</td><td class="num">${pctText(item.winRate)}</td></tr>`;
        }
        return `<tr><td>${escapeHtml(item.name)}${item.eco ? ` <span class="muted small">${escapeHtml(item.eco)}</span>` : ''}</td>
            <td class="num">${item.games}</td><td class="num">${item.resultCounts['1-0'] || 0}</td>
            <td class="num">${item.resultCounts['1/2-1/2'] || 0}</td><td class="num">${item.resultCounts['0-1'] || 0}</td></tr>`;
    }).join('');
    $('openingsTable').innerHTML = `
        <table class="mini-table">
            <thead><tr><th>Abertura</th><th class="num">Jogos</th>${hasIdentity
                ? '<th class="num">V</th><th class="num">E</th><th class="num">D</th><th class="num">Taxa de vitória</th>'
                : '<th class="num">1–0</th><th class="num">½</th><th class="num">0–1</th>'}</tr></thead>
            <tbody>${openingRows || '<tr><td colspan="6" class="muted">Sem dados.</td></tr>'}</tbody>
        </table>`;

    if (hasIdentity) {
        const colorRow = (label, record) => `<tr><td>${label}</td><td class="num">${record.games}</td>
            <td class="num">${record.win}</td><td class="num">${record.draw}</td><td class="num">${record.loss}</td>
            <td class="num">${pctText(record.pct)}</td></tr>`;
        $('colorTable').innerHTML = `<table class="mini-table">
            <thead><tr><th>Cor</th><th class="num">Jogos</th><th class="num">V</th><th class="num">E</th><th class="num">D</th><th class="num">%</th></tr></thead>
            <tbody>${colorRow('Brancas', stats.byColor.w)}${colorRow('Pretas', stats.byColor.b)}</tbody></table>`;
    } else {
        $('colorTable').innerHTML = `<table class="mini-table">
            <thead><tr><th>Resultado</th><th class="num">Partidas</th></tr></thead>
            <tbody>
                <tr><td>Brancas venceram</td><td class="num">${stats.resultCounts['1-0']}</td></tr>
                <tr><td>Empates</td><td class="num">${stats.resultCounts['1/2-1/2']}</td></tr>
                <tr><td>Pretas venceram</td><td class="num">${stats.resultCounts['0-1']}</td></tr>
                <tr><td>Sem resultado</td><td class="num">${stats.resultCounts['*']}</td></tr>
            </tbody></table>`;
    }

    $('timeControlTable').innerHTML = `<table class="mini-table">
        <thead><tr><th>Tipo</th><th class="num">Jogos</th>${hasIdentity ? '<th class="num">%</th>' : ''}</tr></thead>
        <tbody>${stats.timeControls.map(item => `<tr><td>${escapeHtml(item.name)}</td>
            <td class="num">${item.games}</td>${hasIdentity ? `<td class="num">${pctText(item.pct)}</td>` : ''}</tr>`).join('') ||
            '<tr><td colspan="3" class="muted">Sem dados.</td></tr>'}</tbody></table>`;

    const phaseTotal = stats.phases.opening + stats.phases.middlegame + stats.phases.endgame;
    if (!phaseTotal) {
        $('phaseChart').innerHTML = '<p class="muted small">Analise partidas com Stockfish para ver em que fase os erros graves acontecem.</p>';
    } else {
        const maxPhase = Math.max(stats.phases.opening, stats.phases.middlegame, stats.phases.endgame, 1);
        const rows = [
            ['Abertura', stats.phases.opening],
            ['Meio-jogo', stats.phases.middlegame],
            ['Final', stats.phases.endgame],
        ];
        $('phaseChart').innerHTML = rows.map(([label, value]) => `
            <div class="phase-row">
                <div class="phase-top"><span>${label}</span><span>${Math.round(value)}</span></div>
                <div class="phase-bar"><span style="width:${Math.round((value / maxPhase) * 100)}%"></span></div>
            </div>`).join('');
    }

    renderPrecisionPanel(stats);
    renderAnnotationDistribution(stats);
    renderPhaseAccuracy(stats);
    renderBrilliantPhase(stats);
    renderAccuracyChart(stats);
}

/* ---------- precisão, ACPL, anotações e brilhantes ---------- */
function renderPrecisionPanel(stats) {
    const box = $('precisionPanel');
    if (!box) return;
    const precision = stats.precision;
    const legacyNote = stats.excludedAnalyses
        ? `<p class="muted small">${stats.excludedAnalyses} partida(s) sem análise SF19 v3 foram excluídas destas médias.</p>`
        : '';
    if (!precision || !precision.user.games) {
        box.innerHTML = '<p class="muted small">Analise pelo menos uma partida com Stockfish para comparar sua precisão com a dos adversários.</p>' + legacyNote;
        return;
    }
    const card = (label, data) => `<div class="precision-card">
        <span>${label}</span>
        <strong>${pctText(data.accuracy)}</strong>
        <span>ACPL ${data.acpl == null ? '—' : data.acpl} · ${data.acplGames} partida(s)</span>
    </div>`;
    box.innerHTML = `<div class="precision-grid">${card('Você', precision.user)}${card('Adversários', precision.opponent)}</div>` + legacyNote;
}

function renderAnnotationDistribution(stats) {
    const box = $('annotationDistribution');
    if (!box) return;
    const user = stats.annotations.user;
    const opponent = stats.annotations.opponent;
    const total = Engine.ANNOTATION_ORDER.reduce((sum, key) => sum + user[key] + opponent[key], 0);
    if (!total) {
        box.innerHTML = '<p class="muted small">As anotações aparecem depois de analisar partidas com Stockfish.</p>';
        return;
    }
    const rows = Engine.ANNOTATION_ORDER.map(key => {
        const info = Engine.annotationInfo(key);
        return `<tr>
            <td><span class="ann-symbol ann-${key}">${info.symbol}</span> ${info.label}</td>
            <td class="num">${user[key]}</td>
            <td class="num">${opponent[key]}</td>
        </tr>`;
    }).join('');
    box.innerHTML = `<table class="mini-table">
        <thead><tr><th>Anotação</th><th class="num">Você</th><th class="num">Adversário</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
}

function renderPhaseAccuracy(stats) {
    const box = $('phaseAccuracy');
    if (!box) return;
    const phase = stats.precision.phase;
    const rows = [
        ['Abertura', phase.opening],
        ['Meio-jogo', phase.middlegame],
        ['Final', phase.endgame],
    ];
    if (!rows.some(([, data]) => data.user != null || data.opponent != null)) {
        box.innerHTML = '<p class="muted small">Sem precisão por fase. Analise partidas com Stockfish.</p>';
        return;
    }
    box.innerHTML = `<table class="mini-table">
        <thead><tr><th>Fase</th><th class="num">Você</th><th class="num">Adversário</th></tr></thead>
        <tbody>${rows.map(([label, data]) => `<tr>
            <td>${label}</td><td class="num">${pctText(data.user)}</td><td class="num">${pctText(data.opponent)}</td>
        </tr>`).join('')}</tbody></table>`;
}

function renderBrilliantPhase(stats) {
    const box = $('brilliantPhase');
    if (!box) return;
    const phases = stats.brilliantPhases;
    const total = phases.opening.total + phases.middlegame.total + phases.endgame.total;
    if (!total) {
        box.innerHTML = '<p class="muted small">Nenhum lance brilhante detectado ainda. A marcação exige sacrifício correto ou grande virada.</p>';
        return;
    }
    const rows = [
        ['Abertura', phases.opening],
        ['Meio-jogo', phases.middlegame],
        ['Final', phases.endgame],
    ];
    const max = Math.max(...rows.map(([, data]) => data.total), 1);
    box.innerHTML = rows.map(([label, data]) => `
        <div class="phase-row">
            <div class="phase-top"><span>${label}</span><span>${data.total}${data.user ? ` · ${data.user} seu(s)` : ''}</span></div>
            <div class="phase-bar brilliant"><span style="width:${Math.round((data.total / max) * 100)}%"></span></div>
        </div>`).join('');
}

function renderAccuracyChart(stats) {
    const box = $('accuracyChart');
    if (!box) return;
    const series = stats.precision.series || [];
    if (series.length < 2) {
        box.innerHTML = '<div class="chart-empty">São necessárias pelo menos duas partidas analisadas com data para ver a evolução da precisão.</div>';
        return;
    }
    const width = 720;
    const height = 220;
    const padX = 42;
    const padY = 24;
    const x = index => padX + (index / (series.length - 1)) * (width - padX * 2);
    const y = value => padY + ((100 - value) / 100) * (height - padY * 2);
    const points = series.map((point, index) => `${x(index).toFixed(1)},${y(point.accuracy).toFixed(1)}`).join(' ');
    const grid = [0, 25, 50, 75, 100].map(value => {
        const gy = y(value);
        return `<line x1="${padX}" y1="${gy}" x2="${width - padX}" y2="${gy}" stroke="var(--border)" stroke-width="1"/>
                <text x="${padX - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="var(--text-muted)">${value}%</text>`;
    }).join('');
    const dots = series.map((point, index) => `
        <circle cx="${x(index).toFixed(1)}" cy="${y(point.accuracy).toFixed(1)}" r="3.2" fill="var(--accent)" data-game="${escapeHtml(point.gameId)}">
            <title>${escapeHtml(`${formatDate(point.date)} · ${point.accuracy.toFixed(1).replace('.', ',')}% · ${point.opponent}`)}</title>
        </circle>`).join('');
    box.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Precisão ao longo do tempo">
            ${grid}
            <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
            ${dots}
        </svg>
        <p class="muted small">${series.length} partida(s) analisada(s) · de ${formatDate(series[0].date)} a ${formatDate(series[series.length - 1].date)}. Clique em um ponto para abrir a partida.</p>`;
}

/* ===================== IA: LEITURA E REPERTÓRIO ===================== */
function renderInsights() {
    const box = $('insightsBox');
    const meta = $('insightsMeta');
    if (!box) return;
    if (State.insights && State.insights.text) {
        box.innerHTML = renderMarkdown(State.insights.text);
        meta.textContent = aiRecordMeta(State.insights);
    } else {
        box.innerHTML = '<p class="muted small">Gere um diagnóstico das suas partidas, com pontos fortes, pontos fracos e um plano de evolução.</p>';
        meta.textContent = 'Ainda não gerado.';
    }
}

function renderRepertoire() {
    const box = $('repertoireBox');
    const meta = $('repertoireMeta');
    if (!box) return;
    if (State.repertoire && State.repertoire.text) {
        box.innerHTML = renderMarkdown(State.repertoire.text);
        meta.textContent = aiRecordMeta(State.repertoire);
    } else {
        box.innerHTML = '<p class="muted small">Sugestão de repertório baseada nas aberturas que você realmente joga.</p>';
        meta.textContent = 'Ainda não gerado.';
    }
}

/* ---------- leitura local (sem IA) ----------
   Quando o assistente está desligado, sem cota ou sem internet, o aplicativo
   ainda entrega uma leitura útil: os mesmos números alimentam um texto
   determinístico. Isso mantém o site público utilizável sem chave de IA. */
function pctOrDash(value) {
    return value == null ? '—' : value.toFixed(1).replace('.', ',') + '%';
}

function localInsights(brief) {
    const results = brief.resultados || {};
    const wins = results.win || 0;
    const draws = results.draw || 0;
    const losses = results.loss || 0;
    const totalDecided = wins + draws + losses;
    const score = totalDecided ? ((wins + draws / 2) / totalDecided * 100) : null;
    const openings = brief.aberturas_mais_jogadas || [];
    const weakest = brief.aberturas_em_alerta || [];
    const user = brief.precisao && brief.precisao.voce ? brief.precisao.voce : {};
    const opponent = brief.precisao && brief.precisao.adversarios ? brief.precisao.adversarios : {};
    const annotations = brief.anotacoes && brief.anotacoes.voce ? brief.anotacoes.voce : {};
    const phases = brief.precisao && brief.precisao.por_fase ? brief.precisao.por_fase : {};
    const phaseEntries = ['opening', 'middlegame', 'endgame']
        .map(key => ({ key, label: key === 'opening' ? 'abertura' : key === 'middlegame' ? 'meio-jogo' : 'final', value: phases[key] && phases[key].user }))
        .filter(item => item.value != null);
    phaseEntries.sort((a, b) => a.value - b.value);
    const bestOpening = openings.slice().sort((a, b) => (b.aproveitamento || 0) - (a.aproveitamento || 0))[0];
    const mostPlayed = openings[0];

    const lines = [];
    lines.push('## Diagnóstico');
    lines.push(`O acervo tem **${brief.total_de_partidas} partida(s)**, das quais **${brief.partidas_analisadas}** foram analisadas pelo Stockfish. `
        + `O aproveitamento em partidas decididas é de **${pctOrDash(score)}** (${wins}V, ${draws}E, ${losses}D).`);
    if (user.games) {
        lines.push(`Sua precisão média é **${pctOrDash(user.accuracy)}** (ACPL ${user.acpl == null ? '—' : user.acpl}), contra **${pctOrDash(opponent.accuracy)}** dos adversários.`);
    } else {
        lines.push('Ainda não há partidas analisadas suficientes para comparar precisão. Analyze algumas partidas para enriquecer esta leitura.');
    }

    lines.push('');
    lines.push('## Pontos fortes');
    if (bestOpening && bestOpening.aproveitamento != null) {
        lines.push(`- **${bestOpening.abertura}** rende **${pctOrDash(bestOpening.aproveitamento)}** em ${bestOpening.jogos} partida(s).`);
    }
    if (user.games && user.accuracy != null && user.accuracy >= 70) {
        lines.push(`- Precisão média de **${pctOrDash(user.accuracy)}**, um patamar consistente.`);
    }
    if (annotations.excellent && annotations.excellent > 0) {
        lines.push(`- **${annotations.excellent}** lance(s) marcados como excelentes (!) mostram boa escolha de candidatos.`);
    }
    if (brief.brilhantes_por_fase) {
        const brilliants = Object.values(brief.brilhantes_por_fase).reduce((sum, item) => sum + (item.total || 0), 0);
        if (brilliants > 0) lines.push(`- **${brilliants}** lance(s) brilhante(s) (!!) já apareceram no acervo.`);
    }
    if (lines[lines.length - 1] === '## Pontos fortes') lines.push('- Ainda não há dados suficientes para destacar um ponto forte. Importe e analise mais partidas.');

    lines.push('');
    lines.push('## Pontos fracos');
    if (weakest.length) {
        weakest.slice(0, 3).forEach(item => {
            lines.push(`- **${item.abertura}**: ${pctOrDash(item.aproveitamento)} em ${item.jogos} partida(s).`);
        });
    }
    if (annotations.blunder) {
        lines.push(`- **${annotations.blunder}** capivarada(s) (??) e **${annotations.mistake || 0}** erro(s) (?) no seu lado.`);
    }
    if (annotations.missed) {
        lines.push(`- **${annotations.missed}** chance(s) perdida(s) (×): posições ganhas que deixaram de ser ganhas.`);
    }
    if (phaseEntries.length) {
        const worstPhase = phaseEntries[0];
        lines.push(`- A fase com pior precisão é o **${worstPhase.label}** (${pctOrDash(worstPhase.value)}).`);
    }
    if (lines[lines.length - 1] === '## Pontos fracos') lines.push('- Sem dados suficientes para apontar fraquezas específicas.');

    lines.push('');
    lines.push('## Plano de Evolução');
    const focusOpening = weakest[0] ? weakest[0].abertura : (mostPlayed ? mostPlayed.abertura : 'sua abertura principal');
    lines.push('### Semana 1');
    lines.push(`- Revise duas partidas perdidas em **${focusOpening}** e anote a primeira posição em que o plano saiu dos eixos.`);
    lines.push('- Faça 3 exercícios curtos de tática por dia, priorizando lances candidatos antes de capturar.');
    lines.push('### Semana 2');
    lines.push(`- Estude uma linha sólida contra **${focusOpening}** e jogue 4 partidas treinando só essa resposta.`);
    lines.push('- Antes de cada lance, faça a pergunta “o que o adversário ameaça?”.');
    lines.push('### Semana 3');
    lines.push(`- Trabalhe a fase de **${phaseEntries.length ? phaseEntries[0].label : 'meio-jogo'}**: 20 minutos de posições práticas por dia.`);
    lines.push('- Revise suas chances perdidas (×) e escreva o lance que faltou em cada uma.');
    lines.push('### Semana 4');
    lines.push('- Jogue 4 partidas com ritmo mais longo e analise todas com o Stockfish.');
    lines.push('- Compare a precisão e o número de capivaradas com a semana 1.');
    return lines.join('\n');
}

function localRepertoire(stats) {
    const identity = stats.identity || Stats.identifyPlayer(State.games, Settings.playerNameList());
    const rows = window.Openings ? Openings.compute(State.games, identity) : [];
    const byColor = color => rows.filter(row => row.color === color);
    const best = list => list.slice().sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
    const worst = list => list.slice().sort((a, b) => (a.pct || 0) - (b.pct || 0))[0];
    const white = byColor('w');
    const black = byColor('b');
    const whiteBest = best(white);
    const blackBest = best(black);
    const alerts = rows.filter(row => row.pct != null && row.pct < 50).sort((a, b) => a.pct - b.pct).slice(0, 4);
    const lines = [];

    lines.push('## Como brancas');
    if (whiteBest) {
        lines.push(`Mantenha **${whiteBest.name}** (${whiteBest.eco}) como eixo: ${pctOrDash(whiteBest.pct)} em ${whiteBest.games} partida(s). `
            + 'Escolha uma segunda linha apenas para variar o ritmo.');
    } else {
        lines.push('Ainda não há partidas suas com brancas identificadas. Defina seu nome nas Configurações.');
    }

    lines.push('');
    lines.push('## Como pretas');
    if (blackBest) {
        lines.push(`Mantenha **${blackBest.name}** (${blackBest.eco}) como base: ${pctOrDash(blackBest.pct)} em ${blackBest.games} partida(s). `
            + 'Contra 1.e4 e 1.d4, escolha respostas que você já entende, não a mais popular.');
    } else {
        lines.push('Ainda não há partidas suas com pretas identificadas.');
    }

    lines.push('');
    lines.push('## Repertório em Alerta');
    if (alerts.length) {
        alerts.forEach(row => {
            lines.push(`- **${row.name}** (${row.eco}, ${row.color === 'w' ? 'brancas' : 'pretas'}): ${pctOrDash(row.pct)} em ${row.games} partida(s). Reduza a frequência ou ajuste a linha.`);
        });
    } else {
        lines.push('Nenhuma abertura com aproveitamento abaixo de 50% apareceu até agora.');
    }

    lines.push('');
    lines.push('## Rating Médio dos Adversários');
    const rating = stats.opponentRating || {};
    if (rating.games) {
        lines.push(`A média dos adversários é **${rating.average}** em ${rating.games} partida(s) com rating. `
            + 'Em ratings mais altos, evite linhas que dependem de erros simples do adversário.');
    } else {
        lines.push('Os PGNs não trazem rating dos adversários suficiente para calcular uma média.');
    }

    lines.push('');
    lines.push('## Próximos passos');
    lines.push('- Escolha uma abertura principal para cada cor e monte uma página de ideias, não uma árvore infinita.');
    lines.push('- Jogue 4 partidas treinando só essas duas aberturas.');
    lines.push('- Revise com o Stockfish as duas partidas em que a abertura saiu do controle.');
    return lines.join('\n');
}

async function generateInsights() {
    if (!State.games.length) {
        toast('Importe partidas antes de gerar a leitura do acervo.', 'warning');
        return;
    }
    if (State.aiBusy) return;
    const stats = Stats.compute(State.games, Settings.playerNameList());

    // Privacidade primeiro: bloqueio ou recusa do usuário levam à leitura
    // local determinística, sem nenhuma chamada externa.
    let allowed = false;
    if (!AI.isBlocked()) {
        if (!State.ai.online) await checkAI(true);
        allowed = !!State.ai.online && await AI.ensureConsent();
    }

    if (!allowed) {
        const text = localInsights(stats.brief);
        const record = { text, model: 'leitura local', createdAt: Date.now(), source: 'local' };
        State.insights = record;
        await DB.saveMeta('insights', record);
        renderInsights();
        toast(
            AI.isBlocked()
                ? 'Envio de dados à IA desativado. Gerei uma leitura local com os seus números.'
                : 'Sem envio externo autorizado. Gerei uma leitura local com os seus números.',
            'info'
        );
        return;
    }

    State.aiBusy = true;
    setAIBusy(true);
    const box = $('insightsBox');
    const stream = streamTarget(box);
    const controller = new AbortController();
    State.aiController = controller;

    try {
        const response = await AI.request(
            AI.insightsMessages(stats.brief),
            { onToken: stream.push, signal: controller.signal }
        );
        stream.finish();
        const record = { text: response.text, model: (State.ai && State.ai.model) || 'modelo do servidor', createdAt: Date.now(), source: 'ai' };
        State.insights = record;
        await DB.saveMeta('insights', record);
        renderInsights();
        toast('Leitura do acervo salva.', 'success');
    } catch (error) {
        if (error.name === 'AbortError') {
            stream.fail('Geração cancelada.');
            toast('Geração cancelada.', 'info');
        } else {
            // Fallback determinístico: o site continua útil sem IA ou sem cota.
            const text = localInsights(stats.brief);
            const record = { text, model: 'leitura local', createdAt: Date.now(), source: 'local' };
            State.insights = record;
            await DB.saveMeta('insights', record);
            renderInsights();
            toast(AI.describeError(error) + ' Gerei uma leitura local com os seus números.', 'warning');
        }
    } finally {
        State.aiBusy = false;
        State.aiController = null;
        setAIBusy(false);
    }
}

async function generateRepertoire() {
    if (!State.games.length) {
        toast('Importe partidas antes de gerar um repertório.', 'warning');
        return;
    }
    const stats = Stats.compute(State.games, Settings.playerNameList());
    if (!stats.identity.name) {
        toast('Defina seu nome nas Configurações para gerar um repertório por cor.', 'warning');
        return;
    }
    if (State.aiBusy) return;

    let allowed = false;
    if (!AI.isBlocked()) {
        if (!State.ai.online) await checkAI(true);
        allowed = !!State.ai.online && await AI.ensureConsent();
    }

    if (!allowed) {
        const text = localRepertoire(stats);
        const record = { text, model: 'leitura local', createdAt: Date.now(), source: 'local' };
        State.repertoire = record;
        await DB.saveMeta('repertoire', record);
        renderRepertoire();
        toast(
            AI.isBlocked()
                ? 'Envio de dados à IA desativado. Montei um repertório local com os seus resultados.'
                : 'Sem envio externo autorizado. Montei um repertório local com os seus resultados.',
            'info'
        );
        return;
    }

    State.aiBusy = true;
    setAIBusy(true);
    const box = $('repertoireBox');
    const stream = streamTarget(box);
    const controller = new AbortController();
    State.aiController = controller;

    try {
        const response = await AI.request(
            AI.repertoireMessages(stats.brief),
            { onToken: stream.push, signal: controller.signal }
        );
        stream.finish();
        const record = { text: response.text, model: (State.ai && State.ai.model) || 'modelo do servidor', createdAt: Date.now(), source: 'ai' };
        State.repertoire = record;
        await DB.saveMeta('repertoire', record);
        renderRepertoire();
        toast('Repertório sugerido e salvo.', 'success');
    } catch (error) {
        if (error.name === 'AbortError') {
            stream.fail('Geração cancelada.');
            toast('Geração cancelada.', 'info');
        } else {
            const text = localRepertoire(stats);
            const record = { text, model: 'leitura local', createdAt: Date.now(), source: 'local' };
            State.repertoire = record;
            await DB.saveMeta('repertoire', record);
            renderRepertoire();
            toast(AI.describeError(error) + ' Montei um repertório local com os seus resultados.', 'warning');
        }
    } finally {
        State.aiBusy = false;
        State.aiController = null;
        setAIBusy(false);
    }
}

/* ===================== CHAT ===================== */
const CHAT_WELCOME = `
    <div class="chat-msg assistant">
        <p>Pergunte algo sobre as suas partidas. Exemplos:</p>
        <ul>
            <li>Em quais jogos tive problemas no final?</li>
            <li>Qual abertura rende mais pontos para mim?</li>
            <li>Quais erros se repetem nas minhas derrotas?</li>
        </ul>
    </div>`;

function appendChatMessage(role, content) {
    const host = $('chatMessages');
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg ' + role;
    if (role === 'user') {
        const paragraph = document.createElement('p');
        paragraph.textContent = content;
        bubble.appendChild(paragraph);
    } else {
        bubble.innerHTML = renderMarkdown(content);
    }
    host.appendChild(bubble);
    host.scrollTop = host.scrollHeight;
    return bubble;
}

function renderChatSources(chosen) {
    const host = $('chatSources');
    if (!chosen.length) {
        host.innerHTML = '';
        return;
    }
    host.innerHTML = chosen.map((item, index) =>
        `<button class="source-chip" data-game-id="${escapeHtml(item.game.id)}" title="Abrir partida">
            [${index + 1}] ${escapeHtml(item.game.white)} × ${escapeHtml(item.game.black)}
        </button>`).join('');
}

async function sendChat(event) {
    event.preventDefault();
    const input = $('chatInput');
    const question = input.value.trim();
    if (!question || State.aiBusy) return;
    if (!(await requireAI())) return;

    State.aiBusy = true;
    State.aiController = new AbortController();
    $('chatSendBtn').disabled = true;
    $('chatStopBtn').classList.remove('hidden');
    appendChatMessage('user', question);
    input.value = '';

    const stats = Stats.compute(State.games, Settings.playerNameList());
    const summaries = {};
    Object.keys(State.aiSummaries).forEach(id => {
        summaries[id] = State.aiSummaries[id].text || '';
    });
    const chosen = AI.retrieve(question, State.games, summaries, 6);
    const docs = AI.buildDocs(chosen);
    State.chatSources = chosen;
    renderChatSources(chosen);

    const bubble = appendChatMessage('assistant', '');
    bubble.innerHTML = '<p class="spinner-line">Consultando a biblioteca e o assistente…</p>';
    let text = '';

    try {
        const messages = AI.chatMessages(question, docs, stats.brief);
        if (State.chatHistory.length) {
            messages.splice(1, 0, ...State.chatHistory.slice(-6));
        }
        const response = await AI.request(messages, {
            onToken: token => {
                text += token;
                const now = Date.now();
                if (!bubble.dataset.lastPaint || now - Number(bubble.dataset.lastPaint) > 70) {
                    bubble.dataset.lastPaint = String(now);
                    bubble.innerHTML = renderMarkdown(text) + '<span class="stream-cursor"></span>';
                    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
                }
            },
            signal: State.aiController.signal,
        });
        bubble.innerHTML = renderMarkdown(response.text);
        State.chatHistory.push({ role: 'user', content: question });
        State.chatHistory.push({ role: 'assistant', content: response.text });
        State.chatHistory = State.chatHistory.slice(-6);
    } catch (error) {
        const message = error.name === 'AbortError' ? 'Pergunta cancelada.' : AI.describeError(error);
        bubble.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
        toast(message, 'error');
    } finally {
        State.aiBusy = false;
        State.aiController = null;
        $('chatSendBtn').disabled = false;
        $('chatStopBtn').classList.add('hidden');
        $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    }
}

function clearChat() {
    if (State.aiController) State.aiController.abort();
    State.chatHistory = [];
    State.chatSources = [];
    $('chatMessages').innerHTML = CHAT_WELCOME;
    $('chatSources').innerHTML = '';
}

/* ===================== EVENTOS ===================== */
function bindAnalyticsEvents() {
    updateStatsDateControls();
    ['statsSourceFilter', 'statsTimeControlFilter'].forEach(id => {
        $(id).addEventListener('change', renderStatsView);
    });
    $('statsPeriodFilter').addEventListener('change', () => {
        updateStatsDateControls();
        renderStatsView();
    });
    ['statsDateFrom', 'statsDateTo'].forEach(id => {
        $(id).addEventListener('change', () => {
            $('statsPeriodFilter').value = 'custom';
            updateStatsDateControls();
            renderStatsView();
        });
    });
    $('statsToAiBtn').addEventListener('click', () => {
        setView('ai');
        loadAICache();
        toast('Clique em “Gerar” na leitura do acervo.', 'info');
    });
    $('statsIdentity').addEventListener('click', event => {
        if (event.target.closest('[data-open-settings]')) setView('settings');
    });
    $('accuracyChart').addEventListener('click', event => {
        const dot = event.target.closest('[data-game]');
        if (dot) openGame(dot.dataset.game);
    });
    $('openingsColor').addEventListener('change', renderOpeningsView);
    $('openingsViewTable').addEventListener('click', event => {
        const button = event.target.closest('[data-game]');
        if (button) openGame(button.dataset.game);
    });
    $('openingsIdentity').addEventListener('click', event => {
        if (event.target.closest('[data-open-settings]')) setView('settings');
    });

    $('aiRefreshStatus').addEventListener('click', async () => {
        const result = await checkAI(false);
        if (result.online) toast(`Treinador IA conectado a ${aiProviderLabel()}.`, 'success');
        else toast(result.error || 'Treinador IA indisponível.', 'error');
    });
    $('genInsightsBtn').addEventListener('click', generateInsights);
    $('genRepertoireBtn').addEventListener('click', generateRepertoire);
    $('clearChatBtn').addEventListener('click', clearChat);
    $('chatForm').addEventListener('submit', sendChat);
    $('chatStopBtn').addEventListener('click', () => {
        if (State.aiController) State.aiController.abort();
    });
    $('chatSources').addEventListener('click', event => {
        const chip = event.target.closest('[data-game-id]');
        if (chip) openGame(chip.dataset.gameId);
    });
}
