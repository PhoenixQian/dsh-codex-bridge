// Native DSH tool calls are distinct from replies by an isolated DSH peer.
export function deriveInbox(conversation, messages) {
  return messages.filter(message => message.kind === 'agent' && message.from?.name === 'DSH' && message.origin?.kind === 'dsh-native-tool').map(message => {
    const reply = messages.find(row => row.kind === 'agent' && row.origin?.kind === 'native-codex-app-server' && (row.replyTo === message.id || row.inReplyTo?.includes(message.id)));
    const stored = conversation.inbox?.[message.id];
    return {
      messageId: message.id, fromAgentId: message.from.agentId,
      ...stored,
      status: reply ? 'replied' : stored?.status ?? 'waiting',
      reason: reply ? null : stored?.reason ?? (conversation.remainingResponses <= 0 ? '本批额度已用完；点击回复来信开启新批次。' : '等待独立Codex桥接接收。'),
      ...(reply ? {replyMessageId: reply.id} : {}),
    };
  });
}

export const isCurrentDshReceiver = agent => Boolean(agent && Date.now() - Date.parse(agent.lastSeenAt) < 30000 && agent.buildId === '20261106-inbox-1' && agent.capabilities?.terminalInject === true && agent.capabilities?.durableAck === true);
