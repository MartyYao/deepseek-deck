// settings.js — 外观设置页逻辑。预设表来自主进程（settings-get 单源），改动即时生效 + 自动保存。
(function () {
  'use strict';

  var DEFAULTS = {
    bg: { mode: 'default', preset: 'deepblue', custom: '#0d1b2a' },
    label: { mode: 'default', custom: '#e6e6e6' },
    sidebar: { mode: 'follow', custom: '#1c1c1e' },
    bubble: { mode: 'follow', custom: '#e8ecf4' },
    fontSize: 100,
  };

  var state = JSON.parse(JSON.stringify(DEFAULTS));
  var presets = {};

  var els = {
    presetList: document.getElementById('preset-list'),
    bgReset: document.getElementById('bg-reset'),
    bgCustomRow: document.getElementById('bg-custom-row'),
    bgCustom: document.getElementById('bg-custom'),
    labelReset: document.getElementById('label-reset'),
    labelCustomRow: document.getElementById('label-custom-row'),
    labelCustom: document.getElementById('label-custom'),
    sidebarReset: document.getElementById('sidebar-reset'),
    sidebarFollowRow: document.getElementById('sidebar-follow-row'),
    sidebarCustomRow: document.getElementById('sidebar-custom-row'),
    sidebarCustom: document.getElementById('sidebar-custom'),
    bubbleReset: document.getElementById('bubble-reset'),
    bubbleFollowRow: document.getElementById('bubble-follow-row'),
    bubbleCustomRow: document.getElementById('bubble-custom-row'),
    bubbleCustom: document.getElementById('bubble-custom'),
    fontReset: document.getElementById('font-reset'),
    fontSize: document.getElementById('font-size'),
    fontSizeVal: document.getElementById('font-size-val'),
    closeBtn: document.getElementById('close-btn'),
  };

  // 即时生效 + 自动保存；取色器拖动期间事件密集，做 150ms 去抖
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      window.dshShell.setSettings({ appearance: JSON.parse(JSON.stringify(state)) });
    }, 150);
  }

  function render() {
    // 预设色卡
    els.presetList.textContent = '';
    Object.keys(presets).forEach(function (name) {
      var p = presets[name];
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'preset-card' +
        (state.bg.mode === 'preset' && state.bg.preset === name ? ' selected' : '');
      var swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = p.base; // v2：预设只存 base 主色，色卡用 base 色渲染
      var label = document.createElement('span');
      label.textContent = p.label || name;
      card.appendChild(swatch);
      card.appendChild(label);
      card.addEventListener('click', function () {
        state.bg.mode = 'preset';
        state.bg.preset = name;
        render();
        save();
      });
      els.presetList.appendChild(card);
    });
    // 自定义背景
    els.bgCustom.value = state.bg.custom;
    els.bgCustomRow.classList.toggle('selected', state.bg.mode === 'custom');
    // 字体颜色
    els.labelCustom.value = state.label.custom;
    els.labelCustomRow.classList.toggle('selected', state.label.mode === 'custom');
    // 侧边栏：follow=跟随背景整板（选中跟随行）；custom=独立色（选中取色行）；default=均不选中
    els.sidebarFollowRow.classList.toggle('selected', state.sidebar.mode === 'follow');
    els.sidebarCustom.value = state.sidebar.custom;
    els.sidebarCustomRow.classList.toggle('selected', state.sidebar.mode === 'custom');
    // 气泡：follow=随主题色系（默认选中）；custom=独立色+自动对比度文字；default=均不选中
    els.bubbleFollowRow.classList.toggle('selected', state.bubble.mode === 'follow');
    els.bubbleCustom.value = state.bubble.custom;
    els.bubbleCustomRow.classList.toggle('selected', state.bubble.mode === 'custom');
    // 字号
    els.fontSize.value = String(state.fontSize);
    els.fontSizeVal.textContent = state.fontSize + '%';
  }

  function bind() {
    els.bgCustom.addEventListener('input', function () {
      state.bg.mode = 'custom';
      state.bg.custom = els.bgCustom.value;
      render();
      save();
    });
    els.bgReset.addEventListener('click', function () {
      state.bg = JSON.parse(JSON.stringify(DEFAULTS.bg));
      render();
      save();
    });
    els.labelCustom.addEventListener('input', function () {
      state.label.mode = 'custom';
      state.label.custom = els.labelCustom.value;
      render();
      save();
    });
    els.labelReset.addEventListener('click', function () {
      state.label = JSON.parse(JSON.stringify(DEFAULTS.label));
      render();
      save();
    });
    els.sidebarFollowRow.addEventListener('click', function () {
      state.sidebar.mode = 'follow';
      render();
      save();
    });
    els.sidebarCustom.addEventListener('input', function () {
      state.sidebar.mode = 'custom';
      state.sidebar.custom = els.sidebarCustom.value;
      render();
      save();
    });
    els.sidebarReset.addEventListener('click', function () {
      state.sidebar = JSON.parse(JSON.stringify(DEFAULTS.sidebar));
      state.sidebar.mode = 'default'; // 恢复默认 = 官方原样（区别于默认选中的 follow）
      render();
      save();
    });
    els.bubbleFollowRow.addEventListener('click', function () {
      state.bubble.mode = 'follow';
      render();
      save();
    });
    els.bubbleCustom.addEventListener('input', function () {
      state.bubble.mode = 'custom';
      state.bubble.custom = els.bubbleCustom.value;
      render();
      save();
    });
    els.bubbleReset.addEventListener('click', function () {
      state.bubble = JSON.parse(JSON.stringify(DEFAULTS.bubble));
      state.bubble.mode = 'default'; // 恢复默认 = 官方原样（区别于默认选中的 follow）
      render();
      save();
    });
    els.fontSize.addEventListener('input', function () {
      state.fontSize = Number(els.fontSize.value);
      els.fontSizeVal.textContent = state.fontSize + '%';
      save();
    });
    els.fontReset.addEventListener('click', function () {
      state.fontSize = DEFAULTS.fontSize;
      render();
      save();
    });
    els.closeBtn.addEventListener('click', function () { window.close(); });
  }

  function init() {
    bind();
    window.dshShell.getSettings().then(function (data) {
      if (data) {
        presets = data.presets || {};
        var a = data.settings && data.settings.appearance;
        if (a && typeof a === 'object') {
          if (a.bg && typeof a.bg === 'object') {
            if (typeof a.bg.mode === 'string') state.bg.mode = a.bg.mode;
            if (typeof a.bg.preset === 'string') state.bg.preset = a.bg.preset;
            if (typeof a.bg.custom === 'string') state.bg.custom = a.bg.custom;
          }
          if (a.label && typeof a.label === 'object') {
            if (typeof a.label.mode === 'string') state.label.mode = a.label.mode;
            if (typeof a.label.custom === 'string') state.label.custom = a.label.custom;
          }
          if (a.sidebar && typeof a.sidebar === 'object') {
            if (typeof a.sidebar.mode === 'string') state.sidebar.mode = a.sidebar.mode;
            if (typeof a.sidebar.custom === 'string') state.sidebar.custom = a.sidebar.custom;
          }
          if (a.bubble && typeof a.bubble === 'object') {
            if (typeof a.bubble.mode === 'string') state.bubble.mode = a.bubble.mode;
            if (typeof a.bubble.custom === 'string') state.bubble.custom = a.bubble.custom;
          }
          var n = Number(a.fontSize);
          if (isFinite(n) && n >= 90 && n <= 130) state.fontSize = n;
        }
      }
      render();
    }).catch(function () { render(); }); // IPC 失败也用默认值渲染，页面可用
  }

  init();
})();
