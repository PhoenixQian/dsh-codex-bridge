(() => {
  const node = id => document.getElementById(id);
  const taskLabels = { draft: '草稿', planning: '规划中', running: '执行中', validating: '验收中', completed: '已完成', partial: '部分完成', cancelled: '已取消', error: '执行失败', needs_attention: '需要处理' };
  const memberLabels = {waiting_approval:'等待你确认',running:'执行中',idle:'空闲',waiting_discussion:'等待讨论结果',completed:'本轮已完成',needs_user:'等待你补充',interrupted:'已中断',error:'执行出错'};
  const active = status => ['planning', 'running', 'validating'].includes(status);
  const cardCache = new Map(), listCache = new Map(), pendingApprovals = new Set();
  const data = { visible: false, selected: new URL(location.href).searchParams.get('task') || localStorage.getItem('bridge-task') || null, discussionId: new URL(location.href).searchParams.get('conversation') || localStorage.getItem('bridge-conversation') || 'shared-discussion', rendered: null, version: 0, busy: false, again: false, pending: null, submitting: false, capabilities: null, loadingCapabilities: false, limit: 10, archived: false, messagePending: false, drafts: new Map(), lastTask: null };
  function make(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
  function reconcile(container, children) {
    if (container.insertBefore) {
      children.forEach((child,index) => { if(container.children[index] !== child) container.insertBefore(child,container.children[index] || null); });
      while(container.children.length > children.length) container.removeChild(container.lastElementChild);
    } else container.replaceChildren(...children);
  }
  const printable = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  function chatText(event) {
    const text = event.message || event.text || event.summary || '';
    if (event.type !== 'agent-message' || typeof text !== 'string') return text;
    try {
      const value = JSON.parse(text);
      if (typeof value.brief === 'string') return value.brief;
      if (Array.isArray(value.assignments)) return value.assignments.map(role => `${role.agent}：${role.goal}${role.outputs?.length ? '\n交付：' + role.outputs.join('、') : ''}`).join('\n\n');
    } catch { /* Original message is retained in the source details. */ }
    return text;
  }
  function say(text) { node('task-feedback').textContent = text; }
  async function request(path, input) {
    const response = await fetch(path, input === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '任务请求未完成');
    return result;
  }
  function disableActions() {
    data.rendered = null;
    for (const id of ['start-task', 'cancel-task', 'resume-task', 'send-task-message', 'archive-task']) node(id).disabled = true;
  }
  function current(id, version) { return data.visible && data.selected === id && data.version === version; }
  function showTasks(visible) {
    if (visible) data.discussionId = new URL(location.href).searchParams.get('conversation') || localStorage.getItem('bridge-conversation') || data.discussionId;
    data.visible = visible; data.version += 1; disableActions();
    node('tasks-page').hidden = !visible; node('task-browser').hidden = !visible;
    node('discussion-page').hidden = visible; node('discussion-browser').hidden = visible;
    node('show-tasks').setAttribute('aria-pressed', String(visible)); node('show-discussions').setAttribute('aria-pressed', String(!visible));
    if (visible) { history.replaceState(null, '', data.selected ? '/?task=' + encodeURIComponent(data.selected) : '/?view=tasks'); loadCapabilities(); refreshTasks(); }
    else history.replaceState(null, '', '/?conversation=' + encodeURIComponent(data.discussionId));
  }
  function selectTask(id) {
    if (data.selected) data.drafts.set(data.selected, node('task-message-input').value);
    node('task-message-input').value = data.drafts.get(id) || '';
    data.selected = id; data.version += 1; disableActions(); say(''); localStorage.setItem('bridge-task', id);
    history.replaceState(null, '', '/?task=' + encodeURIComponent(id));
    document.querySelector('.shell').classList.remove('sidebar-open'); refreshTasks();
  }
  function renderList(tasks) {
    node('task-count').textContent = tasks.length; const buttons=[];
    if (!tasks.length) buttons.push(make('p', 'task-list-empty', '还没有任务，先创建一份草稿。'));
    for (const task of tasks) {
      const key=JSON.stringify([task,data.selected===task.id]);
      if(listCache.has(key)){buttons.push(listCache.get(key));continue;}
      const button = make('button', `conversation-item${task.id === data.selected ? ' selected' : ''}`);
      button.append(make('strong', '', task.title || task.id), make('small', '', task.goal || '查看任务范围'));
      button.append(make('span', `tiny-status task-status ${task.status}`, taskLabels[task.status] || task.status || '状态待确认'));
      button.addEventListener('click', () => selectTask(task.id)); buttons.push(button);listCache.set(key,button);
    }
    const visible=new Set(buttons);for(const [key,button] of listCache)if(!visible.has(button))listCache.delete(key);
    reconcile(node('task-list'),buttons);
  }
  function panelText(id, value, empty) { node(id).replaceChildren(make('pre', 'task-value', value === undefined || value === null || value === '' ? empty : printable(value))); }
  function fields(id, values) {
    const list = make('dl', 'task-fields');
    for (const [label, value] of values) list.append(make('dt', '', label), make('dd', '', value === undefined || value === null || value === '' ? '未记录' : printable(value)));
    node(id).replaceChildren(list);
  }
  function renderValidation(value) {
    const container = node('task-validation'); container.replaceChildren();
    if (value === undefined || value === null) { container.append(make('p', 'task-muted', '尚无验收结果，未视为通过。')); return; }
    if (typeof value !== 'object') { container.append(make('p', 'task-value', String(value))); return; }
    const workerChecks = Array.isArray(value.workerSuccess) ? value.workerSuccess : [];
    const workerPassed = check => typeof check === 'boolean' ? check : check?.passed;
    const failed = (value.passed ?? value.ok) === false || value.inputVersions === false || value.outputsPresent === false || workerChecks.some(check => workerPassed(check) === false);
    const complete = value.inputVersions === true && value.outputsPresent === true && workerChecks.length > 0 && workerChecks.every(check => workerPassed(check) === true);
    const passed = failed ? false : (value.passed ?? value.ok) === true || complete ? true : undefined;
    container.append(make('strong', 'task-validation-result', passed === true ? '自动检查通过，等待用户验收' : passed === false ? '自动检查未通过' : '已记录自动检查证据，结果待确认'));
    container.append(make('p', 'task-muted', '系统检查不替代你对交付物内容的最终验收。'));
    for (const [field, label] of [['inputVersions', '输入版本一致'], ['outputsPresent', '计划产物齐备']]) {
      if (value[field] !== undefined) container.append(make('p', 'task-value', `${label}：${value[field] === true ? '通过' : value[field] === false ? '未通过' : '待确认'}`));
    }
    for (const check of workerChecks) container.append(make('p', 'task-value', `${check?.agent || '执行者'}执行：${workerPassed(check) === true ? '通过' : workerPassed(check) === false ? '未通过' : '待确认'}`));
    if (value.summary || value.message) container.append(make('p', 'task-value', value.summary || value.message));
    const checks = Array.isArray(value) ? value : value.checks || value.results || [];
    if (Array.isArray(checks)) for (const check of checks) container.append(make('p', 'task-value', typeof check === 'string' ? check : `${check.name || check.description || check.id || '验收项'}：${(check.passed ?? check.ok) === true ? '通过' : (check.passed ?? check.ok) === false ? '未通过' : check.status || '待确认'}${check.reason ? ' · ' + check.reason : ''}`));
    const evidence = make('details', 'task-event-source'); evidence.append(make('summary', '', '查看验收证据'), make('pre', 'task-value', printable(value))); container.append(evidence);
  }
  function renderCards(containerId, taskId, values, build, empty) {
    const previous = cardCache.get(containerId), rows = new Map();
    const cards = values.map((value, index) => {
      const key = `${value.id || index}:${JSON.stringify(value)}`;
      const card = (previous?.taskId === taskId && previous.rows.get(key)) || build(value);
      rows.set(key, card); return card;
    });
    reconcile(node(containerId), cards.length ? cards : [make('p','task-muted',empty)]);
    cardCache.set(containerId, { taskId, rows });
  }
  function renderTask({ task, events = [], artifacts = [], assignments, approvals = [] }) {
    if (!task || task.id !== data.selected || !data.visible) return;
    data.lastTask = task;
    node('send-task-message').disabled = Boolean(task.archivedAt) || task.status === 'draft' || data.messagePending;
    node('archive-task').disabled = Boolean(data.pending);
    if(document.activeElement!==node('existing-task-reply-limit'))node('existing-task-reply-limit').value=task.replyLimit??200;
    node('save-task-reply-limit').disabled=Boolean(data.pending);
    node('archive-task').textContent = task.archivedAt ? '恢复归档' : active(task.status) ? '停止并归档' : '归档';
    node('task-members').replaceChildren(...['Codex','DSH'].map(agent => make('div', 'participant', `${agent} · ${agent === (task.leadAgent || 'Codex') ? '主Agent' : '子Agent'} · ${printable(memberLabels[task.agentStates?.[agent]?.status || task.agentStates?.[agent]] || task.agentStates?.[agent]?.status || task.agentStates?.[agent] || '状态未提供')}`)));
    renderCards('task-approvals', task.id, approvals, approval => {
      const card = make('article', 'approval-card'); card.append(make('strong', '', `${approval.agent} · ${approval.kind || '执行批准'} · ${approval.status}`), make('p', '', approval.reason || ''), make('pre','task-value', printable({ action: approval.action, target: approval.target, preview: approval.preview, scopeVersion: approval.scopeVersion, expiresAt: approval.expiresAt })));
      for (const choice of approval.choices || []) {
        const button = make('button','quiet-button',choice.label); button.disabled = approval.status !== 'pending' || pendingApprovals.has(approval.id);
        button.addEventListener('click', async () => {
          const version = data.version; if (!current(task.id,version) || button.disabled || data.rendered !== task.id || pendingApprovals.has(approval.id)) return;
          pendingApprovals.add(approval.id); for(const child of card.children) if(child.tagName === 'BUTTON' || child.listeners?.has('click')) child.disabled=true; button.disabled = true;
          try { await request(`/api/approvals/${encodeURIComponent(approval.id)}/decide`, { choice: choice.id }); if (current(task.id,version)) say('决定已保存，执行结果以实际回执为准'); }
          catch(error) { if(current(task.id,version)) say(error.message); }
          finally { pendingApprovals.delete(approval.id); refreshTasks(); }
        }); card.append(button);
      } return card;
    }, '暂无待确认动作。');
    node('task-empty').hidden = true; node('task-detail').hidden = false;
    node('task-detail-title').textContent = task.title || task.id;
    node('task-detail-status').textContent = taskLabels[task.status] || task.status || '状态待确认';
    node('task-detail-status').className = `task-status-label ${task.status || ''}`;
    panelText('task-goal', task.goal, '未填写目标');
    fields('task-scope', [['输入路径', task.inputs?.length ? task.inputs.join('\n') : '未指定'], ['交付目录', task.outputDirectory || '由服务生成专用目录'], ['联网检索', task.networkAccess === true ? '允许' : '关闭'], ['生成图片', task.imageGeneration === true ? '允许' : '关闭'], ['覆盖已有文件', task.allowOverwrite === true ? '允许' : '关闭'], ['Word/PowerPoint文档编辑', task.allowOfficeEdit === true ? '允许' : '关闭'], ['已连接应用', task.networkAccess === true && task.connectedApps === true ? '允许' : '关闭']]);
    fields('task-models', [['Codex配置模型', task.models?.Codex], ['DSH配置模型', task.models?.DSH], ['请求思考程度',task.efforts],['已确认思考程度',task.actualEfforts],['回复额度（每位Agent）',task.replyLimit ?? 200],['讨论往返名额',task.discussionLimit ?? 100],['实际使用模型', task.actualModels], ['运行时限', task.budget?.timeoutSeconds ? task.budget.timeoutSeconds + '秒' : undefined], ['工具调用预算', task.budget?.maxToolCalls], ['实际用量', task.usage]]);
    const progress = task.progress;
    panelText('task-progress', progress && typeof progress === 'object' && progress.total !== undefined ? `已完成${progress.completed ?? progress.current ?? 0} / ${progress.total}${progress.message ? '\n' + progress.message : ''}` : progress?.message || progress, taskLabels[task.status] || '等待状态');
    panelText('task-summary', task.summary, '尚无执行总结');
    node('task-error').hidden = !task.error; node('task-error').textContent = task.error ? printable(task.error) : '';
    panelText('task-identities', task.nativeParticipants, '执行会话尚未建立。任务使用专用原生会话，不会唤醒当前主聊天。');
    panelText('task-acceptance', task.acceptance, '未填写验收标准');
    renderValidation(task.validation ?? task.acceptanceResults);
    node('task-assignments').replaceChildren();
    const roles = Array.isArray(assignments) ? assignments : Array.isArray(task.assignments) ? task.assignments : [];
    if (!roles.length) node('task-assignments').append(make('p', 'task-muted', '等待Codex与DSH形成可核验分工。'));
    for (const role of roles) {
      const card = make('article', 'task-assignment');
      card.append(make('strong', '', role.agent || '执行者'), make('span', 'task-muted', taskLabels[role.status] || role.status || '待分配'), make('p', '', role.goal || '目标待确认'));
      if (role.model) card.append(make('p', 'task-muted', `模型：${role.model}`));
      if (role.outputs?.length) card.append(make('pre', 'task-value', role.outputs.join('\n')));
      node('task-assignments').append(card);
    }
    const chatEvents = task.goal ? [{id:'original-user-request',type:'user-message',agent:'你',text:task.goal,createdAt:task.createdAt,source:'task.goal'},...events] : events;
    renderCards('task-events', task.id, chatEvents, event => {
      const item = make('article', `task-event ${event.type === 'user-message' ? 'user-message' : 'agent-action'}`);
      const label = {'user-message':'任务要求','agent-message':'回复','worker':'执行状态','tool':'工具调用','created':'任务已保存','plan':'分工','delivered':'交付','approval-requested':'等待确认','approval-decided':'确认结果'}[event.type] || event.type || event.status || '事件';
      item.append(make('strong', '', [event.agent || (event.type === 'user-message' ? '你' : ''), label].filter(Boolean).join(' · ')), make('time', '', event.timestamp || event.createdAt || ''), make('p', 'task-message-text', chatText(event)));
      if (event.discussionId || event.result?.discussionId) { const link = make('a', 'quiet-button', '查看讨论'); link.href = '/?conversation=' + encodeURIComponent(event.discussionId || event.result.discussionId); item.append(link); }
      const source = make('details', 'task-event-source'); source.append(make('summary', '', '事件详情'), make('pre', 'task-value', printable(event))); item.append(source); return item;
    }, '暂无执行事件。');
    renderCards('task-artifacts', task.id, artifacts.filter(artifact => artifact.id), artifact => {
      const url = `/api/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}`;
      const card = make('article', 'task-artifact');
      if (artifact.mimeType?.startsWith('image/')) { const image = make('img'); image.src = url; image.alt = artifact.name || '任务图片产物'; image.loading = 'lazy'; card.append(image); }
      const link = make('a', '', artifact.name || artifact.id); link.href = url; link.download = artifact.name || ''; card.append(link);
      card.append(make('small', 'task-muted', [artifact.mimeType, Number.isFinite(artifact.size) ? `${artifact.size} bytes` : ''].filter(Boolean).join(' · '))); return card;
    }, '尚无已发布产物。执行文字不代表文件已交付。');
    node('task-export').href = `/api/tasks/${encodeURIComponent(task.id)}/export`;
    node('start-task').disabled = task.status !== 'draft' || Boolean(data.pending);
    node('cancel-task').disabled = !active(task.status) || Boolean(data.pending);
    node('resume-task').disabled = !['error', 'partial', 'cancelled', 'needs_attention'].includes(task.status) || Boolean(data.pending);
    data.rendered = task.id;
  }
  async function refreshTasks() {
    if (!data.visible) return;
    if (data.busy) { data.again = true; return; }
    data.busy = true;
    let version = data.version;
    try {
      const result = await request(`/api/tasks?limit=${data.limit}&archived=${data.archived ? 1 : 0}`);
      if (!data.visible || version !== data.version) return;
      const tasks = Array.isArray(result.tasks) ? result.tasks : [];
      node('pending-approval-tasks').replaceChildren();
      if(result.pendingApprovalCount > 0) node('pending-approval-tasks').append(make('strong','',`待你确认 ${result.pendingApprovalCount}`));
      for(const pending of result.approvalTasks || []) {const link=make('button','quiet-button',`${pending.title || pending.taskId} · ${pending.count}`);link.addEventListener('click',()=>selectTask(pending.taskId));node('pending-approval-tasks').append(link);}
      node('more-tasks').hidden = !result.hasMore;
      if (!data.selected) { data.selected = tasks[0]?.id || null; version = ++data.version; disableActions(); }
      renderList(tasks);
      if (!data.selected) { node('task-empty').hidden = false; node('task-detail').hidden = true; return; }
      const id = data.selected, detail = await request('/api/tasks/' + encodeURIComponent(id));
      if (current(id, version)) renderTask(detail);
    } catch (error) { if (data.visible && version === data.version) say(error.message); }
    finally { data.busy = false; if (data.again) { data.again = false; refreshTasks(); } }
  }
  function fillModels(agent, id) {
    const select = node(id), capability = data.capabilities?.[agent] || {}, models = (capability.models || []).filter(model => model.taskExecution !== false && model.availability !== "host-only");
    select.replaceChildren();
    const placeholder = make('option', '', '请选择模型'); placeholder.value = ''; select.append(placeholder);
    for (const model of models) {
      const option = make('option', '', `${model.displayName || model.id}${model.provider ? ' · ' + model.provider : ''}${model.verified === true ? ' · 已实测' : model.verified === false ? ' · 尚未线上验证' : ''}${model.default ? ' · 默认' : ''}`);
      option.value = model.id; select.append(option);
    }
    select.value = models.find(model => model.default === true)?.id || models.find(model => model.id === capability.defaultModel)?.id || '';
    select.disabled = !models.length;
    fillEfforts(agent);
  }
  function fillEfforts(agent) {
    const select = node(`task-${agent.toLowerCase()}-effort`), model = data.capabilities?.[agent]?.models?.find(m => m.id === node(`task-${agent.toLowerCase()}-model`).value);
    const raw = model?.supportedReasoningEfforts || model?.reasoningEfforts || [];
    const values = (Array.isArray(raw) ? raw : []).map(value => typeof value === 'string' ? value : value.reasoningEffort || value.id || value.value).filter(Boolean);
    const previous = select.value; select.replaceChildren();
    const automatic = make('option','','原生默认'); automatic.value = model ? 'default' : ''; select.append(automatic);
    for (const value of values) { const option = make('option','',value); option.value=value; select.append(option); }
    select.value = values.includes(previous) ? previous : model ? 'default' : ''; select.disabled = !model;
  }
  async function loadCapabilities() {
    if (data.capabilities || data.loadingCapabilities) return;
    data.loadingCapabilities = true;
    try {
      data.capabilities = await request('/api/capabilities');
      fillModels('Codex', 'task-codex-model'); fillModels('DSH', 'task-dsh-model');
      node('task-network-input').disabled = ![data.capabilities.Codex, data.capabilities.DSH].some(agent => agent?.webSearch === true);
      node('task-image-input').disabled = ![data.capabilities.Codex, data.capabilities.DSH].some(agent => agent?.imageGeneration === true);
      fields('task-capabilities', ['Codex', 'DSH'].map(agent => [agent, `${data.capabilities[agent]?.models?.filter(model => model.taskExecution !== false && model.availability !== 'host-only').length || 0}个可选模型 · 联网检索${data.capabilities[agent]?.webSearch === true ? '可用' : '未提供'} · 生图${data.capabilities[agent]?.imageGeneration === true ? '可用' : '未提供'}`]));
      updateFormSummary();
    } catch (error) { node('task-form-feedback').textContent = '能力目录读取失败：' + error.message; }
    finally { data.loadingCapabilities = false; }
  }
  function formValues(autoStart) {
    const outputDirectory = node('task-output-input').value.trim();
    const networkAccess = node('task-network-input').checked && !node('task-network-input').disabled;
    return {
      leadAgent: node('task-lead-agent').value || 'Codex', supportAgents: [node('task-lead-agent').value === 'DSH' ? 'Codex' : 'DSH'], inputMode: node('task-input-mode').value || 'materials', replyLimit: Number(node('task-reply-limit').value), discussionLimit: Number(node('task-discussion-limit').value), discussionTimeoutSeconds: Number(node('task-discussion-timeout').value), efforts: Object.fromEntries(['Codex','DSH'].filter(agent => node(`task-${agent.toLowerCase()}-effort`).value).map(agent => [agent,node(`task-${agent.toLowerCase()}-effort`).value])),
      title: node('task-title-input').value.trim(), goal: node('task-goal-input').value.trim(),
      inputs: node('task-inputs-input').value.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
      ...(outputDirectory ? { outputDirectory } : {}), acceptance: node('task-acceptance-input').value.trim(),
      models: { Codex: node('task-codex-model').value, DSH: node('task-dsh-model').value },
      networkAccess,
      imageGeneration: node('task-image-input').checked && !node('task-image-input').disabled, autoStart,
      allowOverwrite: node('task-overwrite-input').checked && !node('task-overwrite-input').disabled,
      allowOfficeEdit: node('task-office-input').checked && !node('task-office-input').disabled,
      connectedApps: networkAccess && node('task-apps-input').checked && !node('task-apps-input').disabled,
      budget: { timeoutSeconds: Number(node('task-timeout-input').value), maxToolCalls: Number(node('task-tools-input').value) }
    };
  }
  function updateFormSummary() {
    for (const agent of ['Codex','DSH']) fillEfforts(agent);
    const networkAccess = node('task-network-input').checked && !node('task-network-input').disabled;
    node('task-apps-input').disabled = !networkAccess;
    if (!networkAccess) node('task-apps-input').checked = false;
    const value = formValues(false);
    for (const [agent, selectId, badgeId] of [['Codex', 'task-codex-model', 'task-codex-model-verification'], ['DSH', 'task-dsh-model', 'task-dsh-model-verification']]) {
      const model = data.capabilities?.[agent]?.models?.find(item => item.id === node(selectId).value);
      node(badgeId).textContent = '已实测'; node(badgeId).hidden = model?.verified !== true;
    }
    node('task-form-summary').textContent = `输入：${value.inputs.join('、') || '未指定'}\n交付目录：${value.outputDirectory || '由服务生成专用任务目录'}\n模型：Codex ${value.models.Codex || '待选择'} / DSH ${value.models.DSH || '待选择'}\n联网：${value.networkAccess ? '允许' : '关闭'} · 生图：${value.imageGeneration ? '允许' : '关闭'} · 已连接应用：${value.connectedApps ? '允许' : '关闭'}\n覆盖已有文件：${value.allowOverwrite ? '允许' : '关闭'} · Word/PowerPoint文档编辑：${value.allowOfficeEdit ? '允许' : '关闭'}\n预算：${value.budget.timeoutSeconds || 300}秒 / ${value.budget.maxToolCalls || 20}次工具调用`;
  }
  async function submitTask(autoStart) {
    if (data.submitting || !data.visible) return;
    const value = formValues(autoStart);
    if (!node('task-form').reportValidity()) return;
    if (!value.title || !value.goal || !value.acceptance) { node('task-form-feedback').textContent = '请填写任务标题、目标和验收标准。'; return; }
    if (!data.capabilities || !['Codex', 'DSH'].every(agent => data.capabilities[agent]?.models?.some(model => model.id === value.models[agent]))) { node('task-form-feedback').textContent = '请从能力目录明确选择两侧模型，未提供默认值时不会自动选择。'; return; }
    if (!Number.isInteger(value.budget.timeoutSeconds) || value.budget.timeoutSeconds < 1 || !Number.isInteger(value.budget.maxToolCalls) || value.budget.maxToolCalls < 1) { node('task-form-feedback').textContent = '运行时限和工具预算必须是正整数。'; return; }
    const version = data.version;
    data.submitting = true; node('publish-task').disabled = true; node('save-task-draft').disabled = true; node('task-form-feedback').textContent = autoStart ? '正在发布任务…' : '正在保存草稿…';
    try {
      const result = await request('/api/tasks', value);
      if (data.visible && version === data.version) {
        node('task-dialog').close(); say(autoStart ? '任务已发布，由专用执行会话承接。' : '草稿已保存，尚未开始执行。');
        if (result.task?.id) selectTask(result.task.id); else refreshTasks();
      }
    } catch (error) { if (data.visible && version === data.version) node('task-form-feedback').textContent = error.message; }
    finally { data.submitting = false; node('publish-task').disabled = false; node('save-task-draft').disabled = false; }
  }
  async function taskAction(action, buttonId) {
    const id = data.rendered, version = data.version;
    if (!id || !current(id, version) || node(buttonId).disabled || data.pending) return;
    data.pending = id; disableActions();
    try { await request(`/api/tasks/${encodeURIComponent(id)}/${action}`, {}); if (current(id, version)) say({ start: '已请求执行任务', cancel: '已请求取消，已有产物保留', resume: '已请求恢复任务，等待服务检查' }[action]); }
    catch (error) { if (current(id, version)) say(error.message); }
    finally { data.pending = null; refreshTasks(); }
  }
  let messageSequence = 0;
  const messageIds = new Map();
  node('task-message-input').addEventListener('input', () => { if(data.selected) data.drafts.set(data.selected,node('task-message-input').value); });
  node('send-task-message').addEventListener('click', async () => {
    const id = data.rendered, version = data.version, text = node('task-message-input').value.trim();
    if (!id || !current(id,version) || !text || data.messagePending || node('send-task-message').disabled) return;
    const key = `${id}:${text}`, clientMessageId = messageIds.get(key) || `web-${Date.now()}-${++messageSequence}`; messageIds.set(key,clientMessageId);
    data.messagePending = true; node('send-task-message').disabled = true;
    try { await request(`/api/tasks/${encodeURIComponent(id)}/messages`, {clientMessageId,text,expectedRequirementsVersion:data.lastTask?.requirementsVersion,autoStart:true}); if(data.drafts.get(id)?.trim()===text) data.drafts.set(id,''); if(current(id,version)) { if(node('task-message-input').value.trim() === text) { node('task-message-input').value=''; data.drafts.set(id,''); } else data.drafts.set(id,node('task-message-input').value); say('要求已保存，等待主Agent处理'); } messageIds.delete(key); }
    catch(error) { if(current(id,version)) say(error.message); }
    finally { data.messagePending=false; refreshTasks(); }
  });
  node('task-template').addEventListener('click', () => { node('task-message-input').value += `${node('task-message-input').value ? '\n' : ''}目标：\n材料：\n交付物 / 验收标准：\n允许范围：\n截止与预算（可选）：`; });
  node('save-task-reply-limit').addEventListener('click',async()=>{const id=data.rendered,version=data.version;if(!id||!current(id,version)||data.pending)return;const replyLimit=Number(node('existing-task-reply-limit').value);data.pending=id;node('save-task-reply-limit').disabled=true;try{await request(`/api/tasks/${encodeURIComponent(id)}/settings`,{replyLimit});if(current(id,version))say('回复额度已保存，未启动执行。');}catch(error){if(current(id,version))say(error.message);}finally{data.pending=null;refreshTasks();}});
  node('archive-task').addEventListener('click', async () => { const task=data.lastTask,id=data.rendered,version=data.version; if(!id || !current(id,version) || data.pending) return; data.pending=id; node('archive-task').disabled=true; try { await request(`/api/tasks/${encodeURIComponent(id)}/${task.archivedAt ? 'unarchive':'archive'}`,task.archivedAt ? {} : {stop:active(task.status)}); } catch(error) {if(current(id,version)) say(error.message);} finally{data.pending=null;refreshTasks();} });
  node('more-tasks').addEventListener('click', () => { data.limit += 10; refreshTasks(); });
  node('tasks-archived').addEventListener('change', () => { data.archived=node('tasks-archived').checked; data.limit=10; refreshTasks(); });
  node('show-tasks').addEventListener('click', () => showTasks(true));
  node('show-discussions').addEventListener('click', () => showTasks(false));
  node('toggle-task-sidebar').addEventListener('click', () => document.querySelector('.shell').classList.toggle('sidebar-open'));
  node('new-task').addEventListener('click', () => {
    for (const id of ['task-overwrite-input', 'task-office-input', 'task-apps-input']) node(id).checked = false;
    node('task-form-feedback').textContent = ''; loadCapabilities(); updateFormSummary(); node('task-dialog').showModal();
  });
  node('close-task-dialog').addEventListener('click', () => node('task-dialog').close());
  node('save-task-draft').addEventListener('click', () => submitTask(false));
  node('publish-task').addEventListener('click', () => submitTask(true));
  node('task-form').addEventListener('submit', event => { event.preventDefault(); });
  for (const id of ['task-title-input', 'task-goal-input', 'task-inputs-input', 'task-output-input', 'task-acceptance-input', 'task-codex-model', 'task-dsh-model', 'task-network-input', 'task-image-input', 'task-overwrite-input', 'task-office-input', 'task-apps-input', 'task-timeout-input', 'task-tools-input']) {
    node(id).addEventListener('input', updateFormSummary); node(id).addEventListener('change', updateFormSummary);
  }
  node('start-task').addEventListener('click', () => taskAction('start', 'start-task'));
  node('cancel-task').addEventListener('click', () => taskAction('cancel', 'cancel-task'));
  node('resume-task').addEventListener('click', () => taskAction('resume', 'resume-task'));
  disableActions(); setInterval(refreshTasks, 2000);
  if (new URL(location.href).searchParams.has('task') || new URL(location.href).searchParams.get('view') === 'tasks') showTasks(true);
})();
