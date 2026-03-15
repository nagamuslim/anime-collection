/**
 * metadata.js
 * ════════════════════════════════════════════════════════════════════
 * PHASE 1 — RAM Match (offline DB, no API)
 *   Writes immediately: { malId, tags[], allTitles[], matchedTitle, score }
 *   → Genre filtering + search + score display usable right away
 *
 * PHASE 2 — Jikan API (one call per unique MAL ID)
 *   Overwrites: tags[]  (titlecase, more curated than offline DB)
 *   Adds:       synopsis, demographics[]
 *
 * Offline DB structure (anime-offline-database-minified.json):
 *   { sources[], title, type, episodes, status, animeSeason,
 *     picture, thumbnail, duration, score{arithmeticMean,median,...},
 *     synonyms[], studios[], producers[], relatedAnime[], tags[] }
 *   - tags = flat lowercase array of genres + themes (no demographics)
 *   - score.arithmeticMean = numeric rating (28% of entries have it)
 *   - 29,932 of 40,515 entries have a MAL source URL
 *   - 10,583 entries exist only on anime-planet/anidb/etc (no MAL ID)
 *
 * Tested accuracy on 649 anime: 92.9% (603/649 matched)
 * Remaining 46 misses = pure Indonesian titles with no DB synonym
 *
 * Node DB loading priority:
 *   1. ./anime-offline-database-minified.json  (local file, ~2s parse)
 *   2. GitHub releases URL → downloaded to RAM  (no disk write, ~30s)
 *
 * Node cache: metadata.json
 * ════════════════════════════════════════════════════════════════════
 */
