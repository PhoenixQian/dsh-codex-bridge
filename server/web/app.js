const $ = (id) => document.getElementById(id);
const state = { selected: new URL(location.href).searchParams.get('conversation') || localStorage.getItem('bridge-conversation') || 'shared-discussion', rendered: null, selectionVersion: 0, signature: '', busy: false, refreshAgain: false, replyingConversation: null, limit: 10, archived: false, messagePending: false, cards: new Map(), drafts: new Map(), conversation: null };
const conversationListCache = new Map();
const labels = { completed:'本轮已结束', needs_user:'等待你补充', limit_reached:'已达回复额度', timeout:'讨论等待超时', interrupted:'讨论已中断', idle: '等待开启讨论', queued: '已排队', running: 'Agent正在交流', paused: '本批已结束，等待审阅', pausing: '当前响应结束后暂停', error: '本轮遇到问题', archived: '初始讨论记录' };
const shortLabels = { completed:'本轮已结束', needs_user:'等待你补充', limit_reached:'额度已用完', timeout:'已超时', interrupted:'已中断', idle: '待开始', queued: '排队中', running: '交流中', paused: '待审阅', pausing: '暂停中', error: '需查看', archived: '已归档' };
const memberLabels = {waiting_approval:'等待你确认',running:'执行中',idle:'空闲',waiting_discussion:'等待讨论结果',completed:'本轮已完成',needs_user:'等待你补充',interrupted:'已中断',error:'执行出错'};
function memberStatus(value) { const status=value?.status || value; return memberLabels[status] || status || '状态未提供'; }
const date = (value, full = false) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', ...(full ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(value)) : '';
function element(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
async function api(path, input) {
  const result = await fetch(path, input === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const value = await result.json(); if (!result.ok) throw new Error(value.error || '请求未完成。'); return value;
}
function feedback(text) { $('feedback').textContent = text; }
function disableConversationActions() {
  state.rendered = null;
  for (const id of ['start-discussion', 'reply-incoming', 'pause-discussion', 'save-review', 'review-text', 'send-conversation-message', 'archive-conversation']) $(id).disabled = true;
}
function actionConversation() { return state.rendered === state.selected ? state.rendered : null; }
function bodyText(container, text) {
  for (const paragraph of String(text || '').split(/\n\s*\n/)) {
    const p = element('p');
    for (const part of paragraph.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (part.startsWith('**') && part.endsWith('**')) p.append(element('strong', '', part.slice(2, -2)));
      else if (part.startsWith('`') && part.endsWith('`')) p.append(element('code', '', part.slice(1, -1)));
      else p.append(document.createTextNode(part));
    }
    container.append(p);
  }
}
function incomingStatus(entry, deliveries) {
  const status = element('div', `incoming-status ${entry.status}`);
  const labels = { completed:'本轮已结束', needs_user:'等待你补充', limit_reached:'已达回复额度', timeout:'讨论等待超时', interrupted:'讨论已中断', waiting: '已入库，待续批', replying: '回复中', replied: '已回复', received: '已入库，无需自动回复', error: '出错' };
  status.append(element('strong', '', labels[entry.status] || '来信状态待确认'));
  if (entry.reason) status.append(element('span', '', entry.reason));
  if (entry.status === 'received') return status;
  const matching = deliveries.filter(delivery => delivery.targetAgentId === entry.fromAgentId
    && (entry.deliveryId || entry.replyMessageId)
    && (!entry.deliveryId || delivery.id === entry.deliveryId)
    && (!entry.replyMessageId || delivery.replyMessageId === entry.replyMessageId));
  const delivered = matching.some(delivery => delivery.acknowledged === true);
  const delivery = matching.find(item => item.held) || matching[0];
  status.append(element('span', 'delivery-status', delivered ? '已送达真实DSH（已确认）' : entry.replyMessageId || entry.deliveryId || entry.status === 'replied' ? '回复待送达真实DSH，尚无送达确认' : '回复尚未生成，未送达真实DSH'));
  if (!delivered && delivery?.held) status.append(element('span', '', `投递已暂存${delivery.holdReason ? '：' + delivery.holdReason : ''}`));
  if (!delivered && matching.some(item => item.wake)) status.append(element('span', '', '唤醒不代表送达'));
  return status;
}
function messageCard(message, entry, deliveries) {
  if (message.kind === 'event') return element('div', 'event', message.text);
  const actor = ['review','user'].includes(message.kind) ? 'review' : (message.from?.name || 'user').toLowerCase();
  const card = element('article', `message ${actor}`); card.dataset.messageId = message.id;
  const heading = element('div', 'message-heading');
  heading.append(element('span', `avatar ${actor}`, ['review','user'].includes(message.kind) ? '你' : message.from?.name === 'Codex' ? 'CX' : 'DS'));
  heading.append(element('span', 'message-name', ['review','user'].includes(message.kind) ? (message.kind==='review'?'审阅者':'你') : message.from?.name || '系统'));
  heading.append(element('time', 'message-time', date(message.timestamp, true))); card.append(heading);
  const body = element('div', 'message-body'); bodyText(body, message.text); card.append(body);
  if (entry) card.append(incomingStatus(entry, deliveries));
  if (message.kind === 'agent') {
    const source = element('details', 'source'); source.append(element('summary', '', '查看Agent身份与消息来源'));
    source.append(element('pre', '', JSON.stringify({ messageId: message.id, from: message.from, to: message.to, replyTo: message.replyTo, origin: message.origin }, null, 2))); card.append(source);
  }
  return card;
}
function reconcileMessages(container,children) { if(container.insertBefore) { children.forEach((child,index)=>{if(container.children[index]!==child)container.insertBefore(child,container.children[index]||null);});while(container.children.length>children.length)container.removeChild(container.lastElementChild); } else container.replaceChildren(...children); }
function renderConversation({ conversation, messages = [], inbox = [], deliveries = [], dshAgents = [], host }) {
  if (conversation.id !== state.selected) return;
  state.conversation = conversation;
  $('send-conversation-message').disabled = Boolean(conversation.archivedAt) || conversation.status === 'archived' || state.messagePending;
  $('archive-conversation').disabled = !conversation.archivedAt && conversation.schemaVersion!==4 && ['running','queued','pausing'].includes(conversation.status); $('archive-conversation').title = $('archive-conversation').disabled ? '旧版讨论请先暂停，等待当前响应结束后归档。' : '归档保留历史；原生群聊会先停止。'; $('archive-conversation').textContent = conversation.archivedAt || conversation.status === 'archived' ? '恢复归档' : '归档';
  $('origin-task').hidden = !conversation.originTaskId; $('origin-task').href = '/?task=' + encodeURIComponent(conversation.originTaskId || '');
  $('discussion-brief').textContent = typeof conversation.brief === 'string' ? conversation.brief : conversation.brief ? JSON.stringify(conversation.brief) : '';
  $('conversation-title').textContent = conversation.title; $('conversation-title').title = conversation.title;
  const waiting = inbox.filter(entry => entry.status === 'waiting').length;
  $('conversation-status').textContent = `${labels[conversation.status] || conversation.status} · ${messages.filter((m) => m.kind === 'agent').length}条Agent消息${waiting ? ` · ${waiting}条来信待回复` : ''}`;
  const archived = Boolean(conversation.archivedAt) || conversation.status === 'archived';
  const running = ['queued', 'running', 'pausing'].includes(conversation.status);
  $('start-discussion').disabled = archived || running || waiting > 0;
  $('start-discussion').title = waiting ? '有待回复来信，请点击“回复来信”' : '';
  $('start-discussion').textContent = messages.some((m) => m.kind === 'agent') ? '继续讨论' : '开始讨论';
  $('reply-incoming').disabled = archived || running || !waiting || Boolean(state.replyingConversation);
  $('reply-incoming').title = waiting ? '回复最早待回复的真实DSH发送者；同一发送者的待回复来信合并为一批，按会话额度。' : '暂无待回复来信';
  $('pause-discussion').disabled = !running || conversation.status === 'pausing';
  $('save-review').disabled = archived; $('review-text').disabled = archived;
  $('budget').textContent = archived ? '原始记录保持不变' : `往返名额 ${conversation.limit ?? 100} · Codex ${conversation.replyCounts?.Codex ?? 0} / DSH ${conversation.replyCounts?.DSH ?? 0}条回复 · 可提前结束`;
  $('error-banner').hidden = !conversation.error; $('error-banner').textContent = conversation.error || '';
  $('participants').replaceChildren();
  for (const name of ['Codex', 'DSH']) {
    const item = element('div', 'participant'); item.append(element('span', 'participant-name', `${name} · ${name === (conversation.leadAgent || 'Codex') ? '主Agent' : '子Agent'} · ${memberStatus(conversation.memberStates?.[name])}`));
    if (name === 'DSH' && !archived) {
      item.append(element('span', `participant-connection${host?.canRespond === true ? ' connected' : ' attention'}`, host?.canRespond === true ? 'DSH Host可响应' : host?.online === true ? 'DSH Host在线但不可响应' : 'DSH Host不可用（未连接或状态未确认）'));
      const online = dshAgents.filter(agent => agent.online);
      const ready = online.filter(agent => agent.capabilities?.terminalInject && agent.capabilities?.durableAck);
      item.append(element('span', `participant-connection${ready.length ? ' connected' : ' attention'}`, ready.length ? `旧消息投递通道可用（${ready.length}）` : online.length ? '需重载DSH插件' : '旧消息投递通道未登记'));

    }
    item.append(element('span', 'participant-id', conversation.participants?.[name] || (archived ? '原始来源见消息详情' : '本议题原生会话尚未建立')));
    if (name === 'DSH') item.append(element('span','participant-connection', conversation.memoryCapability?.available === true ? '原生经验能力已接通（以检索回执为准）' : '原生经验能力未确认'));
    $('participants').append(item);
  }
  const signature = conversation.id + ':' + JSON.stringify(messages) + ':' + JSON.stringify([inbox, deliveries]);
  if (signature !== state.signature) {
    const transcript = $('transcript'), nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100 || !state.signature;
    const opened = new Set([...transcript.querySelectorAll('details[open]')].map((d) => d.closest('[data-message-id]')?.dataset.messageId));
    const cards=[];
    if (!messages.length) {
      const empty = element('div', 'empty-state'); empty.append(element('div', 'symbol', '↔'), element('strong', '', '让两位Agent在这里交流'));
      empty.append(element('p', '', '点击开始讨论后，双方会以各自身份往返。你可以随时审阅，也可以先留下一条意见。')); cards.push(empty);
    } else { const next = new Map(); for (const message of messages) { const entry = inbox.find(entry => entry.messageId === message.id), key = conversation.id + ':' + message.id + ':' + JSON.stringify([message,entry,deliveries.filter(d => d.replyMessageId === message.id || d.id === entry?.deliveryId || d.replyMessageId === entry?.replyMessageId)]); const card = state.cards.get(key) || messageCard(message,entry,deliveries); next.set(key,card); if (opened.has(message.id)) card.querySelector('details')?.setAttribute('open', ''); cards.push(card); } state.cards = next; }
    reconcileMessages(transcript,cards);
    state.signature = signature; if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
  }
  state.rendered = conversation.id;
}
async function refresh() {
  if (state.busy) { state.refreshAgain = true; return; }
  state.busy = true;
  let version = state.selectionVersion;
  try {
    const { conversations, hasMore, total } = await api(`/api/conversations?limit=${state.limit}&archived=${state.archived ? 1 : 0}`);
    $('more-conversations').hidden = !hasMore;
    if (version !== state.selectionVersion) return;
    if (!state.selected) {
      state.selected = conversations[0]?.id || 'shared-discussion';
      version = ++state.selectionVersion; disableConversationActions();
    }
    const id = state.selected;
    $('service-state').textContent = '本机服务已连接'; $('service-dot').classList.add('online');
    $('conversation-count').textContent = total ?? conversations.length;
    const buttons=[];
    for (const conversation of conversations) {
      const key=JSON.stringify([conversation,state.selected===conversation.id]);
      if(conversationListCache.has(key)){buttons.push(conversationListCache.get(key));continue;}
      const button = element('button', `conversation-item${conversation.id === state.selected ? ' selected' : ''}`);
      button.append(element('strong', '', conversation.title), element('small', '', conversation.lastMessage || '还没有Agent消息'));
      if (conversation.pendingIncomingCount > 0) button.append(element('span', 'incoming-badge', `待回复 ${conversation.pendingIncomingCount}`));
      const bottom = element('div', 'item-bottom'); bottom.append(element('span', `tiny-status ${conversation.status}`, shortLabels[conversation.status] || conversation.status), element('span', '', date(conversation.updatedAt))); button.append(bottom);
      button.addEventListener('click', () => select(conversation.id)); buttons.push(button); conversationListCache.set(key,button);
    }
    const visible=new Set(buttons);for(const [key,button] of conversationListCache)if(!visible.has(button))conversationListCache.delete(key);
    reconcileMessages($('conversation-list'),buttons);
    const detail = await api('/api/conversations/' + encodeURIComponent(id));
    if (version === state.selectionVersion && id === state.selected) renderConversation(detail);
  } catch (error) {
    if (version === state.selectionVersion) {
      $('service-state').textContent = '连接中断，正在重试'; $('service-dot').classList.remove('online'); feedback(error.message);
    }
  } finally {
    state.busy = false;
    if (state.refreshAgain) { state.refreshAgain = false; refresh(); }
  }
}
function select(id) {
  if(state.selected) state.drafts.set(state.selected,$('review-text').value);
  $('review-text').value = state.drafts.get(id) || '';
  state.selected = id; state.selectionVersion += 1; state.signature = ''; disableConversationActions(); localStorage.setItem('bridge-conversation', id);
  history.replaceState(null, '', '/?conversation=' + encodeURIComponent(id));
  document.querySelector('.shell').classList.remove('sidebar-open'); syncSidebar(); refresh();
}
const sidebarShell = document.querySelector('.shell');
const sidebarMedia = window.matchMedia?.('(max-width: 780px)');
function syncSidebar() {
  const expanded = sidebarMedia?.matches ? sidebarShell.classList.contains('sidebar-open') : !sidebarShell.classList.contains('sidebar-collapsed');
  for (const [id, label] of [['toggle-sidebar', '会话列表'], ['toggle-task-sidebar', '任务列表']]) {
    $(id).setAttribute('aria-expanded', String(expanded));
    $(id).setAttribute('aria-label', `${expanded ? '收起' : '打开'}${label}`);
  }
}
function toggleSidebar(event) {
  // This shared control also replaces the task script's mobile-only toggle.
  event.stopImmediatePropagation?.();
  sidebarShell.classList.toggle(sidebarMedia?.matches ? 'sidebar-open' : 'sidebar-collapsed');
  syncSidebar();
}
function closeSidebar() {
  sidebarShell.classList.remove('sidebar-open');
  if (!sidebarMedia?.matches) sidebarShell.classList.add('sidebar-collapsed');
  syncSidebar();
}
$('toggle-sidebar').addEventListener('click', toggleSidebar);
$('toggle-task-sidebar').addEventListener('click', toggleSidebar);
$('close-sidebar').addEventListener('click', closeSidebar);
$('sidebar-backdrop').addEventListener('click', closeSidebar);
$('sidebar').addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSidebar(); });
sidebarMedia?.addEventListener('change', () => { sidebarShell.classList.remove('sidebar-open'); syncSidebar(); });
if (typeof MutationObserver !== 'undefined') new MutationObserver(syncSidebar).observe(sidebarShell, { attributes: true, attributeFilter: ['class'] });
syncSidebar();
$('copy-link').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.origin + '/?conversation=' + encodeURIComponent(state.selected)); feedback('已复制会话链接'); } catch { feedback(location.href); } });
$('start-discussion').addEventListener('click', async () => {
  const id = actionConversation(); if (!id || $('start-discussion').disabled) return;
  $('start-discussion').disabled = true;
  try { await api(`/api/conversations/${id}/start`, { group: true }); if (actionConversation() === id) feedback('已请求主Agent开始讨论'); await refresh(); }
  catch (error) { if (actionConversation() === id) { feedback(error.message); $('start-discussion').disabled = false; } }
});
$('reply-incoming').addEventListener('click', async () => {
  const id = actionConversation(); if (!id || $('reply-incoming').disabled || state.replyingConversation) return;
  state.replyingConversation = id; $('reply-incoming').disabled = true;
  try { await api(`/api/conversations/${encodeURIComponent(id)}/reply-incoming`, {}); if (actionConversation() === id) feedback('已请求回复来信'); }
  catch (error) { if (actionConversation() === id) feedback(error.message); }
  finally { state.replyingConversation = null; refresh(); }
});
$('pause-discussion').addEventListener('click', async () => {
  const id = actionConversation(); if (!id) return;
  try { await api(`/api/conversations/${id}/pause`, {}); if (actionConversation() === id) feedback('将在当前响应结束后暂停'); refresh(); }
  catch (error) { if (actionConversation() === id) feedback(error.message); }
});
$('save-review').addEventListener('click', async () => {
  const id = actionConversation(); if (!id) return;
  const text = $('review-text').value.trim(); if (!text) return;
  try {
    await api(`/api/conversations/${id}/review`, { text });
    if (actionConversation() === id) { if ($('review-text').value.trim() === text) $('review-text').value = ''; feedback('审阅意见已记录'); }
    await refresh();
  } catch (error) { if (actionConversation() === id) feedback(error.message); }
});
$('new-conversation').addEventListener('click', () => { $('new-dialog').showModal(); loadDiscussionModels(); });
$('cancel-new').addEventListener('click', () => $('new-dialog').close());
$('new-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await api('/api/conversations', { title: $('new-title').value, leadAgent: $('discussion-lead-agent').value || 'Codex', limit: Number($('discussion-limit').value) || 100, models: Object.fromEntries(['Codex','DSH'].filter(a=> $(`discussion-${a.toLowerCase()}-model`).value).map(a=>[a,$(`discussion-${a.toLowerCase()}-model`).value])), efforts: Object.fromEntries(['Codex','DSH'].filter(a=>$(`discussion-${a.toLowerCase()}-effort`).value).map(a=>[a,$(`discussion-${a.toLowerCase()}-effort`).value])) }); $('new-dialog').close(); $('new-title').value = ''; select(result.conversation.id); } catch (error) { feedback(error.message); } });

let discussionCapabilities;
function discussionEfforts(agent) {
  const prefix=`discussion-${agent.toLowerCase()}`, select=$(prefix+'-effort'), model=discussionCapabilities?.[agent]?.models?.find(m=>m.id===$(prefix+'-model').value);
  const raw=model?.supportedReasoningEfforts || model?.reasoningEfforts || [];
  const values=(Array.isArray(raw) ? raw : []).map(v=>typeof v==='string'?v:v.reasoningEffort || v.id || v.value).filter(Boolean);
  select.replaceChildren(); const unset=element('option','','原生默认');unset.value=model ? 'default' : '';select.append(unset);
  for(const value of values){const option=element('option','',value);option.value=value;select.append(option);}select.value=model ? 'default' : '';select.disabled=!model;
}
async function loadDiscussionModels() {
  try{ discussionCapabilities ||= await api('/api/capabilities');
    for(const agent of ['Codex','DSH']) {const select=$(`discussion-${agent.toLowerCase()}-model`),models=discussionCapabilities[agent]?.models || [];select.replaceChildren(); const unset=element('option','','原生默认');unset.value='';select.append(unset);for(const model of models){const option=element('option','',model.displayName || model.id);option.value=model.id;select.append(option);}select.value=models.find(m=>m.default)?.id || '';select.disabled=!models.length;discussionEfforts(agent);}
  }catch(error){feedback('模型目录不可用：'+error.message);}
}
for(const agent of ['Codex','DSH']) $(`discussion-${agent.toLowerCase()}-model`).addEventListener('change',()=>discussionEfforts(agent));
$('review-text').addEventListener('input',()=>{if(state.selected)state.drafts.set(state.selected,$('review-text').value);});
let conversationMessageSequence = 0;
const conversationMessageIds = new Map();
$('send-conversation-message').addEventListener('click', async () => {
  const id=actionConversation(),version=state.selectionVersion,text=$('review-text').value.trim();
  if(!id || !text || state.messagePending || $('send-conversation-message').disabled) return;
  const key=id+':'+text, clientMessageId=conversationMessageIds.get(key) || `discussion-web-${Date.now()}-${++conversationMessageSequence}`; conversationMessageIds.set(key,clientMessageId);
  state.messagePending=true; $('send-conversation-message').disabled=true;
  try { await api(`/api/conversations/${encodeURIComponent(id)}/messages`,{clientMessageId,text}); if(state.drafts.get(id)?.trim()===text)state.drafts.set(id,''); if(id===state.selected && version===state.selectionVersion){ if($('review-text').value.trim()===text) { $('review-text').value=''; state.drafts.set(id,''); } else state.drafts.set(id,$('review-text').value); feedback('补充已保存，等待主Agent处理'); } conversationMessageIds.delete(key); }
  catch(error){if(id===state.selected && version===state.selectionVersion) feedback(error.message);}
  finally{state.messagePending=false;refresh();}
});
$('archive-conversation').addEventListener('click', async () => {const id=actionConversation(),version=state.selectionVersion;if(!id || $('archive-conversation').disabled)return; $('archive-conversation').disabled=true; try{await api(`/api/conversations/${encodeURIComponent(id)}/${state.conversation?.archivedAt || state.conversation?.status === 'archived' ? 'unarchive':'archive'}`,{});}catch(error){if(id===state.selected && version===state.selectionVersion) feedback(error.message);}finally{refresh();}});
$('more-conversations').addEventListener('click',()=>{state.limit+=10;refresh();});
$('conversation-archived').addEventListener('change',()=>{state.archived=$('conversation-archived').checked;state.limit=10;refresh();});

async function heartbeat() { if (window.parent === window) return; try { const health = await api('/api/health'); if (health.buildId === 'tongzhou-community-0.3.0' && /^[a-f0-9]{64}$/.test(health.instanceId)) window.parent.postMessage({type:'agent-bridge:ready',buildId:health.buildId,instanceId:health.instanceId},'*'); } catch {} }
disableConversationActions(); heartbeat(); setInterval(heartbeat, 3000); refresh(); setInterval(refresh, 1500);
