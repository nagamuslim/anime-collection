/**
 * bookmark.js  —  Watch-history tracker + "Lanjutkan Menonton" popup
 * ════════════════════════════════════════════════════════════════════
 * Add to ANY page with ONE tag (no defer — needed synchronously):
 *
 *   <script src="bookmark.js" onerror="void 0"></script>
 *
 * "Bookmark" here means WATCH HISTORY only:
 *   • which series was opened
 *   • which episode was last clicked
 *   • how many different episodes visited per series
 *   • when they last visited
 *
 * No favourite/save toggle — that concept was removed.
 *
 * Stored in localStorage key  "anime_tracking_data"
 * SEPARATE from key  "anime_data"  (managed by update_data.js).
 *
 * ── BookmarkManager API ─────────────────────────────────────────────
 *   trackProgress(animeName, videoId, epNumber, epTitle, timeSeconds)
 *       Call when user opens/switches to an episode.
 *
 *   getAnimeData(animeName)    → object | null
 *   getContinueWatching()      → object | null  (most-recent series)
 *   getWatchHistory()          → array, newest first (all visited)
 *   clearEntry(animeName)      → remove one series from history
 *   clearAll()                 → wipe entire history
 *
 * ── ContinueWatching API ────────────────────────────────────────────
 *   index.html  → popup appears automatically ~900ms after load.
 *
 *   player.html → call from onPlayerReady (YT IFrame API):
 *
 *     ContinueWatching.initPlayer(
 *         animeName,      // string
 *         epNumber,       // number
 *         epTitle,        // string
 *         () => ytPlayer  // getter returning YT.Player object
 *     );
 *
 *   Before switching episode / page unload:
 *     ContinueWatching.stopPlayer();
 * ════════════════════════════════════════════════════════════════════
 */

