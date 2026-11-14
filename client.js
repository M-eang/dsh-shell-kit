/**
 * dsh-quick-restart — 浏览器半边。
 *
 * 在「设置 → 一键重启」里放一张卡片：显示宿主能不能自重启、上次重启的结果、
 * 插件操作是否在进行中，以及一个「立即重启」按钮。点击后走
 * POST /api/quick-restart/restart，随后轮询状态直到进程消失（表示重启开始）。
 *
 * 采用 DSH 客户端模块的 __ModuleLoader__ 包壳格式（与 dsh-session-recycle-bin 一致），
 * 只用 require('react')，不引入额外依赖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-shell-kit',
  factory: (require) => {
    'use strict';
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    /** 模块路由前缀（restart 模块自己的 status / restart）。 */
    const MODULE_PREFIX = '/api/shell-kit/restart';
    /** kit 聚合状态（模块清单 + profile 变更提示）。 */
    const KIT_PREFIX = '/api/shell-kit';
    const PLUGIN_HEADER = 'x-dsh-plugin';
    const PLUGIN_HEADER_VALUE = 'shell-kit';
    /**
     * 重启窗口里的轮询间隔。以前是 1 秒，而每轮都要宿主摊一遍全部模块状态，
     * 于是"等重启"本身就成了一份持续负载；2 秒对"进程有没有回来"完全够用。
     */
    const POLL_MS = 2000;

    /* ------------------------------------------------------------------ */
    /* 文案                                                                */
    /* ------------------------------------------------------------------ */

    const MESSAGES = {
      zh: {
        sectionLabel: 'Shell Kit',
        title: '一键重启 DeepSeek Harness',
        lead: '插件或配置变更提示「需重启」时，不需要手动退出再从桌面打开：这里会结束当前进程并按原样重新启动。',
        supported: '当前宿主支持一键重启',
        unsupported: '当前宿主不支持一键重启',
        checking: '正在读取宿主状态…',
        statusFailed: '读取状态失败',
        hostLabel: '宿主',
        hostValue: 'Electron 壳 {shell} · DSH Host {host} · 端口 {port}',
        lastRestart: '上次重启',
        lastRestartNone: '本插件还没有执行过重启',
        lastRestartValue: '{outcome} · 耗时 {seconds} 秒 · {time}',
        outcomeOk: '成功',
        outcomeOkPortTimeout: '已重启（端口未在等待时间内恢复）',
        outcomeKilledOnly: '只杀未启（自检）',
        outcomeRelaunchFailed: '重新启动失败',
        outcomeRelaunchDied: '新进程立即退出',
        outcomeExitTimeout: '等待旧进程退出超时',
        outcomeIdentityUnverified: '身份校验失败，已放弃',
        outcomeRecovered: '看门狗把它救回来了',
        watchdog: '看门狗',
        watchdogValue: '已接管重新启动（{outcome}）',
        pluginOperation: '插件操作',
        pluginOperationBusy: '有插件操作正在进行：{detail}',
        pluginOperationIdle: '没有检测到进行中的插件操作',
        pendingLabel: 'profile 配置',
        restartNow: '立即重启',
        scheduling: '正在安排重启…',
        forceLabel: '跳过插件操作与静默期检查（强制重启）',
        confirm: '现在重启 DeepSeek Harness？窗口会自动关闭并重新打开。',
        scheduled: '已安排重启，约 {seconds} 秒后动手。',
        alreadyScheduled: '重启已经在路上（约 {seconds} 秒后动手），不需要再点一次。',
        actionFailed: '操作失败',
        moduleDisabled: '重启模块已在配置里关闭（config.modules.restart = false），这里只显示状态。',
        moduleFailed: '重启模块挂载失败：{message}',
        sectionFailed: 'Shell Kit 的聚合状态读取失败：{message}',
        shellRestarting: '已请桌面端重启 Harness（窗口保留，稍后自动回到新实例）…',
        shellFallback: '桌面端通道没成功（{message}），改用插件自带的重启方式…',
        pluginBusy: '有插件操作正在进行，等它写完再重启更安全；确实要现在重启请勾选下面的强制选项。',
        profileChanged: '本进程启动后改动过：{names}（可能已热挂载，也可能要重启才完全生效）',
        pendingNone: '本进程启动后没有变化',
        logsLabel: '宿主日志',
        logsValue: '{file}（{size} 字节）· 发 /logs 看尾部',
        logsOff: '日志模块未启用',
        channelShell: '重启方式：桌面端通道（只重启 Harness 子进程，窗口保留）',
        channelHelper: '重启方式：插件自带助手（整应用重启；当前桌面端没有官方重启通道）',
        down: '进程已经退出，正在等它回来…',
        back: '进程已经回来了，正在刷新页面…',
        failed: '重启失败',
        logTitle: '查看最近日志',
        logEmpty: '（暂时没有日志）',
        logLive: '实时跟随（SSE）',
        logLiveFailed: '实时流已断开；宿主重启后需要重新勾选。',
        hmrTitle: '热重载（HMR）',
        hmrMissing: 'profile 里没有 hmr 条目：装了 @deepseek-ai/dsh-hmr 的话，源码与配置改动都需要重启。',
        hmrDisabled: 'HMR 条目被停用了：任何改动都要重启。',
        hmrInactive: 'HMR 条目在，但当前没有存活的实例（从未启动或已被释放）。',
        hmrConfigOnly: 'HMR 活着，但只监听 profile 配置（config.root 为空）：改 cordis.yml / cordis.patch.yml / manifest 热生效，改插件源码仍需重启。想在改源码时也热生效，把这条条目的 config.root 设成 ["."]。',
        hmrActive: 'HMR 活着且监听了源码目录：源码与配置改动都会热生效。',
        hmrSources: '监听的目录：{roots}',
        hmrLastReload: '最近一次重载：{time}（本次进程内共 {count} 次）',
        hmrNoReload: '本次进程内还没有观察到重载事件（也可能只是没改过东西）。',
        hmrEvents: '最近事件：',
        desktopOnly: '此按钮只在 DeepSeek Harness 桌面端可用。',
        menuRestart: '重启',
        menuRestartTitle: '重启 DeepSeek Harness（插件与配置变更立即生效）',
        menuRestartBusy: '重启中…',
      },
      en: {
        sectionLabel: 'Shell Kit',
        title: 'One-click restart',
        lead: 'When a plugin or configuration change asks for a restart, this ends the current process and starts it again the same way — no manual quit and relaunch.',
        supported: 'This host supports one-click restart',
        unsupported: 'This host does not support one-click restart',
        checking: 'Reading host status…',
        statusFailed: 'Could not read status',
        hostLabel: 'Host',
        hostValue: 'Electron shell {shell} · DSH host {host} · port {port}',
        lastRestart: 'Last restart',
        lastRestartNone: 'This plugin has not restarted the app yet',
        lastRestartValue: '{outcome} · {seconds}s · {time}',
        outcomeOk: 'Succeeded',
        outcomeOkPortTimeout: 'Restarted (port did not recover in time)',
        outcomeKilledOnly: 'Killed only (self-test)',
        outcomeRelaunchFailed: 'Relaunch failed',
        outcomeRelaunchDied: 'New process exited immediately',
        outcomeExitTimeout: 'Timed out waiting for the old process',
        outcomeIdentityUnverified: 'Aborted: identity could not be verified',
        outcomeRecovered: 'Recovered by the watchdog',
        watchdog: 'Watchdog',
        watchdogValue: 'Took over the relaunch ({outcome})',
        pluginOperation: 'Plugin operation',
        pluginOperationBusy: 'A plugin operation is running: {detail}',
        pluginOperationIdle: 'No plugin operation detected',
        pendingLabel: 'Profile config',
        restartNow: 'Restart now',
        scheduling: 'Scheduling the restart…',
        forceLabel: 'Skip the plugin-operation and cooldown checks (force)',
        confirm: 'Restart DeepSeek Harness now? The window will close and reopen by itself.',
        scheduled: 'Restart scheduled, firing in about {seconds}s.',
        alreadyScheduled: 'A restart is already on its way (about {seconds}s), no need to click again.',
        actionFailed: 'Action failed',
        moduleDisabled: 'The restart module is switched off in config (config.modules.restart = false); status only.',
        moduleFailed: 'The restart module failed to mount: {message}',
        sectionFailed: 'Could not read the Shell Kit aggregate status: {message}',
        shellRestarting: 'Asked DSH Desktop to restart Harness (the window stays; it comes back on the new instance)…',
        shellFallback: 'The desktop channel did not work ({message}); falling back to the plugin’s own restart…',
        pluginBusy: 'A plugin operation is still running; waiting for it to finish is safer. Tick the force option to restart anyway.',
        profileChanged: 'Changed since this process started: {names} (may already be hot-mounted, or may need a restart)',
        pendingNone: 'Unchanged since this process started',
        logsLabel: 'Host log',
        logsValue: '{file} ({size} bytes) · send /logs to tail it',
        logsOff: 'Log module not enabled',
        channelShell: 'Restart channel: DSH Desktop (restarts the Harness child process only, window stays)',
        channelHelper: 'Restart channel: this plugin’s own helper (whole-app restart; this desktop build has no official restart channel)',
        down: 'The process is gone; waiting for it to come back…',
        back: 'The process is back; reloading the page…',
        failed: 'Restart failed',
        logTitle: 'Recent log',
        logEmpty: '(no log yet)',
        logLive: 'Follow live (SSE)',
        logLiveFailed: 'The live stream is closed; tick again after the host restarts.',
        hmrTitle: 'Hot reload (HMR)',
        hmrMissing: 'No hmr entry in this profile: with @deepseek-ai/dsh-hmr installed, both source and config edits need a restart.',
        hmrDisabled: 'The HMR entry is switched off: every change needs a restart.',
        hmrInactive: 'The HMR entry exists but has no live instance right now (never started, or already disposed).',
        hmrConfigOnly: 'HMR is live but only watches profile config (config.root is empty): edits to cordis.yml / cordis.patch.yml / manifest apply hot, source edits still need a restart. To hot-apply source edits too, set that entry’s config.root to ["."].',
        hmrActive: 'HMR is live and watching source roots: both source and config edits apply hot.',
        hmrSources: 'Watched roots: {roots}',
        hmrLastReload: 'Last reload: {time} ({count} in this process)',
        hmrNoReload: 'No reload event seen in this process yet (possibly nothing was edited).',
        hmrEvents: 'Recent events:',
        desktopOnly: 'This button only works in the DeepSeek Harness desktop app.',
        menuRestart: 'Restart',
        menuRestartTitle: 'Restart DeepSeek Harness so plugin and config changes take effect',
        menuRestartBusy: 'Restarting…',
      },
    };

    function locale() {
      try {
        const lang = String(document?.documentElement?.lang ?? '').toLowerCase();
        return lang.startsWith('zh') ? 'zh' : 'en';
      } catch (error) {
        return 'zh';
      }
    }

    function t(key, vars) {
      const table = MESSAGES[locale()] ?? MESSAGES.zh;
      let text = table[key] ?? MESSAGES.zh[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replaceAll(`{${name}}`, String(value));
        }
      }
      return text;
    }

    function outcomeLabel(outcome) {
      switch (outcome) {
        case 'ok': return t('outcomeOk');
        case 'ok-port-timeout': return t('outcomeOkPortTimeout');
        case 'killed-only': return t('outcomeKilledOnly');
        case 'relaunch-failed': return t('outcomeRelaunchFailed');
        case 'relaunch-died': return t('outcomeRelaunchDied');
        case 'exit-timeout': return t('outcomeExitTimeout');
        case 'identity-unverified': return t('outcomeIdentityUnverified');
        case 'watchdog-recovered': return t('outcomeRecovered');
        default: return outcome ?? '?';
      }
    }

    /* ------------------------------------------------------------------ */
    /* 样式（设计令牌，浅色默认 + DSH 深色外观）                            */
    /* ------------------------------------------------------------------ */

    const STYLE_ID = 'dsh-shell-kit-style';
    const CSS = `
:root {
  --dqr-text: #1f2328;
  --dqr-muted: #6b7280;
  --dqr-faint: #9ca3af;
  --dqr-surface: #ffffff;
  --dqr-subtle: #f6f7f9;
  --dqr-border: #e5e7eb;
  --dqr-accent: #2563eb;
  --dqr-accent-hover: #1d4ed8;
  --dqr-on-accent: #ffffff;
  --dqr-danger: #dc2626;
  --dqr-ok: #16a34a;
}
body[data-ds-dark-theme], html[data-ds-dark-theme] {
  --dqr-text: #e6e8ea;
  --dqr-muted: #9aa3ad;
  --dqr-faint: #6b7280;
  --dqr-surface: #1b1e21;
  --dqr-subtle: #23262a;
  --dqr-border: #33383d;
  --dqr-accent: #4f8cff;
  --dqr-accent-hover: #6ba0ff;
  --dqr-on-accent: #0b0d0f;
  --dqr-danger: #f87171;
  --dqr-ok: #4ade80;
}
.dqr-root {
  color: var(--dqr-text);
  font-family: var(--dsw-font-family, inherit);
  font-size: 14px;
  line-height: 1.6;
  max-width: 760px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dqr-title { font-size: 16px; font-weight: 600; margin: 0; }
.dqr-lead { color: var(--dqr-muted); margin: 0; }
.dqr-card {
  border: 1px solid var(--dqr-border);
  border-radius: 10px;
  background: var(--dqr-surface);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dqr-row { display: flex; gap: 8px; align-items: baseline; }
.dqr-row-label { color: var(--dqr-muted); min-width: 84px; flex: 0 0 auto; }
.dqr-row-value { flex: 1 1 auto; word-break: break-all; }
.dqr-badge {
  display: inline-flex; align-items: center; gap: 6px;
  border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--dqr-border); background: var(--dqr-subtle); color: var(--dqr-muted);
}
.dqr-badge-ok { color: var(--dqr-ok); border-color: color-mix(in srgb, var(--dqr-ok) 40%, transparent); }
.dqr-badge-warn { color: var(--dqr-danger); border-color: color-mix(in srgb, var(--dqr-danger) 40%, transparent); }
.dqr-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dqr-button {
  appearance: none; border: 1px solid transparent; border-radius: 8px;
  background: var(--dqr-accent); color: var(--dqr-on-accent);
  font: inherit; font-weight: 600; padding: 7px 16px; cursor: pointer;
}
.dqr-button:hover:not(:disabled) { background: var(--dqr-accent-hover); }
.dqr-button:disabled { opacity: 0.55; cursor: not-allowed; }
.dqr-check { display: inline-flex; align-items: center; gap: 6px; color: var(--dqr-muted); cursor: pointer; }
.dqr-note { color: var(--dqr-muted); font-size: 13px; }
.dqr-note-error { color: var(--dqr-danger); }
.dqr-note-ok { color: var(--dqr-ok); }
.dqr-pre {
  margin: 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dqr-border);
  background: var(--dqr-subtle); color: var(--dqr-muted);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px; line-height: 1.5; max-height: 220px; overflow: auto; white-space: pre-wrap;
}
.dqr-live { display: flex; flex-direction: column; gap: 6px; }
.dqr-details summary { cursor: pointer; color: var(--dqr-muted); }
`;

    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head ?? document.documentElement).append(style);
      } catch (error) {
        /* 样式注不进去也只是不好看，不影响功能 */
      }
    }

    /**
     * 桌面端自己暴露的重启通道（dsh-desktop 的 preload：dshDesktop.restartHarness）。
     *
     * 这是「源码里的做法」：dsh-desktop 自带的插件（插件市场安装器、workbench、
     * 图像生成）在装完东西需要重启时，就是先判断这个函数在不在，在就调它 ——
     * 由壳把 Harness 子进程停掉再拉一个新的，窗口保留、还会顺带跑壳自己的
     * profile 维护（迁移 / generation / 待移除插件）。
     *
     * 官方端（@deepseek-ai/dsh-desktop 0.2.0-rc.2）没有这个桥，所以那边回落到
     * 插件自带的重启助手（整应用重启）。
     */
    function shellBridge() {
      try {
        const bridge = globalThis.dshDesktop
        return bridge !== null && bridge !== undefined && typeof bridge.restartHarness === 'function' ? bridge : null
      } catch (error) {
        return null
      }
    }

    /* ------------------------------------------------------------------ */
    /* 与宿主通信                                                          */
    /* ------------------------------------------------------------------ */

    async function api(path, options = {}) {
      const response = await fetch(`${path}`, {
        method: options.method ?? 'GET',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE,
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
        error.code = payload?.error?.code;
        throw error;
      }
      return payload.data;
    }

    /* ------------------------------------------------------------------ */
    /* 面板                                                                */
    /* ------------------------------------------------------------------ */

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      try { return date.toLocaleString(); } catch (error) { return value; }
    }

    function StatusRow(label, value) {
      return h('div', { className: 'dqr-row', key: label },
        h('div', { className: 'dqr-row-label' }, label),
        h('div', { className: 'dqr-row-value' }, value));
    }

    /**
     * HMR 的稳定 verdict code → 本地化说明。
     *
     * 线上只传 code（missing / disabled / inactive / config-only / active），中文文案留在
     * 客户端，这样宿主侧没有"翻译"职责，改文案也不用动宿主代码。
     */
    function hmrVerdictText(t, status) {
      switch (status?.verdict) {
        case 'missing': return t('hmrMissing');
        case 'disabled': return t('hmrDisabled');
        case 'inactive': return t('hmrInactive');
        case 'active': return t('hmrActive');
        case 'config-only': return t('hmrConfigOnly');
        default: return `${t('hmrTitle')}: ${String(status?.verdict ?? 'unknown')}`;
      }
    }

    /**
     * 日志预览：默认显示跟上一次轮询一起拿回来的尾部；勾上「实时」后换成
     * `GET /api/shell-kit/logs/stream` 的 SSE 流（逐行 `event: line`）。
     *
     * 只用浏览器全局的 EventSource：它是同源 GET，宿主那道 `x-dsh-plugin`
     * 头只对非 GET 强制，所以这里不需要额外凭证。勾掉或组件卸载都会 close()，
     * 宿主那边的流也随之 stop（模块 dispose 时同样会停）。
     */
    function LiveLog({ t, fallbackLines }) {
      const [live, setLive] = useState(false);
      const [lines, setLines] = useState([]);
      const [error, setError] = useState('');
      const boxRef = useRef(null);
      const translate = useRef(t);
      translate.current = t;

      useEffect(() => {
        if (!live) return undefined;
        setError('');
        const source = new EventSource(`${KIT_PREFIX}/logs/stream`);
        const onLine = (event) => {
          let payload = null;
          try { payload = JSON.parse(event.data); } catch (parseError) { return; }
          if (typeof payload?.line !== 'string') return;
          // 只留最后 200 行：这是一个状态面板，不是日志查看器。
          setLines((previous) => [...previous.slice(-199), payload.line]);
        };
        source.addEventListener('line', onLine);
        source.addEventListener('error', () => {
          if (source.readyState === EventSource.CLOSED) setError(translate.current('logLiveFailed'));
        });
        return () => { source.close(); };
      }, [live]);

      useEffect(() => {
        const box = boxRef.current;
        if (box !== null) box.scrollTop = box.scrollHeight;
      }, [lines]);

      const shown = live ? lines : (Array.isArray(fallbackLines) ? fallbackLines : []);
      return h('div', { className: 'dqr-live' },
        h('label', { className: 'dqr-check' },
          h('input', {
            type: 'checkbox',
            checked: live,
            onChange: (event) => setLive(event.target.checked),
          }),
          t('logLive')),
        error !== '' ? h('div', { className: 'dqr-note dqr-note-error' }, error) : null,
        h('pre', { className: 'dqr-pre', ref: boxRef }, shown.length > 0 ? shown.join('\n') : t('logEmpty')));
    }

    /* ------------------------------------------------------------------ */
    /* 重启：排上去 + 等它回落（设置页卡片与标题栏按钮共用）                */
    /* ------------------------------------------------------------------ */

    /**
     * 把重启排上去：优先桌面端壳的通道，没有（或壳拒绝）就回落到插件自带助手。
     *
     * `notify(text)` 是给调用方的进度回调 —— 设置页卡片写进 notice，
     * 标题栏按钮不显示文字进度，传空函数即可。
     * @param {{ by: string, force: boolean, notify: (text: string) => void }} options
     */
    async function scheduleRestart(options) {
      const notify = typeof options.notify === 'function' ? options.notify : () => {};

      // 优先交给桌面端壳（与 dsh-desktop 自带插件同一条通道）。
      const bridge = shellBridge();
      if (bridge !== null) {
        notify(t('shellRestarting'));
        try {
          const result = await bridge.restartHarness();
          if (result !== null && result !== undefined && result.ok === false) {
            throw new Error('desktop refused the restart');
          }
          return { channel: 'shell' };
        } catch (error) {
          notify(t('shellFallback', { message: error?.message ?? String(error) }));
        }
      }

      notify(t('scheduling'));
      // 注意路径：restart 模块的 POST 路由就是 `${KIT_PREFIX}/restart`
      // （module 自己的 status 才是 `${MODULE_PREFIX}/status`）。
      // 这里曾经误拼成 ${MODULE_PREFIX}/restart → /api/shell-kit/restart/restart → 404。
      const result = await api(`${KIT_PREFIX}/restart`, {
        method: 'POST',
        body: { by: options.by, force: options.force === true },
      });
      const seconds = Math.max(1, Math.round(((result?.alreadyScheduled ? result.pendingInMs : result?.delayMs) ?? 1200) / 1000));
      notify(result?.alreadyScheduled ? t('alreadyScheduled', { seconds }) : t('scheduled', { seconds }));
      return { channel: 'helper', result };
    }

    /**
     * 重启排上之后的等待循环，返回停止函数。
     *
     * 只打轻量的 `/api/shell-kit/restart/status`：这段时间里只关心"进程还在不在"，
     * 没必要每轮都让宿主重算一遍全部模块状态。看到进程消失 → onPhase('down')，
     * 之后再看到响应 → onPhase('back') 并刷新页面。
     * @param {(phase: 'down' | 'back') => void} onPhase
     */
    function watchRestart(onPhase) {
      let missed = 0;
      let timer = 0;
      let stopped = false;
      const tick = async () => {
        timer = 0;
        if (stopped) return;
        try {
          await api(`${MODULE_PREFIX}/status`);
          if (missed > 0) {
            stopped = true;
            onPhase('back');
            window.setTimeout(() => { try { window.location.reload(); } catch (error) { /* 保持原页 */ } }, 1500);
            return;
          }
        } catch (error) {
          if (stopped) return;
          missed += 1;
          onPhase('down');
        }
        if (!stopped) timer = window.setTimeout(tick, POLL_MS);
      };
      tick();
      return () => {
        stopped = true;
        if (timer) window.clearTimeout(timer);
      };
    }

    function RestartPanel({ ctx }) {
      const [status, setStatus] = useState(null);
      const [moduleInfo, setModuleInfo] = useState(null);
      const [error, setError] = useState('');
      const [phase, setPhase] = useState('idle');
      const [notice, setNotice] = useState('');
      const [force, setForce] = useState(false);
      const [hmrModule, setHmrModule] = useState(null);
      const stopWatching = useRef(null);

      /** 从聚合状态里取出 restart / logs 两个模块，摊平成卡片用的一份对象。 */
      const flatten = useCallback((data) => {
        const meta = data?.modules?.restart ?? null;
        const flat = meta?.status ?? null;
        setModuleInfo(meta === null ? null : { enabled: meta.enabled !== false, error: meta.error ?? null });
        setStatus(flat === null ? null : { ...flat, profileChanges: data?.profileChanges ?? null, logs: data?.modules?.logs?.status ?? null });
        // HMR 模块整块交给下面单独渲染（它只读活体 loader，不参与重启判定）。
        setHmrModule(data?.modules?.hmr ?? null);
      }, []);

      const load = useCallback(async () => {
        try {
          const data = await api(`${KIT_PREFIX}/status`);
          // 聚合状态里取 restart 模块的状态，摊平后再附上 kit 级的 profile 变更提示，
          // 这样下面所有字段读取都与原 dsh-quick-restart 一致。
          flatten(data);
          setError('');
        } catch (err) {
          setError(t('sectionFailed', { message: err?.message ?? String(err) }));
        }
      }, [flatten]);

      useEffect(() => {
        load();
        return () => {
          if (typeof stopWatching.current === 'function') stopWatching.current();
        };
      }, [load]);

      /**
       * 重启已经排上之后的等待循环（实现在上面的 watchRestart）：进程消失算成功，
       * 之后再看得到响应就刷新页面。
       */
      const watch = useCallback(() => {
        stopWatching.current = watchRestart((next) => {
          setPhase(next);
          setNotice(t(next === 'back' ? 'back' : 'down'));
        });
      }, []);

      const restart = useCallback(async () => {
        if (!(status?.supported === true)) return;
        if (!window.confirm(t('confirm'))) return;
        // 先过宿主自己的守卫：插件市场在写 node_modules 时重启会把 profile 写坏。
        const busy = status?.pluginOperation?.busy === true;
        if (busy && !force) {
          setError(t('pluginBusy'));
          setNotice('');
          return;
        }
        setError('');
        setPhase('scheduled');
        try {
          await scheduleRestart({
            by: 'settings-panel',
            force,
            notify: (text) => { setPhase('scheduled'); setNotice(text); },
          });
          watch();
        } catch (err) {
          setPhase('idle');
          setError(`${t('actionFailed')}：${err?.message ?? String(err)}`);
          setNotice('');
        }
      }, [force, status, watch]);

      const supported = status?.supported === true;
      const moduleDisabled = moduleInfo !== null && moduleInfo.enabled === false;
      const moduleError = moduleInfo?.error ?? null;
      const busy = status?.pluginOperation?.busy === true;
      const report = status?.lastReport ?? null;
      const watchdog = status?.watchdogReport ?? null;
      const lines = [];

      lines.push(h('h3', { className: 'dqr-title', key: 'title' }, t('title')));
      lines.push(h('p', { className: 'dqr-lead', key: 'lead' }, t('lead')));

      const rows = [];
      if (status === null) {
        rows.push(StatusRow(t('hostLabel'), t('checking')));
      } else {
        rows.push(StatusRow(t('hostLabel'), t('hostValue', {
          shell: status.shellPid ?? '?',
          host: status.hostPid ?? '?',
          port: status.port ?? '?',
        })));
        rows.push(h('div', { className: 'dqr-row', key: 'capability' },
          h('div', { className: 'dqr-row-label' }, ''),
          h('div', { className: 'dqr-row-value' },
            h('span', { className: `dqr-badge ${supported ? 'dqr-badge-ok' : 'dqr-badge-warn'}` },
              supported ? t('supported') : t('unsupported')),
            !supported && Array.isArray(status.reasons) && status.reasons.length > 0
              ? h('div', { className: 'dqr-note' }, status.reasons.join('；'))
              : null)));
        rows.push(StatusRow(t('lastRestart'), report?.outcome
          ? t('lastRestartValue', {
            outcome: outcomeLabel(report.outcome),
            seconds: ((report.elapsedMs ?? 0) / 1000).toFixed(1),
            time: formatTime(report.at),
          })
          : t('lastRestartNone')));
        if (watchdog?.outcome === 'watchdog-recovered' || watchdog?.outcome === 'watchdog-port-timeout') {
          rows.push(StatusRow(t('watchdog'), t('watchdogValue', { outcome: outcomeLabel('watchdog-recovered') })));
        }
        rows.push(StatusRow(t('pluginOperation'), busy
          ? t('pluginOperationBusy', { detail: (status.pluginOperation?.hits ?? []).map((hit) => hit.detail).join('；') })
          : t('pluginOperationIdle')));

        // 「本进程启动后 profile 配置有没有被动过」：变了既可能已热挂载、也可能要重启。
        const changes = status.profileChanges;
        const changedFiles = Array.isArray(changes?.changed) ? changes.changed : [];
        rows.push(StatusRow(t('pendingLabel'), changedFiles.length > 0
          ? t('profileChanged', { names: changedFiles.join('、') })
          : t('pendingNone')));
        const logsInfo = status.logs;
        rows.push(StatusRow(t('logsLabel'), logsInfo === null || logsInfo === undefined
          ? t('logsOff')
          : t('logsValue', { file: logsInfo.newest ?? '?', size: logsInfo.newestSize ?? 0 })));
      }

      lines.push(h('div', { className: 'dqr-card', key: 'card' },
        h('div', { key: 'meta' }, rows),
        h('div', { className: 'dqr-actions', key: 'actions' },
          h('button', {
            type: 'button',
            className: 'dqr-button',
            disabled: !supported || phase === 'scheduled' || phase === 'down' || phase === 'back',
            onClick: restart,
          }, phase === 'idle' ? t('restartNow') : t('scheduling')),
          h('label', { className: 'dqr-check' },
            h('input', { type: 'checkbox', checked: force, onChange: (event) => setForce(event.target.checked) }),
            t('forceLabel'))),
        notice ? h('div', { className: `dqr-note ${phase === 'down' || phase === 'back' ? 'dqr-note-ok' : ''}`, key: 'notice' }, notice) : null,
        h('div', { className: 'dqr-note', key: 'channel' }, shellBridge() !== null ? t('channelShell') : t('channelHelper')),
        error ? h('div', { className: 'dqr-note dqr-note-error', key: 'error' }, error) : null,
        // 模块被配置关掉 / 挂载失败时说清真实原因，别让用户以为"这个宿主不支持"。
        moduleDisabled ? h('div', { className: 'dqr-note', key: 'moduleDisabled' }, t('moduleDisabled')) : null,
        moduleError !== null ? h('div', { className: 'dqr-note dqr-note-error', key: 'moduleError' }, t('moduleFailed', { message: moduleError })) : null,
        !supported && status !== null && !moduleDisabled && moduleError === null
          ? h('div', { className: 'dqr-note', key: 'desktopOnly' }, t('desktopOnly'))
          : null));

      lines.push(h('details', { className: 'dqr-details', key: 'log' },
        h('summary', {}, t('logTitle')),
        h(LiveLog, { t, fallbackLines: status?.logTail ?? [] })));

      // 热重载：只报告事实（活体 loader 里读到的状态），不提供"请重载"的按钮 ——
      // 本版本的 dsh-hmr 没有对外暴露可编程的触发入口，伪造触发比如实说更危险。
      const hmrStatus = hmrModule?.status ?? null;
      const hmrBody = [];
      if (hmrModule !== null) {
        if (hmrModule.enabled === false) {
          hmrBody.push(h('div', { className: 'dqr-note', key: 'off' }, t('moduleDisabled')));
        }
        if (hmrModule.error) {
          hmrBody.push(h('div', { className: 'dqr-note dqr-note-error', key: 'failed' }, t('moduleFailed', { message: hmrModule.error })));
        }
        if (hmrStatus !== null) {
          hmrBody.push(h('div', {
            className: `dqr-note ${hmrStatus.watchesSources === true ? 'dqr-note-ok' : ''}`,
            key: 'verdict',
          }, hmrVerdictText(t, hmrStatus)));
          if (Array.isArray(hmrStatus.sourceRoots) && hmrStatus.sourceRoots.length > 0) {
            hmrBody.push(h('div', { className: 'dqr-note', key: 'roots' },
              t('hmrSources', { roots: hmrStatus.sourceRoots.join('、') })));
          }
          hmrBody.push(h('div', { className: 'dqr-note', key: 'last' }, hmrStatus.lastReloadAt
            ? t('hmrLastReload', { time: formatTime(hmrStatus.lastReloadAt), count: hmrStatus.reloadCount ?? 0 })
            : t('hmrNoReload')));
          const hmrEvents = Array.isArray(hmrStatus.recentEvents) ? hmrStatus.recentEvents.slice(0, 5) : [];
          if (hmrEvents.length > 0) {
            hmrBody.push(h('div', { className: 'dqr-note', key: 'eventsTitle' }, t('hmrEvents')));
            hmrBody.push(h('pre', { className: 'dqr-pre', key: 'events' }, hmrEvents.map((event) => [
              formatTime(event.at),
              event.kind,
              event.url ?? (Array.isArray(event.urls) && event.urls.length > 0 ? event.urls.join(', ') : ''),
              event.count === undefined ? '' : `×${event.count}`,
            ].filter((part) => part !== '').join(' ')).join('\n')));
          }
        }
      }
      lines.push(h('details', { className: 'dqr-details', key: 'hmr' },
        h('summary', {}, t('hmrTitle')),
        h('div', { className: 'dqr-live' }, hmrBody.length > 0 ? hmrBody : h('div', { className: 'dqr-note' }, t('checking')))));

      return h('div', { className: 'dqr-root' }, lines);
    }

    /* ------------------------------------------------------------------ */
    /* 标题栏菜单栏上的「重启」按钮（桌面端）                              */
    /* ------------------------------------------------------------------ */

    /*
     * 桌面端左上角那条「应用 / 编辑」是 preload 画的：一个 `[data-windows-menu]`
     * 宿主 + **open** shadow root，里面 `[role=menubar]` 下两个真的 <button>，
     * 点击只是把坐标发给主进程，由主进程 popup 一份原生菜单 —— 那份菜单的 items
     * 写死在 app.asar 的主进程里，插件扩不了（0.2.0-rc.2 的 `dsh-desktop:windows-menu`
     * 只认 application / edit 两个名字，其余一律抛 invalid popup request）。
     *
     * 但 shadow root 是 open 的，而按钮样式就写在同一个 shadow 的 <style> 上，
     * 所以往 `[role=menubar]` 里追加一个 <button>，外观（字号、圆角、hover、
     * focus ring）与「应用 / 编辑」逐像素一致，点击直接走本插件的重启通道。
     *
     * 浏览器窗口里根本没有那个宿主（preload 只在 `[data-shell-overlay]` 存在时挂），
     * 于是这里静默跳过 —— 这个按钮天然只在桌面端出现。
     */
    const CAPTION_ATTR = 'data-shell-kit-restart';

    /** 桌面端菜单栏的 menubar（宿主没起来时返回 null）。 */
    function captionBar() {
      try {
        const host = document.querySelector('[data-windows-menu]');
        const shadow = host === null || host === undefined ? null : host.shadowRoot;
        return shadow === null || shadow === undefined ? null : shadow.querySelector('[role="menubar"]');
      } catch (error) {
        return null;
      }
    }

    /** 按钮文案跟着界面语言与忙碌状态走。 */
    function captionButtonLabel(button) {
      button.textContent = button.dataset.busy === '1' ? t('menuRestartBusy') : t('menuRestart');
      button.title = t('menuRestartTitle');
      button.setAttribute('aria-label', t('menuRestartTitle'));
    }

    /** 标题栏那条「等回落」的轮询；重复触发或卸载前必须停掉，否则它会一直打 /status。 */
    let stopCaptionWatch = null;

    /**
     * 点菜单栏上的「重启」：确认 → 排上重启 → 等进程回落。
     *
     * 与设置页卡片走同一条 `scheduleRestart`（先壳、后自带助手），区别只有一句
     * confirm（把菜单点错变成整窗重启太粗暴）和失败时用原生 alert 报原因。
     */
    async function captionRestart(button) {
      if (button.dataset.busy === '1') return;
      if (!window.confirm(t('confirm'))) return;

      button.dataset.busy = '1';
      button.disabled = true;
      button.style.opacity = '0.55';
      captionButtonLabel(button);

      try {
        await scheduleRestart({ by: 'caption-menu', force: false, notify: () => {} });
      } catch (error) {
        button.dataset.busy = '';
        button.disabled = false;
        button.style.opacity = '';
        captionButtonLabel(button);
        window.alert(`${t('actionFailed')}：${error?.message ?? String(error)}`);
        return;
      }

      // 停表函数要记住：连点两次会让两条轮询同时打 /status，插件卸载后也没人收尾。
      if (stopCaptionWatch !== null) stopCaptionWatch();
      stopCaptionWatch = watchRestart(() => { /* 文案已经是「重启中…」，回落由 watchRestart 自己刷新页面 */ });
    }

    /**
     * 把按钮挂上去；宿主还没出现就等它出现。返回清理函数（交给 ctx.effect）。
     */
    function mountCaptionButton() {
      let observer = null;
      let langObserver = null;
      let button = null;

      const attach = () => {
        const bar = captionBar();
        if (bar === null) return false;
        // 热重载会重新跑 apply()：先把上一份留下的按钮摘掉再挂新的（旧 disposer 之后
        // 再去 remove() 自己那个已经脱离文档的节点，不会有副作用），保证永远只有一个。
        for (const stale of bar.querySelectorAll(`button[${CAPTION_ATTR}]`)) stale.remove();
        const created = document.createElement('button');
        created.type = 'button';
        created.setAttribute('role', 'menuitem');
        created.setAttribute(CAPTION_ATTR, '');
        // 和宿主自己的两个按钮一样不抢焦点（编辑器里的选区保持着），
        // 否则点一下菜单就把输入框的光标搞没了。
        created.addEventListener('pointerdown', (event) => { event.preventDefault(); });
        created.addEventListener('mousedown', (event) => { event.preventDefault(); });
        created.addEventListener('click', () => { captionRestart(created).catch(() => {}); });
        captionButtonLabel(created);
        bar.append(created);
        button = created;
        return true;
      };

      if (!attach()) {
        try {
          observer = new MutationObserver(() => {
            if (attach()) {
              observer.disconnect();
              observer = null;
            }
          });
          observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
        } catch (error) {
          observer = null;
        }
      }

      // 界面语言写在 documentElement[@lang] 上：切了就同步按钮文案。
      try {
        langObserver = new MutationObserver(() => { if (button !== null) captionButtonLabel(button); });
        langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      } catch (error) {
        langObserver = null;
      }

      return () => {
        if (observer !== null) observer.disconnect();
        if (langObserver !== null) langObserver.disconnect();
        if (stopCaptionWatch !== null) { stopCaptionWatch(); stopCaptionWatch = null; }
        if (button !== null) button.remove();
        button = null;
      };
    }

    /* ------------------------------------------------------------------ */
    /* 注册                                                                */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ensureStyle();
      // 设置面板的导航列高度固定且不可滚动，排在末尾的条目在小窗口下会被裁掉；
      // order 27 落在内存系统(20)与费用(30)之间，属于最上面几项，必然可见。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'shell-kit',
            order: 27,
            label: () => t('sectionLabel'),
          },
          (props) => RestartPanel({ ...props, ctx })
        )
      );

      // 桌面端：把「重启」挂到标题栏那条「应用 / 编辑」旁边。
      // ctx.effect 负责在插件卸载时把按钮与两个观察者一起撤掉。
      if (typeof ctx.effect === 'function') ctx.effect(() => mountCaptionButton(), 'dsh-shell-kit: caption restart button');
      else mountCaptionButton();
    }

    exports.apply = apply;
    exports.inject = ['slots', 'connection'];

    return module.exports;
  },
});
