import { YOUTUBE_API_KEY, MAX_PLAYLIST_ITEMS, YT_API_BASE } from './config.js';

const YTApi = (function () {
  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(function () { return ''; });
      throw new Error('YouTube API ' + res.status + ': ' + text);
    }
    return res.json();
  }

  // Trae los videos de una playlist (hasta MAX_PLAYLIST_ITEMS).
  // Retorna [{ videoId, title, thumbnail, channel, duration, position }]
  async function getPlaylistItems(playlistId) {
    const items = [];
    let pageToken = '';
    const max = MAX_PLAYLIST_ITEMS;

    while (items.length < max) {
      const url = YT_API_BASE + '/playlistItems?part=snippet,contentDetails' +
        '&playlistId=' + encodeURIComponent(playlistId) +
        '&maxResults=' + Math.min(50, max - items.length) +
        '&pageToken=' + encodeURIComponent(pageToken) +
        '&key=' + encodeURIComponent(YOUTUBE_API_KEY);

      const data = await fetchJson(url);
      const part = (data.items || []).map(function (it, i) {
        const sn = it.snippet || {};
        const cd = it.contentDetails || {};
        const thumb = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default || sn.thumbnails.high)) || {};
        return {
          videoId: sn.resourceId && sn.resourceId.videoId,
          title: sn.title || 'Sin titulo',
          thumbnail: thumb.url || '',
          channel: sn.videoOwnerChannelTitle || sn.channelTitle || '',
          duration: parseISODuration(cd.duration),
          position: items.length + i + 1
        };
      }).filter(function (x) { return x.videoId; });

      items.push.apply(items, part);
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }

    return items.slice(0, max);
  }

  // Trae metadata de un video suelto.
  async function getVideo(videoId) {
    const url = YT_API_BASE + '/videos?part=snippet,contentDetails' +
      '&id=' + encodeURIComponent(videoId) +
      '&key=' + encodeURIComponent(YOUTUBE_API_KEY);
    const data = await fetchJson(url);
    if (!data.items || !data.items.length) return null;
    const it = data.items[0];
    const sn = it.snippet || {};
    const cd = it.contentDetails || {};
    const thumb = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default || sn.thumbnails.high)) || {};
    return {
      videoId: it.id,
      title: sn.title || 'Sin titulo',
      thumbnail: thumb.url || '',
      channel: sn.channelTitle || '',
      duration: parseISODuration(cd.duration)
    };
  }

  // Convierte ISO 8601 (PT1H2M3S) a segundos.
  function parseISODuration(iso) {
    if (!iso) return null;
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!m) return null;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseInt(m[3] || '0', 10);
    return h * 3600 + min * 60 + s;
  }

  return { getPlaylistItems, getVideo };
})();

window.YTApi = YTApi;
export default YTApi;