// ══════════════════════════════════════════════════════════════════════
// 1. BookmarkManager  — watch history, no favourites
// ══════════════════════════════════════════════════════════════════════
var BookmarkManager = (function () {
    'use strict';

    var KEY = 'anime_tracking_data'; // intentionally different from anime_data

    function getData() {
        try {
            var raw = localStorage.getItem(KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function saveData(data) {
        try {
            localStorage.setItem(KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('BookmarkManager: localStorage write failed —', e.message);
        }
    }

    return {

        /**
         * Record that the user opened/switched to an episode.
         * visitCount increments only when the video_id changes
         * (i.e. actually switching to a different episode, not just
         * re-entering the same one on page reload).
         */
        trackProgress: function (animeName, videoId, epNumber, epTitle, timeSeconds) {
            var data = getData();
            if (!data[animeName]) data[animeName] = { visitCount: 0 };

            if (data[animeName].lastWatchedVideoId !== videoId) {
                data[animeName].visitCount = (data[animeName].visitCount || 0) + 1;
            }
            data[animeName].lastWatchedVideoId       = videoId;
            data[animeName].lastWatchedEpisodeNumber = epNumber;
            data[animeName].lastWatchedEpisodeTitle  = epTitle;
            data[animeName].lastWatchedAt            = Date.now();
            
            if (typeof timeSeconds === 'number' && timeSeconds > 5) {
                data[animeName].lastWatchedTime = Math.floor(timeSeconds);
            }
            
            saveData(data);
        },

        /** All stored tracking data for one series, or null. */
        getAnimeData: function (animeName) {
            return getData()[animeName] || null;
        },

        /**
         * Most-recently-visited series — used by the popup on index.html.
         * Returns null if history is empty.
         */
        getContinueWatching: function () {
            var data = getData();
            var list = Object.entries(data)
                .filter(function (e) { return e[1].lastWatchedAt && e[1].lastWatchedVideoId; })
                .map(function (e) { return Object.assign({ name: e[0] }, e[1]); })
                .sort(function (a, b) { return b.lastWatchedAt - a.lastWatchedAt; });
            return list.length > 0 ? list[0] : null;
        },

        /**
         * All series with watch history, newest first.
         * Use this for a history/watch-list page.
         */
        getWatchHistory: function () {
            var data = getData();
            return Object.entries(data)
                .filter(function (e) { return e[1].lastWatchedAt; })
                .map(function (e) { return Object.assign({ name: e[0] }, e[1]); })
                .sort(function (a, b) { return b.lastWatchedAt - a.lastWatchedAt; });
        },

        /** Remove one series from history. */
        clearEntry: function (animeName) {
            var data = getData();
            delete data[animeName];
            saveData(data);
        },

        /** Wipe all watch history. */
        clearAll: function () {
            try { localStorage.removeItem(KEY); } catch (e) {}
        }
    };
}());


// ══════════════════════════════════════════════════════════════════════
// 2. ContinueWatching  — popup (index) + YT API polling (player)
// ══════════════════════════════════════════════════════════════════════
var ContinueWatching = (function () {
    'use strict';

    // ── Inject CSS once ────────────────────────────────────────────────
    var _stylesInjected = false;
    function injectStyles() {
        if (_stylesInjected) return;
        _stylesInjected = true;
        var s = document.createElement('style');
        s.textContent = [
            '#cw-popup{position:fixed;bottom:24px;right:24px;z-index:9998;',
                'background:rgba(15,12,41,0.96);',
                'border:1px solid rgba(255,255,255,0.13);border-radius:16px;',
                'padding:16px 18px 14px;width:300px;',
                'box-shadow:0 12px 40px rgba(0,0,0,0.6);',
                'backdrop-filter:blur(16px);',
                'font-family:"Segoe UI",Tahoma,sans-serif;',
                'animation:cw-in .38s cubic-bezier(.22,.68,0,1.2) both;',
                'transition:opacity .3s,transform .3s}',
            '#cw-popup.cw-hiding{opacity:0;transform:translateY(16px);pointer-events:none}',
            '@keyframes cw-in{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}',
            '#cw-popup .cw-label{font-size:.68em;color:#667eea;font-weight:700;',
                'text-transform:uppercase;letter-spacing:1.2px;',
                'margin-bottom:6px;display:flex;align-items:center;gap:5px}',
            '#cw-popup .cw-label::before{content:"▶";font-size:.85em}',
            '#cw-popup .cw-title{color:#fff;font-weight:700;font-size:.97em;',
                'line-height:1.35;margin-bottom:3px;',
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '#cw-popup .cw-ep{color:#a8e6cf;font-size:.78em;margin-bottom:13px;',
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '#cw-popup .cw-actions{display:flex;gap:8px}',
            '#cw-popup .cw-btn{flex:1;padding:8px 10px;border-radius:9px;border:none;',
                'cursor:pointer;font-size:.83em;font-weight:600;',
                'text-decoration:none;text-align:center;line-height:1.2;',
                'transition:opacity .2s,background .2s;',
                'display:flex;align-items:center;justify-content:center;gap:4px}',
            '#cw-popup .cw-go{',
                'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff}',
            '#cw-popup .cw-go:hover{opacity:.84}',
            '#cw-popup .cw-dismiss{background:rgba(255,255,255,.07);color:#999;',
                'border:1px solid rgba(255,255,255,.1);flex:0 0 auto;padding:8px 12px}',
            '#cw-popup .cw-dismiss:hover{background:rgba(255,255,255,.14);color:#ccc}',
            '@media(max-width:480px){#cw-popup{left:12px;right:12px;bottom:12px;width:auto}}'
        ].join('');
        document.head.appendChild(s);
    }

    function esc(str) {
        return String(str)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── index.html : show popup ────────────────────────────────────────
    function initIndex() {
        var item = BookmarkManager.getContinueWatching();
        if (!item) return;

        injectStyles();

        var epText = item.lastWatchedEpisodeNumber
            ? 'Episode ' + item.lastWatchedEpisodeNumber +
              (item.lastWatchedEpisodeTitle ? ' \u00b7 ' + item.lastWatchedEpisodeTitle : '')
            : 'Terakhir ditonton';

        var url = 'player.html?anime=' + encodeURIComponent(item.name) +
                  (item.lastWatchedEpisodeNumber ? '&episode=' + item.lastWatchedEpisodeNumber : '');

        var popup = document.createElement('div');
        popup.id = 'cw-popup';
        popup.setAttribute('role','status');
        popup.setAttribute('aria-live','polite');
        popup.innerHTML =
            '<div class="cw-label">Lanjutkan Menonton</div>' +
            '<div class="cw-title">' + esc(item.name) + '</div>' +
            '<div class="cw-ep">' + esc(epText) + '</div>' +
            '<div class="cw-actions">' +
                '<a class="cw-btn cw-go" href="' + url + '">&#9654; Lanjutkan</a>' +
                '<button class="cw-btn cw-dismiss" id="cw-x" aria-label="Tutup">&#10005;</button>' +
            '</div>';

        document.body.appendChild(popup);

        function dismiss() {
            popup.classList.add('cw-hiding');
            setTimeout(function () {
                if (popup.parentNode) popup.parentNode.removeChild(popup);
            }, 320);
        }
        document.getElementById('cw-x').addEventListener('click', dismiss);
        setTimeout(dismiss, 12000); // auto-dismiss after 12 s
    }

    // ── player.html : polling tracker via YT IFrame API ───────────────
    //
    // YT player states used here:
    //   -1 = unstarted
    //    0 = ended        ← save immediately
    //    1 = playing      ← save every SAVE_EVERY_S real seconds
    //    2 = paused
    //    3 = buffering
    //    5 = video cued
    //
    // getVideoLoadedFraction() → 0–1 buffered fraction (not used for
    // save-gating but available to the caller via the getter).

    var _interval  = null;
    var _lastSaved = -1;
    var POLL_MS      = 5000; // poll interval in ms
    var SAVE_EVERY_S = 15;   // save every 15 s of actual playback

    /**
     * Begin tracking. Call from player.html's onPlayerReady callback.
     * Also call (after stopPlayer) whenever the user switches episodes.
     *
     * @param {string}          animeName  - Series name
     * @param {number}          epNumber   - Episode number now playing
     * @param {string}          epTitle    - Human-readable label
     * @param {Function|Object} getPlayer  - () => YT.Player instance
     */
    function initPlayer(animeName, epNumber, epTitle, getPlayer) {
        stopPlayer(); // always clear previous interval first

        _interval = setInterval(function () {
            var p = (typeof getPlayer === 'function') ? getPlayer() : getPlayer;
            if (!p || typeof p.getPlayerState !== 'function') return;

            var state = p.getPlayerState();
            var t     = p.getCurrentTime(); // seconds elapsed

            // Only track while playing (1) or immediately on end (0)
            if (state !== 1 && state !== 0) return;

            var shouldSave = (_lastSaved < 0 || (t - _lastSaved) >= SAVE_EVERY_S) && state === 1;

            if (shouldSave) {
                _lastSaved = t;
                var videoId = null;
                try { videoId = p.getVideoData().video_id; } catch (e) {}
                BookmarkManager.trackProgress(animeName, videoId, epNumber, epTitle, t);
                console.log('[BookmarkManager] Saved time:', Math.floor(t) + 's', 'for', animeName, 'ep', epNumber);
            } else if (state === 0) {
                var videoId = null;
                try { videoId = p.getVideoData().video_id; } catch (e) {}
                BookmarkManager.trackProgress(animeName, videoId, epNumber, epTitle, null);
            }
        }, POLL_MS);
    }

    /**
     * Stop tracking. Call BEFORE switching episode so the old interval
     * doesn't fire after the new video loads.
     */
    function stopPlayer() {
        if (_interval) { clearInterval(_interval); _interval = null; }
        _lastSaved = -1;
    }

    // ── auto-init on index.html only ──────────────────────────────────
    function autoInit() {
        // index.html has #animeGrid; player.html does not
        if (document.getElementById('animeGrid')) {
            setTimeout(initIndex, 900); // wait for anime data to load
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }

    return { initIndex: initIndex, initPlayer: initPlayer, stopPlayer: stopPlayer };
}());
