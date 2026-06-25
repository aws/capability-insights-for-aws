import { useCallback, useRef, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Spinner from '@cloudscape-design/components/spinner';
import Alert from '@cloudscape-design/components/alert';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import PromptInput from '@cloudscape-design/components/prompt-input';
import LiveRegion from '@cloudscape-design/components/live-region';

import { capabilityInsightsClient, ChatNotEnabledError } from '~/clients/capability-insights-client';
import type { AnswerPayload, ChatMessage, ConverseTurn, WriteProposal } from '~/types/chat';
import { useFeatureFlagsResolved } from '~/hooks/use-feature-flags';
import { confirmProposal, describeProposal } from './write-proposal';
import { suggestedPromptsFor } from './suggested-prompts';
import AnswerCard from './answer-card';

let seq = 0;
const nextId = () => `m${(seq += 1)}`;

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{ maxWidth: '90%' }}>
        <Box variant="awsui-key-label" color={isUser ? 'text-status-info' : 'text-label'}>
          {isUser ? 'You' : 'Assistant'}
        </Box>
        <Container>
          {message.pending ? (
            <StatusIndicator type="loading">Thinking…</StatusIndicator>
          ) : (
            <Box variant="p">{message.text}</Box>
          )}
          {/* The structured answer card renders INLINE under the assistant's
              prose, inside the drawer. The chat never drives the search-results
              table, so the card's data can't diverge from the page. */}
          {message.answer && <AnswerCard answer={message.answer} />}
        </Container>
      </div>
    </div>
  );
}

/**
 * Companion assistant drawer — a self-contained conversation strip on the right
 * that overlays whatever page the user is on. The assistant's prose reply and
 * its structured answer card both render INSIDE the drawer; it does NOT navigate
 * or filter the main search-results table. This keeps the chat's computed answer
 * authoritative and impossible to contradict against the page's own filtering.
 */
export default function ChatDrawer({ pageName }: { pageName?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<WriteProposal | null>(null);
  const [confirming, setConfirming] = useState(false);
  const historyRef = useRef<ConverseTurn[]>([]);
  const flags = useFeatureFlagsResolved();

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setError(null);
      setProposal(null);

      const userMsg: ChatMessage = { id: nextId(), role: 'user', text: trimmed };
      const pendingMsg: ChatMessage = { id: nextId(), role: 'assistant', text: '', pending: true };
      setMessages(prev => [...prev, userMsg, pendingMsg]);
      setInput('');
      setBusy(true);

      try {
        const res = await capabilityInsightsClient.chat(trimmed, historyRef.current, pageName);
        historyRef.current = [
          ...historyRef.current,
          { role: 'user', content: [{ text: trimmed }] },
          { role: 'assistant', content: [{ text: res.reply }] },
        ];
        // Attach the structured answer (if any) to the assistant message so it
        // renders inline in the drawer — no main-pane navigation or filtering.
        const answer: AnswerPayload | undefined = res.answer;
        setMessages(prev =>
          prev.map(m => (m.id === pendingMsg.id ? { ...m, text: res.reply, pending: false, answer } : m)),
        );
        if (res.writeProposal) setProposal(res.writeProposal);
      } catch (e) {
        const msg =
          e instanceof ChatNotEnabledError
            ? e.message
            : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
        setError(msg);
        setMessages(prev => prev.filter(m => m.id !== pendingMsg.id));
      } finally {
        setBusy(false);
      }
    },
    [busy, pageName],
  );

  const onConfirm = useCallback(async () => {
    if (!proposal) return;
    setConfirming(true);
    setError(null);
    try {
      const note = await confirmProposal(proposal);
      setMessages(prev => [...prev, { id: nextId(), role: 'assistant', text: note }]);
      setProposal(null);
    } catch (e) {
      setError(`Action failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirming(false);
    }
  }, [proposal]);

  const prompts = suggestedPromptsFor(pageName, flags?.usageAnalysis.enabled === true);

  return (
    <SpaceBetween size="m">
      <Box variant="p" color="text-body-secondary">
        Ask about regional availability, compare regions, or summarize your usage. The answer appears in the main view.
      </Box>

      {messages.length === 0 && prompts.length > 0 && (
        <SpaceBetween size="xs">
          <Box variant="awsui-key-label">Try asking</Box>
          {prompts.map(p => (
            <Button key={p} variant="inline-link" onClick={() => void send(p)}>
              {p}
            </Button>
          ))}
        </SpaceBetween>
      )}

      <SpaceBetween size="m">
        {messages.map(m => (
          <Bubble key={m.id} message={m} />
        ))}
      </SpaceBetween>

      {busy && (
        <LiveRegion>
          <Spinner /> Working…
        </LiveRegion>
      )}

      {proposal && (
        <Alert
          type="warning"
          header="Confirm action"
          action={
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => setProposal(null)} disabled={confirming}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void onConfirm()} loading={confirming}>
                Confirm
              </Button>
            </SpaceBetween>
          }
        >
          {describeProposal(proposal)}
        </Alert>
      )}

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Suggestions stay reachable mid-conversation: once the user has asked
          something (the top welcome block is gone), pin a compact "Try asking"
          row just above the input so a new line of questioning is one tap away. */}
      {messages.length > 0 && prompts.length > 0 && (
        <SpaceBetween size="xxs">
          <Box variant="awsui-key-label">Try asking</Box>
          <SpaceBetween size="xxs">
            {prompts.map(p => (
              <Button key={p} variant="inline-link" onClick={() => void send(p)} disabled={busy}>
                {p}
              </Button>
            ))}
          </SpaceBetween>
        </SpaceBetween>
      )}

      <PromptInput
        value={input}
        onChange={({ detail }) => setInput(detail.value)}
        onAction={({ detail }) => void send(detail.value)}
        placeholder="Ask the assistant…"
        actionButtonIconName="send"
        actionButtonAriaLabel="Send message"
        disableActionButton={busy}
        maxRows={6}
      />
    </SpaceBetween>
  );
}
