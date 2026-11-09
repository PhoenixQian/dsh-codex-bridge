window.__ModuleLoader__.load({
  id: 'dsh-codex-bridge',
  factory(require) {
    const React = require('react');
    const PAGE_URL = 'http://127.0.0.1:32719/';
    const ORIGIN = 'http://127.0.0.1:32719';
    const PANEL_ID = 'codex-dsh-bridge';
    const BUILD_ID = 'tongzhou-community-0.3.0';
    const READING_VIEW_ID = 'tongzhou-reading';
    const h = React.createElement;
    let identityRequest;

    function useHostIdentity(revision = 0) {
      const [identity, setIdentity] = React.useState(null);
      React.useEffect(() => {
        let active = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => { controller.abort(); if (active) setIdentity(false); }, 4000);
        setIdentity(null);
        Promise.resolve().then(() => identityRequest(controller.signal)).then(result => {
          if (!active || controller.signal.aborted) return;
          const value = result?.ok === true ? result.value : null;
          setIdentity(value?.buildId === BUILD_ID && typeof value.instanceId === 'string' && /^[a-f0-9]{64}$/.test(value.instanceId)
            ? {buildId: value.buildId, instanceId: value.instanceId} : false);
        }).catch(() => { if (active) setIdentity(false); }).finally(() => clearTimeout(timeout));
        return () => { active = false; clearTimeout(timeout); controller.abort(); };
      }, [revision]);
      return identity;
    }

    function BridgeIcon(owner = {}) {
      return h('svg', {width: owner.size ?? 16, height: owner.size ?? 16,
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        'aria-hidden': true},
      h('path', {d: 'M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4'}));
    }

    function BridgePanel({pageUrl = PAGE_URL, nativeReading = false, onOpenOriginal} = {}) {
      const frame = React.useRef(null);
      const lastReply = React.useRef(0);
      const [status, setStatus] = React.useState('connecting');
      const [revision, setRevision] = React.useState(0);
      const identity = useHostIdentity(revision);

      React.useEffect(() => {
        if (!identity) return;
        let active = true;
        const start = Date.now();
        const receive = event => {
          if (event.origin !== ORIGIN || event.source !== frame.current?.contentWindow ||
            event.data?.type !== 'agent-bridge:ready' || event.data.buildId !== BUILD_ID || event.data.instanceId !== identity.instanceId) return;
          lastReply.current = Date.now();
          if (active) setStatus('responded');
        };
        window.addEventListener('message', receive);
        const timer = setInterval(() => {
          if (Date.now() - (lastReply.current || start) > 8000 && active) setStatus('offline');
        }, 1500);
        return () => {
          active = false;
          clearInterval(timer);
          window.removeEventListener('message', receive);
        };
      }, [revision, identity && identity.instanceId]);

      const retry = () => {
        lastReply.current = 0;
        setStatus('connecting');
        setRevision(value => value + 1);
      };
      return h('section', {style: {
        width: '100%', height: nativeReading
          ? 'max(360px, calc(var(--dsh-conversation-viewport-height, 75vh) - var(--dsh-composer-height, 120px)))'
          : '100%',
        minHeight: nativeReading ? 360 : 0, display: 'flex', flexDirection: 'column',
        paddingTop: nativeReading ? 0 : 'var(--dsh-frame-top-clearance, 0px)', boxSizing: 'border-box'
      }, 'aria-label': nativeReading ? '同舟 讨论正文' : '同舟 共享聊天'},
      h('header', {style: {
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 16px', borderBottom: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
        font: '13px/1.5 system-ui, sans-serif'
      }},
      h('strong', null, nativeReading ? '同舟讨论正文' : '同舟'),
      h('span', {'role': 'status', style: {flex: 1}}, identity === false
        ? '无法验证 DSH 宿主中的同舟实例，嵌入页面已停用。请检查插件连接后重试。'
        : identity === null ? '正在验证 DSH 插件实例…' : status === 'responded'
        ? nativeReading ? '记录已连接' : '共享页面已响应 · Agent 状态请查看页面内的身份与记录'
        : status === 'offline' ? '本机同舟服务未就绪，或 32719 端口被其他安装占用。请检查插件与运行状态后重试。'
          : '正在连接本机共享页面…'),
      onOpenOriginal && h('button', {type: 'button', onClick: onOpenOriginal,
        style: {cursor: 'pointer', padding: '3px 10px'}}, '原生聊天 / 协议记录'),
      h('button', {type: 'button', onClick: retry, style: {cursor: 'pointer', padding: '3px 10px'}}, '重新连接')),
      identity && h('iframe', {
        key: revision, ref: frame, src: pageUrl,
        title: nativeReading ? '同舟 具名讨论正文' : '同舟 共享聊天列表与记录',
        onError: () => setStatus('offline'),
        style: {width: '100%', flex: 1, minHeight: 0, border: 0, background: 'transparent', visibility: status === 'responded' ? 'visible' : 'hidden'},
        referrerPolicy: 'no-referrer', sandbox: nativeReading
          ? 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox'
          : 'allow-scripts allow-same-origin allow-forms allow-downloads'
      }));
    }

    const readingUrl = sessionId => `${ORIGIN}/reading?session=${encodeURIComponent(sessionId)}`;

    function NativeReadingView({sessionId, actions}) {
      return h(BridgePanel, {
        key: sessionId, pageUrl: readingUrl(sessionId), nativeReading: true,
        onOpenOriginal: actions?.setView ? () => actions.setView('chat') : undefined
      });
    }

    function NativeReadingProbe({sessionId, useStore, actions, markVerified}) {
      const frame = React.useRef(null);
      const view = React.useRef(null);
      const [verified, setVerified] = React.useState(null);
      const identity = useHostIdentity();
      view.current = useStore(state => state.view);

      React.useEffect(() => {
        if (!identity) return;
        let switched = false;
        const receive = event => {
          if (event.origin !== ORIGIN || event.source !== frame.current?.contentWindow ||
            event.data?.type !== 'agent-bridge:reading-ready' || event.data.buildId !== BUILD_ID || event.data.instanceId !== identity.instanceId || event.data.sessionId !== sessionId ||
            !['shared-discussion', 'native-public'].includes(event.data.source)) return;
          markVerified(sessionId, event.data.source);
          setVerified(sessionId);
          // The SDK falls back to Chat when the persisted view is null. Only
          // replace that default; explicit native tab selections stay intact.
          if (!switched && view.current === null) {
            switched = true;
            actions.setView(READING_VIEW_ID);
          }
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
      }, [sessionId, actions, markVerified, identity && identity.instanceId]);

      return h('span', null,
        // The bridge origin verifies ownership itself. This probe carries no
        // discussion text across postMessage and needs no cross-origin API grant.
        identity && h('iframe', {
          key: sessionId, ref: frame, src: `${readingUrl(sessionId)}&probe=1`,
          title: '同舟会话归属检查', hidden: true, 'aria-hidden': true, tabIndex: -1,
          referrerPolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin'
        }),
        identity === false && h('span', {'role':'status'}, '无法验证同舟实例，请检查插件连接。'),
        identity && verified === sessionId && h('button', {
          type: 'button', onClick: () => actions.setView(READING_VIEW_ID),
          style: {cursor: 'pointer', padding: '3px 10px'}
        }, '同舟正文'));
    }

    function NativeReadonlyComposer() {
      return h('div', {style: {padding: '12px 20px', font: '13px/1.6 system-ui, sans-serif'}},
        h('span', null, '讨论与补充请前往同舟。'),
        h('a', {href: PAGE_URL, target: '_blank', rel: 'noopener noreferrer',
          style: {marginLeft: 8}}, '前往同舟继续讨论'));
    }

    return {
      name: 'codex-dsh-bridge',
      inject: ['slots', 'connection'],
      apply(ctx) {
        identityRequest = signal => ctx.connection.rpc.call('/api', 'tongzhou.bridgeIdentity', {}, signal);
        const verifiedSessions = new Set();
        let installComposer;
        const markVerified = (sessionId, source) => {
          if (!['shared-discussion', 'native-public'].includes(source) || verifiedSessions.has(sessionId)) return;
          verifiedSessions.add(sessionId);
          installComposer?.(sessionId);
        };
        ctx.slots.inject('conversation.composer', () => {
          const registrations = new Map();
          const install = sessionId => {
            if (registrations.has(sessionId)) return;
            const matched = {sessionId};
            registrations.set(sessionId, ctx.slots.register({
              name: 'conversation.composer', priority: 100,
              select: owner => owner.sessionId === sessionId ? matched : null
            }, NativeReadonlyComposer));
          };
          installComposer = install;
          for (const sessionId of verifiedSessions) install(sessionId);
          return () => {
            if (installComposer === install) installComposer = undefined;
            for (const dispose of registrations.values()) dispose();
            registrations.clear();
          };
        });
        // A live slots service can precede the layout/sidebar declarations on
        // cold boot. Native inject waits and owns cleanup if a slot disappears.
        ctx.slots.inject('main', () =>
          ctx.slots.register({name: 'main', key: PANEL_ID}, BridgePanel));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: '同舟'}, BridgeIcon));
        // conversation.view is a native strict-Session list slot. Sharing the
        // shell's store gives its shortcut the same tab action as the header.
        ctx.slots.inject('conversation.view', () => {
          const nativeStore = ctx.slots.entries?.('conversation.session')
            ?.find(entry => entry.store?.spec?.persist === 'dsh.conversation')?.store;
          return ctx.slots.register({name: 'conversation.view', id: READING_VIEW_ID,
            order: 5, label: '同舟正文', ...(nativeStore ? {store: nativeStore} : {})}, NativeReadingView);
        });
        ctx.slots.inject('conversation.session.header.utilities', () => {
          // Reuse the shell's Store handle through its supported same-scope
          // registration contract. Do not edit browser storage or replace Chat.
          // A future SDK with a different store gets the explicit view only.
          const nativeStore = ctx.slots.entries?.('conversation.session')
            ?.find(entry => entry.store?.spec?.persist === 'dsh.conversation')?.store;
          if (!nativeStore) return;
          return ctx.slots.register({name: 'conversation.session.header.utilities',
            id: READING_VIEW_ID, order: 5, store: nativeStore,
            inject: () => ({markVerified})}, NativeReadingProbe);
        });
      }
    };
  }
});
