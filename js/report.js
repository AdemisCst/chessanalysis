/* ========================================================================
   ARQUIVO: js/report.js
   DESCRIÇÃO: Relatório detalhado da partida para impressão / “Salvar como
   PDF”. Sem biblioteca externa: monta um documento HTML próprio e usa o
   diálogo de impressão do navegador.

   Princípios:
   - Nenhum dado é inventado. Campos ausentes aparecem como “—”.
   - A avaliação objetiva vem do Stockfish salvo no IndexedDB.
   - O texto da IA só entra quando existe um resumo salvo.
   - Variantes só são exibidas quando o Stockfish registrou uma linha (PV).
   ======================================================================== */

const Report = (() => {
    const PHASE_LABELS = {
        opening: 'Abertura',
        middlegame: 'Meio-jogo',
        endgame: 'Final',
    };

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }

    function formatDate(iso, fallback) {
        if (!iso) return fallback || '—';
        const parts = String(iso).split('-');
        if (parts.length !== 3) return iso;
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }

    function pct(value, digits) {
        if (value == null || !Number.isFinite(Number(value))) return '—';
        return Number(value).toFixed(digits == null ? 1 : digits).replace('.', ',') + '%';
    }

    function num(value, suffix) {
        if (value == null || !Number.isFinite(Number(value))) return '—';
        return String(Number(value)) + (suffix || '');
    }

    function moveLabel(ply, color) {
        const number = Math.ceil(Number(ply) / 2);
        return `${number}${color === 'w' ? '.' : '…'}`;
    }

    function sideLabel(color) {
        return color === 'w' ? 'Brancas' : 'Pretas';
    }

    function openingLabel(game) {
        if (!game.opening) return game.eco || '—';
        return game.eco ? `${game.eco} · ${game.opening}` : game.opening;
    }

    function annotationInfo(key) {
        if (window.Engine && typeof Engine.annotationInfo === 'function') return Engine.annotationInfo(key);
        return { symbol: '?', label: key || '—' };
    }

    /* ---------- pequeno markdown seguro para o texto da IA ---------- */
    function inlineMarkdown(text) {
        return text
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    function markdown(text) {
        if (!text) return '';
        const lines = esc(text).replace(/\r\n?/g, '\n').split('\n');
        let html = '';
        let list = null;
        const close = () => { if (list) { html += `</${list}>`; list = null; } };
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) { close(); continue; }
            let match = line.match(/^#{1,4}\s+(.*)$/);
            if (match) { close(); html += `<h4>${inlineMarkdown(match[1])}</h4>`; continue; }
            match = line.match(/^[-*•]\s+(.*)$/);
            if (match) {
                if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
                html += `<li>${inlineMarkdown(match[1])}</li>`;
                continue;
            }
            match = line.match(/^\d+[.)]\s+(.*)$/);
            if (match) {
                if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
                html += `<li>${inlineMarkdown(match[1])}</li>`;
                continue;
            }
            close();
            html += `<p>${inlineMarkdown(line)}</p>`;
        }
        close();
        return html;
    }

    /* ---------- avaliação ---------- */
    function winSeries(analysis) {
        if (!analysis || !Array.isArray(analysis.winPctWhite) || analysis.winPctWhite.length < 2) return null;
        return analysis.winPctWhite.map(value => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 50;
        });
    }

    function graphSvg(series) {
        if (!series) return '';
        const width = 760;
        const height = 210;
        const left = 38;
        const right = 14;
        const top = 14;
        const bottom = 26;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const x = index => left + (series.length <= 1 ? 0 : (index / (series.length - 1)) * plotW);
        const y = value => top + ((100 - value) / 100) * plotH;
        const points = series.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
        const area = `${x(0).toFixed(1)},${(top + plotH).toFixed(1)} ${points} ${x(series.length - 1).toFixed(1)},${(top + plotH).toFixed(1)}`;
        const grid = [0, 25, 50, 75, 100].map(value =>
            `<line x1="${left}" y1="${y(value).toFixed(1)}" x2="${width - right}" y2="${y(value).toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>
             <text x="${left - 6}" y="${(y(value) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#667085">${value}%</text>`
        ).join('');
        const last = series.length - 1;
        return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico da probabilidade de vitória das brancas ao longo da partida" class="eval-graph">
            ${grid}
            <polygon points="${area}" fill="rgba(34,197,94,0.13)"/>
            <polyline points="${points}" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
            <text x="${left}" y="${height - 7}" font-size="9" fill="#667085">início</text>
            <text x="${width - right}" y="${height - 7}" text-anchor="end" font-size="9" fill="#667085">final (${last} meias-jogadas)</text>
            <text x="${width - right}" y="${top + 12}" text-anchor="end" font-size="9" fill="#667085">probabilidade de vitória das brancas</text>
        </svg>`;
    }

    function classificationRows(analysis) {
        if (!analysis || !analysis.counts) return '';
        const order = window.Engine && Engine.ANNOTATION_ORDER
            ? Engine.ANNOTATION_ORDER
            : ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'missed', 'blunder'];
        return order.map(key => {
            const info = annotationInfo(key);
            const white = analysis.counts.w ? analysis.counts.w[key] || 0 : 0;
            const black = analysis.counts.b ? analysis.counts.b[key] || 0 : 0;
            return `<tr><td class="sym">${esc(info.symbol)} ${esc(info.label)}</td><td>${white}</td><td>${black}</td></tr>`;
        }).join('');
    }

    function phaseRows(analysis) {
        if (!analysis || !analysis.phaseAccuracy) return '';
        return ['opening', 'middlegame', 'endgame'].map(phase => {
            const item = analysis.phaseAccuracy[phase] || {};
            if (item.w == null && item.b == null) return '';
            return `<tr><td>${esc(PHASE_LABELS[phase])}</td><td>${pct(item.w)}</td><td>${pct(item.b)}</td></tr>`;
        }).join('');
    }

    function moveAnnotationSymbol(annotations, index) {
        const record = annotations[index];
        if (!record || !record.annotation) return '';
        return record.symbol || annotationInfo(record.annotation).symbol;
    }

    function moveListRows(data, analysis) {
        const moves = data && Array.isArray(data.moves) ? data.moves : [];
        const annotations = analysis && Array.isArray(analysis.moves) ? analysis.moves : [];
        const rows = [];
        for (let index = 0; index < moves.length; index += 2) {
            const white = moves[index];
            const black = moves[index + 1];
            const whiteAnnotation = moveAnnotationSymbol(annotations, index);
            const blackAnnotation = black ? moveAnnotationSymbol(annotations, index + 1) : '';
            rows.push(`<tr>
                <td>${Math.floor(index / 2) + 1}. ${esc(white.san)}${whiteAnnotation ? ` <span class="sym">${esc(whiteAnnotation)}</span>` : ''}</td>
                <td>${black ? `${esc(black.san)}${blackAnnotation ? ` <span class="sym">${esc(blackAnnotation)}</span>` : ''}` : ''}</td>
            </tr>`);
        }
        return rows.join('');
    }

    function beforeFen(data, ply) {
        if (!data) return null;
        if (ply <= 1) return data.startFen || null;
        const previous = data.moves && data.moves[ply - 2];
        return previous ? previous.fen : (data.startFen || null);
    }

    /** Converte a linha UCI registrada pelo Stockfish em SAN, sem inventar nada. */
    function pvToSan(fen, pv) {
        if (!fen || !Array.isArray(pv) || !pv.length || typeof Chess !== 'function') return '';
        try {
            const chess = new Chess(fen);
            const parts = [];
            for (const uci of pv.slice(0, 10)) {
                if (!uci || uci.length < 4) break;
                const move = chess.move({
                    from: uci.slice(0, 2),
                    to: uci.slice(2, 4),
                    promotion: uci[4] || undefined,
                });
                if (!move) break;
                parts.push(move.san);
            }
            return parts.join(' ');
        } catch (error) {
            return '';
        }
    }

    function keyMomentRows(analysis, data) {
        if (!analysis || !Array.isArray(analysis.keyMoments) || !analysis.keyMoments.length) return '';
        return analysis.keyMoments.map(moment => {
            const info = annotationInfo(moment.annotation || 'mistake');
            const ply = Number(moment.ply) || 0;
            const loss = moment.loss == null ? '—' : pct(moment.loss);
            const before = moment.before == null ? '—' : pct(moment.before);
            const after = moment.after == null ? '—' : pct(moment.after);
            const explanation = moment.loss == null
                ? 'O Stockfish registrou este lance como crítico.'
                : `Perda de ${loss} em chance de vitória (${before} → ${after}).`;
            const position = analysis.positions && ply > 0 ? analysis.positions[ply - 1] : null;
            const variant = position && position.pv && position.pv.length
                ? pvToSan(beforeFen(data, ply), position.pv)
                : '';
            const cells = [
                esc(moveLabel(ply, moment.color)),
                `<strong>${esc(moment.san)}</strong>`,
                esc(sideLabel(moment.color)),
                `${esc(info.symbol)} ${esc(info.label)}`,
                esc(loss),
                esc(moment.bestSan || '—'),
                `${esc(explanation)}${variant ? `<br><span class="variant">Linha do Stockfish: ${esc(variant)}</span>` : ''}`,
            ];
            return `<tr>${cells.map((content, index) =>
                `<td${index === 3 ? ' class="sym"' : ''}>${content}</td>`
            ).join('')}</tr>`;
        }).join('');
    }

    function hasVariants(analysis) {
        return !!(analysis && Array.isArray(analysis.keyMoments) && analysis.positions
            && analysis.keyMoments.some(moment => {
                const position = analysis.positions[moment.ply - 1];
                return !!(position && position.pv && position.pv.length);
            }));
    }

    function worstPhase(analysis) {
        if (!analysis || !analysis.phaseAccuracy) return null;
        const entries = ['opening', 'middlegame', 'endgame']
            .map(phase => ({ phase, value: analysis.phaseAccuracy[phase] }))
            .filter(item => item.value && (item.value.w != null || item.value.b != null));
        if (!entries.length) return null;
        // Média simples dos lados que têm dados, apenas para orientar a recomendação.
        entries.forEach(item => {
            const values = [item.value.w, item.value.b].filter(value => value != null);
            item.average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 100;
        });
        entries.sort((a, b) => a.average - b.average);
        return entries[0];
    }

    function recommendations(analysis) {
        const items = [];
        if (!analysis) {
            items.push('Analise esta partida com o Stockfish para gerar precisão, ACPL, classificação dos lances e momentos críticos.');
            items.push('Depois da análise, volte a este relatório: todos os números e explicações serão preenchidos a partir dos dados reais.');
            return items;
        }
        const counts = analysis.counts || { w: {}, b: {} };
        const annotationKeys = window.Engine && Engine.ANNOTATION_ORDER
            ? Engine.ANNOTATION_ORDER
            : ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'missed', 'blunder'];
        const total = side => annotationKeys
            .reduce((sum, key) => sum + Number((counts[side] || {})[key] || 0), 0);
        const blunders = Number((counts.w || {}).blunder || 0) + Number((counts.b || {}).blunder || 0);
        const missed = Number((counts.w || {}).missed || 0) + Number((counts.b || {}).missed || 0);
        const mistakes = Number((counts.w || {}).mistake || 0) + Number((counts.b || {}).mistake || 0);
        const phase = worstPhase(analysis);

        if (blunders > 0) {
            items.push(`Revise os ${blunders} erro(s) grosseiro(s) (??) antes de jogar a próxima partida: pare no lance anterior e calcule o lance candidato por 2–3 minutos.`);
        }
        if (missed > 0) {
            items.push(`Treine conversão: houve ${missed} chance(s) perdida(s) (×). Com vantagem, compare o lance jogado com a linha do Stockfish antes de simplificar.`);
        }
        if (mistakes > 0) {
            items.push(`Reveja os ${mistakes} erro(s) (?) e identifique a fase em que eles se concentram; a análise por fase abaixo mostra onde priorizar.`);
        }
        if (phase) {
            items.push(`Priorize o ${PHASE_LABELS[phase.phase].toLowerCase()} nas próximas sessões: é a fase com a menor precisão média neste relatório (${pct(phase.average)}).`);
        }
        if (total('w') + total('b') > 0) {
            items.push('Use as classificações e os momentos críticos como lista de estudo, não como nota: o objetivo é reconhecer o padrão na próxima partida.');
        }
        if (!items.length) {
            items.push('A análise não registrou erros graves nem chances perdidas. Mantenha o método e revise os momentos críticos quando existirem.');
        }
        return items;
    }

    function fichaRows(game, data, analysis) {
        const rows = [
            ['Evento', game.event || '—'],
            ['Local', game.site || '—'],
            ['Rodada', game.round || '—'],
            ['Data', formatDate(game.dateISO, game.headers && game.headers.Date)],
            ['Abertura', openingLabel(game)],
            ['Controle de tempo', game.timeControl || '—'],
            ['Resultado', game.result || '*'],
            ['Rating (brancas / pretas)', [game.whiteElo, game.blackElo].filter(Boolean).join(' / ') || '—'],
            ['Meias-jogadas', data && data.moves ? String(data.moves.length) : (game.plyCount != null ? String(game.plyCount) : '—')],
            ['Análise', analysis
                ? `Stockfish · profundidade ${analysis.depth || '—'} · ${analysis.engine || 'motor local'}`
                : 'não realizada'],
        ];
        return rows.map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`).join('');
    }

    function buildHtml(game, data, analysis, summaryRecord) {
        const series = winSeries(analysis);
        const moves = data && Array.isArray(data.moves) ? data.moves : [];
        const counts = analysis && analysis.counts ? analysis.counts : null;
        const summary = summaryRecord && summaryRecord.text ? summaryRecord.text : '';
        const recommendationsHtml = recommendations(analysis)
            .map(item => `<li>${esc(item)}</li>`).join('');

        const cards = analysis ? `
            <div class="cards">
                <div class="card"><span class="muted">Precisão — brancas</span><strong>${pct(analysis.accuracy && analysis.accuracy.w)}</strong><span class="muted">ACPL ${num(analysis.acpl && analysis.acpl.w)}</span></div>
                <div class="card"><span class="muted">Precisão — pretas</span><strong>${pct(analysis.accuracy && analysis.accuracy.b)}</strong><span class="muted">ACPL ${num(analysis.acpl && analysis.acpl.b)}</span></div>
                <div class="card"><span class="muted">Lances classificados</span><strong>${moves.length}</strong><span class="muted">${series ? 'gráfico de win% abaixo' : 'sem série de avaliação'}</span></div>
            </div>` : '';

        return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Relatório — ${esc(game.white)} × ${esc(game.black)}</title>
<style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #16202e; max-width: 900px; margin: 26px auto; padding: 0 20px; line-height: 1.48; }
    h1 { font-size: 23px; margin: 0 0 4px; }
    h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #d8dee8; padding-bottom: 4px; page-break-after: avoid; }
    h4 { font-size: 13px; margin: 12px 0 4px; }
    p { margin: 5px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td, th { border-bottom: 1px solid #e4e9f1; padding: 6px; text-align: left; vertical-align: top; }
    th { color: #667085; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; }
    .muted { color: #667085; }
    .small { font-size: 11px; }
    .sym { font-weight: 700; white-space: nowrap; }
    .variant { color: #475467; font-size: 10.5px; }
    .cards { display: flex; gap: 10px; margin: 10px 0; }
    .card { flex: 1; border: 1px solid #d8dee8; border-radius: 8px; padding: 10px; page-break-inside: avoid; }
    .card strong { font-size: 21px; display: block; margin: 2px 0; }
    .eval-graph { width: 100%; height: auto; border: 1px solid #e4e9f1; border-radius: 8px; background: #fff; margin-top: 8px; }
    ul, ol { margin: 4px 0 10px 20px; padding: 0; }
    li { margin: 3px 0; }
    .callout { border-left: 3px solid #16a34a; background: #f6fbf7; padding: 9px 12px; margin: 10px 0; page-break-inside: avoid; }
    .toolbar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e4e9f1; padding: 8px 0 10px; margin-bottom: 12px; display: flex; gap: 8px; align-items: center; }
    .toolbar button { font: inherit; padding: 7px 14px; border-radius: 7px; border: 1px solid #16a34a; background: #16a34a; color: #fff; cursor: pointer; }
    .toolbar span { color: #667085; font-size: 11px; }
    .no-break { page-break-inside: avoid; }
    /* Sem quebra forçada: a lista de lances começa logo após a seção
       anterior. O h2 já tem page-break-after: avoid, então o título não
       fica órfão no fim da página nem abre uma página em branco. */
    .moves-section { margin-top: 4px; }
    @media print {
        body { margin: 0; max-width: none; padding: 0; }
        .toolbar { position: static; display: none; }
        /* table-header-group repete o cabeçalho em cada página; table-row-group
           (valor usado antes) transformava o thead num grupo comum e cancelava
           a repetição. */
        thead { display: table-header-group; }
        .card, tr, .callout { page-break-inside: avoid; break-inside: avoid; }
    }
</style>
</head>
<body>
    <div class="toolbar">
        <button onclick="window.print()">Imprimir / Salvar como PDF</button>
        <span>O navegador abre o diálogo de impressão. Nada é enviado a servidores.</span>
    </div>

    <h1>${esc(game.white)} × ${esc(game.black)}</h1>
    <p class="muted">${esc(formatDate(game.dateISO, game.headers && game.headers.Date))} · ${esc(openingLabel(game))} · ${esc(game.result || '*')}</p>
    ${analysis && window.Engine && Engine.isLegacyAnalysis(analysis)
        ? `<p class="small muted">Análise gerada por ${esc(analysis.engine || 'motor anterior')}. O resultado original foi preservado e não foi sobrescrito.</p>`
        : ''}

    <h2>Ficha da partida</h2>
    <table>${fichaRows(game, data, analysis)}</table>

    ${analysis ? `<h2>Visão geral da análise</h2>${cards}
        <p class="small muted">Precisão e ACPL são calculados a partir da perda de probabilidade de vitória e de centipeões. São métricas comparativas, não uma nota absoluta.</p>` : ''}

    ${series ? `<h2>Gráfico de avaliação</h2>${graphSvg(series)}
        <p class="small muted">Cada ponto é uma meia-jogada. A linha do meio representa equilíbrio (50%); acima dela, vantagem das brancas.</p>` : ''}

    ${counts ? `<h2>Classificação dos lances</h2>
        <table><thead><tr><th>Classificação</th><th>Brancas</th><th>Pretas</th></tr></thead>
        <tbody>${classificationRows(analysis)}</tbody></table>
        <p class="small muted">A classificação combina limites de perda e exceções táticas; a ordem visual não é uma escala linear.</p>`
        : '<h2>Classificação dos lances</h2><p class="muted">Partida ainda não analisada pelo Stockfish.</p>'}

    ${analysis && analysis.phaseAccuracy ? `<h2>Precisão por fase</h2>
        <table><thead><tr><th>Fase</th><th>Brancas</th><th>Pretas</th></tr></thead><tbody>${phaseRows(analysis)}</tbody></table>`
        : ''}

    <section class="moves-section">
        <h2>Lista completa de lances</h2>
        ${moves.length ? `<table class="move-list">
            <thead><tr><th>Brancas</th><th>Pretas</th></tr></thead>
            <tbody>${moveListRows(data, analysis)}</tbody>
        </table>` : '<p class="muted">Esta partida não tem lances válidos.</p>'}
    </section>

    ${analysis && analysis.keyMoments && analysis.keyMoments.length ? `<h2>Momentos críticos</h2>
        <table><thead><tr><th>Lance</th><th>Jogada</th><th>Lado</th><th>Classificação</th><th>Perda</th><th>Melhor</th><th>Explicação</th></tr></thead>
        <tbody>${keyMomentRows(analysis, data)}</tbody></table>
        <p class="small muted">“Perda” é a queda em pontos percentuais de chance de vitória para quem jogou. “Melhor” é o lance indicado pelo Stockfish na posição.</p>`
        : '<h2>Momentos críticos</h2><p class="muted">A análise não registrou momentos críticos ou a partida ainda não foi analisada.</p>'}

    ${hasVariants(analysis) ? `<p class="small muted">As linhas exibidas em itálico são a variante calculada pelo Stockfish (PV) convertida para SAN; não são análise humana nem comentário editorial.</p>` : ''}

    ${summary ? `<h2>Resumo do Treinador IA</h2>
        <div class="callout">${markdown(summary)}</div>
        <p class="small muted">Texto gerado por ${esc(summaryRecord.model || 'modelo do servidor')}${summaryRecord.createdAt ? ' em ' + esc(new Date(summaryRecord.createdAt).toLocaleString('pt-BR')) : ''}. Baseado apenas nos dados enviados; não substitui a análise do Stockfish.</p>`
        : '<h2>Resumo do Treinador IA</h2><p class="muted">Nenhum resumo de IA salvo para esta partida. O relatório continua válido com os dados objetivos do Stockfish.</p>'}

    <h2>Recomendações de estudo</h2>
    <ul>${recommendationsHtml}</ul>
    <p class="small muted">Recomendações derivadas dos números desta análise. Nenhum lance ou avaliação foi inventado.</p>

    <hr>
    <p class="muted small">Relatório gerado por Chess-Analysis em ${esc(new Date().toLocaleString('pt-BR'))}. Dados locais deste navegador.</p>
</body>
</html>`;
    }

    function open(game, data, analysis, summaryRecord) {
        if (!game) return false;
        const html = buildHtml(game, data, analysis, summaryRecord);
        const win = window.open('', '_blank');
        if (!win) return false;
        win.document.open();
        win.document.write(html);
        win.document.close();
        win.focus();
        // Dá tempo de o navegador montar o SVG antes de abrir a impressão.
        setTimeout(() => {
            try { win.print(); } catch (error) { /* o usuário pode usar o botão do documento */ }
        }, 600);
        return true;
    }

    return {
        open,
        buildHtml,
        _internal: { esc, graphSvg, winSeries, recommendations, pvToSan },
    };
})();

window.Report = Report;
