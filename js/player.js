const Player = (function () {
  let player = null;
  let ready = false;
  let onReadyFn = null;
  let onStateChangeFn = null;
  let onErrorFn = null;

  const stateNames = {
    '-1': 'unstarted',
    '0': 'ended',
    '1': 'playing',
    '2': 'paused',
    '3': 'buffering',
    '5': 'cued'
  };

  function createPlayer(containerId) {
    player = new YT.Player(containerId, {
      height: '100%',
      width: '100%',
      playerVars: {
        enablejsapi: 1,
        autoplay: 0,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        disablekb: 1,
        fs: 0,
        playsinline: 1
      },
      events: {
        onReady: function (event) {
          ready = true;
          if (onReadyFn) onReadyFn(event);
        },
        onStateChange: function (event) {
          if (onStateChangeFn) onStateChangeFn(event.data);
        },
        onError: function (event) {
          if (onErrorFn) onErrorFn(event.data);
          console.error('YouTube player error', event.data);
        }
      }
    });
  }

  function init(config) {
    if (!config || !config.containerId) {
      throw new Error('Player.init requiere containerId');
    }
    onReadyFn = config.onReady || null;
    onStateChangeFn = config.onStateChange || null;
    onErrorFn = config.onError || null;

    if (window.YT && window.YT.Player) {
      createPlayer(config.containerId);
      return;
    }

    const tag = document.createElement('script');
    tag.id = 'youtube-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = function () {
      createPlayer(config.containerId);
    };
  }

  function isReady() {
    return ready && player && typeof player.getPlayerState === 'function';
  }

  function isUnstarted() {
    return player.getPlayerState() === -1;
  }

  function loadPlaylist(playlistId, index, startSeconds) {
    if (!isReady()) return;
    if (!playlistId || typeof playlistId !== 'string' || playlistId.length < 5) {
      console.warn('[Player] loadPlaylist: ID invalido o muy corto:', playlistId);
      return;
    }
    player.loadPlaylist({
      list: playlistId,
      listType: 'playlist',
      index: index || 0,
      startSeconds: startSeconds || 0
    });
  }

  function loadVideo(videoId, startSeconds) {
    if (!isReady()) return;
    if (!videoId || typeof videoId !== 'string' || videoId.length < 5) {
      console.warn('[Player] loadVideo: ID invalido o muy corto:', videoId);
      return;
    }
    player.loadVideoById({
      videoId: videoId,
      startSeconds: startSeconds || 0
    });
  }

  function cueVideo(videoId, startSeconds) {
    if (!isReady()) return;
    if (!videoId || typeof videoId !== 'string' || videoId.length < 5) {
      console.warn('[Player] cueVideo: ID invalido o muy corto:', videoId);
      return;
    }
    player.cueVideoById({
      videoId: videoId,
      startSeconds: startSeconds || 0
    });
  }

  function cuePlaylist(playlistId, index, startSeconds) {
    if (!isReady()) return;
    player.cuePlaylist({
      list: playlistId,
      listType: 'playlist',
      index: index || 0,
      startSeconds: startSeconds || 0
    });
  }

  function play() {
    if (isReady()) player.playVideo();
  }

  function pause() {
    if (isReady()) player.pauseVideo();
  }

  function stop() {
    if (isReady()) player.stopVideo();
  }

  function seekTo(seconds, allowSeekAhead) {
    if (isReady()) player.seekTo(seconds, allowSeekAhead !== false);
  }

  function playVideoAt(index) {
    if (isReady()) player.playVideoAt(index || 0);
  }

  function previousVideo() {
    if (isReady()) player.previousVideo();
  }

  function nextVideo() {
    if (isReady()) player.nextVideo();
  }

  function getCurrentTime() {
    return isReady() ? player.getCurrentTime() : 0;
  }

  function getDuration() {
    return isReady() ? player.getDuration() : 0;
  }

  function getState() {
    return isReady() ? player.getPlayerState() : null;
  }

  function getStateName() {
    return stateNames[String(getState())] || 'unknown';
  }

  function getVideoId() {
    try {
      const data = player.getVideoData && player.getVideoData();
      return data && data.video_id ? data.video_id : null;
    } catch (e) {
      return null;
    }
  }

  function getPlaylistIndex() {
    try {
      return isReady() && typeof player.getPlaylistIndex === 'function'
        ? player.getPlaylistIndex()
        : 0;
    } catch (e) {
      return 0;
    }
  }

  function getVolume() {
    return isReady() ? player.getVolume() : 100;
  }

  function setVolume(vol) {
    if (isReady()) player.setVolume(vol);
  }

  return {
    init,
    isReady,
    isUnstarted,
    loadPlaylist,
    loadVideo,
    cueVideo,
    cuePlaylist,
    play,
    pause,
    stop,
    seekTo,
    playVideoAt,
    previousVideo,
    nextVideo,
    getCurrentTime,
    getDuration,
    getState,
    getStateName,
    getVideoId,
    getPlaylistIndex,
    getVolume,
    setVolume
  };
})();

window.Player = Player;
