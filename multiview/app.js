/**
 * @file app.js - 치지직 멀티뷰어 코어 컨트롤러 (최근 시청 채널 중복 방지, 5개 단위 페이징 및 상하단 접기 지원)
 */

// 1. 상태 관리
const state = {
  streams: [],              // [{ id, title, x, y, w, h, isAudioForced, hlsInstance, videoEl }]
  activeStreamId: null,     // 현재 활성 스트림 ID
  isEditMode: false,        // 리사이즈/이동 모드
  isMagnetEnabled: true,    // 마그넷 스냅 활성화 여부
  isSidebarCollapsed: false,// 사이드바 접힘 상태
  activePresetType: null,   // 적용된 프리셋 종류 ('1x1', '2x1', '1x2', '2x2', '1pn', 'custom:이름', 'custom:manual')
  isCustomLayout: false,    // 커스텀 프리셋/수동 조절 유지 여부
  customPresets: {},        // 저장된 커스텀 프리셋
  recentChannels: [],       // [{ id, name }]
  visibleRecentCount: 5     // 현재 노출 중인 최근 채널 개수 (기본 5개)
};

const SNAP_THRESHOLD = 15;

// 2. DOM 요소 매핑
const elements = {
  playerGrid: document.getElementById('player-grid'),
  playerContainer: document.getElementById('player-container'),
  sidebar: document.getElementById('sidebar'),
  btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),
  tabChat: document.getElementById('tab-btn-chat'),
  tabSettings: document.getElementById('tab-btn-settings'),
  panelChat: document.getElementById('panel-chat'),
  panelSettings: document.getElementById('panel-settings'),
  chatFrameContainer: document.getElementById('chat-frame-container'),
  activeChannelTitle: document.getElementById('active-channel-title'),
  
  // 수동 입력
  inputChannelId: document.getElementById('input-channel-id'),
  btnAddStream: document.getElementById('btn-add-stream'),
  
  // 최근 채널 UI
  detailsRecentChannels: document.getElementById('details-recent-channels'),
  recentStatusMsg: document.getElementById('recent-status-msg'),
  recentChannelList: document.getElementById('recent-channel-list'),
  recentFoldTop: document.getElementById('recent-fold-top'),
  btnFoldRecentTop: document.getElementById('btn-fold-recent-top'),
  recentFoldBottom: document.getElementById('recent-fold-bottom'),
  btnMoreRecent: document.getElementById('btn-more-recent'),
  btnFoldRecentBottom: document.getElementById('btn-fold-recent-bottom'),

  // 설정 및 프리셋
  toggleEditMode: document.getElementById('toggle-edit-mode'),
  toggleMagnet: document.getElementById('toggle-magnet'),
  presetButtons: document.querySelectorAll('.btn-preset'),
  inputPresetName: document.getElementById('input-preset-name'),
  btnSaveCustomPreset: document.getElementById('btn-save-custom-preset'),
  customPresetList: document.getElementById('custom-preset-list')
};

// 3. 채널 ID 추출 유틸리티
function extractChannelId(input) {
  if (!input) return null;
  const cleanInput = input.trim();
  const hashMatch = cleanInput.match(/([a-fA-F0-9]{32})/);
  if (hashMatch) return hashMatch[1];
  const urlMatch = cleanInput.match(/chzzk\.naver\.com\/(?:live\/)?([a-zA-Z0-9_-]+)/);
  if (urlMatch && urlMatch[1]) return urlMatch[1];
  return cleanInput;
}

// 4. 치지직 라이브 API 파싱
async function fetchStreamInfo(channelId) {
  try {
    const res = await fetch(`https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`, {
      credentials: 'include'
    });
    if (!res.ok) throw new Error(`API HTTP Error: ${res.status}`);
    const data = await res.json();
    
    if (data.code !== 200 || !data.content) {
      throw new Error(data.message || '채널 정보를 찾을 수 없습니다.');
    }

    const content = data.content;
    const channelName = content.channel?.channelName || channelId;
    const status = content.status;

    if (status !== 'OPEN' || !content.livePlaybackJson) {
      return { channelName, hlsUrl: null, isLive: false };
    }

    const playback = JSON.parse(content.livePlaybackJson);
    const media = playback.media?.find(m => m.mediaId === 'HLS') || playback.media?.[0];
    const hlsUrl = media ? media.path : null;

    return { channelName, hlsUrl, isLive: true };
  } catch (err) {
    console.error(`[CHZZK API Error] Channel ${channelId}:`, err);
    return { channelName: channelId, hlsUrl: null, isLive: false, error: err.message };
  }
}