(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.AnimeMetadata = factory();
}(this, function() {
    'use strict';

    const LS_PREFIX  = 'meta_';
    const isNode     = typeof process !== 'undefined' && process.versions && process.versions.node;
    const LOCAL_DB   = './anime-offline-database-minified.json';
    const GITHUB_DB  = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';

    let offlineDb  = null;
    let titleIndex = new Map();  // cleanedTitle → record
    let storage    = null;

    // ── Storage ───────────────────────────────────────────────────────
    if (isNode) {
        const fs = require('fs'), path = require('path');
        const _baseDir   = (typeof __dirname !== 'undefined' && __dirname) ? __dirname : process.cwd();
        const CACHE_FILE = path.join(_baseDir, 'metadata.json');
        let cacheData = {};
        if (fs.existsSync(CACHE_FILE)) {
            try { cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
        }
        const _persist = () => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2)); } catch(e) {} };
        storage = {
            getItem:    k => cacheData[k] !== undefined ? JSON.stringify(cacheData[k]) : null,
            setItem:    (k, v) => { try { cacheData[k] = JSON.parse(v); _persist(); } catch(e) {} },
            removeItem: k => { delete cacheData[k]; _persist(); },
            length: 0, key: () => null, _raw: cacheData
        };
    } else if (typeof localStorage !== 'undefined') {
        storage = localStorage;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ── cleanForIndex ─────────────────────────────────────────────────
    // Keeps: a-z, 0-9, hiragana U+3040-30FA, katakana U+30FC-30FF,
    //        kanji U+4E00-9FFF + CJK compat
    // Strips: spaces, punctuation, emoji, latin accents
    //
    // Specifically EXCLUDES U+30FB (katakana middle dot ・) because
    // "Blend・S" and "Blend S" must hash to the same key "blends".
    // ・ is used as a separator in Japanese titles, not a letter.
    const cleanForIndex = t =>
        t.toLowerCase()
         .replace(/\u30fb/g, '')  // strip katakana middle dot ・ (U+30FB)
         .replace(/[^a-z0-9\u3040-\u30fa\u30fc-\u9fff\uff00-\uffef]/g, '');

    // ── Suffix patterns ───────────────────────────────────────────────
    const SUFFIX_PATTERNS = [
        /\s+Season\s+\d+\s*$/i,
        /\s+S\d+\s*$/i,
        /\s+Part\s+\d+\s*$/i,
        /\s+Cour\s+\d+\s*$/i,
        /\s+Musim\s+\S+(\s+\S+)?\s*$/i,
        /\s+\d+(?:st|nd|rd|th)\s+Season\s*$/i,
    ];
    function stripSuffix(s) {
        for (const pat of SUFFIX_PATTERNS) {
            const s2 = s.replace(pat, '').trim();
            if (s2 !== s && s2.length > 2) return s2;
        }
        return s;
    }

    // ── makeVariations ────────────────────────────────────────────────
    // Returns all candidate strings to try against the index.
    //
    // Handles:
    //  LEADING  paren  (Tensura) Title     → strip, try inner word
    //  TRAILING paren  Title (JpName)      → try before paren AND inside paren
    //                  Cells at Work! (Hataraku Saibou) → "Hataraku Saibou" ✓
    //                  Wasteful Days (Joshi Kousei...)  → "Joshi Kousei..." ✓
    //                  Goblin Slayer (Censored)         → "Goblin Slayer" ✓
    //                  Bleach (Season 1)                → "Bleach" ✓
    //  Season suffix   Title Season 2 / S3 / Musim 2   → strip
    //  Arc suffix      Title S3: Arc Name               → colon split THEN strip S3
    //  Colon           Title: Subtitle                  → try before ":"
    //  Dash            Title - Subtitle                 → try before " - "
    //  Blend・S        middot stripped by cleanForIndex  → "blends" ✓
    function makeVariations(name) {
        let base = name.replace(/\s*\(dub indo\)\s*/gi, '').trim();

        // Leading parenthetical: "(Word) Title" → "Title" (also try "Word")
        const leadMatch = base.match(/^\s*\(([^)]+)\)\s+(.+)/);
        if (leadMatch) {
            const leadWord = leadMatch[1].trim();
            base = leadMatch[2].trim();
            // Don't add leadWord — it's usually a franchise nickname, not the title
        }

        const seeds = new Set([base]);

        // Trailing parenthetical: "Title (Content)"
        // Two sub-cases: content = Japanese title  OR  content = tag like "Censored"
        const trailMatch = base.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
        if (trailMatch) {
            const before = trailMatch[1].trim();
            const inside = trailMatch[2].trim();
            seeds.add(before);  // always add "Title" without the paren
            // Add inside content if it looks like a real title (not a tag)
            const isTag = /^(censored|season\s*\d+|special|ova|ona|web version|dub\s*indo|s\d+)$/i.test(inside);
            if (!isTag && inside.length > 3) seeds.add(inside);
        }

        // Colon and dash splits
        if (base.includes(':'))   seeds.add(base.split(':')[0].trim());
        if (base.includes(' - ')) seeds.add(base.split(' - ')[0].trim());

        // Apply suffix stripping to EVERY seed (catches "Title S3: Arc Name")
        const results = new Set(seeds);
        for (const seed of seeds) {
            const s1 = stripSuffix(seed);
            if (s1 !== seed) {
                results.add(s1);
                const s2 = stripSuffix(s1);  // double-strip edge case
                if (s2 !== s1) results.add(s2);
            }
        }

        return [...results].filter(v => v.length > 0);
    }

    // ── Build index ───────────────────────────────────────────────────
    const buildIndex = data => {
        titleIndex.clear();
        for (const anime of data) {
            const malSrc = anime.sources?.find(s => s.includes('myanimelist.net/anime/'));
            if (!malSrc) continue;
            const idM = malSrc.match(/anime\/(\d+)/);
            if (!idM) continue;

            const malId     = idM[1];
            const allTitles = [anime.title, ...(anime.synonyms || [])];
            const tags      = anime.tags || [];
            // score.arithmeticMean from offline DB (free, no API needed)
            const score     = anime.score?.arithmeticMean
                                ? Math.round(anime.score.arithmeticMean * 100) / 100
                                : null;
            const rec = { malId, tags, matchedTitle: anime.title, allTitles, score };

            titleIndex.set(cleanForIndex(anime.title), rec);
            for (const syn of (anime.synonyms || [])) {
                const k = cleanForIndex(syn);
                if (k && !titleIndex.has(k)) titleIndex.set(k, rec);
            }
        }
    };

    // ── loadOfflineDb ─────────────────────────────────────────────────
    const loadOfflineDb = (logCallback, onProgress = null) => {
        return new Promise((resolve, reject) => {
            if (offlineDb) return resolve(offlineDb);
            logCallback('[INFO] Memuat anime-offline-database-minified.json...');

            if (isNode) {
                const fs = require('fs'), path = require('path');
                // __dirname is undefined when piped via stdin (curl | node)
                const _dir = (typeof __dirname !== 'undefined' && __dirname) ? __dirname : process.cwd();
                const localPath = path.join(_dir, 'anime-offline-database-minified.json');

                if (fs.existsSync(localPath)) {
                    try {
                        logCallback('[INFO] Membaca file lokal...');
                        const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
                        offlineDb    = parsed.data || parsed;
                        buildIndex(offlineDb);
                        logCallback(`[SUCCESS] Lokal: ${offlineDb.length} entri, ${titleIndex.size} judul.`);
                        return resolve(offlineDb);
                    } catch(err) {
                        logCallback('[WARN] File lokal gagal: ' + err.message + ' — download...');
                    }
                } else {
                    logCallback('[INFO] File lokal tidak ada — mengunduh dari GitHub Releases...');
                }

                logCallback('[INFO] URL: ' + GITHUB_DB);
                logCallback('[INFO] ~60MB, harap tunggu...');

                const download = (url, hops = 0) => {
                    if (hops > 5) return reject(new Error('Too many redirects'));
                    const mod = url.startsWith('https') ? require('https') : require('http');
                    mod.get(url, res => {
                        if (res.statusCode === 301 || res.statusCode === 302)
                            return download(res.headers.location, hops + 1);
                        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                        const chunks = [];
                        let downloaded = 0;
                        res.on('data', chunk => {
                            chunks.push(chunk);
                            downloaded += chunk.length;
                            if (downloaded % (5 * 1024 * 1024) < chunk.length)
                                logCallback(`[INFO] Download: ${(downloaded / 1024 / 1024).toFixed(0)}MB`);
                        });
                        res.on('end', () => {
                            try {
                                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                                offlineDb    = parsed.data || parsed;
                                buildIndex(offlineDb);
                                logCallback(`[SUCCESS] Download selesai: ${offlineDb.length} entri.`);
                                resolve(offlineDb);
                            } catch(e) { reject(e); }
                        });
                        res.on('error', reject);
                    }).on('error', reject);
                };
                return download(GITHUB_DB);
            }

            // Browser: try relative dir, then db/ subfolder, then ask user to upload
            const BROWSER_PATHS = [
                './anime-offline-database-minified.json',           // same folder as index.html
                './db/anime-offline-database-minified.json',        // db/ subfolder
            ];
            const tryNext = (paths, idx) => {
                if (idx >= paths.length) {
                    // All paths failed — tell user to upload the file manually
                    return reject(new Error(
                        'File anime-offline-database-minified.json tidak ditemukan. ' +
                        'Letakkan di folder yang sama dengan index.html atau di subfolder db/, ' +
                        'atau gunakan tombol Upload DB untuk mengunggahnya secara manual.'
                    ));
                }
                const url = paths[idx];
                logCallback('[INFO] Mencoba: ' + url);
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.responseType = 'json';
                xhr.onprogress = e => { if (onProgress) onProgress(e.loaded, e.lengthComputable ? e.total : 61000000); };
                xhr.onload = () => {
                    if (xhr.status !== 200) {
                        logCallback('[WARN] Tidak ditemukan di ' + url + ' — mencoba lokasi berikutnya...');
                        return tryNext(paths, idx + 1);
                    }
                    const parsed = xhr.response?.data || xhr.response;
                    if (!Array.isArray(parsed)) {
                        logCallback('[WARN] Format tidak valid di ' + url + ' — mencoba lokasi berikutnya...');
                        return tryNext(paths, idx + 1);
                    }
                    offlineDb = parsed;
                    buildIndex(offlineDb);
                    logCallback('[SUCCESS] Dimuat dari ' + url + ': ' + offlineDb.length + ' entri, ' + titleIndex.size + ' judul.');
                    resolve(offlineDb);
                };
                xhr.onerror = () => {
                    logCallback('[WARN] Error jaringan di ' + url + ' — mencoba lokasi berikutnya...');
                    tryNext(paths, idx + 1);
                };
                xhr.send();
            };
            tryNext(BROWSER_PATHS, 0);
        });
    };

    // ── diceCoefficient ───────────────────────────────────────────────
    // Bigram-based similarity score (0–1). "tondemo" vs "tondemos" → ~0.92
    const diceCoefficient = (s1, s2) => {
        if (s1 === s2) return 1;
        if (s1.length < 2 || s2.length < 2) return 0;
        const b1 = new Set(), b2 = new Set();
        for (let i = 0; i < s1.length - 1; i++) b1.add(s1.slice(i, i + 2));
        for (let i = 0; i < s2.length - 1; i++) b2.add(s2.slice(i, i + 2));
        let hit = 0;
        for (const b of b1) if (b2.has(b)) hit++;
        return (2 * hit) / (b1.size + b2.size);
    };

    // ── findRecord ────────────────────────────────────────────────────
    // Four-tier matching (stops at first hit per variation):
    //
    // 1. EXACT   — cleanForIndex(variation) === titleIndex key
    //
    // 2. PREFIX  — DB key STARTS WITH our key (min 4 chars)
    //              Handles BOFURI-type: "bofuri" → finds "bofuriidontwant..."
    //
    // 3. PARTIAL — one contains the other, shorter ≥ 10 chars, ratio ≥ 0.70
    //              Blocks short false-positives like "ars" vs "giantbeastofars".
    //
    // 4. FUZZY   — Dice Coefficient ≥ 0.85, key ≥ 15 chars, length diff ≤ 5
    //              Catches near-misses like "tondemo" DB vs "tondemos" search.
    //              Uses matchScore (NOT score) to avoid colliding with the
    //              anime's actual DB rating stored in rec.score.
    //
    // NOT FIXABLE by matching alone:
    //   ~42 purely Indonesian titles with no English/Japanese DB synonym.
    const findRecord = animeName => {
        if (titleIndex.size === 0) return null;
        const variations = makeVariations(animeName);

        // Tiers 1–3: fast structural matching
        for (const v of variations) {
            const key = cleanForIndex(v);
            if (!key) continue;

            // 1. Exact
            if (titleIndex.has(key))
                return { ...titleIndex.get(key), matchedAs: v, matchType: 'exact' };

            // 2. Prefix
            if (key.length >= 4) {
                for (const [k, rec] of titleIndex) {
                    if (k.startsWith(key))
                        return { ...rec, matchedAs: v, matchType: 'prefix' };
                }
            }

            // 3. Ratio partial
            if (key.length >= 10) {
                for (const [k, rec] of titleIndex) {
                    if (k.length < 10) continue;
                    if (!(k.includes(key) || key.includes(k))) continue;
                    const shorter = Math.min(key.length, k.length);
                    const longer  = Math.max(key.length, k.length);
                    if (shorter / longer >= 0.70)
                        return { ...rec, matchedAs: v, matchType: 'partial' };
                }
            }
        }

        // Tier 4: Fuzzy — only runs if tiers 1–3 all failed
        for (const v of variations) {
            const key = cleanForIndex(v);
            if (key.length < 15) continue;  // short keys too risky for fuzzy
            let best = null, bestMatchScore = 0;
            for (const [k, rec] of titleIndex) {
                if (Math.abs(k.length - key.length) > 5) continue;  // length gate
                const sc = diceCoefficient(key, k);
                if (sc > bestMatchScore) { bestMatchScore = sc; best = rec; }
            }
            // matchScore ≠ score — rec.score is the anime's DB rating (e.g. 7.5)
            // matchScore is the dice similarity (e.g. 0.91) — kept separate
            if (bestMatchScore >= 0.85)
                return { ...best, matchedAs: v, matchType: 'fuzzy', matchScore: bestMatchScore };
        }

        return null;
    };

    const findMalId = animeName => { const r = findRecord(animeName); return r ? r.malId : null; };

    // ── Jikan — overwrites tags, adds synopsis + demographics ─────────
    const fetchJikan = async malId => {
        const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
        if (res.status === 429) { await sleep(2000); return fetchJikan(malId); }
        const data = await res.json();
        if (data?.data) {
            const d = data.data;
            return {
                tags:         [...(d.genres?.map(g => g.name) || []), ...(d.themes?.map(t => t.name) || [])],
                synopsis:     d.synopsis || null,
                demographics: d.demographics?.map(x => x.name) || []
            };
        }
        return null;
    };

    // ── getMetadata ───────────────────────────────────────────────────
    const getMetadata = animeName => {
        if (!storage) return null;
        const raw = storage.getItem(LS_PREFIX + animeName);
        if (!raw) return null;
        const d = JSON.parse(raw);
        return d.not_found ? null : d;
    };

    // ── clearAll ──────────────────────────────────────────────────────
    const clearAll = () => {
        // Also wipe the in-memory snapshot so loadMetadataJson re-fetches
        _inMemoryMeta = null;
        if (!storage) return 0;
        if (isNode) {
            const fs = require('fs'), path = require('path');
            fs.writeFileSync(path.join(__dirname, 'metadata.json'), '{}');
            if (storage._raw) for (const k of Object.keys(storage._raw)) delete storage._raw[k];
            console.log('[clearAll] metadata.json dikosongkan.');
            return -1;
        }
        const toDelete = [];
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i); if (k?.startsWith(LS_PREFIX)) toDelete.push(k);
        }
        toDelete.forEach(k => storage.removeItem(k));
        return toDelete.length;
    };

    // ── batchProcess ──────────────────────────────────────────────────
    //
    // mode = 'debug'  — match only, NO storage writes, NO Jikan.
    //                   Stats are accurate (counted separately from queue).
    //                   Use: node metadata.js --debug
    //
    // mode = 'phase1' — Phase 1 only: writes { malId, tags, allTitles, score }
    //                   to storage immediately. NO Jikan. Safe to run anytime,
    //                   genre filter + search + score display work after this.
    //                   Use: node metadata.js --phase1
    //
    // mode = 'full'   — Phase 1 + Phase 2 Jikan. Overwrites tags with curated
    //                   titlecase list, adds synopsis + demographics.
    //                   Use: node metadata.js  (default)
    //
    // ── WHY STATS WERE BROKEN ────────────────────────────────────────
    // fetchQueue was the ONLY counter. It was only populated inside
    // `if (!isDebugMode)`, so debug mode always showed "0 MAL ID unik"
    // even when hundreds of titles were matched. Now matchCount/notFoundCount
    // are tracked independently — always accurate regardless of mode.
    //
    const batchProcess = async (animeList, callbacks, mode = 'full') => {
        // Accept legacy boolean isDebugMode for backwards compat
        if (mode === true)  mode = 'debug';
        if (mode === false) mode = 'full';

        const onLog      = callbacks.onLog      || console.log;
        const onStatus   = callbacks.onStatus   || (() => {});
        const onProgress = callbacks.onProgress || (() => {});
        const saveData   = (mode === 'phase1' || mode === 'full');
        const runJikan   = (mode === 'full');

        onStatus('Memuat Database...');
        try {
            await loadOfflineDb(onLog, (loaded, total) => {
                if (total) onStatus(`Memuat DB: ${Math.round(loaded / total * 100)}%`);
            });
        } catch(e) { onLog('[ERROR] ' + e.message); onStatus('Gagal.'); return; }

        const fetchQueue = new Map(); // only used for Jikan phase
        let matchCount = 0, notFoundCount = 0, skipCount = 0;

        onLog(`\n--- FASE 1: RAM MATCHING [mode: ${mode}] ---`);
        for (let i = 0; i < animeList.length; i++) {
            const animeName = animeList[i].name;
            onProgress(i + 1, animeList.length);

            // Check cache — skip if already fully processed (has synopsis)
            // In debug/phase1 mode: still skip fully-done entries to show clean output
            if (storage && mode !== 'debug') {
                const cached = storage.getItem(LS_PREFIX + animeName);
                if (cached) {
                    const d = JSON.parse(cached);
                    // synopsis = fully done (Jikan ran). Skip in full mode.
                    if (d.synopsis !== undefined && runJikan) {
                        skipCount++;
                        onLog(`[SKIP] ${animeName}`);
                        continue;
                    }
                    // Has MAL ID but no synopsis yet = Phase 1 done, Jikan pending
                    if (d.malId && runJikan) {
                        if (!fetchQueue.has(d.malId)) fetchQueue.set(d.malId, []);
                        fetchQueue.get(d.malId).push(animeName);
                        matchCount++;
                        onLog(`[PARTIAL] ${animeName} -> MAL:${d.malId} (Jikan pending)`);
                        continue;
                    }
                    // not_found cached — skip in full/phase1, re-run in debug
                    if (d.not_found) {
                        skipCount++;
                        onLog(`[SKIP-MISS] ${animeName}`);
                        continue;
                    }
                }
            }

            const rec = findRecord(animeName);
            if (rec) {
                matchCount++;
                onLog(`[ID KETEMU] ${animeName} -> MAL:${rec.malId} [${rec.matchType}: "${rec.matchedAs}"]`);
                if (saveData && storage) {
                    storage.setItem(LS_PREFIX + animeName, JSON.stringify({
                        malId:        rec.malId,
                        tags:         rec.tags,         // offline DB (lowercase)
                        matchedTitle: rec.matchedTitle,
                        allTitles:    rec.allTitles,
                        score:        rec.score,        // from offline DB, free
                    }));
                }
                if (runJikan) {
                    if (!fetchQueue.has(rec.malId)) fetchQueue.set(rec.malId, []);
                    fetchQueue.get(rec.malId).push(animeName);
                }
            } else {
                notFoundCount++;
                onLog(`[TIDAK KETEMU] ${animeName}`);
                if (saveData && storage) {
                    storage.setItem(LS_PREFIX + animeName, JSON.stringify({ not_found: true }));
                }
            }
        }

        // ── Stats — always accurate now (counted independently from queue) ──
        const uniqueIds = Array.from(fetchQueue.keys());
        onLog(`\n[STATISTIK] Total: ${animeList.length} | Ketemu: ${matchCount} | Tidak: ${notFoundCount} | Skip: ${skipCount} | MAL unik: ${uniqueIds.length}`);
        onLog(`[AKURASI] ${(matchCount / (matchCount + notFoundCount) * 100).toFixed(1)}% (dari ${matchCount + notFoundCount} yang diproses)`);

        if (mode === 'debug') {
            onLog('[DEBUG] Tidak ada data yang disimpan.');
            onStatus('Selesai (Debug)');
            return;
        }
        if (mode === 'phase1') {
            onLog('[PHASE1] Data disimpan. Jikan dilewati — jalankan tanpa --phase1 untuk synopsis.');
            onStatus('✅ Phase 1 Selesai!');
            return;
        }
        if (uniqueIds.length === 0) { onStatus('Selesai'); return; }

        onLog(`\n--- FASE 2: JIKAN (tags + synopsis + demographics) untuk ${uniqueIds.length} ID ---`);
        let count = 0;
        for (const malId of uniqueIds) {
            count++;
            const titles = fetchQueue.get(malId);
            onStatus(`Jikan ${count}/${uniqueIds.length}: MAL:${malId}`);
            onProgress(count, uniqueIds.length);
            onLog(`[FETCH] MAL:${malId} → ${titles.join(', ')}`);
            try {
                const jikan = await fetchJikan(malId);
                for (const title of titles) {
                    const existing = JSON.parse(storage.getItem(LS_PREFIX + title) || '{}');
                    storage.setItem(LS_PREFIX + title, JSON.stringify({
                        ...existing,
                        tags:         jikan?.tags         ?? existing.tags ?? [],
                        synopsis:     jikan?.synopsis     ?? null,
                        demographics: jikan?.demographics ?? [],
                    }));
                    onLog(`[SUCCESS] ${title}`);
                }
            } catch(e) { onLog(`[ERROR] MAL:${malId}: ${e.message}`); }
            await sleep(1500);
        }
        onStatus('✅ Selesai!');
    };

    // ── Node CLI ──────────────────────────────────────────────────────
    // node metadata.js           → full (Phase 1 + Jikan)
    // node metadata.js --phase1  → Phase 1 only (save MAL IDs, no Jikan)
    // node metadata.js --debug   → dry run (no saves, accurate stats)
    if (isNode && require.main === module) {
        const fs = require('fs'), path = require('path');
        const mode = process.argv.includes('--debug')  ? 'debug'
                   : process.argv.includes('--phase1') ? 'phase1'
                   : 'full';
        const jsonPath = path.join(__dirname, 'anime_data.json');
        if (!fs.existsSync(jsonPath)) { console.log('[ERROR] anime_data.json tidak ditemukan!'); process.exit(1); }
        const animeList = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).anime_list || [];
        console.log(`Metadata Sync — mode: ${mode.toUpperCase()} — ${animeList.length} anime`);
        batchProcess(animeList, {
            onLog:      msg => console.log(msg),
            onStatus:   msg => process.stdout.write('\r' + msg + '                    '),
            onProgress: () => {}
        }, mode).then(() => console.log('\nSelesai.'));
    }

    // ── TAG_ALIAS_MAP ─────────────────────────────────────────────────────
    // Maps low-frequency typographic variants → canonical (most-frequent) form.
    // 47 aliases covering 45 duplicate groups found by frequency analysis of the
    // offline DB's 568,614 tag instances. Duplicates like 'sci-fi'/'sci fi'
    // collapse into a single genre pill when buildGenrePills() runs.
    const TAG_ALIAS_MAP = {
        'after school club':            'afterschool club',
        'all girls school':             'all-girls school',
        'anti war':                     'anti-war',
        'antihero':                     'anti-hero',
        'avant-garde':                  'avant garde',
        'bakumatsu meiji period':       'bakumatsu - meiji period',
        'bi-shounen':                   'bishounen',
        'cat girls':                    'catgirls',
        'coming-of-age':                'coming of age',
        'cross dressing':               'crossdressing',
        'cross-dressing':               'crossdressing',
        'dark skinned girl':            'dark-skinned girl',
        'ero-guro':                     'ero guro',
        'esports':                      'e-sports',
        'fan service':                  'fanservice',
        'fan-service':                  'fanservice',
        'ganime':                       'ga-nime',
        'genderbending':                'gender bending',
        'high-stakes game':             'high stakes game',
        'host club':                    'host-club',
        'human-experimentation':        'human experimentation',
        'ice-skating':                  'ice skating',
        'iyashi-kei':                   'iyashikei',
        'manga-ka':                     'mangaka',
        'martial-arts':                 'martial arts',
        'monster-of-the-week':          'monster of the week',
        'post apocalyptic':             'post-apocalyptic',
        'post war':                     'post-war',
        'reverse-harem':                'reverse harem',
        'school-life':                  'school life',
        'sci fi':                       'sci-fi',
        'science-fiction':              'science fiction',
        'shoujo-ai':                    'shoujo ai',
        'shounen ai':                   'shounen-ai',
        'slice-of-life':                'slice of life',
        'slow paced':                   'slow-paced',
        'steam punk':                   'steampunk',
        'stop-motion animation':        'stop motion animation',
        'student teacher relationship': 'student-teacher relationship',
        'super hero':                   'superhero',
        'super powers':                 'superpowers',
        'superpower':                   'super power',
        'sword-fights':                 'swordfights',
        'time-travel':                  'time travel',
        'watersports':                  'water sports',
        'yuki-onna':                    'yukionna',
        'zashiki warashi':              'zashiki-warashi',
    };

    const normalizeTag = t => TAG_ALIAS_MAP[t] || t;

    const normalizeTags = tags => {
        // Deduplicate AFTER aliasing so 'sci-fi' + 'sci fi' collapse to one.
        const seen = new Set(), out = [];
        for (const t of tags) {
            const n = normalizeTag(t);
            if (!seen.has(n)) { seen.add(n); out.push(n); }
        }
        return out;
    };

    // ── In-memory metadata stores ─────────────────────────────────────────
    //
    // Priority 1 — localStorage (meta_<N>):
    //   Written ONLY by Jikan on-demand fetch (player page opens an anime).
    //   Contains curated TitleCase tags + synopsis + demographics.
    //   Phase1 in BROWSER never writes here — only RAM.
    //   Node CLI phase1 writes to LS to build metadata.json.
    //
    // Priority 2 — _inMemoryMeta  { LS_PREFIX+animeName → metadata }:
    //   Loaded from server metadata.json (or browser RAM phase1 result).
    //   Never written to localStorage — gone on page close.
    //
    // Priority 3 — titleIndex (offline DB in RAM):
    //   Built by loadOfflineDb() / setupMetadata. Available to enrichAnimeList
    //   AND to setMalResolver so update_data.js can pre-annotate videos.
    let _inMemoryMeta = null;

    // ── loadMetadataJson ──────────────────────────────────────────────────
    // Browser-only. Fetches metadata.json → _inMemoryMeta (RAM, no LS write).
    const loadMetadataJson = async () => {
        if (isNode) return false;
        try {
            const res = await fetch('metadata.json', { cache: 'no-cache' });
            if (!res.ok) return false;
            const obj = await res.json();
            if (!obj || typeof obj !== 'object') return false;
            _inMemoryMeta = obj;
            return Object.keys(obj).length > 0;
        } catch(e) { return false; }
    };

    // ── enrichAnimeList ───────────────────────────────────────────────────
    // Attaches allTitles[] and tags[] to every anime.
    //
    // Per-entry priority (ALWAYS checked independently — no list-level short-circuit):
    //   1. localStorage  — Jikan curated TitleCase tags + synopsis
    //   2. _inMemoryMeta — metadata.json (or browser RAM phase1)
    //   3. titleIndex    — offline DB in RAM (built by setupMetadata)
    //
    // IMPORTANT: having even 1 LS entry must NOT block other entries from
    // getting priority-2/3 data. The OLD bug was a list-level early-return in
    // setupMetadata ("if any LS entry → return"). Fixed: setupMetadata now
    // always loads ALL RAM sources; enrichAnimeList checks them per-entry.
    const enrichAnimeList = list => {
        let count = 0;
        const result = list.map(a => {
            try {
                const key = LS_PREFIX + a.name;

                // P1: localStorage (Jikan, written when user visits player page)
                let lsData = null;
                if (storage) {
                    const raw = storage.getItem(key);
                    if (raw) lsData = JSON.parse(raw);
                }
                const lsOk = lsData && !lsData.not_found;

                // P2: _inMemoryMeta (metadata.json loaded by setupMetadata)
                const memData = _inMemoryMeta?.[key] || null;
                const memOk   = memData && !memData.not_found;

                // P3: titleIndex — offline DB already in RAM
                const dbRec = titleIndex.size > 0 ? (findRecord(a.name) || null) : null;
                const dbOk  = dbRec && !dbRec.not_found;

                if (!lsOk && !memOk && !dbOk) return { ...a, allTitles: [], tags: [] };
                count++;

                // Tags: Jikan TitleCase wins over offline DB lowercase
                let tags = [];
                if      (lsOk  && lsData.tags?.length)  tags = lsData.tags;
                else if (memOk && memData.tags?.length)  tags = memData.tags;
                else if (dbOk  && dbRec.tags?.length)    tags = dbRec.tags;

                // allTitles: offline DB has most synonyms (all languages)
                let allTitles = [];
                if      (dbOk  && dbRec.allTitles?.length)   allTitles = dbRec.allTitles;
                else if (memOk && memData.allTitles?.length)  allTitles = memData.allTitles;
                else if (lsOk  && lsData.allTitles?.length)  allTitles = lsData.allTitles;

                return { ...a, allTitles, tags: normalizeTags(tags) };
            } catch(e) {}
            return { ...a, allTitles: [], tags: [] };
        });
        enrichAnimeList.lastCount = count;
        return result;
    };

    // ── setupMetadata ─────────────────────────────────────────────────────
    // Browser-only coordinator. Called once on page load.
    //
    // OLD BUG: returned early if ANY localStorage entry existed, so priority
    // 2 (metadata.json) and 3 (offline DB) never loaded into RAM. New anime
    // added since last Jikan run had no tags or synonyms.
    //
    // FIX: ALWAYS load both RAM sources regardless of LS state.
    //   setupMetadata loads priority 2 + 3 into RAM.
    //   enrichAnimeList picks LS > _inMemoryMeta > titleIndex per-entry.
    //   Jikan on-demand (fetchJikanForAnime) writes to LS for that one anime.
    const setupMetadata = async animeList => {
        if (isNode) return;

        // Priority 2: always load metadata.json → _inMemoryMeta
        const loaded = await loadMetadataJson();
        console.log(loaded
            ? '[Metadata] metadata.json → RAM (P2 active, ' + Object.keys(_inMemoryMeta).length + ' entries)'
            : '[Metadata] metadata.json not available');

        // Priority 3: always load offline DB → titleIndex
        // Used by enrichAnimeList P3 AND by setMalResolver in update_data.js.
        // If offline DB unavailable, gracefully skip — site still works via P1+P2.
        if (!offlineDb) {
            try {
                await loadOfflineDb(() => {});
                console.log('[Metadata] Offline DB → RAM (P3 active, ' + titleIndex.size + ' title keys)');
            } catch(e) {
                console.warn('[Metadata] Offline DB unavailable (place anime-offline-database-minified.json alongside):', e.message);
            }
        }
        // P1 (localStorage) is read per-entry in enrichAnimeList — no batch needed here.
        // New anime not in metadata.json get P3 coverage from titleIndex.
    };

    // ── fetchJikanForAnime ────────────────────────────────────────────────
    // On-demand Jikan fetch for ONE anime. Call from player.html when an
    // anime is opened (NOT from setupMetadata — no batch fetching).
    //
    // Writes to localStorage — overwrites phase1/metadata.json tags with
    // curated TitleCase Jikan tags + adds synopsis + demographics.
    // Returns the stored data object, or null on failure.
    const fetchJikanForAnime = async (animeName) => {
        if (isNode) return null;
        const key = LS_PREFIX + animeName;

        // Already have full Jikan data?
        if (storage) {
            const raw = storage.getItem(key);
            if (raw) {
                const d = JSON.parse(raw);
                if (d.synopsis !== undefined) return d;  // already fetched
            }
        }

        // Find MAL ID — titleIndex first (loaded by setupMetadata), LS fallback
        let malId = null;
        const rec = titleIndex.size > 0 ? findRecord(animeName) : null;
        if (rec) malId = rec.malId;
        if (!malId && storage) {
            const raw = storage.getItem(key);
            if (raw) { const d = JSON.parse(raw); malId = d.malId || null; }
        }
        if (!malId && _inMemoryMeta?.[key]) malId = _inMemoryMeta[key].malId || null;
        if (!malId) return null;

        try {
            const jikan = await fetchJikan(malId);
            if (!jikan) return null;
            // Merge with any existing P2/P3 data for allTitles/score
            const base = rec || (_inMemoryMeta?.[key]) || {};
            const toStore = {
                malId,
                tags:         jikan.tags         ?? base.tags         ?? [],
                allTitles:    base.allTitles      ?? [],
                score:        base.score          ?? null,
                synopsis:     jikan.synopsis      ?? null,
                demographics: jikan.demographics  ?? [],
            };
            if (storage) storage.setItem(key, JSON.stringify(toStore));
            return toStore;
        } catch(e) {
            console.warn('[Metadata] Jikan failed for', animeName, ':', e.message);
            return null;
        }
    };

    // ── injectOfflineDb ───────────────────────────────────────────────
    // Browser-only. Lets the user upload anime-offline-database-minified.json
    // directly — the data is pre-parsed by the caller and injected here.
    // Sets offlineDb + rebuilds titleIndex, so subsequent batchProcess calls
    // skip the HTTP fetch and use the injected data instead.
    const injectOfflineDb = (arr) => {
        if (!Array.isArray(arr)) throw new Error('injectOfflineDb: expected an array');
        offlineDb = arr;
        buildIndex(offlineDb);
        console.log('[AnimeMetadata] injectOfflineDb: ' + offlineDb.length + ' entries, ' + titleIndex.size + ' title keys');
        return offlineDb.length;
    };

    return { loadOfflineDb, getMetadata, batchProcess, findMalId, findRecord, clearAll,
             normalizeTag, normalizeTags, enrichAnimeList, loadMetadataJson, setupMetadata,
             fetchJikanForAnime, injectOfflineDb };
}));
