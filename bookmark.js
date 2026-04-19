/**
 * bookmark.js  —  Watch-history tracker + "Lanjutkan Menonton" popup + MALSync
 * ════════════════════════════════════════════════════════════════════════════
 * <script src="metadata.js" onerror="void 0"></script>   ← load before this
 * <script src="bookmark.js" onerror="void 0"></script>
 *
 * Stored in localStorage key  "anime_tracking_data"
 *
 * ── BookmarkManager API ──────────────────────────────────────────────
 *   trackProgress(animeName, videoId, epNumber, epTitle, timeSeconds)
 *   getAnimeData(animeName) / getContinueWatching() / getWatchHistory()
 *   clearEntry(animeName)   / clearAll()
 *
 * ── MALSync API ──────────────────────────────────────────────────────
 *   Tokens: cookies (avoids localStorage quota pressure), mirrored to LS.
 *   MAL API: via GAS proxy (MAL blocks browser CORS).
 *   Jikan:  direct + via AnimeMetadata.fetchJikanForAnime when loaded.
 *   Sequel chain: Jikan /full relations → recursive, cached in tracking data.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ══════════════════════════════════════════════════════════════════════
// 1. BookmarkManager
// ══════════════════════════════════════════════════════════════════════
var BookmarkManager = (function () {
    'use strict';

    var KEY = 'anime_tracking_data';
    function getData() { try { var r = localStorage.getItem(KEY); return r ? JSON.parse(r) : {}; } catch(e){ return {}; } }
    function saveData(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch(e){ console.warn('BookmarkManager: write failed —', e.message); } }

    return {
        trackProgress: function (animeName, videoId, epNumber, epTitle, timeSeconds) {
            if (timeSeconds === undefined && !getData()[animeName]) return;
            var data = getData();
            if (!data[animeName]) data[animeName] = { visitCount: 0 };

            var isNewEpisode = (data[animeName].lastWatchedVideoId !== videoId);
            if (isNewEpisode) data[animeName].visitCount = (data[animeName].visitCount || 0) + 1;

            data[animeName].lastWatchedVideoId       = videoId;
            data[animeName].lastWatchedEpisodeNumber = epNumber;
            data[animeName].lastWatchedEpisodeTitle  = epTitle;
            data[animeName].lastWatchedAt            = Date.now();

            if (typeof timeSeconds === 'number' && timeSeconds > 5) {
                data[animeName].lastWatchedTime = Math.floor(timeSeconds);
            } else if (timeSeconds === null || timeSeconds === 0) {
                delete data[animeName].lastWatchedTime;
                // Trigger MAL Completion check on near-end
                if (epNumber && typeof MALSync !== 'undefined' && MALSync.isConnected()) {
                    MALSync.scheduleCompletion(animeName, epNumber);
                }
            }
            saveData(data);

            // Trigger MAL sync on episode switch (not on every 15-second save)
            if (isNewEpisode && epNumber && typeof MALSync !== 'undefined' && MALSync.isConnected()) {
                MALSync.scheduleSyncEpisode(animeName, epNumber);
            }
        },

        getAnimeData:        function(n){ return getData()[n] || null; },
        getContinueWatching: function(){
            var data = getData();
            var list = Object.entries(data)
                .filter(function(e){ return e[1].lastWatchedAt && e[1].lastWatchedVideoId; })
                .map(function(e){ return Object.assign({ name: e[0] }, e[1]); })
                .sort(function(a,b){ return b.lastWatchedAt - a.lastWatchedAt; });
            return list.length ? list[0] : null;
        },
        getWatchHistory: function(){
            var data = getData();
            return Object.entries(data)
                .filter(function(e){ return e[1].lastWatchedAt; })
                .map(function(e){ return Object.assign({ name: e[0] }, e[1]); })
                .sort(function(a,b){ return b.lastWatchedAt - a.lastWatchedAt; });
        },
        clearEntry: function(n){ var d=getData(); delete d[n]; saveData(d); },
        clearAll:   function(){ try{ localStorage.removeItem(KEY); } catch(e){} }
    };
}());


// ══════════════════════════════════════════════════════════════════════
// 2. ContinueWatching
// ══════════════════════════════════════════════════════════════════════
var ContinueWatching = (function () {
    'use strict';

    var _stylesInjected = false;
    function injectStyles() {
        if (_stylesInjected) return; _stylesInjected = true;
        var s = document.createElement('style');
        s.textContent = '#cw-popup{position:fixed;bottom:24px;right:24px;z-index:9998;background:rgba(15,12,41,0.96);border:1px solid rgba(255,255,255,0.13);border-radius:16px;padding:16px 18px 14px;width:300px;box-shadow:0 12px 40px rgba(0,0,0,0.6);backdrop-filter:blur(16px);font-family:"Segoe UI",Tahoma,sans-serif;animation:cw-in .38s cubic-bezier(.22,.68,0,1.2) both;transition:opacity .3s,transform .3s}#cw-popup.cw-hiding{opacity:0;transform:translateY(16px);pointer-events:none}@keyframes cw-in{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}#cw-popup .cw-label{font-size:.68em;color:#667eea;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px;display:flex;align-items:center;gap:5px}#cw-popup .cw-label::before{content:"▶";font-size:.85em}#cw-popup .cw-title{color:#fff;font-weight:700;font-size:.97em;line-height:1.35;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#cw-popup .cw-ep{color:#a8e6cf;font-size:.78em;margin-bottom:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#cw-popup .cw-actions{display:flex;gap:8px}#cw-popup .cw-btn{flex:1;padding:8px 10px;border-radius:9px;border:none;cursor:pointer;font-size:.83em;font-weight:600;text-decoration:none;text-align:center;line-height:1.2;transition:opacity .2s,background .2s;display:flex;align-items:center;justify-content:center;gap:4px}#cw-popup .cw-go{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff}#cw-popup .cw-go:hover{opacity:.84}#cw-popup .cw-dismiss{background:rgba(255,255,255,.07);color:#999;border:1px solid rgba(255,255,255,.1);flex:0 0 auto;padding:8px 12px}#cw-popup .cw-dismiss:hover{background:rgba(255,255,255,.14);color:#ccc}@media(max-width:480px){#cw-popup{left:12px;right:12px;bottom:12px;width:auto}}';
        document.head.appendChild(s);
    }

    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function initIndex() {
        var item = BookmarkManager.getContinueWatching();
        if (!item) return;
        injectStyles();

        function fmtTime(s){ var m=Math.floor(s/60),sc=Math.floor(s%60); return m+':'+(sc<10?'0':'')+sc; }

        var epNum=item.lastWatchedEpisodeNumber, rawTitle=item.lastWatchedEpisodeTitle||'';
        var savedTime=(item.lastWatchedTime&&item.lastWatchedTime>5)?item.lastWatchedTime:null;
        var _displayTime=savedTime;
        if (savedTime && epNum) {
            try {
                var _raw=localStorage.getItem('anime_data');
                if (_raw) {
                    var _p=JSON.parse(_raw), _a=(_p.anime_list||[]).find(function(a){return a.name===item.name;});
                    if (_a) { var _v=(_a.videos||[]).find(function(v){return v.episode===epNum;}); if(_v&&_v.start_seconds>0) _displayTime=savedTime-_v.start_seconds; }
                }
            } catch(e){}
        }
        var isDefault=!rawTitle||/^Episode\s+[\d]+(\s*[-–]\s*[\d]+)?$/i.test(rawTitle.trim());
        var epText=epNum?('Episode '+epNum+(savedTime?(' \u00b7 '+fmtTime(_displayTime>0?_displayTime:savedTime)):(!isDefault?' \u00b7 '+rawTitle:''))):'Terakhir ditonton';
        var url='player.html?anime='+encodeURIComponent(item.name)+(epNum?'&episode='+epNum:'')+(savedTime?'&time='+savedTime:'');

        var popup=document.createElement('div'); popup.id='cw-popup';
        popup.setAttribute('role','status'); popup.setAttribute('aria-live','polite');
        popup.innerHTML='<div class="cw-label">Lanjutkan Menonton</div><div class="cw-title">'+esc(item.name)+'</div><div class="cw-ep">'+esc(epText)+'</div><div class="cw-actions"><a class="cw-btn cw-go" href="'+url+'">&#9654; Lanjutkan</a><button class="cw-btn cw-dismiss" id="cw-x">&#10005;</button></div>';
        document.body.appendChild(popup);

        var _rm=null;
        requestAnimationFrame(function(){ if(window.__toastStack) _rm=window.__toastStack.push(popup); });
        function dismiss(){ if(_rm){_rm();_rm=null;} popup.classList.add('cw-hiding'); setTimeout(function(){if(popup.parentNode)popup.parentNode.removeChild(popup);},320); }
        document.getElementById('cw-x').addEventListener('click', dismiss);
        setTimeout(dismiss, 12000);
    }

    var _interval=null, _lastSaved=-1, POLL_MS=5000, SAVE_EVERY_S=15;

    function initPlayer(animeName, epNumber, epTitle, getPlayer) {
        stopPlayer();
        _interval = setInterval(function(){
            var p=(typeof getPlayer==='function')?getPlayer():getPlayer;
            if (!p||typeof p.getPlayerState!=='function') return;
            var state=p.getPlayerState(), t=p.getCurrentTime();
            if (state!==1&&state!==0) return;
            var shouldSave=(_lastSaved<0||(t-_lastSaved)>=SAVE_EVERY_S)&&state===1;
            if (shouldSave) {
                _lastSaved=t;
                var vid=null; try{vid=p.getVideoData().video_id;}catch(e){}
                var dur=(typeof p.getDuration==='function')?p.getDuration():0;
                BookmarkManager.trackProgress(animeName,vid,epNumber,epTitle,(dur>0&&(dur-t)<60)?null:t);
                console.log('[BookmarkManager] Saved',Math.floor(t)+'s','for',animeName,'ep',epNumber);
            } else if (state===0) {
                var vid=null; try{vid=p.getVideoData().video_id;}catch(e){}
                BookmarkManager.trackProgress(animeName,vid,epNumber,epTitle,null);
            }
        }, POLL_MS);
    }

    function stopPlayer(){ if(_interval){clearInterval(_interval);_interval=null;} _lastSaved=-1; }

    function autoInit(){ if(document.getElementById('animeGrid')) setTimeout(initIndex,900); }
    if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',autoInit); else autoInit();

    return { initIndex, initPlayer, stopPlayer };
}());


// ══════════════════════════════════════════════════════════════════════
// 3. SPA Router
// ══════════════════════════════════════════════════════════════════════
(function(){
    'use strict';
    if (window.__spaInitialized) return;
    var me=document.currentScript||(document.querySelector('script[src*="bookmark.js"]'));
    if (!me||!me.hasAttribute('spa')) return;
    window.__spaInitialized=true;

    window.__spaLoadedCdn=new Set([].slice.call(document.querySelectorAll('script[src]'))
        .map(function(s){return new URL(s.getAttribute('src'),location.href).href;})
        .filter(function(u){return /(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|youtube\.com)/.test(u);}));

    document.addEventListener('click',function(e){
        var a=e.target.closest('a');
        if(!a||a.host!==location.host||a.hasAttribute('download')||a.target==='_blank') return;
        e.preventDefault();
        var url=a.href;
        if(url.endsWith('/index.html')) url=url.slice(0,-10);
        if(url===location.href) return;
        history.pushState({},''  ,url); _spaNavigate(url);
    });
    window.addEventListener('popstate',function(){_spaNavigate(location.href);});

    function _spaNavigate(url){
        if(typeof ContinueWatching!=='undefined') ContinueWatching.stopPlayer();
        if(typeof window.__spaStopTimeObserver==='function'){window.__spaStopTimeObserver();window.__spaStopTimeObserver=null;}
        document.body.style.transition='opacity 0.15s ease-out';
        document.body.style.opacity='0.4'; document.body.style.pointerEvents='none';
        fetch(url).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
        .then(function(html){
            var doc=new DOMParser().parseFromString(html,'text/html');
            document.title=doc.title;
            [].forEach.call(document.head.querySelectorAll('style:not([data-dynamic])'),function(s){s.remove();});
            [].forEach.call(doc.head.querySelectorAll('style'),function(s){document.head.appendChild(s.cloneNode(true));});
            document.body.innerHTML=doc.body.innerHTML;
            [].forEach.call(document.body.querySelectorAll('script'),function(old){
                var rawSrc=old.getAttribute('src'), absSrc=rawSrc?new URL(rawSrc,location.href).href:null;
                if(absSrc&&/bookmark\.js/.test(absSrc)){old.remove();return;}
                var isCdn=absSrc&&/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|youtube\.com)/.test(absSrc);
                if(isCdn&&window.__spaLoadedCdn.has(absSrc)){old.remove();return;}
                var fresh=document.createElement('script');
                [].forEach.call(old.attributes,function(attr){fresh.setAttribute(attr.name,attr.value);});
                if(!absSrc) fresh.textContent=old.textContent;
                if(isCdn) window.__spaLoadedCdn.add(absSrc);
                old.replaceWith(fresh);
            });
            if(typeof window.onYouTubeIframeAPIReady==='function'&&typeof YT!=='undefined'&&typeof YT.Player==='function')
                setTimeout(window.onYouTubeIframeAPIReady,0);
            window.scrollTo(0,0);
            document.body.style.opacity='1'; document.body.style.pointerEvents='auto';
        }).catch(function(err){
            console.error('[bookmark.js/spa] Navigation failed:',err);
            document.body.style.opacity='1'; location.assign(url);
        });
    }
}());


// ══════════════════════════════════════════════════════════════════════
// 4. MALSync
//
//  Design notes:
//  ─────────────
//  • Tokens in cookies (avoids localStorage quota), mirrored to LS for
//    MAL tester page compatibility.
//  • MAL API calls via GAS (MAL blocks browser CORS for write endpoints).
//  • Jikan: prefer AnimeMetadata.fetchJikanForAnime(animeName) when available
//    (handles rate-limit retry, caches to LS). For sequel chain (by malId),
//    fall back to direct fetch since fetchJikanForAnime only accepts names.
//  • Sequel offset math:
//    initialOffset = min_episode - 1  (from anime_data)
//    e.g. Sengoku Youko Thousandfold: min_episode=14 → offset=13
//         local ep 20 → malEp = 20-13 = 7 for MAL 58488  ✓
//    e.g. Frieren merged (min_episode=1, S1=28 eps, sequel S2):
//         local ep 30 → beyond S1 → S2 → malEp = 30-28 = 2  ✓
//  • Segment chain cached in anime_tracking_data[name].malSegments.
//  • Default GAS URL = the shared public GAS proxy.
// ══════════════════════════════════════════════════════════════════════
var MALSync = (function(){
    'use strict';

    var DEFAULT_GAS = 'https://script.google.com/macros/s/AKfycbyFxnexHxeO9l34KeFJG8LvasAZk0x-RHFSox-hYliU3EGFKF6KBEZW_2GOIwrBGI0s/exec';

    // ── Cookie helpers ────────────────────────────────────────────────
    function setCk(n,v,days){ var d=new Date(); d.setTime(d.getTime()+days*86400000); document.cookie=n+'='+encodeURIComponent(v||'')+';expires='+d.toUTCString()+';path=/;SameSite=Strict'; }
    function getCk(n){ var m=document.cookie.match('(?:^|; )'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)'); return m?decodeURIComponent(m[1]):''; }
    function delCk(n){ setCk(n,'',-1); }

    // ── LS helpers ────────────────────────────────────────────────────
    function lsGet(k){ try{return localStorage.getItem(k)||'';}catch(e){return '';} }
    function lsSet(k,v){ try{localStorage.setItem(k,v);}catch(e){} }

    // ── Config/token accessors (cookie primary, LS fallback) ──────────
    function getToken()  { return getCk('mal_tok')  || lsGet('mal_access_token');  }
    function getExpiry() { return parseInt(getCk('mal_exp') || lsGet('mal_expiry') || '0'); }
    function getGasUrl() { return getCk('mal_gas')  || lsGet('gas_url') || DEFAULT_GAS; }
    function getCid()    { return getCk('mal_cid')  || lsGet('cid');               }
    function getCsec()   { return getCk('mal_cs')   || lsGet('csec');              }

    function saveTokens(access, refresh, expiresIn){
        var exp=String(Date.now()+(expiresIn||2592000)*1000);
        setCk('mal_tok',access,35); setCk('mal_rtok',refresh||'',40); setCk('mal_exp',exp,35);
        lsSet('mal_access_token',access); lsSet('mal_refresh_token',refresh||''); lsSet('mal_expiry',exp);
    }
    function saveConfig(gasUrl,cid,csec){
        setCk('mal_gas',gasUrl,365); setCk('mal_cid',cid,365); setCk('mal_cs',csec,365);
        lsSet('gas_url',gasUrl); lsSet('cid',cid); lsSet('csec',csec);
    }
    function clearTokens(){
        ['mal_tok','mal_rtok','mal_exp'].forEach(delCk);
        ['mal_access_token','mal_refresh_token','mal_expiry'].forEach(function(k){try{localStorage.removeItem(k);}catch(e){}});
    }

    function isConnected(){ return !!(getToken() && getExpiry() > Date.now()); }

    // ── GAS proxy (for MAL write + read endpoints) ────────────────────
    async function gasPost(payload){
        var url=getGasUrl();
        payload.token=getToken();
        var r=await fetch(url,{method:'POST',body:JSON.stringify(payload)});
        if(!r.ok) throw new Error('GAS HTTP '+r.status);
        return r.json();
    }

    // ── Jikan fetch by malId ──────────────────────────────────────────
    // AnimeMetadata.fetchJikanForAnime(name) exists but only works by anime name.
    // For the sequel chain we have malIds, so we call Jikan directly.
    // fetchWithRetry is private in metadata.js so we implement a minimal version.
    var _jikanCache = {};
    async function jikanByMalId(malId){
        var id=String(malId);
        if(_jikanCache[id]) return _jikanCache[id];
        for(var i=0;i<3;i++){
            try{
                var r=await fetch('https://api.jikan.moe/v4/anime/'+id+'/full');
                if(r.status===429){ await new Promise(function(res){setTimeout(res,1500*(i+1));}); continue; }
                if(r.status===404) return null;
                if(!r.ok) throw new Error('HTTP '+r.status);
                var d=(await r.json()).data;
                _jikanCache[id]=d; return d;
            }catch(e){ if(i===2) return null; await new Promise(function(res){setTimeout(res,1000);}); }
        }
        return null;
    }

    // ── MAL user profile (via GAS → /users/@me) ───────────────────────
    // Jikan /users/{username}/full gives us the avatar.
    async function fetchUserProfile(){
        try{
            var resp=await gasPost({action:'GET_ME'});
            if(!resp||!resp.success) return null;
            var me=resp.data;                          // { id, name, picture, anime_statistics, ... }
            // Jikan for avatar (MAL API picture URL often returns null or restricted)
            var jUser=null;
            if(me.name){
                try{
                    var jr=await fetch('https://api.jikan.moe/v4/users/'+encodeURIComponent(me.name)+'/full');
                    if(jr.ok) jUser=(await jr.json()).data;
                }catch(e){}
            }
            return {
                id:         me.id,
                username:   me.name,
                picture:    (jUser&&jUser.images&&jUser.images.jpg&&jUser.images.jpg.image_url) || me.picture || null,
                statistics: me.anime_statistics || (jUser&&jUser.statistics&&jUser.statistics.anime) || null
            };
        }catch(e){ console.warn('[MALSync] fetchUserProfile error:',e.message); return null; }
    }

    // ── anime_data min_episode map (parsed once) ──────────────────────
    var _minEpMap=null;
    function getMinEpMap(){
        if(_minEpMap) return _minEpMap;
        try{ var d=JSON.parse(lsGet('anime_data')||'{}'); _minEpMap={}; (d.anime_list||[]).forEach(function(a){_minEpMap[a.name]=a.min_episode||1;}); }
        catch(e){ _minEpMap={}; }
        return _minEpMap;
    }

    // ── Tracking data helpers ─────────────────────────────────────────
    var TK='anime_tracking_data';
    function getTK(){ try{return JSON.parse(localStorage.getItem(TK)||'{}')}catch(e){return {};} }
    function setTK(d){ try{localStorage.setItem(TK,JSON.stringify(d));}catch(e){console.warn('[MALSync] TK write failed');} }

    // ── Resolve local episode → { malId, malEp } ─────────────────────
    //
    // Uses AnimeMetadata.fetchJikanForAnime(animeName) for the PRIMARY anime
    // (benefits from metadata.js retry logic + LS caching).
    // For SEQUELS (by malId only), falls back to jikanByMalId().
    //
    async function resolveMALEpisode(animeName, localEp){
        // 1. Check cached segment chain
        var tk=getTK();
        if(tk[animeName]&&tk[animeName].malSegments&&tk[animeName].malSegments.length)
            return walk(tk[animeName].malSegments, localEp);

        // 2. Get startMalId — prefer AnimeMetadata (more reliable resolution)
        var startId=null;
        if(typeof window.AnimeMetadata!=='undefined'){
            var rec=window.AnimeMetadata.findRecord(animeName);
            if(rec) startId=rec.malId||null;
            if(!startId) startId=window.AnimeMetadata.getMalId(animeName)||null;
        }
        if(!startId){ try{ var mr=lsGet('meta_'+animeName); if(mr) startId=JSON.parse(mr).malId||null; }catch(e){} }
        if(!startId) return null;

        // 3. Initial offset = min_episode - 1
        var baseOffset=(getMinEpMap()[animeName]||1)-1;

        // 4. Build segment chain
        var segments=[], curId=String(startId), cumOffset=baseOffset, limit=12;

        while(curId&&limit-->0){
            // For PRIMARY (first iteration): try AnimeMetadata.fetchJikanForAnime first
            var jd=null;
            if(segments.length===0&&typeof window.AnimeMetadata!=='undefined'){
                try{
                    var meta=await window.AnimeMetadata.fetchJikanForAnime(animeName);
                    if(meta&&meta.fullData) jd=meta.fullData;
                }catch(e){}
            }
            // For sequels (or if primary fetch failed): direct Jikan by malId
            if(!jd) jd=await jikanByMalId(curId);
            if(!jd){ console.warn('[MALSync] Jikan unavailable for malId',curId); break; }

            var epCnt=jd.episodes||9999;
            segments.push({malId:curId, offset:cumOffset, epCount:epCnt});
            if(localEp<=cumOffset+epCnt) break; // found segment

            cumOffset+=epCnt;
            // Follow Sequel relation
            var next=null;
            (jd.relations||[]).forEach(function(rel){
                if(rel.relation==='Sequel')
                    (rel.entry||[]).forEach(function(e){ if(e.type==='anime'&&!next) next=String(e.mal_id); });
            });
            curId=next;
            if(curId) await new Promise(function(r){setTimeout(r,400);}); // Jikan rate limit
        }

        if(!segments.length) return null;

        // 5. Cache segments
        tk=getTK();
        if(tk[animeName]){ tk[animeName].malSegments=segments; setTK(tk); }
        return walk(segments,localEp);
    }

    function walk(segs,localEp){
        for(var i=0;i<segs.length;i++){
            var s=segs[i];
            if(localEp<=s.offset+s.epCount) return {malId:s.malId, malEp:localEp-s.offset};
        }
        var last=segs[segs.length-1];
        return {malId:last.malId, malEp:localEp-last.offset};
    }

    // ── Sync episode ──────────────────────────────────────────────────
    var _compTimer=null;
    async function scheduleCompletion(animeName, localEp){
        clearTimeout(_compTimer);
        _compTimer=setTimeout(function(){_doCompletion(animeName,localEp);}, 2000);
    }

    async function _doCompletion(animeName, localEp){
        if(!isConnected()||!getGasUrl()) return;
        try{
            var res=await resolveMALEpisode(animeName,localEp);
            if(!res) return;
            var tk=getTK();
            if(tk[animeName]) {
                tk[animeName].malStatus = 'completed';
                setTK(tk);
            }
            var upd={num_watched_episodes:res.malEp, status:'completed'};
            var resp=await gasPost({action:'UPDATE', animeId:parseInt(res.malId), updateData:upd});
            if(resp&&resp.success){
                updateSyncStatus();
                console.log('[MALSync] ✓ Marked COMPLETED:',animeName);
            } else {
                // Revert if GAS fails, so it tries again later
                if(tk[animeName]) {
                    tk[animeName].malStatus = 'watching';
                    setTK(tk);
                }
            }
        }catch(e){console.warn('[MALSync] Completion error:',e.message);}
    }

    var _syncTimer=null;
    function scheduleSyncEpisode(animeName, localEp){
        clearTimeout(_syncTimer);
        _syncTimer=setTimeout(function(){_doSync(animeName,localEp);},5000);
    }

    async function _doSync(animeName, localEp){
        if(!isConnected()||!getGasUrl()) return;
        try{
            var res=await resolveMALEpisode(animeName,localEp);
            if(!res){console.log('[MALSync] No MAL mapping for',animeName);return;}
            var tk=getTK(), existing=tk[animeName]&&tk[animeName].malStatus;
            var upd={num_watched_episodes:res.malEp};
            if(!existing||existing==='plan_to_watch'||existing==='dropped') upd.status='watching';
            else if(existing==='completed'){ upd.status='watching'; upd.is_rewatching=true; }

            var resp=await gasPost({action:'UPDATE', animeId:parseInt(res.malId), updateData:upd});
            if(resp&&resp.success){
                tk=getTK(); if(tk[animeName]){ tk[animeName].malStatus=upd.status||existing||'watching'; tk[animeName].malLastSync=Date.now(); setTK(tk); }
                updateSyncStatus();
                console.log('[MALSync] ✓',animeName,'ep',res.malEp,'→ MAL',res.malId);
            }else console.warn('[MALSync] Update failed:',resp);
        }catch(e){console.warn('[MALSync] _doSync error:',e.message);}
    }

    // ── Full MAL list import ──────────────────────────────────────────
    //
    // Three-step approach:
    //  1. Fetch all anime from MAL API via GAS proxy.
    //  2. Build a reverse map  malId → local anime name  by:
    //       a. Loading metadata.json into RAM  (P2 — fast, ~few KB)
    //       b. Calling AnimeMetadata.getMalId(name) for each local anime
    //          which checks  P1 localStorage → P2 _inMemoryMeta → P3 titleIndex
    //       c. Direct meta_* LS fallback if AnimeMetadata not available
    //  3. Write / create tracking entries for all matched anime, then call
    //     window.renderHistory() so the page updates without a manual refresh.
    //
    async function importFromMAL(){
        if(!isConnected()||!getGasUrl()) return;
        var btn=document.getElementById('mal-sync-btn');
        if(btn){ btn.disabled=true; btn.textContent='Memuat...'; }
        try{

            // ── Step 1: fetch all MAL pages ──────────────────────────────
            var all=[],offset=0;
            console.log('[MALSync] importFromMAL: fetching MAL list...');
            while(true){
                var resp=await gasPost({action:'GET',userName:'@me',limit:100,offset:offset});
                var items=(resp&&resp.data&&resp.data.data)||[];
                if(!items.length) break;
                all=all.concat(items);
                if(!(resp&&resp.data&&resp.data.paging&&resp.data.paging.next)) break;
                offset+=100;
                await new Promise(function(r){setTimeout(r,350);});
            }
            console.log('[MALSync] Fetched '+all.length+' anime from MAL API');

            // Build malId → rich entry map
            var malMap={};
            all.forEach(function(item){
                var n=item.node;
                if(n&&n.my_list_status){
                    var mls=n.my_list_status;
                    malMap[String(n.id)]={
                        title:        n.title||'',
                        status:       mls.status||'',
                        score:        mls.score||0,
                        numWatched:   mls.num_episodes_watched||0,
                        isRewatching: mls.is_rewatching||false,
                        updatedAt:    mls.updated_at
                                        ? new Date(mls.updated_at).getTime()
                                        : Date.now()
                    };
                }
            });

            // ── Step 2: build reverse map via AnimeMetadata (all 3 priorities) ──
            //
            // AnimeMetadata.getMalId checks:
            //   P3 → titleIndex  (offline DB in RAM — already loaded if index.html was visited)
            //   P1 → localStorage meta_* keys  (Jikan on-demand, player.html visits)
            //   P2 → _inMemoryMeta  (metadata.json loaded below)
            //
            // We load metadata.json first because bookmark.html never calls
            // setupMetadata, so _inMemoryMeta is null and P2 would be skipped.
            if(typeof window.AnimeMetadata !== 'undefined'){
                try{
                    var loaded = await window.AnimeMetadata.loadMetadataJson();
                    console.log('[MALSync] metadata.json '+(loaded?'loaded':'not available')+
                                (loaded ? ' ('+Object.keys(window.AnimeMetadata._inMemoryMetaSize||{}).length+' entries)' : ''));
                }catch(e){
                    console.warn('[MALSync] metadata.json load error:',e.message);
                }
            }

            // Iterate local anime list → resolve malId for each name
            var malIdToName={};
            var localList=[];
            try{
                var _adRaw=lsGet('anime_data');
                if(_adRaw) localList=(JSON.parse(_adRaw).anime_list||[]);
            }catch(e){ console.warn('[MALSync] Cannot read anime_data from LS:',e.message); }

            var metaMatches=0, lsFallbacks=0, noMatch=0;
            localList.forEach(function(a){
                var mid=null;

                // Primary: AnimeMetadata.getMalId covers P3→P1→P2
                if(typeof window.AnimeMetadata !== 'undefined'){
                    try{ mid=window.AnimeMetadata.getMalId(a.name)||null; }catch(e){}
                    if(mid) metaMatches++;
                }

                // Fallback: direct LS meta_* scan (P1 only, for when AnimeMetadata unavailable)
                if(!mid){
                    try{
                        var _mr=lsGet('meta_'+a.name);
                        if(_mr){
                            var _md=JSON.parse(_mr);
                            if(_md.malId&&!_md.not_found){ mid=String(_md.malId); lsFallbacks++; }
                        }
                    }catch(e){}
                }

                if(mid){ malIdToName[String(mid)]=a.name; }
                else { noMatch++; }
            });
            console.log('[MALSync] Reverse map built: '+Object.keys(malIdToName).length+' entries'+
                        ' | AnimeMetadata: '+metaMatches+', LS fallback: '+lsFallbacks+
                        ', no match: '+noMatch+' (of '+localList.length+' local anime)');

            // ── Step 3: write tracking data ──────────────────────────────
            var tk=getTK();
            var nNew=0, nUpdated=0, nSkipped=0, nRefreshed=0;

            // 3a. Refresh MAL fields on entries that already have real playback data.
            //     We look up their malId by name (same getMalId path).
            Object.keys(tk).forEach(function(name){
                if(!tk[name].lastWatchedVideoId) return; // MAL-only entry — handled in 3b
                try{
                    var mid=malIdToName
                        // reverse the map: find the key whose value === name
                        ? Object.keys(malIdToName).find(function(id){return malIdToName[id]===name;})
                        : null;
                    if(!mid&&typeof window.AnimeMetadata!=='undefined'){
                        mid=window.AnimeMetadata.getMalId(name)||null;
                        if(mid) mid=String(mid);
                    }
                    if(!mid) return;
                    var entry=malMap[mid];
                    if(!entry) return;
                    tk[name].malStatus=entry.status;
                    tk[name].malScore=entry.score;
                    tk[name].malIsRewatching=entry.isRewatching;
                    nRefreshed++;
                    console.log('[MALSync] Refreshed play-tracked: '+name+' → '+entry.status);
                }catch(e){}
            });

            // 3b. Create / update entries for every MAL anime that has a local name match.
            var changed = nRefreshed > 0;
            Object.keys(malMap).forEach(function(malId){
                var entry=malMap[malId];
                var name=malIdToName[malId];

                // Skip plan_to_watch with 0 episodes — nothing to show
                if(entry.status==='plan_to_watch'&&entry.numWatched===0){
                    console.log('[MALSync] Skip PTW/0ep: "'+entry.title+'" (MAL:'+malId+')');
                    nSkipped++;
                    return;
                }

                if(!name){
                    // Not in the local collection yet — no card to create
                    console.log('[MALSync] No local match: MAL:'+malId+' "'+entry.title+'"');
                    nSkipped++;
                    return;
                }

                // Entry already has real playback data — already refreshed in 3a
                if(tk[name]&&tk[name].lastWatchedVideoId){
                    return;
                }

                var isNew=!tk[name];
                if(isNew){
                    tk[name]={visitCount:0};
                    nNew++;
                    console.log('[MALSync] NEW entry: "'+name+'" (MAL:'+malId+
                                ') status='+entry.status+' ep='+entry.numWatched+
                                (entry.isRewatching?' [rewatching]':''));
                } else {
                    nUpdated++;
                    console.log('[MALSync] UPDATE entry: "'+name+'" (MAL:'+malId+
                                ') status='+entry.status+' ep='+entry.numWatched+
                                (entry.isRewatching?' [rewatching]':''));
                }

                // MAL status / score / rewatch flag
                tk[name].malStatus      = entry.status;
                tk[name].malScore       = entry.score;
                tk[name].malIsRewatching= entry.isRewatching;

                // lastWatchedAt — use MAL updated_at as proxy (makes entry visible in history)
                if(!tk[name].lastWatchedAt)
                    tk[name].lastWatchedAt = entry.updatedAt;

                // Episode progress from MAL
                if(!tk[name].lastWatchedEpisodeNumber && entry.numWatched > 0)
                    tk[name].lastWatchedEpisodeNumber = entry.numWatched;

                // visitCount — episodes watched is a meaningful proxy
                if(!tk[name].visitCount && entry.numWatched > 0)
                    tk[name].visitCount = entry.numWatched;

                changed=true;
            });

            console.log('[MALSync] Summary → new:'+nNew+' updated:'+nUpdated+
                        ' refreshed:'+nRefreshed+' skipped:'+nSkipped);

            if(changed){ setTK(tk); console.log('[MALSync] Tracking data saved to localStorage'); }

            lsSet('mal_last_import', String(Date.now()));
            updateSyncStatus();

            // ── Re-render the history page if we're on bookmark.html ────
            // renderHistory() is a top-level function in bookmark.html's script block.
            // Calling it here avoids the race where the page rendered "Belum Ada Riwayat"
            // before this async import finished writing to localStorage.
            if(typeof window.renderHistory === 'function'){
                console.log('[MALSync] Triggering renderHistory()');
                window.renderHistory();
            }

            var matched = Object.keys(malIdToName).filter(function(id){ return !!malMap[id]; }).length;
            showToast('✓ '+all.length+' anime MAL · '+matched+' cocok · '+nNew+' baru');

        }catch(e){
            console.warn('[MALSync] importFromMAL error:',e.message, e);
            showToast('Gagal mengimpor dari MAL: '+e.message);
        }finally{
            if(btn){ btn.disabled=false; btn.textContent='Sinkron Sekarang ↺'; }
        }
    }

    // ── DOM status update ─────────────────────────────────────────────
    function updateSyncStatus(){
        var dot=document.getElementById('mal-dot');
        var stTxt=document.getElementById('mal-status-text');
        var syncTx=document.getElementById('mal-last-sync');
        var discB=document.getElementById('mal-disconnect-btn');
        var togB=document.getElementById('mal-toggle-btn');
        var connB=document.getElementById('mal-connect-btn');
        var avatar=document.getElementById('mal-avatar');
        if(!dot) return;

        if(isConnected()){
            dot.className='mal-dot ok';
            var username=getCk('mal_username')||lsGet('mal_username')||'';
            stTxt.textContent=username?username:'MAL Terhubung';
            if(discB) discB.style.display='';
            if(connB) connB.style.display='none';
            if(togB)  togB.textContent='Kelola ▾';
            var last=parseInt(lsGet('mal_last_import')||'0');
            if(last&&syncTx){ var mins=Math.floor((Date.now()-last)/60000); syncTx.textContent=mins<1?'· baru saja':'· '+mins+' mnt lalu'; }
            if(avatar&&getCk('mal_avatar')) { avatar.src=getCk('mal_avatar'); avatar.style.display=''; }
        }else{
            dot.className='mal-dot';
            stTxt.textContent='MAL: Belum terhubung';
            if(discB)  discB.style.display='none';
            if(connB)  connB.style.display='';
            if(togB)   togB.textContent='Hubungkan ▾';
            if(syncTx) syncTx.textContent='';
            if(avatar) avatar.style.display='none';
        }
    }

    // ── Save user info to cookies/LS ──────────────────────────────────
    function saveUserInfo(username, avatarUrl){
        setCk('mal_username',username,35); setCk('mal_avatar',avatarUrl||'',35);
        lsSet('mal_username',username);
    }

    // ── OAuth PKCE ────────────────────────────────────────────────────
    var _ver='', _sid='', _pollIv=null;
    function genVer(){ var c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~',s=''; for(var i=0;i<128;i++)s+=c[Math.floor(Math.random()*c.length)]; return s; }
    function genSid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

    function startAuth(){
        var el=function(id){return document.getElementById(id);};
        var cid    =(el('mal-cid')?.value||'').trim()    ||getCid();
        var csec   =(el('mal-csec')?.value||'').trim()   ||getCsec();
        var gasUrl =(el('mal-gas-url')?.value||'').trim()||getGasUrl();
        var auto   =el('mal-auto-cb')?.checked;

        if(!cid)  {showToast('Masukkan Client ID');return;}
        if(!csec) {showToast('Masukkan Client Secret');return;}
        if(!gasUrl){showToast('Masukkan GAS URL (klik ⚙ Advanced)');return;}
        saveConfig(gasUrl,cid,csec);

        _ver=genVer();
        var nonce=Math.random().toString(36).slice(2,6);
        var state=auto?(nonce+':'+(_sid=genSid())+':poll'):nonce;
        var params=new URLSearchParams({response_type:'code',client_id:cid,redirect_uri:gasUrl,code_challenge:_ver,state:state});
        window.open('https://myanimelist.net/v1/oauth2/authorize?'+params,'_blank');

        if(auto){ _startPoll(); }
        else{
            var pr=el('mal-paste-row'); if(pr) pr.style.display='flex';
            showToast('Selesaikan otorisasi di tab baru, lalu tempel kode');
        }
    }

    function _startPoll(){
        var attempt=0, gasUrl=getGasUrl();
        showToast('Menunggu otorisasi MAL...');
        _pollIv=setInterval(async function(){
            if(++attempt>60){_stopPoll();showToast('Timeout — coba lagi');return;}
            try{
                var r=await fetch(gasUrl,{method:'POST',body:JSON.stringify({action:'CHECK_CODE',sessionId:_sid,token:''})});
                var d=await r.json();
                if(d.success&&d.data&&d.data.found){_stopPoll();exchangeCode(d.data.code);}
            }catch(e){}
        },2000);
    }
    function _stopPoll(){if(_pollIv){clearInterval(_pollIv);_pollIv=null;}}

    async function exchangeCode(code){
        showToast('Menukar kode...');
        try{
            var r=await fetch(getGasUrl(),{method:'POST',body:JSON.stringify({
                action:'GET_TOKEN', token:'', code:code,
                codeVerifier:_ver||code,
                clientId:getCid(), clientSecret:getCsec(), redirectUri:getGasUrl()
            })});
            var resp=await r.json(), tok=(resp&&resp.data)||resp;
            if(tok&&tok.access_token){
                saveTokens(tok.access_token,tok.refresh_token,tok.expires_in);

                // Collapse panel
                var panel=document.getElementById('mal-panel');
                if(panel) panel.style.display='none';

                // Fetch user profile + auto-import
                showToast('✓ Terhubung! Memuat profil...');
                updateSyncStatus();
                var profile=await fetchUserProfile();
                if(profile){
                    saveUserInfo(profile.username, profile.picture);
                    updateSyncStatus(); // refresh with username + avatar
                    showToast('Halo, '+profile.username+'!');
                }
                importFromMAL(); // auto-fetch after connect
            }else{
                showToast('Gagal — periksa Client ID/Secret');
                console.warn('[MALSync] Exchange failed:',resp);
            }
        }catch(e){showToast('Error: '+e.message);}
    }

    // ── Toast ─────────────────────────────────────────────────────────
    function showToast(msg){
        var t=document.getElementById('mal-toast');
        if(!t) return;
        t.textContent=msg; t.classList.add('show');
        clearTimeout(t._t); t._t=setTimeout(function(){t.classList.remove('show');},3200);
    }

    return {
        isConnected, getToken, getGasUrl,
        scheduleSyncEpisode, scheduleCompletion, importFromMAL, updateSyncStatus,
        startAuth, exchangeCode, showToast, stopPolling: _stopPoll,
        disconnect: function(){
            _stopPoll(); clearTokens();
            ['mal_username','mal_avatar'].forEach(delCk);
            updateSyncStatus(); showToast('Terputus dari MAL');
        }
    };
}());