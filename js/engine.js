/* ========================================================================
   ARQUIVO: js/engine.js
   DESCRIÇÃO: Integração com o Stockfish (Web Worker) e transformação das
   avaliações em: anotação de cada lance, precisão, ACPL, gráfico, momentos-
   chave e fases da partida.

   ANOTAÇÕES (ordem visual oficial):
     !!  Brilhante       sacrifício correto ou grande virada, mantendo vantagem
     !   Excelente       perda de até 2 pontos percentuais
     ★   Melhor          lance escolhido pelo Stockfish
     👍  Ótimo           perda entre 2 e 9,9 pontos percentuais
     ?   Erro            perda entre 10 e 29,9 pontos percentuais
     ×   Chance perdida  posição ganha que deixou de ser ganha, mas não perdida
     ??  Capivarada      perda de 30 pontos percentuais ou mais

   Os limiares ficam em constantes comentadas para calibração. A perda usada
   nas anotações é medida em PONTOS PERCENTUAIS de vitória (win%), não em
   centipeões. O ACPL é medido em centipeões e serve para comparação com
   outras ferramentas.

   Nada sai do computador: o Stockfish roda em vendor/stockfish.
   ======================================================================== */

const Engine = (() => {
    const WORKER_URL = 'vendor/stockfish/stockfish-19-lite-single.js';

    /**
     * Identidade estável do build. É ela que entra na chave de armazenamento
     * (`gameId@depth@build`), não o `id name` do UCI: o rótulo do motor pode
     * mudar entre releases e não serve como chave. Análises antigas, sem este
     * campo, continuam legíveis e nunca são sobrescritas por uma nova.
     */
    const BUILD_ID = 'stockfish-19-lite-single';
    const BUILD_LABEL = 'Stockfish 19 Lite WASM';
    const LEGACY_BUILD_ID = 'stockfish-10-legacy';

    /* ---------- limiares de anotação (calibráveis) ---------- */
    const THRESHOLDS = {
        blunder: 30,        // ?? a partir de 30pp de perda
        mistake: 10,        // ?  entre 10 e 29,9pp
        excellent: 2,       // !  até 2pp de perda
        missedBefore: 80,   // ×  posição era ganha com 80%+ (ou mate)
        missedAfter: 70,    // ×  deixou de ser ganha abaixo de 70%
        missedFloor: 45,    // ×  mas ainda não está perdida (45%+)
        sacrifice: 2,       // !! material entregue (em peões)
        brilliantAfter: 60, // !! mantém 60%+ depois do lance
        brilliantFollow: 55,// !! e ainda 55%+ dois lances depois
        turnaroundBefore: 35, // !! virada: antes 35% ou menos...
        turnaroundAfter: 60,  // ...depois 60% ou mais
        brilliantLoss: 2,   // !! tolerância de perda do próprio lance
        minPly: 6,          // não marca brilhante nos 3 primeiros lances
    };

    const ANNOTATIONS = {
        brilliant: { key: 'brilliant', symbol: '!!', label: 'Brilhante', cls: 'best' },
        best:      { key: 'best',      symbol: '★',  label: 'Melhor', cls: 'best' },
        missed:    { key: 'missed',    symbol: '×',  label: 'Chance perdida', cls: 'mistake' },
        blunder:   { key: 'blunder',   symbol: '??', label: 'Capivarada', cls: 'blunder' },
        mistake:   { key: 'mistake',   symbol: '?',  label: 'Erro', cls: 'mistake' },
        excellent: { key: 'excellent', symbol: '!',  label: 'Excelente', cls: 'good' },
        good:      { key: 'good',      symbol: '👍', label: 'Ótimo', cls: 'good' },
    };

    const ANNOTATION_ORDER = ['brilliant', 'excellent', 'best', 'good', 'mistake', 'missed', 'blunder'];
    const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

    let worker = null;
    let readyPromise = null;
    let active = null;
    let searchCounter = 0;
    let engineId = null;

    function supported() {
        return location.protocol !== 'file:';
    }

    /**
     * WDL opcional do Stockfish 19 (UCI_ShowWDL): `wdl <w> <d> <l>`, em
     * por-mil, do ponto de vista de quem joga na posição. Devolve null quando
     * o motor não enviou o trio ou quando ele é inconsistente — nunca inventa
     * um valor. O trio alimenta o Expected Score da versão 3 quando todas as
     * posições avaliadas o trazem; caso contrário a análise usa a curva de cp.
     */
    function parseWdl(line) {
        const match = line.match(/\bwdl (\d+) (\d+) (\d+)\b/);
        if (!match) return null;
        const w = Number(match[1]);
        const d = Number(match[2]);
        const l = Number(match[3]);
        if (w + d + l !== 1000 || w > 1000 || d > 1000 || l > 1000) return null;
        return { w, d, l };
    }

    /**
     * Identidade do motor de uma análise/sumário. Registros anteriores a esta
     * tarefa não têm `engineBuild`; a inferência usa o texto do `id name`, que
     * é o dado real gravado na época. Nunca inventa um build moderno: o que
     * não for reconhecido fica como legado desconhecido.
     */
    function buildOf(record) {
        if (!record) return 'legacy-unknown';
        if (record.engineBuild) return String(record.engineBuild);
        if (record.build) return String(record.build);
        const text = `${record.engineId || ''} ${record.engine || ''}`;
        if (/stockfish[\s_-]*19/i.test(text)) return BUILD_ID;
        if (/stockfish[\s_-]*10/i.test(text)) return LEGACY_BUILD_ID;
        return 'legacy-unknown';
    }

    /** Verdadeiro quando a análise não veio do build atual. */
    function isLegacyAnalysis(analysis) {
        return !!analysis && buildOf(analysis) !== BUILD_ID;
    }

    /**
     * Posição terminal confirmada: `depth 0`, sem melhor lance/PV e com mate ou
     * cp. O SF19 não envia WDL nessas posições — por isso elas são isentas da
     * exigência de WDL e continuam decididas por `mate`/`cp`.
     */
    function isTerminalPosition(position) {
        if (!position) return false;
        if (position.terminal === true) return true;
        return position.depth === 0
            && position.best == null
            && (!Array.isArray(position.pv) || position.pv.length === 0)
            && (position.mate != null || position.cp != null);
    }

    /** WDL válido (por-mil, soma 1000) ou `null`. Não corrige valores ruins. */
    function validWdl(position) {
        const wdl = position && position.wdl;
        if (!wdl) return null;
        const w = Number(wdl.w);
        const d = Number(wdl.d);
        const l = Number(wdl.l);
        if (![w, d, l].every(value => Number.isInteger(value) && value >= 0 && value <= 1000)) return null;
        if (w + d + l !== 1000) return null;
        return { w, d, l };
    }

    /** Expected Score do lado a jogar, em 0–100, a partir do WDL. */
    function wdlWinPct(position) {
        const wdl = validWdl(position);
        if (!wdl) return null;
        return (wdl.w + wdl.d / 2) / 10;
    }

    /**
     * Cobertura do WDL em uma análise. Posições terminais não contam. A fonte
     * é escolhida por análise (contrato da v3): só usa WDL se todas as
     * posições avaliadas trouxerem o trio válido.
     */
    function wdlCoverage(positions) {
        const list = Array.isArray(positions) ? positions : [];
        let evaluated = 0;
        let present = 0;
        let missing = 0;
        let invalid = 0;
        list.forEach(position => {
            if (isTerminalPosition(position)) return;
            evaluated++;
            if (!position || !position.wdl) { missing++; return; }
            if (validWdl(position)) present++;
            else invalid++;
        });
        return {
            complete: evaluated > 0 && present === evaluated,
            evaluated,
            present,
            missing,
            invalid,
        };
    }

    function parseInfo(line) {
        if (!line.startsWith('info') || !line.includes(' score ')) return null;
        const depthMatch = line.match(/\bdepth (\d+)/);
        const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
        if (!scoreMatch) return null;
        const pvMatch = line.match(/\bpv (.+)$/);
        return {
            depth: depthMatch ? Number(depthMatch[1]) : 0,
            type: scoreMatch[1],
            value: Number(scoreMatch[2]),
            wdl: parseWdl(line),
            pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : [],
        };
    }

    /**
     * Resultado de uma posição terminal, confirmado pela biblioteca de regras.
     *
     * O SF19 responde `info depth 0` tanto para posição terminal quanto para
     * FEN inválida, então `depth 0` sozinho não prova nada. Aqui a FEN é
     * validada e o estado é classificado antes de qualquer conclusão:
     *   - xeque-mate: `mate: 0` (o lado a jogar está em mate; o sinal segue a
     *     convenção do motor, do ponto de vista de quem joga);
     *   - afogamento ou material insuficiente: `cp: 0` (empate);
     *   - qualquer outra posição, inclusive FEN inválida: `null`.
     * O WDL fica `null`: o motor não envia o trio em posição terminal.
     */
    function terminalResult(fen) {
        try {
            const chess = new Chess(fen);
            if (typeof chess.validate_fen === 'function') {
                const validation = chess.validate_fen(fen);
                if (!validation || !validation.valid) return null;
            }
            // O validate_fen desta versão não exige reis; um tabuleiro vazio
            // seria lido como afogamento. Exigimos um rei de cada lado.
            const board = String(fen || '').split(/\s+/)[0] || '';
            const whiteKings = (board.match(/K/g) || []).length;
            const blackKings = (board.match(/k/g) || []).length;
            if (whiteKings !== 1 || blackKings !== 1) return null;
            if (chess.in_checkmate()) {
                return { cp: null, mate: 0, wdl: null, depth: 0, best: null, pv: [] };
            }
            if (chess.in_stalemate() || chess.insufficient_material()) {
                return { cp: 0, mate: null, wdl: null, depth: 0, best: null, pv: [] };
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Só aceita `depth 0` quando `terminalResult` confirmou a terminalidade.
     * Fora disso a linha é descartada: não se presume que todo `depth 0` é
     * uma posição terminal válida.
     */
    function usableInfo(info, terminal) {
        if (!info) return false;
        if (info.depth > 0) return true;
        return info.depth === 0 && terminal === true;
    }

    function onLine(line) {
        if (!active) return;
        const info = parseInfo(line);
        if (usableInfo(info, active.terminal) && info.depth >= active.best.depth) {
            active.best.depth = info.depth;
            active.best.cp = info.type === 'cp' ? info.value : null;
            active.best.mate = info.type === 'mate' ? info.value : null;
            active.best.wdl = info.wdl;
            active.best.pv = info.pv;
        }
        if (line.startsWith('bestmove')) {
            const parts = line.split(/\s+/);
            const best = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
            const result = {
                cp: active.best.cp,
                mate: active.best.mate,
                wdl: active.best.wdl,
                depth: active.best.depth,
                best,
                pv: active.best.pv,
            };
            const finish = active.finish;
            active = null;
            finish(result);
        }
    }

    function init() {
        if (!supported()) {
            return Promise.reject(new Error('A análise com Stockfish precisa do iniciar.bat (servidor local).'));
        }
        if (readyPromise) return readyPromise;
        readyPromise = new Promise((resolve, reject) => {
            engineId = null;
            try {
                worker = new Worker(WORKER_URL);
            } catch (e) {
                reject(new Error('Não foi possível iniciar o Stockfish: ' + e.message));
                return;
            }
            let sentOptions = false;
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('O Stockfish demorou demais para responder.'));
                }
            }, 25000);

            worker.onerror = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error('Falha ao carregar o Stockfish.'));
                }
            };

            worker.onmessage = event => {
                const line = typeof event.data === 'string' ? event.data : '';
                if (!line) return;
                if (line.startsWith('id name ')) {
                    engineId = line.slice(8).trim() || null;
                    return;
                }
                if (line.includes('uciok') && !sentOptions) {
                    sentOptions = true;
                    worker.postMessage('setoption name Hash value 32');
                    worker.postMessage('setoption name MultiPV value 1');
                    worker.postMessage('setoption name UCI_ShowWDL value true');
                    worker.postMessage('isready');
                    return;
                }
                if (line.includes('readyok') && !settled) {
                    settled = true;
                    clearTimeout(timer);
                    worker.postMessage('ucinewgame');
                    resolve(true);
                    return;
                }
                onLine(line);
            };

            worker.postMessage('uci');
        });
        return readyPromise;
    }

    function evaluate(fen, depth, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(new DOMException('Análise cancelada.', 'AbortError'));
                return;
            }
            // Posição terminal não passa pelo motor: o resultado é conhecido e
            // a linha `depth 0` do SF19 não distingue mate de afogamento nem
            // de FEN inválida.
            const terminal = terminalResult(fen);
            if (terminal) { resolve(terminal); return; }
            if (!worker) { reject(new Error('Stockfish não iniciado.')); return; }
            const id = ++searchCounter;
            let cursor = null;
            let timer = null;

            function cleanup() {
                if (timer) clearTimeout(timer);
                if (cursor) signal && signal.removeEventListener('abort', cursor);
                if (active && active.id === id) active = null;
            }

            function fail(error) {
                cleanup();
                reject(error);
            }

            active = {
                id,
                terminal: false,
                best: { cp: null, mate: null, wdl: null, depth: -1, pv: [] },
                finish: result => {
                    cleanup();
                    resolve(result);
                },
            };

            if (signal) {
                if (signal.aborted) { fail(new DOMException('Análise cancelada.', 'AbortError')); return; }
                cursor = () => {
                    if (worker) worker.postMessage('stop');
                    fail(new DOMException('Análise cancelada.', 'AbortError'));
                };
                signal.addEventListener('abort', cursor, { once: true });
            }

            timer = setTimeout(() => {
                if (worker) worker.postMessage('stop');
                const fallback = active && active.best;
                cleanup();
                resolve({
                    cp: fallback ? fallback.cp : null,
                    mate: fallback ? fallback.mate : null,
                    wdl: fallback ? fallback.wdl : null,
                    depth: fallback ? fallback.depth : 0,
                    best: null,
                    pv: [],
                });
            }, 45000);

            worker.postMessage('position fen ' + fen);
            worker.postMessage('go depth ' + depth);
        });
    }

    function stop() {
        if (worker) {
            try { worker.postMessage('stop'); } catch (e) { /* ignore */ }
            worker.terminate();
        }
        worker = null;
        readyPromise = null;
        active = null;
        engineId = null;
    }

    /* ====================================================================
       01 - CÁLCULOS DE AVALIAÇÃO
       ==================================================================== */
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function uciToSan(fen, uci) {
        if (!uci || uci.length < 4) return null;
        try {
            const chess = new Chess(fen);
            const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
            return move ? move.san : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Converte uma avaliação do Stockfish em centipeões, sempre do ponto de
     * vista de quem está a jogar naquela posição. Mate vale ±1400, o mesmo
     * teto usado para evitar que uma única posição domine as médias.
     */
    function cpOf(position) {
        if (!position) return 0;
        if (position.mate != null) return position.mate > 0 ? 1400 : -1400;
        return clamp(position.cp == null ? 0 : position.cp, -1400, 1400);
    }

    /**
     * Probabilidade de vitória das brancas (0 a 100) na posição `index`.
     * A fonte é escolhida por análise:
     *   - `wdl` (v3): `(w + d/2) / 10`, do ponto de vista de quem joga;
     *   - `cp` (v2 e legado): curva logística sobre centipeões.
     * O mate tem prioridade sobre as duas fontes.
     */
    function whiteWinPct(position, index, source) {
        if (!position) return 50;
        if (position.mate != null) {
            const moverWins = position.mate > 0;
            const whiteWins = index % 2 === 0 ? moverWins : !moverWins;
            return whiteWins ? 100 : 0;
        }
        const wdlScore = source === 'wdl' ? wdlWinPct(position) : null;
        const cp = cpOf(position);
        const winForSideToMove = wdlScore != null
            ? wdlScore
            : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
        return index % 2 === 0 ? winForSideToMove : 100 - winForSideToMove;
    }

    /** Win% do lado `mover` numa posição de índice `index`. */
    function winForMover(winPctWhite, index, mover) {
        const white = winPctWhite[Math.max(0, Math.min(index, winPctWhite.length - 1))];
        return mover === 'w' ? white : 100 - white;
    }

    /**
     * Mate a favor do lado `mover`: positivo quando ele dá mate, negativo
     * quando apanha mate. `null` quando não há mate na avaliação.
     */
    function mateFor(position, index, mover) {
        if (!position || position.mate == null) return null;
        const sideToMove = index % 2 === 0 ? 'w' : 'b';
        return sideToMove === mover ? position.mate : -position.mate;
    }

    /**
     * Precisão estimada (0–100) a partir da perda em pontos percentuais.
     * Fórmula clássica de conversão de perda de win% em precisão.
     */
    function accuracyForLoss(loss) {
        return clamp(103.1668 * Math.exp(-0.04354 * loss) - 3.1669, 0, 100);
    }

    /**
     * Material de um lado em uma FEN, em peões (rei ignorado).
     * Usado apenas para detectar sacrifícios; não entra na avaliação.
     */
    function materialOf(fen, color) {
        const board = String(fen || '').split(' ')[0];
        let total = 0;
        for (const ch of board) {
            const lower = ch.toLowerCase();
            const value = PIECE_VALUE[lower];
            if (!value) continue;
            const isWhite = ch === ch.toUpperCase();
            if ((color === 'w') === isWhite) total += value;
        }
        return total;
    }

    /**
     * Fase da partida. A abertura vai até o lance 20 (10 lances de cada lado);
     * o final começa nos últimos 25% de partidas com mais de 60 lances.
     */
    function phaseOf(ply, total) {
        if (ply <= 20) return 'opening';
        if (total > 60 && ply > Math.floor(total * 0.75)) return 'endgame';
        return 'middlegame';
    }

    function annotationInfo(key) {
        return ANNOTATIONS[key] || ANNOTATIONS.good;
    }

    /**
     * Decide a anotação de um lance seguindo a prioridade pedida:
     * Brilhante → Melhor → Chance perdida → Capivarada → Erro →
     * Excelente → Ótimo.
     */
    function decideAnnotation(flags) {
        if (flags.brilliant) return 'brilliant';
        if (flags.isBest) return 'best';
        if (flags.missed) return 'missed';
        if (flags.loss >= THRESHOLDS.blunder) return 'blunder';
        if (flags.loss >= THRESHOLDS.mistake) return 'mistake';
        if (flags.loss <= THRESHOLDS.excellent) return 'excellent';
        return 'good';
    }

    function blankCounts() {
        const record = {};
        ANNOTATION_ORDER.forEach(key => { record[key] = 0; });
        return record;
    }

    function average(list) {
        if (!list.length) return null;
        return Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 10) / 10;
    }

    /* ====================================================================
       02 - MONTAGEM DA ANÁLISE
       ==================================================================== */
    /**
     * Transforma as avaliações posição a posição em uma análise completa.
     * É a função central: usada tanto na análise nova quanto no
     * enriquecimento de análises antigas salvas antes das anotações.
     *
     * `meta` preserva a proveniência no enriquecimento (motor, build, versão)
     * e permite forçar a fonte do Expected Score. Sem `meta`, a v3 é usada
     * quando todas as posições avaliadas têm WDL válido; caso contrário, a
     * análise inteira permanece na v2 com a curva sobre cp.
     */
    function buildAnalysis(gameId, data, positions, depth, createdAt, meta) {
        const options = meta || {};
        const coverage = wdlCoverage(positions);
        let scoreSource = options.scoreSource === 'wdl' || options.scoreSource === 'cp'
            ? options.scoreSource
            : (coverage.complete ? 'wdl' : 'cp');
        if (scoreSource === 'wdl' && !coverage.complete) scoreSource = 'cp';
        const resolvedEngineId = options.engineId === undefined ? engineId : options.engineId;
        const engineBuild = options.engineBuild || BUILD_ID;
        const engineName = options.engine
            || resolvedEngineId
            || (engineBuild === BUILD_ID ? BUILD_LABEL : 'Stockfish (WASM)');
        const version = scoreSource === 'wdl' ? 3 : 2;
        const moves = data.moves || [];
        const winPctWhite = positions.map((position, index) => whiteWinPct(position, index, scoreSource));
        const evaluated = [];
        const counts = { w: blankCounts(), b: blankCounts() };
        const phaseBlunders = { opening: 0, middlegame: 0, endgame: 0 };
        const phaseBrilliants = { opening: 0, middlegame: 0, endgame: 0 };
        const phaseBrilliantsByColor = {
            w: { opening: 0, middlegame: 0, endgame: 0 },
            b: { opening: 0, middlegame: 0, endgame: 0 },
        };
        const phaseAccuracy = {
            opening: { w: [], b: [] },
            middlegame: { w: [], b: [] },
            endgame: { w: [], b: [] },
        };
        const accuracyLists = { w: [], b: [] };
        const cpLossLists = { w: [], b: [] };
        const keyCandidates = [];

        for (let i = 0; i < moves.length; i++) {
            const mover = i % 2 === 0 ? 'w' : 'b';
            const opponent = mover === 'w' ? 'b' : 'w';
            const before = winForMover(winPctWhite, i, mover);
            const after = winForMover(winPctWhite, i + 1, mover);
            const loss = Math.max(0, before - after);
            const phase = phaseOf(i + 1, moves.length);

            const beforeFen = i === 0 ? data.startFen : moves[i - 1].fen;
            const afterFen = moves[i].fen;
            const beforePosition = positions[i];
            const afterPosition = positions[i + 1];
            const bestUci = positions[i] ? positions[i].best : null;
            const bestSan = bestUci ? uciToSan(beforeFen, bestUci) : null;
            const playedSan = moves[i].san;
            const isBest = !!bestSan && bestSan.replace(/[+#]/g, '') === playedSan.replace(/[+#]/g, '');
            const mateBefore = mateFor(beforePosition, i, mover);
            const mateAfter = mateFor(afterPosition, i + 1, mover);
            const beforeWinning = before >= THRESHOLDS.missedBefore || (mateBefore != null && mateBefore > 0);
            const afterWinning = after >= THRESHOLDS.missedAfter || (mateAfter != null && mateAfter > 0);
            const missed = beforeWinning && !afterWinning
                && after >= THRESHOLDS.missedFloor
                && loss >= THRESHOLDS.mistake;

            // Sacrifício: material entregue de imediato e vantagem mantida.
            const sacrifice = Math.max(0, materialOf(beforeFen, mover) - materialOf(afterFen, mover));
            const followIndex = Math.min(i + 2, positions.length - 1);
            const followWin = winForMover(winPctWhite, followIndex, mover);
            const sacrificeOk = sacrifice >= THRESHOLDS.sacrifice
                && after >= THRESHOLDS.brilliantAfter
                && followWin >= THRESHOLDS.brilliantFollow;
            const turnaround = before <= THRESHOLDS.turnaroundBefore
                && after >= THRESHOLDS.turnaroundAfter
                && followWin >= THRESHOLDS.brilliantFollow;
            const brilliant = i + 1 >= THRESHOLDS.minPly
                && loss <= THRESHOLDS.brilliantLoss
                && (sacrificeOk || turnaround);

            const annotation = decideAnnotation({ brilliant, isBest, missed, loss });
            const info = annotationInfo(annotation);

            // ACPL em centipeões: avaliação antes menos avaliação depois,
            // ambas do ponto de vista de quem jogou.
            const cpBefore = cpOf(beforePosition);
            const cpAfter = -cpOf(afterPosition);
            const cpLoss = Math.round(Math.max(0, cpBefore - cpAfter));

            const accuracy = accuracyForLoss(loss);
            counts[mover][annotation]++;
            accuracyLists[mover].push(accuracy);
            cpLossLists[mover].push(cpLoss);
            phaseAccuracy[phase][mover].push(accuracy);

            if (annotation === 'blunder') phaseBlunders[phase] += 1;
            if (annotation === 'brilliant') {
                phaseBrilliants[phase] += 1;
                phaseBrilliantsByColor[mover][phase] += 1;
            }

            const record = {
                loss: Math.round(loss * 10) / 10,
                cpLoss,
                cls: info.cls,
                annotation,
                symbol: info.symbol,
                label: info.label,
                bestSan,
                before: Math.round(before * 10) / 10,
                after: Math.round(after * 10) / 10,
                phase,
                sacrifice,
                brilliant,
                missed,
                isBest,
            };
            evaluated.push(record);

            if (annotation === 'brilliant' || annotation === 'missed'
                || annotation === 'blunder' || annotation === 'mistake') {
                keyCandidates.push({
                    ply: i + 1,
                    san: playedSan,
                    color: mover,
                    opponent,
                    phase,
                    cls: info.cls,
                    annotation,
                    symbol: info.symbol,
                    label: info.label,
                    loss: record.loss,
                    cpLoss,
                    bestSan,
                    before: record.before,
                    after: record.after,
                    sacrifice,
                });
            }
        }

        const severity = {
            brilliant: 1000,
            missed: 500,
            blunder: 300,
            mistake: 200,
        };
        keyCandidates.sort((a, b) => (severity[b.annotation] + b.loss) - (severity[a.annotation] + a.loss));
        const keyMoments = keyCandidates.slice(0, 8).sort((a, b) => a.ply - b.ply);

        const accuracy = { w: average(accuracyLists.w), b: average(accuracyLists.b) };
        const acpl = {
            w: cpLossLists.w.length ? Math.round(cpLossLists.w.reduce((s, v) => s + v, 0) / cpLossLists.w.length) : null,
            b: cpLossLists.b.length ? Math.round(cpLossLists.b.reduce((s, v) => s + v, 0) / cpLossLists.b.length) : null,
        };

        const phaseAccuracyResult = {};
        ['opening', 'middlegame', 'endgame'].forEach(phase => {
            phaseAccuracyResult[phase] = {
                w: average(phaseAccuracy[phase].w),
                b: average(phaseAccuracy[phase].b),
            };
        });

        return {
            gameId,
            // v3: win% e perda derivados do WDL bruto (§3.1 do modelo de dados).
            // Sem cobertura completa de WDL, a análise permanece v2 e usa a
            // curva logística sobre cp — a fonte nunca é misturada por posição.
            version,
            depth,
            engine: engineName,
            engineId: resolvedEngineId || null,
            engineBuild,
            scoreSource,
            wdlCoverage: coverage,
            createdAt: createdAt || Date.now(),
            positions,
            moves: evaluated,
            winPctWhite,
            accuracy,
            acpl,
            counts,
            phaseAccuracy: phaseAccuracyResult,
            phaseBlunders,
            phaseBrilliants,
            phaseBrilliantsByColor,
            keyMoments,
            summary: {
                engine: engineName,
                engineBuild,
                scoreSource,
                blundersW: counts.w.blunder,
                blundersB: counts.b.blunder,
                mistakesW: counts.w.mistake,
                mistakesB: counts.b.mistake,
                missedW: counts.w.missed,
                missedB: counts.b.missed,
                brilliantsW: counts.w.brilliant,
                brilliantsB: counts.b.brilliant,
                accuracyW: accuracy.w,
                accuracyB: accuracy.b,
                acplW: acpl.w,
                acplB: acpl.b,
                phaseAccuracy: phaseAccuracyResult,
                phaseBlunders,
                phaseBrilliants,
                phaseBrilliantsByColor,
                counts,
            },
        };
    }

    /**
     * Enriquece uma análise antiga (sem anotações/ACPL) sem rodar o Stockfish
     * outra vez. Usa as posições e os lances já salvos.
     */
    function enrichAnalysis(analysis, data) {
        if (!analysis || !data || !Array.isArray(analysis.positions) || !Array.isArray(data.moves)) return analysis;
        const complete = analysis.version >= 2
            && Array.isArray(analysis.moves)
            && analysis.moves.length === data.moves.length
            && analysis.moves.every(move => move && move.annotation && move.symbol);
        if (complete) return analysis;
        try {
            // Reconstrução não altera a história: mantém o motor, o build e a
            // fonte originais. Só uma análise já v3 usa WDL; o resto continua
            // na curva sobre cp, mesmo que o registro tenha wdl armazenado.
            const rebuilt = buildAnalysis(
                analysis.gameId,
                data,
                analysis.positions,
                analysis.depth,
                analysis.createdAt,
                {
                    engine: analysis.engine,
                    engineId: analysis.engineId === undefined ? null : analysis.engineId,
                    engineBuild: buildOf(analysis),
                    scoreSource: analysis.scoreSource === 'wdl' ? 'wdl' : 'cp',
                }
            );
            if (analysis.key) rebuilt.key = analysis.key;
            return rebuilt;
        } catch (error) {
            console.warn('Não foi possível enriquecer a análise antiga:', error);
            return analysis;
        }
    }

    /* ====================================================================
       03 - ANÁLISE COMPLETA DE UMA PARTIDA
       ==================================================================== */
    async function analyzeGame(game, data, options) {
        const opts = options || {};
        const depth = Number(opts.depth) || 12;
        const moves = data.moves || [];
        const total = moves.length + 1;

        // Retomada (M3): `startIndex` é a primeira posição ainda não avaliada e
        // `seedPositions` são as posições já verificadas (prefixo 0..startIndex-1).
        // O resultado continua completo: o motor só evita refazer o prefixo.
        const startIndex = opts.startIndex === undefined || opts.startIndex === null
            ? 0
            : Number(opts.startIndex);
        if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > total) {
            throw new RangeError('startIndex fora do intervalo da partida.');
        }
        const seeds = Array.isArray(opts.seedPositions)
            ? opts.seedPositions.slice(0, startIndex)
            : [];
        if (seeds.length !== startIndex) {
            throw new RangeError('seedPositions não cobrem o startIndex informado.');
        }

        await init();
        const positions = seeds.slice();

        for (let index = startIndex; index < total; index++) {
            if (opts.signal && opts.signal.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
            const fen = index === 0 ? data.startFen : moves[index - 1].fen;
            const result = await evaluate(fen, depth, opts.signal);
            positions[index] = result;
            // `onPosition` é aguardado de propósito: o chamador grava o
            // checkpoint antes de o motor avançar para a próxima posição.
            if (opts.onPosition) {
                await opts.onPosition({ index, position: result, done: index + 1, total });
            }
            if (opts.onProgress) opts.onProgress({ done: index + 1, total, index });
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        return buildAnalysis(game.id, data, positions, depth);
    }

    return {
        BUILD_ID,
        BUILD_LABEL,
        LEGACY_BUILD_ID,
        THRESHOLDS,
        ANNOTATIONS,
        ANNOTATION_ORDER,
        supported,
        init,
        analyzeGame,
        enrichAnalysis,
        buildAnalysis,
        buildOf,
        isLegacyAnalysis,
        terminalResult,
        usableInfo,
        isTerminalPosition,
        validWdl,
        wdlWinPct,
        wdlCoverage,
        annotationInfo,
        stop,
        whiteWinPct,
        uciToSan,
        accuracyForLoss,
        cpOf,
        materialOf,
        phaseOf,
    };
})();

window.Engine = Engine;
