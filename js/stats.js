/* ========================================================================
   ARQUIVO: js/stats.js
   DESCRIÇÃO: Cálculo local de estatísticas do acervo: resultados por cor,
   aberturas, controle de tempo, rating, precisão e fase dos erros.
   Nenhuma IA participa destes números: eles alimentam a IA, e não o contrário.
   ======================================================================== */

const Stats = (() => {
    const PLACEHOLDERS = ['?', 'brancas', 'pretas', 'white', 'black', 'unknown', 'desconhecido'];

    function normalize(text) {
        return String(text || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function nameTokens(name) {
        return normalize(name).split(/[^a-z0-9]+/).filter(token => token.length > 2);
    }

    function namesMatch(a, b) {
        const na = normalize(a);
        const nb = normalize(b);
        if (!na || !nb) return false;
        if (na === nb || na.includes(nb) || nb.includes(na)) return true;
        const ta = nameTokens(a);
        const tb = nameTokens(b);
        if (!ta.length || !tb.length) return false;
        const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
        return shorter.every(token => longer.includes(token));
    }

    function inferPlayer(games) {
        const counts = new Map();
        const display = new Map();
        games.forEach(game => {
            [game.white, game.black].forEach(name => {
                const key = normalize(name);
                if (!key || key.length < 4 || PLACEHOLDERS.includes(key)) return;
                counts.set(key, (counts.get(key) || 0) + 1);
                if (!display.has(key)) display.set(key, name);
            });
        });
        let bestKey = null;
        let bestCount = 0;
        counts.forEach((count, key) => {
            if (count > bestCount) { bestCount = count; bestKey = key; }
        });
        if (!bestKey) return null;
        if (bestCount < 2 || bestCount < games.length * 0.2) return null;
        return { key: bestKey, name: display.get(bestKey), games: bestCount };
    }

    function identifyPlayer(games, configuredNames) {
        const names = (configuredNames || []).filter(Boolean);
        if (names.length) {
            const first = names[0];
            return { name: first, names, inferred: false };
        }
        const inferred = inferPlayer(games);
        return inferred
            ? { name: inferred.name, names: [inferred.name], inferred: true, games: inferred.games }
            : { name: null, names: [], inferred: false };
    }

    function userColor(game, identity) {
        if (!identity || !identity.names.length) return null;
        for (const name of identity.names) {
            if (namesMatch(game.white, name)) return 'w';
            if (namesMatch(game.black, name)) return 'b';
        }
        return null;
    }

    function outcome(result, color) {
        if (!color || !result) return null;
        if (result === '1/2-1/2') return 'draw';
        if (result === '1-0') return color === 'w' ? 'win' : 'loss';
        if (result === '0-1') return color === 'b' ? 'win' : 'loss';
        return null;
    }

    function blankRecord() {
        return { games: 0, win: 0, draw: 0, loss: 0, score: 0, pct: null };
    }

    /** Contadores das classificações, separados por lado (você × adversário). */
    function blankAnnotations() {
        const record = {};
        const keys = window.Engine && Array.isArray(window.Engine.ANNOTATION_ORDER)
            ? window.Engine.ANNOTATION_ORDER
            : ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'missed', 'blunder'];
        keys
            .forEach(key => { record[key] = 0; });
        return record;
    }

    function addAnnotations(target, source) {
        if (!source) return;
        Object.keys(target).forEach(key => {
            target[key] += Number(source[key]) || 0;
        });
    }

    function addOutcome(record, result) {
        record.games++;
        if (!result) return;
        record[result]++;
        if (result === 'win') record.score += 1;
        if (result === 'draw') record.score += 0.5;
        const decided = record.win + record.draw + record.loss;
        record.pct = decided ? Math.round((record.score / decided) * 1000) / 10 : null;
    }

    function timeControlCategory(game) {
        const raw = String(game.timeControl || '');
        const event = String(game.event || '');
        const combined = (raw + ' ' + event).toLowerCase();
        let seconds = null;
        const plus = raw.match(/^(\d+)\s*\+/);
        if (plus) seconds = Number(plus[1]);
        else if (/^\d+$/.test(raw.trim())) seconds = Number(raw.trim());
        if (seconds != null) {
            if (seconds < 180) return 'Bullet';
            if (seconds < 600) return 'Blitz';
            if (seconds < 1800) return 'Rápido';
            return 'Clássico';
        }
        if (combined.includes('bullet')) return 'Bullet';
        if (combined.includes('blitz')) return 'Blitz';
        if (combined.includes('rapid') || combined.includes('rápid')) return 'Rápido';
        if (combined.includes('classical') || combined.includes('clássic')) return 'Clássico';
        if (combined.includes('correspondence') || combined.includes('correspond')) return 'Correspondência';
        return 'Não informado';
    }

    function filterGames(games, filters, now) {
        const selected = filters || {};
        const source = selected.source || 'all';
        const timeControl = selected.timeControl || 'all';
        let from = '';
        let to = '';

        if (selected.period === 'custom') {
            from = selected.dateFrom || '';
            to = selected.dateTo || '';
        } else {
            const daysByPeriod = { '30d': 30, '90d': 90, '365d': 365 };
            const days = daysByPeriod[selected.period];
            if (days) {
                const current = now ? new Date(now) : new Date();
                if (!Number.isNaN(current.getTime())) {
                    const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
                    const start = new Date(today);
                    start.setDate(start.getDate() - days + 1);
                    const isoDate = date => [
                        date.getFullYear(),
                        String(date.getMonth() + 1).padStart(2, '0'),
                        String(date.getDate()).padStart(2, '0'),
                    ].join('-');
                    from = isoDate(start);
                    to = isoDate(today);
                }
            }
        }

        if (from && to && from > to) return [];
        return (games || []).filter(game => {
            const gameSource = game.source || 'manual';
            if (source === 'manual') {
                if (gameSource !== 'manual') return false;
            } else if (source !== 'all' && gameSource !== source) {
                return false;
            }
            if (timeControl !== 'all' && timeControlCategory(game) !== timeControl) return false;
            if ((from || to) && (!game.dateISO || (from && game.dateISO < from) || (to && game.dateISO > to))) {
                return false;
            }
            return true;
        });
    }

    function hasValidAnalysis(game, summary) {
        const engine = window.Engine;
        if (!summary || !engine || !engine.BUILD_ID || summary.scoreSource !== 'wdl') return false;
        if (summary.version != null && Number(summary.version) !== 3) return false;
        const build = summary.engineBuild
            || game.analyzedBuild
            || (typeof engine.buildOf === 'function' ? engine.buildOf(summary) : '');
        return build === engine.BUILD_ID;
    }

    function compute(games, configuredNames, options) {
        const opts = options || {};
        const identity = opts.identity || identifyPlayer(games, configuredNames);
        const includeRating = opts.includeRating !== false;
        const resultCounts = { '1-0': 0, '0-1': 0, '1/2-1/2': 0, '*': 0 };
        const overall = blankRecord();
        const byColor = { w: blankRecord(), b: blankRecord() };
        const openings = new Map();
        const timeControls = new Map();
        const years = includeRating ? new Map() : null;
        const eloSeries = [];
        const phases = { opening: 0, middlegame: 0, endgame: 0 };
        const phaseResults = {
            opening: { games: 0, win: 0, draw: 0, loss: 0 },
            middlegame: { games: 0, win: 0, draw: 0, loss: 0 },
            endgame: { games: 0, win: 0, draw: 0, loss: 0 },
        };
        const accuracy = { w: [], b: [] };
        const annotations = { user: blankAnnotations(), opponent: blankAnnotations() };
        const precision = {
            userAccuracy: [],
            opponentAccuracy: [],
            userAcpl: [],
            opponentAcpl: [],
            series: [],
            phase: {
                opening: { user: [], opponent: [] },
                middlegame: { user: [], opponent: [] },
                endgame: { user: [], opponent: [] },
            },
        };
        const phaseBrilliants = { opening: 0, middlegame: 0, endgame: 0 };
        const phaseBrilliantsUser = { opening: 0, middlegame: 0, endgame: 0 };
        const opponentElos = [];
        let analyzed = 0;
        let excludedAnalyses = 0;

        games.forEach(game => {
            resultCounts[game.result] = (resultCounts[game.result] || 0) + 1;
            const color = userColor(game, identity);
            const result = outcome(game.result, color);
            if (color) addOutcome(byColor[color], result);
            addOutcome(overall, result);

            const openingKey = `${game.eco || ''}|${game.opening || 'Sem classificação'}`;
            if (!openings.has(openingKey)) {
                openings.set(openingKey, {
                    name: game.opening || 'Sem classificação',
                    eco: game.eco || '',
                    record: blankRecord(),
                    resultCounts: { '1-0': 0, '0-1': 0, '1/2-1/2': 0 },
                });
            }
            const opening = openings.get(openingKey);
            addOutcome(opening.record, result);
            opening.resultCounts[game.result] = (opening.resultCounts[game.result] || 0) + 1;

            const tc = timeControlCategory(game);
            if (!timeControls.has(tc)) timeControls.set(tc, blankRecord());
            addOutcome(timeControls.get(tc), result);

            if (includeRating && game.year) {
                if (!years.has(game.year)) years.set(game.year, { year: game.year, record: blankRecord(), eloSum: 0, eloCount: 0 });
                const entry = years.get(game.year);
                addOutcome(entry.record, result);
                const elo = color === 'w' ? game.whiteElo : color === 'b' ? game.blackElo : null;
                if (elo) { entry.eloSum += elo; entry.eloCount++; }
            }

            if (includeRating && color) {
                const elo = color === 'w' ? game.whiteElo : game.blackElo;
                if (elo && (game.dateISO || game.year)) {
                    eloSeries.push({
                        date: game.dateISO || `${game.year}-01-01`,
                        elo,
                        gameId: game.id,
                        opponent: color === 'w' ? game.black : game.white,
                        result: game.result,
                        color,
                    });
                }
                const opponentElo = color === 'w' ? game.blackElo : game.whiteElo;
                if (opponentElo) opponentElos.push(opponentElo);
            }

            if (game.analysisSummary) {
                const summary = game.analysisSummary;
                if (!hasValidAnalysis(game, summary)) {
                    excludedAnalyses++;
                } else {
                    analyzed++;
                    if (summary.phaseBlunders) {
                        phases.opening += summary.phaseBlunders.opening || 0;
                        phases.middlegame += summary.phaseBlunders.middlegame || 0;
                        phases.endgame += summary.phaseBlunders.endgame || 0;
                    }
                    if (result && summary.phaseAccuracy) {
                        ['opening', 'middlegame', 'endgame'].forEach(phase => {
                            const phaseAccuracy = summary.phaseAccuracy[phase];
                            if (!phaseAccuracy || (phaseAccuracy.w == null && phaseAccuracy.b == null)) return;
                            phaseResults[phase].games++;
                            phaseResults[phase][result]++;
                        });
                    }
                    if (summary.accuracyW != null) accuracy.w.push(summary.accuracyW);
                    if (summary.accuracyB != null) accuracy.b.push(summary.accuracyB);

                    // Precisão e ACPL do dono do acervo contra os adversários.
                    if (color) {
                        const opponent = color === 'w' ? 'b' : 'w';
                        const userAccuracy = color === 'w' ? summary.accuracyW : summary.accuracyB;
                        const oppAccuracy = color === 'w' ? summary.accuracyB : summary.accuracyW;
                        const userAcpl = color === 'w' ? summary.acplW : summary.acplB;
                        const oppAcpl = color === 'w' ? summary.acplB : summary.acplW;
                        if (userAccuracy != null) precision.userAccuracy.push(userAccuracy);
                        if (oppAccuracy != null) precision.opponentAccuracy.push(oppAccuracy);
                        if (userAcpl != null) precision.userAcpl.push(userAcpl);
                        if (oppAcpl != null) precision.opponentAcpl.push(oppAcpl);

                        if (summary.phaseAccuracy) {
                            ['opening', 'middlegame', 'endgame'].forEach(phase => {
                                const entry = summary.phaseAccuracy[phase];
                                if (!entry) return;
                                if (entry[color] != null) precision.phase[phase].user.push(entry[color]);
                                if (entry[opponent] != null) precision.phase[phase].opponent.push(entry[opponent]);
                            });
                        }

                        if (summary.phaseBrilliantsByColor) {
                            const own = summary.phaseBrilliantsByColor[color] || {};
                            ['opening', 'middlegame', 'endgame'].forEach(phase => {
                                phaseBrilliantsUser[phase] += Number(own[phase]) || 0;
                            });
                        }
                        if (summary.phaseBrilliants) {
                            ['opening', 'middlegame', 'endgame'].forEach(phase => {
                                phaseBrilliants[phase] += Number(summary.phaseBrilliants[phase]) || 0;
                            });
                        }
                        if (summary.counts) {
                            addAnnotations(annotations.user, summary.counts[color]);
                            addAnnotations(annotations.opponent, summary.counts[opponent]);
                        }
                        if (userAccuracy != null && (game.dateISO || game.year)) {
                            precision.series.push({
                                date: game.dateISO || `${game.year}-01-01`,
                                accuracy: userAccuracy,
                                gameId: game.id,
                                opponent: color === 'w' ? game.black : game.white,
                                result: game.result,
                                color,
                            });
                        }
                    }
                }
            }
        });

        overall.decided = overall.win + overall.draw + overall.loss;
        byColor.w.decided = byColor.w.win + byColor.w.draw + byColor.w.loss;
        byColor.b.decided = byColor.b.win + byColor.b.draw + byColor.b.loss;

        const openingList = Array.from(openings.values())
            .map(item => ({
                name: item.name,
                eco: item.eco,
                games: item.record.games,
                win: item.record.win,
                draw: item.record.draw,
                loss: item.record.loss,
                pct: item.record.pct,
                winRate: item.record.win + item.record.draw + item.record.loss
                    ? Math.round((item.record.win / (item.record.win + item.record.draw + item.record.loss)) * 1000) / 10
                    : null,
                resultCounts: item.resultCounts,
                decided: item.record.win + item.record.draw + item.record.loss,
            }))
            .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));

        const timeControlList = Array.from(timeControls.entries()).map(([name, record]) => ({
            name,
            games: record.games,
            win: record.win,
            draw: record.draw,
            loss: record.loss,
            pct: record.pct,
        })).sort((a, b) => b.games - a.games);

        const yearList = includeRating ? Array.from(years.values()).map(entry => ({
            year: entry.year,
            games: entry.record.games,
            win: entry.record.win,
            draw: entry.record.draw,
            loss: entry.record.loss,
            pct: entry.record.pct,
            avgElo: entry.eloCount ? Math.round(entry.eloSum / entry.eloCount) : null,
        })).sort((a, b) => a.year - b.year) : null;

        if (includeRating) eloSeries.sort((a, b) => a.date.localeCompare(b.date));

        function avg(list) {
            if (!list.length) return null;
            return Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 10) / 10;
        }

        function avgInt(list) {
            if (!list.length) return null;
            return Math.round(list.reduce((sum, value) => sum + value, 0) / list.length);
        }

        precision.series.sort((a, b) => a.date.localeCompare(b.date));
        const precisionResult = {
            user: {
                accuracy: avg(precision.userAccuracy),
                acpl: avgInt(precision.userAcpl),
                games: precision.userAccuracy.length,
                acplGames: precision.userAcpl.length,
            },
            opponent: {
                accuracy: avg(precision.opponentAccuracy),
                acpl: avgInt(precision.opponentAcpl),
                games: precision.opponentAccuracy.length,
                acplGames: precision.opponentAcpl.length,
            },
            phase: {
                opening: { user: avg(precision.phase.opening.user), opponent: avg(precision.phase.opening.opponent) },
                middlegame: { user: avg(precision.phase.middlegame.user), opponent: avg(precision.phase.middlegame.opponent) },
                endgame: { user: avg(precision.phase.endgame.user), opponent: avg(precision.phase.endgame.opponent) },
            },
            series: precision.series,
        };

        const brilliantPhases = {};
        ['opening', 'middlegame', 'endgame'].forEach(phase => {
            brilliantPhases[phase] = {
                total: phaseBrilliants[phase],
                user: phaseBrilliantsUser[phase],
            };
        });

        const opponentRating = includeRating ? {
            average: avgInt(opponentElos),
            games: opponentElos.length,
        } : null;

        const stats = {
            total: games.length,
            analyzed,
            identity,
            resultCounts,
            overall,
            byColor,
            openings: openingList,
            topOpenings: openingList.slice(0, 5),
            timeControls: timeControlList,
            phases,
            phaseResults,
            accuracy: { w: avg(accuracy.w), b: avg(accuracy.b) },
            precision: precisionResult,
            excludedAnalyses,
            annotations,
            brilliantPhases,
            worstOpenings: openingList
                .filter(item => item.decided >= 3 && item.pct != null)
                .sort((a, b) => a.pct - b.pct)
                .slice(0, 6),
        };
        if (includeRating) {
            stats.years = yearList;
            stats.eloSeries = eloSeries;
            stats.opponentRating = opponentRating;
        }
        stats.brief = buildBrief(stats);
        return stats;
    }

    function selectRepertoireOpenings(openings, totalsByColor) {
        const totals = totalsByColor || {};
        const result = {};
        ['w', 'b'].forEach(color => {
            const totalGames = Math.max(0, Math.floor(Number(totals[color]) || 0));
            const candidates = (openings || []).filter(item =>
                item.color === color
                && Number(item.games) > 0
                && item.pct != null
                && Number.isFinite(Number(item.pct))
            );
            const meetingShare = share => totalGames
                ? candidates.filter(item => Number(item.games) / totalGames >= share)
                : [];

            let selected = meetingShare(0.30);
            let strategy = '30%';
            if (!selected.length) {
                selected = meetingShare(0.15);
                strategy = '15%';
            }
            if (!selected.length) {
                selected = candidates
                    .filter(item => Number(item.games) >= 5)
                    .slice()
                    .sort((a, b) => Number(b.games) - Number(a.games)
                        || String(a.name || '').localeCompare(String(b.name || '')))
                    .slice(0, 5);
                strategy = 'top5';
            }

            const best = selected.slice().sort((a, b) => Number(b.pct) - Number(a.pct)
                || Number(b.games) - Number(a.games)
                || String(a.name || '').localeCompare(String(b.name || ''))).slice(0, 5);
            const worst = selected.slice().sort((a, b) => Number(a.pct) - Number(b.pct)
                || Number(b.games) - Number(a.games)
                || String(a.name || '').localeCompare(String(b.name || ''))).slice(0, 5);

            result[color] = { totalGames, strategy, best, worst };
        });
        return result;
    }

    function buildBrief(stats) {
        const colorRecord = record => ({
            jogos: record.games,
            vitorias: record.win,
            empates: record.draw,
            derrotas: record.loss,
            aproveitamento: record.pct,
        });
        const brief = {
            jogador: stats.identity.name || 'não identificado',
            total_de_partidas: stats.total,
            partidas_analisadas: stats.analyzed,
            resultados: stats.resultCounts,
            como_brancas: colorRecord(stats.byColor.w),
            como_pretas: colorRecord(stats.byColor.b),
            aberturas_mais_jogadas: stats.openings.slice(0, 8).map(item => ({
                abertura: item.name,
                eco: item.eco,
                jogos: item.games,
                aproveitamento: item.pct,
            })),
            aberturas_mais_fracas: stats.worstOpenings.map(item => ({
                abertura: item.name,
                jogos: item.games,
                aproveitamento: item.pct,
            })),
            controles_de_tempo: stats.timeControls.map(item => ({
                tipo: item.name,
                jogos: item.games,
                aproveitamento: item.pct,
            })),
            precisao_media: {
                brancas: stats.accuracy.w,
                pretas: stats.accuracy.b,
            },
            precisao: {
                voce: stats.precision.user,
                adversarios: stats.precision.opponent,
                por_fase: stats.precision.phase,
            },
            anotacoes: {
                voce: stats.annotations.user,
                adversarios: stats.annotations.opponent,
            },
            erros_graves_por_fase: stats.phases,
            brilhantes_por_fase: stats.brilliantPhases,
            aberturas_em_alerta: stats.worstOpenings.map(item => ({
                abertura: item.name,
                jogos: item.games,
                aproveitamento: item.pct,
            })),
        };
        if (stats.opponentRating) brief.rating_medio_adversarios = stats.opponentRating;
        if (stats.eloSeries && stats.eloSeries.length >= 2) {
            const first = stats.eloSeries[0];
            const last = stats.eloSeries[stats.eloSeries.length - 1];
            brief.rating = { primeiro: first.elo, ultimo: last.elo, variacao: last.elo - first.elo };
        }
        return brief;
    }

    return {
        compute,
        filterGames,
        identifyPlayer,
        userColor,
        outcome,
        selectRepertoireOpenings,
        timeControlCategory,
        normalize,
        namesMatch,
        buildBrief,
    };
})();

window.Stats = Stats;
