import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AssistantTurn, Session } from './api';
import { palette as c } from './theme';

type Props = {
  turns: AssistantTurn[];
  draft: string;
  onDraft: (value: string) => void;
  onSend: (message?: string) => void;
  onClear: () => void;
  onVoice: () => void;
  onSpeak: (text: string) => void;
  onToggleReadAloud: () => void;
  busy: boolean;
  connected: boolean;
  listening: boolean;
  voiceStatus: string | null;
  error: string | null;
  readAloud: boolean;
  session: Session | null;
  model: string | null;
};

function suggestedPrompts(stage?: string) {
  if (stage === 'awaiting_approval') return [
    'Walk me through the proposed change',
    'What should I review before approving?',
    'Which test will run after approval?',
  ];
  if (stage === 'verified') return [
    'What does the passing test prove?',
    'What does Undo restore?',
    'Summarize this fix for my teammate',
  ];
  if (stage === 'failed' || stage === 'analysis_failed') return [
    'Why did this step fail?',
    'What should I inspect first?',
    'Is the original code still safe?',
  ];
  if (stage === 'root_cause_found' || stage === 'generating_fix') return [
    'Explain the root cause simply',
    'What evidence supports this location?',
    'How certain is this diagnosis?',
  ];
  return [
    'What does PocketPilot do?',
    'How does the safe-fix flow work?',
    'How do you keep me in control?',
  ];
}

