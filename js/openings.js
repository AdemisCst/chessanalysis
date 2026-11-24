/* ========================================================================
   ARQUIVO: js/openings.js
   DESCRIÇÃO: Catálogo de aberturas embutido e reconhecimento pelo maior
   prefixo de lances.

   A base vem do projeto aberto `lichess-org/chess-openings` (CC0), com cerca
   de 3.800 linhas nomeadas. O arquivo `vendor/eco/openings.json` é gerado a
   partir dos TSV oficiais e não depende de internet em tempo de execução.

   COMO O RECONHECIMENTO FUNCIONA
   1. Todas as linhas da base são normalizadas para uma sequência de lances
      SAN (sem números, comentários, NAGs ou resultado).
   2. Na carga, criamos um índice em que cada prefixo aponta para a linha mais
      específica que o contém.
   3. Ao reconhecer uma partida, procuramos do prefixo mais longo para o mais
      curto. Assim, uma variante nomeada vence a abertura-mãe.

   O reconhecimento é puramente textual e local. Ele não muda a avaliação nem
   o resultado da partida.
   ======================================================================== */

const Openings = (() => {
    const DATA_URL = 'vendor/eco/openings.json';
    const MAX_PLIES = 24; // profundidade máxima usada para casar uma linha
    let database = null;
    let prefixIndex = null;
    let loadPromise = null;

    /** Normaliza um lance SAN para comparação (castelos, xeques e NAGs). */
    function normalizeSan(san) {
        return String(san || '')
            .trim()
            .replace(/^0-0-0$/i, 'O-O-O')
            .replace(/^0-0$/i, 'O-O')
            .replace(/[!?]+$/g, '')
            .replace(/[+#]+$/g, '');
    }

    function keyOf(moves, length) {
        return moves.slice(0, length).map(normalizeSan).join(' ');
    }

    function buildIndex(entries) {
        const index = new Map();
        entries.forEach(entry => {
            const moves = entry.moves.map(normalizeSan).filter(Boolean);
            if (!moves.length) return;
            entry.moves = moves;
            // Registra cada prefixo; em caso de empate, mantém a linha mais
            // longa (a variante) e ignora a genérica.
            for (let length = 1; length <= Math.min(moves.length, MAX_PLIES); length++) {
                const key = keyOf(moves, length);
                const current = index.get(key);
                if (!current || current.moves.length < entry.moves.length) index.set(key, entry);
            }
        });
        return index;
    }

    /** Carrega a base uma única vez. Falhas são silenciosas e não travam o app. */
    function load() {
        if (database && prefixIndex) return Promise.resolve(database);
        if (loadPromise) return loadPromise;
        loadPromise = fetch(DATA_URL, { cache: 'force-cache' })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(entries => {
                database = Array.isArray(entries) ? entries : [];
                prefixIndex = buildIndex(database);
                return database;
            })
            .catch(error => {
                console.warn('Catálogo de aberturas indisponível:', error);
                database = [];
                prefixIndex = new Map();
                return database;
            });
        return loadPromise;
    }

    /**
     * Reconhece a abertura de uma lista de lances.
     * @param {Array<{san:string}>} moves lances da partida
     * @returns {{eco:string,name:string,moves:string[]}|null}
     */
    function detect(moves) {
        if (!prefixIndex || !Array.isArray(moves) || !moves.length) return null;
        const sans = moves.map(move => normalizeSan(move && move.san ? move.san : move));
        for (let length = Math.min(sans.length, MAX_PLIES); length >= 1; length--) {
            const entry = prefixIndex.get(sans.slice(0, length).join(' '));
            if (entry) return entry;
        }
        return null;
    }

    /** True only while every supplied move remains a catalogued prefix. */
    function isBookSequence(moves) {
        if (!prefixIndex || !Array.isArray(moves) || !moves.length || moves.length > MAX_PLIES) return false;
        const sans = moves.map(move => normalizeSan(move && move.san ? move.san : move));
        return sans.every(Boolean) && prefixIndex.has(sans.join(' '));
    }

    /**
     * Aplica a abertura reconhecida aos metadados. Mantém o cabeçalho original
     * quando a base não conhece a linha, para não apagar informação do PGN.
     */
    function enrichGame(game) {
        if (!game || !Array.isArray(game.moves)) return false;
        const entry = detect(game.moves);
        if (!entry) return false;
        const changed = game.eco !== entry.eco || game.opening !== entry.name;
        game.eco = entry.eco;
        game.opening = entry.name;
        game.openingSource = 'lichess';
        return changed;
    }

    /**
     * Percorre o acervo e devolve as partidas que mudaram. Quem chama decide
     * se grava no IndexedDB (a importação grava em lote; a inicialização
     * atualiza apenas o necessário).
     */
    function enrichLibrary(games) {
        const changed = [];
        (games || []).forEach(game => {
            if (enrichGame(game)) changed.push(game);
        });
        return changed;
    }

    /**
     * Agrega o desempenho por abertura e por cor do dono do acervo.
     * Inclui V/E/D, aproveitamento, precisão média, rating médio e último jogo.
     */
    function compute(games, identity) {
        const rows = new Map();
        (games || []).forEach(game => {
            const color = Stats.userColor(game, identity);
            if (!color) return;
            const name = game.opening || 'Abertura não identificada';
            const eco = game.eco || '—';
            const key = `${color}|${eco}|${name}`;
            if (!rows.has(key)) {
                rows.set(key, {
                    key, eco, name, color,
                    games: 0, win: 0, draw: 0, loss: 0, score: 0, pct: null,
                    accuracySum: 0, accuracyGames: 0,
                    ratingSum: 0, ratingGames: 0,
                    lastDate: '', lastGameId: null, lastOpponent: '',
                });
            }
            const row = rows.get(key);
            row.games++;
            const outcome = Stats.outcome(game.result, color);
            if (outcome === 'win') { row.win++; row.score += 1; }
            else if (outcome === 'draw') { row.draw++; row.score += 0.5; }
            else if (outcome === 'loss') row.loss++;
            const decided = row.win + row.draw + row.loss;
            row.pct = decided ? Math.round((row.score / decided) * 1000) / 10 : null;

            const summary = game.analysisSummary;
            const accuracy = summary ? (color === 'w' ? summary.accuracyW : summary.accuracyB) : null;
            if (accuracy != null) {
                row.accuracySum += Number(accuracy);
                row.accuracyGames++;
            }
            const rating = color === 'w' ? game.whiteElo : game.blackElo;
            if (rating) {
                row.ratingSum += rating;
                row.ratingGames++;
            }
            const date = game.dateISO || '';
            if (!row.lastDate || date > row.lastDate) {
                row.lastDate = date;
                row.lastGameId = game.id;
                row.lastOpponent = color === 'w' ? game.black : game.white;
            }
        });

        return Array.from(rows.values()).map(row => ({
            ...row,
            accuracy: row.accuracyGames ? Math.round((row.accuracySum / row.accuracyGames) * 10) / 10 : null,
            rating: row.ratingGames ? Math.round(row.ratingSum / row.ratingGames) : null,
            lastDate: row.lastDate || null,
        })).sort((a, b) => b.games - a.games || (b.lastDate || '').localeCompare(a.lastDate || ''));
    }

    return {
        DATA_URL,
        load,
        detect,
        isBookSequence,
        enrichGame,
        enrichLibrary,
        compute,
        normalizeSan,
        get loaded() { return !!prefixIndex; },
    };
})();

window.Openings = Openings;