// 5. 엔트리 포인트
document.addEventListener('DOMContentLoaded', async () => {
  initEventListeners();
  await loadSavedPresets();
  await loadSavedRecentChannels();

  const params = new URLSearchParams(window.location.search);
  const initialChannel = params.get('channelId');
  if (initialChannel) {
    const parsedId = extractChannelId(initialChannel);
    if (parsedId) addStream(parsedId);
  }
});

// 6. 이벤트 바인딩
function initEventListeners() {
  elements.btnToggleSidebar.addEventListener('click', toggleSidebar);
  elements.tabChat.addEventListener('click', () => switchTab('chat'));
  elements.tabSettings.addEventListener('click', () => switchTab('settings'));

  // 수동 채널 추가
  elements.btnAddStream.addEventListener('click', () => {
    const rawVal = elements.inputChannelId.value.trim();
    if (!rawVal) return;
    const channelId = extractChannelId(rawVal);
    if (channelId) {
      addStream(channelId);
      elements.inputChannelId.value = '';
    } else {
      alert('올바른 치지직 채널 주소 또는 채널 ID를 입력해주세요.');
    }
  });

  // 최근 채널 5개 더보기 버튼
  elements.btnMoreRecent.addEventListener('click', () => {
    state.visibleRecentCount += 5;
    renderRecentChannels();
  });

  // 상단 접기 버튼 (5개로 리셋)
  elements.btnFoldRecentTop.addEventListener('click', () => {
    state.visibleRecentCount = 5;
    renderRecentChannels();
  });

  // 하단 접기 버튼 (5개로 리셋)
  elements.btnFoldRecentBottom.addEventListener('click', () => {
    state.visibleRecentCount = 5;
    renderRecentChannels();
  });

  // 전체 아코디언이 접힐 때 노출 개수를 기본 5개로 초기화
  elements.detailsRecentChannels.addEventListener('toggle', () => {
    if (!elements.detailsRecentChannels.open) {
      state.visibleRecentCount = 5;
      renderRecentChannels();
    }
  });

  elements.toggleEditMode.addEventListener('change', (e) => {
    state.isEditMode = e.target.checked;
    document.body.classList.toggle('edit-mode', state.isEditMode);
  });

  elements.toggleMagnet.addEventListener('change', (e) => {
    state.isMagnetEnabled = e.target.checked;
  });

  elements.presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.isCustomLayout = false;
      applyDefaultPreset(btn.dataset.preset);
    });
  });

  elements.btnSaveCustomPreset.addEventListener('click', saveCurrentLayoutAsPreset);
}

// 7. 최근 시청 채널 로컬 스토리지 관리 (중복 제거 & 단일 노출 보장)
async function saveRecentChannel(channelId, channelName) {
  // 동일한 채널 ID가 이미 존재하면 필터링하여 삭제 후 최상단에 1개만 삽입
  state.recentChannels = state.recentChannels.filter(c => c.id !== channelId);
  state.recentChannels.unshift({ id: channelId, name: channelName });

  // 최대 50개까지만 보관
  if (state.recentChannels.length > 50) {
    state.recentChannels.pop();
  }

  await browser.storage.local.set({ recentChannels: state.recentChannels });
  renderRecentChannels();
}

async function loadSavedRecentChannels() {
  const data = await browser.storage.local.get('recentChannels');
  state.recentChannels = data.recentChannels || [];
  renderRecentChannels();
}

async function deleteRecentChannel(channelId) {
  state.recentChannels = state.recentChannels.filter(c => c.id !== channelId);
  await browser.storage.local.set({ recentChannels: state.recentChannels });
  renderRecentChannels();
}

