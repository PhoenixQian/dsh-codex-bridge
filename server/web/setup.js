/* Optional local integration; opening this panel performs no model request. */
(() => {
  const button = document.getElementById('open-setup');
  const dialog = document.createElement('dialog');
  dialog.className = 'setup-dialog';
  const heading = document.createElement('h2'); heading.textContent = '接入本机 Codex';
  const description = document.createElement('p');
  description.textContent = 'DSH 安装此插件即可打开完整同舟。跨 Agent 讨论还需要本机已安装并登录的 Codex。';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.className = 'setup-status';
  const detail = document.createElement('dl'); detail.className = 'setup-detail';
  const scope = document.createElement('p'); scope.className = 'notice';
  scope.textContent = '接入按钮仅安装随插件提供的协作技能，不调用模型。账号登录由 Codex 自己完成。';
  const field = document.createElement('label'); field.textContent = 'Codex 可执行文件路径（自动发现失败时填写）';
  const path = document.createElement('input'); path.placeholder = '/绝对路径/codex'; path.autocomplete = 'off'; field.append(path);
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const close = document.createElement('button'); close.className = 'quiet-button'; close.textContent = '关闭';
  const refresh = document.createElement('button'); refresh.className = 'quiet-button'; refresh.textContent = '检查连接';
  const install = document.createElement('button'); install.className = 'primary-button'; install.textContent = '一键接入 Codex';
  actions.append(close, refresh, install); dialog.append(heading, description, status, detail, scope, field, actions); document.body.append(dialog);
  let pending = false;
  function show(value) {
    detail.replaceChildren();
    for (const [name, text] of [['本机 Codex', value.codex.message], ['协作技能', value.skill.installed ? '已安装' : value.skill.conflict ? '已有不同版本，已保留' : '尚未安装'], ['技能位置', value.skill.path]]) {
      const term = document.createElement('dt'), data = document.createElement('dd'); term.textContent = name; data.textContent = text; detail.append(term, data);
    }
    status.textContent = value.message;
    install.disabled = value.skill.conflict || value.skill.installed || (!value.codex.available && !path.value.trim());
    install.textContent = value.skill.installed ? '已接入' : '一键接入 Codex';
  }
  async function request(installing = false) {
    if (pending) return;
    pending = true; refresh.disabled = install.disabled = true; status.textContent = installing ? '正在安装协作技能…' : '正在检查本机连接…';
    try {
      const response = await fetch(installing ? '/api/setup/codex-install' : '/api/setup', installing ? {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(path.value.trim() ? {codexCliPath:path.value.trim()} : {})} : {});
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '本机接入未完成。'); show(value);
    } catch (error) { status.textContent = error.message; install.disabled = false; }
    finally { pending = false; refresh.disabled = false; }
  }
  button.addEventListener('click', () => { dialog.showModal(); request(); });
  close.addEventListener('click', () => dialog.close());
  refresh.addEventListener('click', () => request());
  install.addEventListener('click', () => request(true));
  path.addEventListener('input', () => { if (!pending) install.disabled = !path.value.trim(); });
})();
