const STATUS = /(?:([A-Za-z0-9_]{1,30})\/)?status(?:es)?\/(\d{5,25})(?:\/(?:video|photo)\/(\d{1,2}))?/i;
const HOSTS = /(?:^|[/.])(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr|nitter|xcancel)\.(?:com|net|poast\.org)/i;

export function parseLink(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (/^\d{5,25}$/.test(s)) return { id: s, user: null, index: 1, key: `${s}-1` };
  if (!HOSTS.test(s) && !/^\/?[A-Za-z0-9_]+\/status/.test(s)) return null;
  const m = s.match(STATUS);
  if (!m) return null;
  const user = m[1] && m[1].toLowerCase() !== 'i' ? m[1] : null;
  const index = m[3] ? Math.max(1, parseInt(m[3], 10)) : 1;
  return { id: m[2], user, index, key: `${m[2]}-${index}` };
}

export function parseLinks(text) {
  const out = [];
  const seen = new Set();
  for (const token of String(text || '').split(/\s+/)) {
    const ref = parseLink(token);
    if (ref && !seen.has(ref.key)) {
      seen.add(ref.key);
      out.push(ref);
    }
  }
  return out;
}

function dims(url) {
  const m = /\/(\d{2,4})x(\d{2,4})\//.exec(url || '');
  return m ? { width: +m[1], height: +m[2] } : { width: 0, height: 0 };
}

function mp4s(media) {
  const list = [];
  for (const f of media.formats || []) {
    if (f && f.url && (f.container === 'mp4' || /\.mp4(\?|$)/.test(f.url))) {
      list.push({ url: f.url, bitrate: f.bitrate || 0, ...dims(f.url) });
    }
  }
  if (!list.length) {
    for (const v of media.variants || []) {
      if (v && v.url && (v.content_type === 'video/mp4' || /\.mp4(\?|$)/.test(v.url))) {
        list.push({ url: v.url, bitrate: v.bitrate || 0, ...dims(v.url) });
      }
    }
  }
  if (!list.length && media.url) {
    const d = dims(media.url);
    list.push({
      url: media.url,
      bitrate: 0,
      width: d.width || media.width || 0,
      height: d.height || media.height || 0,
    });
  }
  return list;
}

function fxVideos(tweet) {
  const media = (tweet && tweet.media && (tweet.media.all || tweet.media.videos)) || [];
  return media
    .filter((m) => m && (m.type === 'video' || m.type === 'gif'))
    .map((m) => ({
      width: m.width || 0,
      height: m.height || 0,
      duration: m.duration || 0,
      thumb: m.thumbnail_url || '',
      formats: mp4s(m),
    }))
    .filter((v) => v.formats.length);
}

export function fromFx(json) {
  const t = json && json.tweet;
  if (!t) return null;
  let videos = fxVideos(t);
  let source = t;
  if (!videos.length && t.quote) {
    videos = fxVideos(t.quote);
    source = t.quote;
  }
  return {
    id: String(source.id || t.id),
    url: source.url || t.url,
    author: (source.author && source.author.screen_name) || '',
    name: (source.author && source.author.name) || '',
    text: source.text || '',
    videos,
  };
}

export function fromVx(json) {
  if (!json || !Array.isArray(json.media_extended)) return null;
  const videos = json.media_extended
    .filter((m) => m && (m.type === 'video' || m.type === 'gif') && m.url)
    .map((m) => ({
      width: (m.size && m.size.width) || 0,
      height: (m.size && m.size.height) || 0,
      duration: (m.duration_millis || 0) / 1000,
      thumb: m.thumbnail_url || '',
      formats: [{ url: m.url, bitrate: 0, ...dims(m.url) }],
    }));
  return {
    id: String(json.tweetID || json.conversationID || ''),
    url: json.tweetURL || '',
    author: json.user_screen_name || '',
    name: json.user_name || '',
    text: json.text || '',
    videos,
  };
}

export function pickFormats(video, maxSide = 1920, prepShort = 360) {
  const list = video.formats.slice();
  const side = (f) => Math.max(f.width || 0, f.height || 0);
  const short = (f) => Math.min(f.width || 0, f.height || 0);
  const byBitrate = list.slice().sort((a, b) => b.bitrate - a.bitrate || side(b) - side(a));
  const play = byBitrate.find((f) => !side(f) || side(f) <= maxSide) || byBitrate[0];
  const ascending = list.slice().sort((a, b) => short(a) - short(b) || a.bitrate - b.bitrate);
  const prep = ascending.find((f) => short(f) >= prepShort) || play;
  return { play: play.url, prep: prep.url };
}

async function getJson(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class ResolveError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function resolveTweet(ref) {
  const fx = fromFx(await getJson(`https://api.fxtwitter.com/status/${ref.id}`));
  if (fx && fx.videos.length) return fx;
  const vx = fromVx(await getJson(`https://api.vxtwitter.com/i/status/${ref.id}`));
  if (vx && vx.videos.length) return vx;
  if (fx || vx) throw new ResolveError('novideo');
  throw new ResolveError('offline');
}
