/*
 * Stremio Addons para Movian (esqueleto minimo, ES5)
 *
 * Flujo: manifest -> catalogo -> meta (temporadas/episodios) -> streams -> reproducir.
 * Configura la(s) URL(s) de manifest en Ajustes (separadas por espacio o coma).
 */

var page = require('movian/page');
var service = require('movian/service');
var http = require('movian/http');
var io = null;
try { io = require('native/io'); } catch (e) { io = null; }

var plugin = JSON.parse(Plugin.manifest);
var logo = Plugin.path + plugin.icon;
var UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// ---------- estado y ajustes ----------
var addonSetting = '';
var addonCache = null;
var manifests = {};
var hlsTxt = true;
var showTorrents = true;
var hdrMode = 'scan';
var hostHeaders = {};
var hooked = {};
var allHeaders = null;
var allHooked = false;

var settings = new (require('movian/settings').globalSettings)(plugin.id, plugin.title, logo, plugin.synopsis);
settings.createDivider('Addons');
settings.createString('addons', 'URL de manifest o de una lista de addons (admite enlace corto)', '', function(v) {
    addonSetting = v;
    addonCache = null;
    manifests = {};
});
settings.createDivider('Reproduccion');
settings.createBool('hls_txt', 'Tratar .txt como HLS (m3u8 disfrazados)', true, function(v) { hlsTxt = v; });
settings.createBool('show_torrents', 'Mostrar streams torrent (infoHash)', true, function(v) { showTorrents = v; });
settings.createMultiOpt('hdr_mode', 'Aplicar cabeceras del stream (proxyHeaders) a', [
    ['scan', 'Dominios de la playlist (recomendado)', true],
    ['host', 'Solo el dominio del stream'],
    ['all',  'Todos los dominios']
], function(v) { hdrMode = v; });