// 8. 최근 시청 채널 렌더링 (5개 단위 페이징 및 상하단 컨트롤 연동)
function renderRecentChannels() {
  const total = state.recentChannels.length;
  elements.recentChannelList.innerHTML = '';

  if (total === 0) {
    elements.recentStatusMsg.style.display = 'block';
    elements.recentFoldTop.classList.add('hidden');
    elements.recentFoldBottom.classList.add('hidden');
    return;
  }

  elements.recentStatusMsg.style.display = 'none';

  // 현재 노출할 목록 슬라이싱
  const currentDisplayList = state.recentChannels.slice(0, state.visibleRecentCount);

  currentDisplayList.forEach(item => {
    const li = document.createElement('li');
    li.className = 'recent-channel-item';
    li.innerHTML = `
      <span class="recent-channel-name" title="${item.name}">${item.name}</span>
      <div class="recent-channel-actions">
        <button class="btn-add-recent" type="button">+ 추가</button>
        <button class="btn-delete-recent" title="기록 삭제" type="button">✕</button>
      </div>
    `;

    li.querySelector('.btn-add-recent').addEventListener('click', () => {
      addStream(item.id);
    });

    li.querySelector('.btn-delete-recent').addEventListener('click', () => {
      deleteRecentChannel(item.id);
    });

    elements.recentChannelList.appendChild(li);
  });

  const isExpandedBeyond5 = state.visibleRecentCount > 5;
  const hasMoreToLoad = state.visibleRecentCount < total;

  // 상단 접기 버튼 (5개 초과 노출 시에만 보임)
  elements.recentFoldTop.classList.toggle('hidden', !isExpandedBeyond5);

  // 하단 컨트롤 바
  if (total > 5) {
    elements.recentFoldBottom.classList.remove('hidden');
    elements.btnMoreRecent.classList.toggle('hidden', !hasMoreToLoad);
    elements.btnFoldRecentBottom.classList.toggle('hidden', !isExpandedBeyond5);
  } else {
    elements.recentFoldBottom.classList.add('hidden');
  }
}

// 9. 사이드바 숨김/펼침 토글
function toggleSidebar() {
  state.isSidebarCollapsed = !state.isSidebarCollapsed;
  elements.sidebar.classList.toggle('collapsed', state.isSidebarCollapsed);
  elements.btnToggleSidebar.textContent = state.isSidebarCollapsed ? '❮' : '❯';
}

// 10. 탭 전환
function switchTab(tabName) {
  const isChat = tabName === 'chat';
  elements.tabChat.classList.toggle('active', isChat);
  elements.tabSettings.classList.toggle('active', !isChat);
  elements.panelChat.classList.toggle('active', isChat);
  elements.panelSettings.classList.toggle('active', !isChat);
}

// 11. 방송 추가 및 삭제
async function addStream(channelId) {
  if (state.streams.some(s => s.id === channelId)) return;

  const newStream = {
    id: channelId,
    title: channelId,
    x: 0,
    y: 0,
    w: 50,
    h: 50,
    isAudioForced: false,
    hlsInstance: null,
    videoEl: null
  };

  state.streams.push(newStream);

  if (!state.isCustomLayout) {
    recalculateAutoLayout();
  } else {
    newStream.x = 0;
    newStream.y = 0;
    newStream.w = 50;
    newStream.h = 50;
  }

  renderPlayers();
  setActiveStream(channelId);

  await loadHlsStream(newStream);
}

function removeStream(channelId) {
  const stream = state.streams.find(s => s.id === channelId);
  if (stream?.hlsInstance) {
    stream.hlsInstance.destroy();
  }

  state.streams = state.streams.filter(s => s.id !== channelId);
  if (state.activeStreamId === channelId) {
    state.activeStreamId = state.streams[0]?.id || null;
  }

  if (!state.isCustomLayout) {
    recalculateAutoLayout();
  }

  renderPlayers();
  updateChatView();
}

// 12. HLS 비디오 로딩 엔진 및 최근 시청 채널 자동 기록
async function loadHlsStream(stream) {
  const wrapper = elements.playerGrid.querySelector(`.player-wrapper[data-id="${stream.id}"]`);
  if (!wrapper) return;

  const video = wrapper.querySelector('video');
  const titleSpan = wrapper.querySelector('.stream-title');

  const info = await fetchStreamInfo(stream.id);
  stream.title = info.channelName;
  if (titleSpan) titleSpan.textContent = info.channelName;

  // 최근 시청 채널 자동 기록 (중복 방지 저장)
  saveRecentChannel(stream.id, info.channelName);

  if (!info.isLive || !info.hlsUrl) return;

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: false,
      lowLatencyMode: true,
      backBufferLength: 30
    });
    hls.loadSource(info.hlsUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {
        video.muted = true;
        video.play();
      });
    });

    stream.hlsInstance = hls;
    stream.videoEl = video;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = info.hlsUrl;
    video.play();
    stream.videoEl = video;
  }

  syncAudioVolumes();
}