export function PilotPanel({
  turns, draft, onDraft, onSend, onClear, onVoice, onSpeak, onToggleReadAloud,
  busy, connected, listening, voiceStatus, error, readAloud, session, model,
}: Props) {
  const location = session?.analysis?.location;
  const prompts = suggestedPrompts(session?.stage);
  return <>
    <View style={styles.heading}>
      <Text style={styles.eyebrow}>PILOT / LOCAL CONVERSATION</Text>
      <Text style={styles.title}>Talk it through<Text style={styles.period}>.</Text></Text>
      <Text style={styles.subtitle}>Ask about the failure, the evidence, or the next safe step. Ollama answers on your laptop.</Text>
    </View>

    <View style={styles.contextStrip}>
      <View style={styles.contextDot} />
      <View style={styles.contextText}>
        <Text style={styles.contextHeading}>{session ? 'CURRENT DEBUG SESSION' : 'GENERAL ASSISTANT'}</Text>
        <Text style={styles.contextDetail} numberOfLines={2}>
          {location ? `${location.path}:${location.line}  ·  ${session?.stage.replaceAll('_', ' ')}` : session ? `Session ${session.stage.replaceAll('_', ' ')}` : 'Start a debug session to ground answers in its evidence.'}
        </Text>
      </View>
      <Text style={styles.contextModel}>{model ? 'LOCAL AI' : 'WAITING'}</Text>
    </View>

    <View style={styles.conversation}>
      {turns.length === 0 ? <View style={styles.emptyState}>
        <Text style={styles.emptyGlyph}>✳</Text>
        <Text style={styles.emptyTitle}>A second pair of eyes.</Text>
        <Text style={styles.emptyBody}>Pilot can explain what the current run found. It cannot edit files or approve a change for you.</Text>
      </View> : <>
        {turns.map((turn, index) => <View key={`${index}-${turn.role}`} style={[styles.message, turn.role === 'user' ? styles.userMessage : styles.pilotMessage]}>
          <Text style={[styles.speaker, turn.role === 'user' && styles.userSpeaker]}>{turn.role === 'user' ? 'YOU' : 'PILOT  ·  LOCAL AI'}</Text>
          <Text style={styles.messageText}>{turn.content}</Text>
          {turn.role === 'assistant' && <Pressable accessibilityRole="button" accessibilityLabel="Read Pilot reply aloud" onPress={() => onSpeak(turn.content)} style={styles.listenButton}><Text style={styles.listenText}>◖  LISTEN</Text></Pressable>}
        </View>)}
      </>}
      <View style={styles.threadHeading}>
        <Text style={styles.threadLabel}>{turns.length ? 'CONVERSATION / SUGGESTED FOLLOW-UPS' : 'TRY ASKING'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={busy ? 'Discard reply and clear chat memory' : 'Clear chat memory'} accessibilityState={{ disabled: listening || !connected }} disabled={listening || !connected} onPress={onClear}><Text style={[styles.clearText, (listening || !connected) && styles.dimmed]}>{busy ? 'DISCARD & CLEAR' : 'CLEAR CHAT'}</Text></Pressable>
      </View>
      <View style={styles.prompts}>
        {prompts.map(prompt => <Pressable key={prompt} accessibilityRole="button" disabled={busy || !connected} onPress={() => onSend(prompt)} style={[styles.prompt, (busy || !connected) && styles.dimmed]}>
          <Text style={styles.promptText}>{prompt}  ↗</Text>
        </Pressable>)}
      </View>
      {busy && <View style={styles.thinking}><ActivityIndicator color={c.lime} size="small" /><Text style={styles.thinkingText}>PILOT IS THINKING ON YOUR LAPTOP…</Text></View>}
    </View>

    <View style={styles.composer}>
      <View style={styles.composerHeading}><Text style={styles.composerLabel}>ASK PILOT</Text><Pressable accessibilityRole="switch" accessibilityState={{ checked: readAloud }} onPress={onToggleReadAloud}><Text style={styles.readAloud}>{readAloud ? '◖  VOICE REPLIES ON' : '◖  VOICE REPLIES OFF'}</Text></Pressable></View>
      <TextInput
        accessibilityLabel="Ask Pilot a question"
        placeholder="Ask about this error or your next step…"
        placeholderTextColor={c.dim}
        multiline
        maxLength={1200}
        value={draft}
        onChangeText={onDraft}
        style={styles.input}
        textAlignVertical="top"
      />
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Stop voice question' : 'Speak a question to Pilot'} disabled={busy || !connected} onPress={onVoice} style={[styles.micButton, listening && styles.micLive]}><Text style={styles.micText}>{listening ? '■  STOP' : '◉  SPEAK'}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy || !connected || listening || !draft.trim()} onPress={() => onSend()} style={[styles.sendButton, (busy || !connected || listening || !draft.trim()) && styles.disabled]}><Text style={styles.sendText}>SEND QUESTION  ↗</Text></Pressable>
      </View>
      {voiceStatus && <Text style={styles.voiceNote}>{voiceStatus}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.privacy}>Speech is transcribed on the phone. Your question and a bounded session summary go to loopback Ollama on the paired laptop. Recent chat memory stays in laptop RAM and is cleared on request, session change, unpair, or agent restart. Do not include credentials. The phone-to-laptop link uses HTTP; use a trusted Wi-Fi network.</Text>
    </View>
  </>;
}

const styles = StyleSheet.create({
  heading: { marginBottom: 24 },
  eyebrow: { color: c.lime, fontSize: 10, fontWeight: '900', letterSpacing: 2.2 },
  title: { color: c.ink, fontSize: 38, lineHeight: 43, fontWeight: '900', letterSpacing: -1.8, marginTop: 14 },
  period: { color: c.lime },
  subtitle: { color: c.quiet, fontSize: 14, lineHeight: 21, marginTop: 11 },
  contextStrip: { flexDirection: 'row', alignItems: 'center', gap: 12, borderColor: c.line, borderWidth: 1, borderRadius: 16, backgroundColor: c.raised, padding: 15, marginBottom: 18 },
  contextDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: c.teal },
  contextText: { flex: 1 },
  contextHeading: { color: c.lime, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  contextDetail: { color: c.quiet, fontSize: 11, lineHeight: 17, marginTop: 5 },
  contextModel: { color: c.teal, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  conversation: { minHeight: 280, borderWidth: 1, borderColor: c.line, borderRadius: 20, backgroundColor: c.raised, padding: 18, marginBottom: 16 },
  emptyState: { paddingVertical: 11 },
  emptyGlyph: { color: c.lime, fontSize: 34 },
  emptyTitle: { color: c.ink, fontSize: 23, fontWeight: '800', letterSpacing: -0.5, marginTop: 18 },
  emptyBody: { color: c.quiet, fontSize: 13, lineHeight: 20, marginTop: 8 },
  prompts: { gap: 8, marginTop: 24 },
  prompt: { borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 13 },
  promptText: { color: c.ink, fontSize: 12, fontWeight: '700' },
  threadHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  threadLabel: { color: c.dim, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  clearText: { color: c.lime, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  message: { borderRadius: 15, padding: 15, marginBottom: 12, maxWidth: '94%' },
  userMessage: { backgroundColor: c.raisedAlt, alignSelf: 'flex-end', borderColor: c.line, borderWidth: 1 },
  pilotMessage: { backgroundColor: c.canvas, alignSelf: 'flex-start', borderColor: c.line, borderWidth: 1 },
  speaker: { color: c.teal, fontSize: 9, fontWeight: '900', letterSpacing: 1.2, marginBottom: 9 },
  userSpeaker: { color: c.lime },
  messageText: { color: c.ink, fontSize: 14, lineHeight: 21 },
  listenButton: { marginTop: 12, alignSelf: 'flex-start' },
  listenText: { color: c.lime, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, padding: 10 },
  thinkingText: { color: c.teal, fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
  composer: { borderWidth: 1, borderColor: c.line, borderRadius: 20, backgroundColor: c.raised, padding: 18 },
  composerHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  composerLabel: { color: c.ink, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  readAloud: { color: c.teal, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  input: { minHeight: 100, borderColor: c.line, borderWidth: 1, borderRadius: 12, backgroundColor: c.canvas, color: c.ink, fontSize: 14, lineHeight: 21, padding: 14, marginTop: 15 },
  actions: { flexDirection: 'row', gap: 9, marginTop: 11 },
  micButton: { minWidth: 102, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderColor: c.lime, borderWidth: 1, borderRadius: 11 },
  micLive: { borderColor: c.coral },
  micText: { color: c.lime, fontWeight: '900', fontSize: 11 },
  sendButton: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: c.lime, borderRadius: 11 },
  sendText: { color: c.canvas, fontWeight: '900', fontSize: 10, letterSpacing: 0.8 },
  disabled: { opacity: 0.45 },
  dimmed: { opacity: 0.45 },
  voiceNote: { color: c.teal, fontSize: 11, lineHeight: 17, marginTop: 12 },
  error: { color: c.coral, fontSize: 12, lineHeight: 18, marginTop: 12 },
  privacy: { color: c.dim, fontSize: 11, lineHeight: 17, marginTop: 15 },
});