// ---------- utilidades ----------
function E(s) { return encodeURIComponent(s === null || s === undefined ? '' : String(s)); }
function D(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function encPath(s) { return encodeURIComponent(String(s)).replace(/%3A/gi, ':'); }
function rx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function normBase(u) {
    u = String(u).replace(/^\s+|\s+$/g, '');
    if (u.indexOf('stremio://') === 0) u = 'https://' + u.substring(10);
    u = u.replace(/[?#].*$/, '').replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
    return u;
}

function looksLikeManifest(u) {
    return /\/manifest\.json(\?|#|$)/i.test(u) || /^stremio:\/\//i.test(u);
}

// Lee una lista de addons: JSON (array o {addons:[...]}) o texto plano (una URL por linea, # = comentario).
function parseAddonList(txt) {
    var out = [], data = null, i;
    try { data = JSON.parse(txt); } catch (e) { data = null; }
    if (data) {
        var arr = (data instanceof Array) ? data : (data.addons || []);
        for (i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (typeof it === 'string') out.push(it);
            else if (it && it.url) out.push(String(it.url));
        }
        return out;
    }
    var lines = String(txt).split(/\r?\n/);
    for (i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/^\s+|\s+$/g, '');
        if (!l || l.charAt(0) === '#') continue;
        var parts = l.split(/[\s,]+/);
        for (var j = 0; j < parts.length; j++) if (/^(https?|stremio):\/\//i.test(parts[j])) out.push(parts[j]);
    }
    return out;
}

// Devuelve las bases de los addons configurados. Cada entrada del ajuste puede ser un manifest.json
// o la URL (tambien acortada) de una lista de addons. Las listas no se anidan.
function getAddons() {
    if (addonCache) return addonCache;
    var out = [], toks = String(addonSetting || '').split(/[\s,]+/), i, j;
    function add(u) { var b = normBase(u); if (b && out.indexOf(b) === -1) out.push(b); }
    for (i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (!t) continue;
        if (looksLikeManifest(t)) { add(t); continue; }
        if (!/^https?:\/\//i.test(t)) continue;
        var txt = null;
        try { txt = http.request(t, { headers: UA, noFail: true, compression: true, caching: true, cacheTime: 60 }).toString(); }
        catch (e) { txt = null; }
        if (!txt) continue;
        var list = parseAddonList(txt);
        for (j = 0; j < list.length; j++) if (looksLikeManifest(list[j])) add(list[j]);
    }
    addonCache = out;
    return out;
}

function getJSON(url, cacheTime) {
    var opts = { headers: UA, noFail: true, compression: true };
    if (cacheTime) { opts.caching = true; opts.cacheTime = cacheTime; }
    try { return JSON.parse(http.request(url, opts).toString()); } catch (e) { return null; }
}

function getManifest(base) {
    if (manifests[base]) return manifests[base];
    var m = getJSON(base + '/manifest.json', 600);
    if (m && (m.catalogs || m.resources)) { manifests[base] = m; return m; }
    return null;
}

function supports(m, resource, type, id) {
    var res = m.resources || [];
    for (var i = 0; i < res.length; i++) {
        var r = res[i];
        var name = (typeof r === 'string') ? r : r.name;
        if (name !== resource) continue;
        var obj = (typeof r === 'object');
        var types = (obj && r.types) || m.types || [];
        var prefixes = (obj && r.idPrefixes) || m.idPrefixes || null;
        if (types.length && types.indexOf(type) === -1) continue;
        if (prefixes && prefixes.length) {
            var ok = false;
            for (var j = 0; j < prefixes.length; j++) if (String(id).indexOf(prefixes[j]) === 0) ok = true;
            if (!ok) continue;
        }
        return true;
    }
    return false;
}

function catExtras(c) {
    var out = [], i;
    if (c.extra && c.extra.length) {
        for (i = 0; i < c.extra.length; i++) out.push({ name: c.extra[i].name, req: !!c.extra[i].isRequired });
    } else {
        var sup = c.extraSupported || [], rq = c.extraRequired || [];
        for (i = 0; i < sup.length; i++) out.push({ name: sup[i], req: rq.indexOf(sup[i]) !== -1 });
    }
    return out;
}
function catHasRequired(c) {
    var ex = catExtras(c);
    for (var i = 0; i < ex.length; i++) if (ex[i].req) return true;
    return false;
}
function catSearchable(c) {
    var ex = catExtras(c), has = false;
    for (var i = 0; i < ex.length; i++) {
        if (ex[i].name === 'search') has = true;
        else if (ex[i].req) return false; // exige otro parametro (p.ej. genre)
    }
    return has;
}

function header(pg, title) {
    pg.type = 'directory';
    pg.metadata.title = title;
    pg.metadata.logo = logo;
}

function route(path, fn) {
    new page.Route(plugin.id + ':' + path, function(pg) {
        var args = Array.prototype.slice.call(arguments);
        try { fn.apply(null, args); }
        catch (e) { pg.error('Stremio: ' + e); return; }
        pg.loading = false;
    });
}

function pad2(n) { n = parseInt(n, 10); if (isNaN(n)) return '??'; return (n < 10 ? '0' : '') + n; }

// ---------- cabeceras (proxyHeaders) ----------
function hostOf(u) {
    var m = /^https?:\/\/([^\/:?#]+)/i.exec(u);
    return m ? m[1].toLowerCase() : null;
}

function absUrl(base, rel) {
    if (/^https?:\/\//i.test(rel)) return rel;
    if (rel.indexOf('//') === 0) return 'https:' + rel;
    var m = /^(https?:\/\/[^\/]+)(\/.*)?$/i.exec(base);
    if (!m) return rel;
    if (rel.charAt(0) === '/') return m[1] + rel;
    var dir = (m[2] || '/').replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
    return m[1] + dir + rel;
}

function mergeUA(h) {
    var o = {}, k;
    for (k in UA) o[k] = UA[k];
    for (k in h) o[k] = h[k];
    return o;
}

// Lee la playlist HLS (y la primera variante) para conocer los dominios de los segmentos.
function scanPlaylistHosts(url, headers, depth, out) {
    var txt;
    try { txt = http.request(url, { headers: mergeUA(headers), noFail: true, compression: true }).toString(); }
    catch (e) { return; }
    if (!txt || txt.indexOf('#EXTM3U') === -1) return;
    var lines = txt.split(/\r?\n/), segs = 0, subs = 0;
    for (var i = 0; i < lines.length; i++) {
        var t = lines[i].replace(/^\s+|\s+$/g, '');
        if (!t) continue;
        var isTag = (t.charAt(0) === '#'), u = null;
        if (isTag) {
            var um = /URI="([^"]+)"/.exec(t);
            if (!um) continue;
            u = um[1];
        } else {
            u = t;
        }
        u = absUrl(url, u);
        var h = hostOf(u);
        if (h) out[h] = true;
        if (isTag) continue;
        if (/\.(m3u8|txt)(\?|#|$)/i.test(u)) {
            if (subs < 1 && depth < 1) { subs++; scanPlaylistHosts(u, headers, depth + 1, out); }
        } else {
            segs++;
            if (segs >= 5) break;
        }
    }
}

function hookHost(host) {
    if (hooked[host]) return;
    hooked[host] = true;
    io.httpInspectorCreate('.*' + rx(host) + '.*', function(req) {
        var h = hostHeaders[host];
        if (!h) return;
        for (var k in h) req.setHeader(k, String(h[k]));
    });
}

function applyHeaders(url, headers, hls) {
    if (!io || !io.httpInspectorCreate) return;
    if (hdrMode === 'all') {
        allHeaders = headers;
        if (!allHooked) {
            allHooked = true;
            io.httpInspectorCreate('.*', function(req) {
                if (!allHeaders) return;
                for (var k in allHeaders) req.setHeader(k, String(allHeaders[k]));
            });
        }
        return;
    }
    var hosts = {}, h0 = hostOf(url);
    if (h0) hosts[h0] = true;
    if (hdrMode === 'scan' && hls) scanPlaylistHosts(url, headers, 0, hosts);
    for (var h in hosts) { hostHeaders[h] = headers; hookHost(h); }
}

// ---------- streams ----------
function isHls(u) {
    return /\.m3u8/i.test(u) || (hlsTxt && /\.txt(\?|#|$)/i.test(u));
}

function magnetOf(st) {
    var m = 'magnet:?xt=urn:btih:' + st.infoHash, src = st.sources || [];
    for (var i = 0; i < src.length; i++) {
        if (typeof src[i] === 'string' && src[i].indexOf('tracker:') === 0) m += '&tr=' + encodeURIComponent(src[i].substring(8));
    }
    return m;
}

function buildPlay(st, title, icon) {
    var p = { t: title || '', i: icon || '' };
    if (st.url && /^https?:\/\//i.test(st.url)) {
        p.u = st.url;
        p.hls = isHls(st.url);
        var bh = st.behaviorHints;
        var h = bh && bh.proxyHeaders && bh.proxyHeaders.request;
        if (h) p.h = h;
    } else if (st.infoHash && showTorrents) {
        p.m = magnetOf(st);
    } else {
        return null; // externalUrl / ytId no soportados en este esqueleto
    }
    if (st.subtitles && st.subtitles.length) {
        p.s = [];
        for (var i = 0; i < st.subtitles.length; i++) {
            if (st.subtitles[i] && st.subtitles[i].url) p.s.push({ url: st.subtitles[i].url, language: st.subtitles[i].lang || '' });
        }
    }
    return p;
}

function addStreamItem(pg, addonName, st, title, icon) {
    var p = buildPlay(st, title, icon);
    if (!p) return 0;
    var n = String(st.name || '').replace(/\s*\n\s*/g, ' ').replace(/^\s+|\s+$/g, '');
    var d = String(st.title || st.description || '');
    var first = d.split('\n')[0];
    var label = '[' + addonName + '] ' + (n || (p.m ? 'Torrent' : 'Stream')) + (first ? ' - ' + first : '');
    pg.appendItem(plugin.id + ':play:' + E(JSON.stringify(p)), 'video', {
        title: label,
        description: d,
        icon: icon || logo
    });
    return 1;
}

function orderedBases(first) {
    var out = [first], i;
    var all = getAddons();
    for (i = 0; i < all.length; i++) if (out.indexOf(all[i]) === -1) out.push(all[i]);
    return out;
}

function renderStreams(pg, base, type, id, title, icon) {
    pg.loading = true;
    var shown = 0, bases = orderedBases(base);
    for (var i = 0; i < bases.length; i++) {
        var m = getManifest(bases[i]);
        if (!m || !supports(m, 'stream', type, id)) continue;
        var d = getJSON(bases[i] + '/stream/' + encPath(type) + '/' + encPath(id) + '.json', 0);
        var list = (d && d.streams) || [];
        if (!list.length) continue;
        pg.appendItem('', 'separator', { title: m.name || bases[i] });
        for (var j = 0; j < list.length; j++) shown += addStreamItem(pg, m.name || 'addon', list[j], title, icon);
    }
    if (!shown) pg.appendItem('', 'separator', { title: 'Sin streams disponibles' });
}

// ---------- meta / catalogos ----------
function addMetaItem(pg, base, mt, type) {
    var t = mt.type || type;
    var title = mt.name || mt.id;
    if (mt.releaseInfo) title += ' (' + String(mt.releaseInfo).substring(0, 9) + ')';
    var md = { title: title, icon: mt.poster || logo, description: mt.description || '' };
    var r = parseFloat(mt.imdbRating);
    if (!isNaN(r)) md.rating = Math.round(r * 10);
    pg.appendItem(plugin.id + ':meta:' + E(base) + ':' + E(t) + ':' + E(mt.id), 'directory', md);
}

function fetchMeta(base, type, id) {
    var bases = orderedBases(base);
    for (var i = 0; i < bases.length; i++) {
        if (i > 0) {
            var m = getManifest(bases[i]);
            if (!m || !supports(m, 'meta', type, id)) continue;
        }
        var d = getJSON(bases[i] + '/meta/' + encPath(type) + '/' + encPath(id) + '.json', 600);
        if (d && d.meta) return d.meta;
    }
    return { id: id, type: type, name: id };
}

function seasonOf(v) {
    var n = parseInt(v.season, 10);
    return isNaN(n) ? null : n;
}

function renderEpisodes(pg, base, type, meta, season) {
    var vids = meta.videos || [], eps = [], i;
    for (i = 0; i < vids.length; i++) if (seasonOf(vids[i]) === season) eps.push(vids[i]);
    eps.sort(function(a, b) { return (parseInt(a.episode || a.number, 10) || 0) - (parseInt(b.episode || b.number, 10) || 0); });
    for (i = 0; i < eps.length; i++) {
        var v = eps[i], ep = v.episode || v.number;
        var label = 'S' + pad2(season) + 'E' + pad2(ep) + ' - ' + (v.title || v.name || ('Episodio ' + ep));
        pg.appendItem(plugin.id + ':streams:' + E(base) + ':' + E(type) + ':' + E(v.id) + ':' + E(meta.name + ' ' + label), 'directory', {
            title: label,
            icon: v.thumbnail || meta.poster || logo,
            description: v.overview || v.description || ''
        });
    }
}

// ---------- rutas ----------
route('start', function(page) {
    header(page, plugin.title);
    hostHeaders = {};
    allHeaders = null;
    addonCache = null; // vuelve a leer la lista de addons cada vez que se abre el inicio
    var addons = getAddons();
    page.appendItem(plugin.id + ':search:', 'search', { title: 'Buscar...' });
    if (!addons.length) {
        page.appendItem('', 'separator', { title: addonSetting ? 'No se pudo leer ningun addon: revisa la URL en Ajustes' : 'Configura la URL de tu addon (o de tu lista) en Ajustes' });
        return;
    }
    for (var i = 0; i < addons.length; i++) {
        var base = addons[i], m = getManifest(base);
        if (!m) { page.appendItem('', 'separator', { title: 'No se pudo leer: ' + base }); continue; }
        var cats = [], allCats = m.catalogs || [], j;
        for (j = 0; j < allCats.length; j++) if (!catHasRequired(allCats[j])) cats.push(allCats[j]); // se omiten los que exigen parametros
        page.appendItem('', 'separator', { title: (m.name || base) + (cats.length ? '' : ' (solo streams)') });
        for (j = 0; j < cats.length; j++) {
            var c = cats[j];
            var title = (c.name || c.id) + ' (' + c.type + ')';
            page.appendItem(plugin.id + ':catalog:' + E(base) + ':' + E(c.type) + ':' + E(c.id) + ':' + E(title), 'directory', {
                title: title,
                icon: m.logo || logo
            });
        }
    }
});

route('catalog:([^:]*):([^:]*):([^:]*):(.*)', function(page, eb, et, ei, etitle) {
    var base = D(eb), type = D(et), id = D(ei);
    header(page, D(etitle));
    page.model.contents = 'grid';
    var skip = 0, seen = {}, total = 0, done = false;
    function loadMore() {
        if (done) return false;
        var url = base + '/catalog/' + encPath(type) + '/' + encPath(id) + (skip ? '/skip=' + skip : '') + '.json';
        var d = getJSON(url, 300);
        var metas = (d && d.metas) || [], added = 0;
        for (var i = 0; i < metas.length; i++) {
            var mt = metas[i];
            if (!mt || !mt.id || seen[mt.id]) continue;
            seen[mt.id] = true;
            added++;
            addMetaItem(page, base, mt, type);
        }
        total += added;
        skip += metas.length;
        if (!added) done = true;
        return !done;
    }
    loadMore();
    if (!total) page.appendItem('', 'separator', { title: 'Sin resultados' });
    page.paginator = loadMore;
});

route('meta:([^:]*):([^:]*):(.*)', function(page, eb, et, ei) {
    var base = D(eb), type = D(et), id = D(ei);
    var meta = fetchMeta(base, type, id);
    header(page, meta.name || id);
    if (meta.background) { page.metadata.background = meta.background; page.metadata.backgroundAlpha = 0.3; }

    var vids = meta.videos || [], seasons = [], i, hasSeasons = false, s;
    for (i = 0; i < vids.length; i++) {
        s = seasonOf(vids[i]);
        if (s !== null) { hasSeasons = true; if (seasons.indexOf(s) === -1) seasons.push(s); }
    }
    seasons.sort(function(a, b) { return a - b; });

    if (type !== 'movie' && vids.length && hasSeasons) {
        if (seasons.length === 1) { renderEpisodes(page, base, type, meta, seasons[0]); return; }
        for (i = 0; i < seasons.length; i++) {
            page.appendItem(plugin.id + ':season:' + E(base) + ':' + E(type) + ':' + E(id) + ':' + seasons[i], 'directory', {
                title: seasons[i] === 0 ? 'Especiales' : 'Temporada ' + seasons[i],
                icon: meta.poster || logo
            });
        }
        return;
    }
    if (type !== 'movie' && vids.length > 1) {
        for (i = 0; i < vids.length; i++) {
            var v = vids[i], t = v.title || v.name || v.id;
            page.appendItem(plugin.id + ':streams:' + E(base) + ':' + E(type) + ':' + E(v.id) + ':' + E((meta.name || '') + ' ' + t), 'directory', {
                title: t, icon: v.thumbnail || meta.poster || logo, description: v.overview || v.description || ''
            });
        }
        return;
    }
    renderStreams(page, base, type, id, meta.name || id, meta.poster);
});

route('season:([^:]*):([^:]*):([^:]*):(.*)', function(page, eb, et, ei, es) {
    var base = D(eb), type = D(et), id = D(ei), season = parseInt(es, 10);
    var meta = fetchMeta(base, type, id);
    header(page, (meta.name || id) + (season === 0 ? ' - Especiales' : ' - Temporada ' + season));
    if (meta.background) { page.metadata.background = meta.background; page.metadata.backgroundAlpha = 0.3; }
    renderEpisodes(page, base, type, meta, season);
});

route('streams:([^:]*):([^:]*):([^:]*):(.*)', function(page, eb, et, ei, etitle) {
    var title = D(etitle);
    header(page, title);
    renderStreams(page, D(eb), D(et), D(ei), title, null);
});

route('search:(.*)', function(page, eq) {
    var q = D(eq);
    header(page, 'Buscar: ' + q);
    page.model.contents = 'grid';
    if (!q) return;
    var n = 0, seen = {}, addons = getAddons();
    for (var i = 0; i < addons.length; i++) {
        var base = addons[i], m = getManifest(base);
        if (!m) continue;
        var cats = m.catalogs || [];
        for (var j = 0; j < cats.length; j++) {
            if (!catSearchable(cats[j])) continue;
            var url = base + '/catalog/' + encPath(cats[j].type) + '/' + encPath(cats[j].id) + '/search=' + encodeURIComponent(q) + '.json';
            var d = getJSON(url, 120), metas = (d && d.metas) || [];
            for (var k = 0; k < metas.length; k++) {
                var mt = metas[k], key = base + '|' + (mt && mt.id);
                if (!mt || !mt.id || seen[key]) continue;
                seen[key] = true;
                addMetaItem(page, base, mt, cats[j].type);
                n++;
            }
        }
    }
    if (!n) page.appendItem('', 'separator', { title: 'Sin resultados' });
});

route('play:(.*)', function(page, enc) {
    var p = JSON.parse(D(enc)), src;
    if (p.m) {
        src = 'torrent:video:' + p.m;
    } else {
        if (p.h) applyHeaders(p.u, p.h, p.hls);
        src = p.hls ? 'hls:' + p.u : p.u;
    }
    var vp = { title: p.t || '', sources: [{ url: src }], no_fs_scan: true };
    if (p.i) vp.icon = p.i;
    if (p.s && p.s.length) vp.subtitles = p.s;
    page.type = 'video';
    page.source = 'videoparams:' + JSON.stringify(vp);
});

service.create(plugin.title, plugin.id + ':start', 'video', true, logo);