// 13. 활성 방송 선택 및 오디오 제어
function setActiveStream(channelId) {
  state.activeStreamId = channelId;

  document.querySelectorAll('.player-wrapper').forEach(el => {
    el.classList.toggle('active', el.dataset.id === channelId);
  });

  updateChatView();
  syncAudioVolumes();
}

function toggleAudioForced(channelId) {
  const stream = state.streams.find(s => s.id === channelId);
  if (!stream) return;

  stream.isAudioForced = !stream.isAudioForced;
  syncAudioVolumes();
}

function syncAudioVolumes() {
  state.streams.forEach(stream => {
    const wrapper = elements.playerGrid.querySelector(`.player-wrapper[data-id="${stream.id}"]`);
    if (!wrapper) return;

    const video = wrapper.querySelector('video');
    const audioBtn = wrapper.querySelector('.btn-audio-toggle');
    const isMainAudio = stream.id === state.activeStreamId;
    const shouldPlaySound = isMainAudio || stream.isAudioForced;

    if (video) {
      video.muted = !shouldPlaySound;
    }

    if (audioBtn) {
      if (shouldPlaySound) {
        audioBtn.classList.add('audio-on');
        audioBtn.textContent = isMainAudio ? '🔊 주음성' : '🔊 동시듣기 중';
      } else {
        audioBtn.classList.remove('audio-on');
        audioBtn.textContent = '🔇 음소거됨 (클릭시 함께듣기)';
      }
    }
  });
}

function updateChatView() {
  if (!state.activeStreamId) {
    elements.activeChannelTitle.textContent = '선택된 방송 없음';
    elements.chatFrameContainer.innerHTML = '<div class="empty-notice">화면을 클릭하면 해당 방송의 채팅이 표시됩니다.</div>';
    return;
  }

  const activeStream = state.streams.find(s => s.id === state.activeStreamId);
  elements.activeChannelTitle.textContent = activeStream ? activeStream.title : state.activeStreamId;

  elements.chatFrameContainer.innerHTML = `
    <iframe 
      src="https://chzzk.naver.com/live/${state.activeStreamId}/chat" 
      allow="autoplay; encrypted-media">
    </iframe>
  `;
}

// 14. 마그넷 스냅 대상 좌표 수집기
function getMagnetSnapTargets(currentId, containerW, containerH) {
  const total = state.streams.length;
  const n = total > 2 ? total - 1 : 2;

  const snapX = [0, containerW];
  const snapY = [0, containerH];

  for (let i = 1; i < n; i++) {
    snapX.push((containerW / n) * i);
    snapY.push((containerH / n) * i);
  }

  state.streams.filter(s => s.id !== currentId).forEach(other => {
    const ox = (other.x / 100) * containerW;
    const oy = (other.y / 100) * containerH;
    const ow = (other.w / 100) * containerW;
    const oh = (other.h / 100) * containerH;

    snapX.push(ox, ox + ow);
    snapY.push(oy, oy + oh);

    for (let i = 1; i < n; i++) {
      snapX.push(ox + (ow / n) * i);
      snapY.push(oy + (oh / n) * i);
    }
  });

  return { snapX, snapY };
}

// 15. DOM 렌더링 엔진
function renderPlayers() {
  const existingWrappers = elements.playerGrid.querySelectorAll('.player-wrapper');
  existingWrappers.forEach(wrapper => {
    if (!state.streams.some(s => s.id === wrapper.dataset.id)) {
      wrapper.remove();
    }
  });

  state.streams.forEach(stream => {
    let wrapper = elements.playerGrid.querySelector(`.player-wrapper[data-id="${stream.id}"]`);

    if (!wrapper) {
      wrapper = createPlayerElement(stream);
      elements.playerGrid.appendChild(wrapper);
    }

    wrapper.style.left = `${stream.x}%`;
    wrapper.style.top = `${stream.y}%`;
    wrapper.style.width = `${stream.w}%`;
    wrapper.style.height = `${stream.h}%`;
    wrapper.classList.toggle('active', stream.id === state.activeStreamId);
  });

  syncAudioVolumes();
}

