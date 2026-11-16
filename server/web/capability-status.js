/* Capability discovery is separate from account authentication and model use. */
(() => {
  function problem(agent, capability = {}) {
    if (!capability.error && !capability.errorCode) return '';
    if (capability.errorCode === 'UNSUPPORTED_DSH_VERSION') {
      const version = capability.runtimeVersion || '未知';
      const supported = (capability.supportedRuntimeVersions || []).join('、');
      return `${agent} 当前版本 ${version} 尚未经过同舟兼容验证${supported ? `；已验证版本：${supported}` : ''}。请更新同舟后重试。`;
    }
    return `${agent} 能力目录暂不可用：${typeof capability.error === 'string' && capability.error ? capability.error : '请检查原生应用及插件运行状态后重试。'}`;
  }
  globalThis.TongzhouCapabilities = Object.freeze({problem});
})();