function createPlayerElement(stream) {
  const wrapper = document.createElement('div');
  wrapper.className = `player-wrapper ${stream.id === state.activeStreamId ? 'active' : ''}`;
  wrapper.dataset.id = stream.id;

  const toolbar = document.createElement('div');
  toolbar.className = 'player-toolbar';
  toolbar.innerHTML = `
    <span class="stream-title">${stream.title || stream.id}</span>
    <div class="toolbar-controls">
      <button class="btn-audio-toggle" type="button">🔇 음소거됨</button>
      <button class="btn-remove-stream" type="button">닫기</button>
    </div>
  `;

  toolbar.querySelector('.btn-audio-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAudioForced(stream.id);
  });

  toolbar.querySelector('.btn-remove-stream').addEventListener('click', (e) => {
    e.stopPropagation();
    removeStream(stream.id);
  });

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.controls = true;

  const handle = document.createElement('div');
  handle.className = 'resize-handle';

  initMoveDrag(toolbar, wrapper, stream);
  initResizeDrag(handle, wrapper, stream);

  wrapper.appendChild(toolbar);
  wrapper.appendChild(video);
  wrapper.appendChild(handle);

  wrapper.addEventListener('click', () => setActiveStream(stream.id));

  return wrapper;
}

// 16. 화면 자유 이동 핸들러
function initMoveDrag(toolbar, wrapper, stream) {
  toolbar.addEventListener('mousedown', (e) => {
    if (!state.isEditMode || e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();

    const containerRect = elements.playerContainer.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const initialLeft = (stream.x / 100) * containerRect.width;
    const initialTop = (stream.y / 100) * containerRect.height;
    const streamW = (stream.w / 100) * containerRect.width;
    const streamH = (stream.h / 100) * containerRect.height;

    function onMouseMove(moveEvent) {
      let curLeft = initialLeft + (moveEvent.clientX - startX);
      let curTop = initialTop + (moveEvent.clientY - startY);

      if (state.isMagnetEnabled) {
        const { snapX, snapY } = getMagnetSnapTargets(stream.id, containerRect.width, containerRect.height);

        for (const targetX of snapX) {
          if (Math.abs(curLeft - targetX) < SNAP_THRESHOLD) {
            curLeft = targetX;
            break;
          }
          if (Math.abs((curLeft + streamW) - targetX) < SNAP_THRESHOLD) {
            curLeft = targetX - streamW;
            break;
          }
        }

        for (const targetY of snapY) {
          if (Math.abs(curTop - targetY) < SNAP_THRESHOLD) {
            curTop = targetY;
            break;
          }
          if (Math.abs((curTop + streamH) - targetY) < SNAP_THRESHOLD) {
            curTop = targetY - streamH;
            break;
          }
        }
      }

      const percentX = Math.max(0, Math.min(100 - stream.w, (curLeft / containerRect.width) * 100));
      const percentY = Math.max(0, Math.min(100 - stream.h, (curTop / containerRect.height) * 100));

      stream.x = percentX;
      stream.y = percentY;
      wrapper.style.left = `${percentX}%`;
      wrapper.style.top = `${percentY}%`;
    }

    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      state.isCustomLayout = true;
      state.activePresetType = 'custom:manual';
      highlightActivePreset();
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

// 17. 크기 조절 핸들러
function initResizeDrag(handle, wrapper, stream) {
  handle.addEventListener('mousedown', (e) => {
    if (!state.isEditMode) return;
    e.preventDefault();
    e.stopPropagation();

    const containerRect = elements.playerContainer.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = (stream.w / 100) * containerRect.width;
    const startH = (stream.h / 100) * containerRect.height;
    const originLeft = (stream.x / 100) * containerRect.width;
    const originTop = (stream.y / 100) * containerRect.height;

    function onMouseMove(moveEvent) {
      let currentW = startW + (moveEvent.clientX - startX);
      let currentH = startH + (moveEvent.clientY - startY);

      if (state.isMagnetEnabled) {
        const { snapX, snapY } = getMagnetSnapTargets(stream.id, containerRect.width, containerRect.height);
        const rightEdge = originLeft + currentW;
        const bottomEdge = originTop + currentH;

        for (const targetX of snapX) {
          if (Math.abs(rightEdge - targetX) < SNAP_THRESHOLD) {
            currentW = targetX - originLeft;
            break;
          }
        }

        for (const targetY of snapY) {
          if (Math.abs(bottomEdge - targetY) < SNAP_THRESHOLD) {
            currentH = targetY - originTop;
            break;
          }
        }
      }

      const percentW = Math.max(10, Math.min(100 - stream.x, (currentW / containerRect.width) * 100));
      const percentH = Math.max(10, Math.min(100 - stream.y, (currentH / containerRect.height) * 100));

      stream.w = percentW;
      stream.h = percentH;
      wrapper.style.width = `${percentW}%`;
      wrapper.style.height = `${percentH}%`;
    }

    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      state.isCustomLayout = true;
      state.activePresetType = 'custom:manual';
      highlightActivePreset();
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

// 18. 프리셋 자동/수동 레이아웃
function recalculateAutoLayout() {
  const count = state.streams.length;
  if (count === 0) return;
  if (count === 1) applyDefaultPreset('1x1');
  else if (count === 2) applyDefaultPreset('2x1');
  else if (count <= 4) applyDefaultPreset('2x2');
  else applyDefaultPreset('1pn');
}

function applyDefaultPreset(type) {
  const count = state.streams.length;
  if (count === 0) return;

  state.activePresetType = type;
  highlightActivePreset();

  switch (type) {
    case '1x1':
      if (state.streams[0]) state.streams[0] = { ...state.streams[0], x: 0, y: 0, w: 100, h: 100 };
      break;
    case '2x1':
      state.streams.forEach((s, idx) => {
        s.x = (idx % 2) * 50;
        s.y = 0;
        s.w = 50;
        s.h = 100;
      });
      break;
    case '1x2':
      state.streams.forEach((s, idx) => {
        s.x = 0;
        s.y = (idx % 2) * 50;
        s.w = 100;
        s.h = 50;
      });
      break;
    case '2x2':
      state.streams.forEach((s, idx) => {
        s.x = (idx % 2) * 50;
        s.y = Math.floor(idx / 2) * 50;
        s.w = 50;
        s.h = 50;
      });
      break;
    case '1pn':
      if (state.streams[0]) state.streams[0] = { ...state.streams[0], x: 0, y: 0, w: 70, h: 100 };
      for (let i = 1; i < count; i++) {
        state.streams[i].x = 70;
        state.streams[i].y = (100 / (count - 1)) * (i - 1);
        state.streams[i].w = 30;
        state.streams[i].h = 100 / (count - 1);
      }
      break;
  }
  renderPlayers();
}

// 19. 활성 프리셋 하이라이트 동기화
function highlightActivePreset() {
  elements.presetButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === state.activePresetType);
  });

  document.querySelectorAll('.custom-preset-item').forEach(item => {
    item.classList.toggle('active', `custom:${item.dataset.name}` === state.activePresetType);
  });
}

// 20. 커스텀 프리셋 저장 및 불러오기
async function saveCurrentLayoutAsPreset() {
  const name = elements.inputPresetName.value.trim();
  if (!name) {
    alert('프리셋 이름을 입력해주세요.');
    return;
  }

  state.customPresets[name] = state.streams.map(s => ({
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h
  }));

  await browser.storage.local.set({ customPresets: state.customPresets });
  elements.inputPresetName.value = '';
  renderCustomPresetsList();
}

async function loadSavedPresets() {
  const data = await browser.storage.local.get('customPresets');
  state.customPresets = data.customPresets || {};
  renderCustomPresetsList();
}

function renderCustomPresetsList() {
  elements.customPresetList.innerHTML = '';
  Object.keys(state.customPresets).forEach(name => {
    const li = document.createElement('li');
    li.className = `custom-preset-item ${state.activePresetType === `custom:${name}` ? 'active' : ''}`;
    li.dataset.name = name;
    li.innerHTML = `
      <span>${name}</span>
      <div>
        <button class="btn-load" type="button">적용</button>
        <button class="btn-delete-preset" type="button">삭제</button>
      </div>
    `;

    li.querySelector('.btn-load').addEventListener('click', () => {
      state.isCustomLayout = true;
      state.activePresetType = `custom:${name}`;
      highlightActivePreset();

      const presetLayouts = state.customPresets[name];
      state.streams.forEach((s, idx) => {
        if (presetLayouts[idx]) {
          s.x = presetLayouts[idx].x;
          s.y = presetLayouts[idx].y;
          s.w = presetLayouts[idx].w;
          s.h = presetLayouts[idx].h;
        }
      });
      renderPlayers();
    });

    li.querySelector('.btn-delete-preset').addEventListener('click', async () => {
      delete state.customPresets[name];
      await browser.storage.local.set({ customPresets: state.customPresets });
      renderCustomPresetsList();
    });

    elements.customPresetList.appendChild(li);
  });
}