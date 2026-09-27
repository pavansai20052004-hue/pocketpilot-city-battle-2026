import * as SecureStore from 'expo-secure-store';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { StatusBar } from 'expo-status-bar';
import { NavigationBar } from 'expo-navigation-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AgentState, AssistantResponse, AssistantTurn, PairResult, Session, SessionHistoryItem, normalizeAgentAddress, request } from './api';
import { PilotPanel } from './PilotPanel';
import { palette as c } from './theme';
import { ErrorImageSource, extractErrorFromImage } from './vision';

const URL_KEY = 'pocketpilot.citybattle.agent-url';
const TOKEN_KEY = 'pocketpilot.citybattle.token';
const ANDROID_SPEECH_SERVICE = 'com.google.android.as';
type Tab = 'home' | 'debug' | 'pilot' | 'sessions' | 'settings';

const workingStages = new Set<Session['stage']>(['analyzing', 'generating_fix', 'testing']);

async function savePairing(url: string, token: string) {
  if (Platform.OS === 'web') {
    localStorage.setItem(URL_KEY, url);
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    await SecureStore.setItemAsync(URL_KEY, url);
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  }
}

async function loadPairing(): Promise<[string | null, string | null]> {
  if (Platform.OS === 'web') return [localStorage.getItem(URL_KEY), localStorage.getItem(TOKEN_KEY)];
  return Promise.all([SecureStore.getItemAsync(URL_KEY), SecureStore.getItemAsync(TOKEN_KEY)]);
}

async function clearPairing() {
  if (Platform.OS === 'web') {
    localStorage.removeItem(URL_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } else {
    await Promise.all([SecureStore.deleteItemAsync(URL_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);
  }
}

function Label({ children, color = c.dim }: { children: React.ReactNode; color?: string }) {
  return <Text style={[styles.label, { color }]}>{children}</Text>;
}

function Button({
  children,
  onPress,
  tone = 'primary',
  disabled = false,
  icon,
}: {
  children: React.ReactNode;
  onPress: () => void;
  tone?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  icon?: string;
}) {
  const primary = tone === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : tone === 'danger' ? styles.buttonDanger : styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, primary ? styles.buttonTextPrimary : tone === 'danger' ? { color: c.coral } : null]}>
        {icon ? `${icon}   ` : ''}{children}
      </Text>
    </Pressable>
  );
}

function BrandHeader({ connected, paired, onDisconnect }: { connected: boolean; paired: boolean; onDisconnect: () => void }) {
  return (
    <View style={styles.header}>
      <View style={styles.brandWrap}>
        <View style={styles.brandMark}><Text style={styles.brandMarkText}>P↗</Text></View>
        <View>
          <Text style={styles.brandName}>POCKETPILOT</Text>
          <Text style={styles.brandSubtitle}>SEE IT. SAY IT. FIX IT.</Text>
        </View>
      </View>
      <Pressable
        accessibilityRole={paired ? 'button' : 'text'}
        accessibilityLabel={connected ? 'Disconnect laptop' : paired ? 'Pair with laptop again' : 'Not connected'}
        onPress={paired ? onDisconnect : undefined}
        style={styles.connectionPill}
      >
        <View style={[styles.connectionDot, { backgroundColor: connected ? c.lime : c.dim }]} />
        <Text style={styles.connectionText}>{connected ? 'LINKED' : paired ? 'PAIR AGAIN' : 'OFFLINE'}</Text>
      </Pressable>
    </View>
  );
}

function Eyebrow({ index, children }: { index: string; children: React.ReactNode }) {
  return <View style={styles.eyebrowRow}><Text style={styles.eyebrowIndex}>{index}</Text><Label>{children}</Label></View>;
}

function Metric({ value, label }: { value: string; label: string }) {
  return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Label>{label}</Label></View>;
}

function Panel({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return <View style={[styles.panel, accent && styles.panelAccent]}>{children}</View>;
}

function ProcessingPanel({ stage }: { stage: Session['stage'] }) {
  const spin = useRef(new Animated.Value(0)).current;
  const [startedAt] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 5400, useNativeDriver: true }));
    loop.start();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => { loop.stop(); clearInterval(timer); };
  }, [spin, startedAt]);
  const title = stage === 'analyzing' ? 'Finding the signal' : stage === 'generating_fix' ? 'Designing a safe fix' : 'Checking the result';
  const body = stage === 'analyzing'
    ? 'Your laptop is examining the error and nearby source with local AI.'
    : stage === 'generating_fix'
      ? 'A proposed change is being prepared. No file is changing yet.'
      : 'The approved patch is being checked against the selected project.';
  const helper = stage === 'analyzing'
    ? 'You can review the captured error while the model works.'
    : stage === 'generating_fix'
      ? 'You will see the exact diff before deciding whether to apply it.'
      : 'If verification fails, the result will say so clearly.';
  const rotation = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Panel accent>
      <Eyebrow index="↳">LOCAL AI / LIVE PROCESS</Eyebrow>
      <View style={styles.processingMain}>
        <View style={styles.orbitBox}>
          <View style={styles.orbitInner}><Text style={styles.orbitCenter}>✦</Text></View>
          <Animated.View style={[styles.orbitTrack, { transform: [{ rotate: rotation }] }]}><View style={styles.orbitSatellite} /></Animated.View>
        </View>
        <View style={styles.processingCopy}>
          <Text style={styles.processingTitle}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
      </View>
      <View style={styles.liveRow}><View style={styles.liveDot} /><Text style={styles.liveText}>{elapsed}s elapsed  ·  Working on your laptop</Text></View>
      <Pressable accessibilityRole="button" onPress={() => setExpanded(value => !value)} style={styles.processDisclosure}>
        <Text style={styles.processDisclosureText}>{expanded ? 'HIDE WHAT HAPPENS NEXT' : 'WHAT HAPPENS NEXT?'}</Text>
        <Text style={styles.processDisclosureText}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded && <Text style={styles.processDetail}>{helper} Keep this screen open; results appear automatically.</Text>}
    </Panel>
  );
}

function Pipeline({ stage }: { stage: Session['stage'] }) {
  const done = stage === 'undone' ? 4 : stage === 'verified' ? 6 : stage === 'testing' || stage === 'failed' ? 5 : stage === 'awaiting_approval' || stage === 'generating_fix' ? 4 : stage === 'root_cause_found' ? 3 : stage === 'analysis_failed' ? 2 : 1;
  const steps = ['Error received', 'Source context', 'Root cause', 'Safe proposal', 'Human approval', 'Tests verified'];
  const current = stage === 'undone' ? 'CHANGE REVERSED' : stage === 'verified' ? 'VERIFIED' : stage === 'failed' ? 'CHECKS FAILED' : stage === 'testing' ? 'VERIFYING CHANGE' : stage === 'analysis_failed' ? 'ANALYSIS STOPPED' : (steps[Math.min(done, steps.length - 1)] ?? 'IN PROGRESS').toUpperCase();
  return (
    <View style={styles.pipeline}>
      <View style={styles.pipelineHeader}><Eyebrow index="01">REPAIR ROUTE</Eyebrow><Text style={styles.pipelineCount}>{Math.min(done, 6)} / 06</Text></View>
      <View style={styles.progressTrack}>{steps.map((name, index) => <View key={name} style={[styles.progressSegment, index < done && styles.progressSegmentDone]} />)}</View>
      <Text style={styles.pipelineCurrent}>{current}</Text>
      {steps.map((name, index) => <View key={name} style={styles.pipelineStep}>
        <Text style={[styles.stepIcon, index < done ? { color: c.signal } : index === done ? { color: c.amber } : { color: c.dim }]}>{index < done ? '✓' : index === done ? '●' : '○'}</Text>
        <Text style={[styles.stepText, index > done && { color: c.dim }]}>{name}</Text>
      </View>)}
    </View>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.detail}><Label>{label}</Label><Text style={styles.detailBody}>{children}</Text></View>;
}

function AnalysisPanel({ session }: { session: Session }) {
  const a = session.analysis;
  if (!a) return null;
  const confidenceColor = a.confidence === 'high' ? c.signal : a.confidence === 'medium' ? c.amber : c.coral;
  return (
    <Panel accent>
      <View style={styles.splitRow}><Eyebrow index="02">ROOT CAUSE</Eyebrow><View style={[styles.tag, { borderColor: confidenceColor }]}><Text style={[styles.tagText, { color: confidenceColor }]}>{a.confidence.toUpperCase()} CONFIDENCE</Text></View></View>
      <Text style={styles.analysisTitle}>{a.title}</Text>
      <Text style={styles.pathText}>{a.location ? `${a.location.path}:${a.location.line}` : 'Location not established'}</Text>
      <Detail label="PROBLEM">{a.problem}</Detail>
      <Detail label="EVIDENCE">{a.evidence}</Detail>
      <Detail label="REPAIR STRATEGY">{a.repair_strategy}</Detail>
      {a.confidence === 'low' && <Text style={styles.cautionText}>Low confidence: inspect the evidence before generating a fix.</Text>}
    </Panel>
  );
}

function DiffView({ diff }: { diff: string }) {
  return <View style={styles.diffBox}><ScrollView horizontal showsHorizontalScrollIndicator>
    <View style={styles.diffContent}>{diff.split('\n').map((line, index) => {
      const kind = line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : 'plain';
      return <Text key={`${index}-${line}`} style={[styles.diffLine, kind === 'added' ? styles.diffAdded : kind === 'removed' ? styles.diffRemoved : null]}>{line || ' '}</Text>;
    })}</View>
  </ScrollView></View>;
}

function ProposalPanel({ session, onApprove, onReject, busy }: { session: Session; onApprove: () => void; onReject: () => void; busy: boolean }) {
  const p = session.proposal;
  if (!p) return null;
  return <Panel>
    <View style={styles.splitRow}><Eyebrow index="03">PROPOSED CHANGE</Eyebrow><View style={styles.tag}><Text style={styles.tagText}>{p.risk.toUpperCase()} RISK</Text></View></View>
    <Text style={styles.proposalTitle}>{p.title}</Text>
    <Text style={styles.body}>{p.summary}</Text>
    <View style={styles.metricRow}><Metric value={String(p.files.length)} label="FILES" /><Metric value="0" label="WRITTEN YET" /></View>
    {p.files.map(file => <View key={file.path} style={styles.fileWrap}><Text style={styles.fileName}>{file.path}</Text><DiffView diff={file.diff} /></View>)}
    <Detail label="WHY THIS FIX">{p.why}</Detail>
    <Detail label="EXPECTED EFFECT">{p.expected_effect}</Detail>
    <Text style={styles.approvalNotice}>Only your explicit approval can write these file changes.</Text>
    <Button onPress={onApprove} disabled={busy} icon="✓">APPROVE & VERIFY</Button>
    <View style={styles.buttonGap} /><Button onPress={onReject} disabled={busy} tone="secondary">NOT NOW</Button>
  </Panel>;
}

function ResultPanel({ session, onUndo, onNew, onPublish, publishMessage, onPublishMessage, busy }: {
  session: Session;
  onUndo: () => void;
  onNew: () => void;
  onPublish: () => void;
  publishMessage: string;
  onPublishMessage: (message: string) => void;
  busy: boolean;
}) {
  const verified = session.stage === 'verified';
  const undone = session.stage === 'undone';
  const patchApplied = verified || (session.stage === 'failed' && session.validation !== null);
  const patchNotGenerated = session.stage === 'failed' && !session.validation;
  const publish = session.github_publish;
  const pushed = publish?.status === 'pushed';
  const undoBlocked = Boolean(publish && ['awaiting_desktop_confirmation', 'committing', 'pushing', 'commit_failed', 'upload_failed', 'pushed'].includes(publish.status));
  const retryPublish = publish?.status === 'upload_failed' || publish?.status === 'commit_failed';
  const awaitingDesktop = publish?.status === 'awaiting_desktop_confirmation';
  return <>
  <Panel accent={verified}>
    <Eyebrow index={verified ? '✓' : undone ? '↶' : '!'}>{verified ? 'MISSION COMPLETE' : undone ? 'CHANGE REVERSED' : 'NEEDS ATTENTION'}</Eyebrow>
    <Text style={[styles.resultTitle, { color: verified ? c.teal : undone ? c.ink : c.coral }]}>{verified ? 'Fix verified.' : undone ? 'Fix undone.' : patchNotGenerated ? 'Patch not generated.' : 'Verification failed.'}</Text>
    <Text style={styles.body}>{verified ? 'The approved change passed the selected project check.' : undone ? 'The project files were restored to their pre-fix state.' : session.error_message || 'The change could not be verified. Review the test output before continuing.'}</Text>
    {session.validation && <View style={styles.validation}><View style={styles.splitRow}><Label>CHECK RUN</Label><Text style={{ color: session.validation.passed ? c.teal : c.coral }}>{session.validation.passed ? 'PASSED' : 'FAILED'}</Text></View><Text style={styles.validationCommand}>{session.validation.command}</Text><Text style={styles.validationOutput} numberOfLines={12}>{session.validation.output}</Text></View>}
    {patchApplied && <><Button onPress={onUndo} disabled={busy || undoBlocked} tone={verified ? 'secondary' : 'danger'} icon="↶">UNDO FIX</Button><View style={styles.buttonGap} /></>}
    <Button onPress={onNew} disabled={busy || (patchApplied && !pushed)} tone={verified ? 'secondary' : 'primary'}>{pushed ? 'START NEXT SESSION' : 'START A NEW SESSION'}</Button>
    {patchApplied && <Text style={styles.fieldHint}>{pushed ? 'This verified fix is committed and pushed. It remains in the project; the session will be archived when you start the next one.' : undoBlocked ? 'A commit may exist or a publish request is pending. Resolve the laptop publish state before undoing or starting another session.' : 'Undo the applied patch before starting another session.'}</Text>}
  </Panel>
  {verified && publish && <Panel accent={publish.status === 'pushed'}>
    <Eyebrow index="GITHUB / VERIFIED FIX">PUBLISH FROM THE LAPTOP</Eyebrow>
    <Text style={styles.proposalTitle}>{publish.status === 'pushed' ? 'Published.' : publish.status === 'unavailable' ? 'Publishing unavailable.' : 'Keep the proof with the code.'}</Text>
    {publish.repository && <Text style={styles.pathText}>{publish.repository}  ·  {publish.branch}</Text>}
    {publish.path && <Text style={styles.fieldHint}>{publish.path}</Text>}
    {publish.commit_sha && <Text style={styles.fieldHint}>Commit {publish.commit_sha.slice(0, 12)}</Text>}
    {publish.detail && <Text style={styles.body}>{publish.detail}</Text>}
    {publish.status === 'ready' && <>
      <Text style={styles.fieldLabel}>COMMIT MESSAGE</Text>
      <TextInput accessibilityLabel="GitHub commit message" value={publishMessage} onChangeText={onPublishMessage} maxLength={72} placeholder="Describe the verified fix" placeholderTextColor={c.dim} style={styles.input} />
      <Text style={styles.fieldHint}>Request this exact file and message for desktop confirmation. GitHub credentials stay on the laptop; configured Git hooks may run there.</Text>
      <View style={styles.buttonGap} /><Button onPress={onPublish} disabled={busy || !publishMessage.trim()} icon="↗">REQUEST LAPTOP PUBLISH</Button>
    </>}
    {retryPublish && <>
      <Text style={styles.fieldHint}>Retry keeps the same commit and message. The laptop will check GitHub before attempting upload again.</Text>
      <View style={styles.buttonGap} /><Button onPress={onPublish} disabled={busy} icon="↻">REQUEST RETRY</Button>
    </>}
    {awaitingDesktop && <Text style={styles.fieldHint}>Request sent. Review the repository, branch, file, and commit message on the laptop dashboard, then confirm there to create and push the commit.</Text>}
    {(publish.status === 'committing' || publish.status === 'pushing') && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 }}><ActivityIndicator color={c.lime} /><Text style={styles.body}>{publish.status === 'committing' ? 'Creating the reviewed one-file commit…' : 'Checking and uploading the exact commit…'}</Text></View>}
    {publish.status === 'unavailable' && <Text style={styles.fieldHint}>You can still use the verified fix locally. Review the laptop Git repository setup to enable publishing next time.</Text>}
  </Panel>}
  </>;
}

function HistoryPanel({ items, historyError }: { items: SessionHistoryItem[]; historyError?: string | null }) {
  return <>
    <Eyebrow index="ARCHIVE / LOCAL">RECENT SESSIONS</Eyebrow>
    <Text style={styles.pageTitle}>Your debug trail.</Text>
    <Text style={styles.pageSubtitle}>A private record of outcomes from this laptop.</Text>
    {items.length ? items.map(item => <Panel key={item.id}>
      <View style={styles.splitRow}>
        <Eyebrow index={item.stage === 'verified' ? '✓' : item.stage === 'undone' ? '↶' : '!'}>{item.stage.replaceAll('_', ' ').toUpperCase()}</Eyebrow>
        <Label>{new Date(item.updated_at * 1000).toLocaleDateString()}</Label>
      </View>
      <Text style={styles.proposalTitle}>{item.title}</Text>
      <Label>{item.source.toUpperCase()} INPUT</Label>
      <Text style={styles.pathText}>{item.location ? `${item.location.path}:${item.location.line}` : 'Source location not established'}</Text>
      <Text style={styles.fieldHint}>{item.check_passed === null ? 'No check completed' : `${item.check_passed ? 'CHECK PASSED' : 'CHECK FAILED'}${item.check_command ? ` · ${item.check_command}` : ''}`}</Text>
      {item.github_status && <Text style={styles.fieldHint}>{`GITHUB ${item.github_status.replaceAll('_', ' ').toUpperCase()}${item.repository ? ` · ${item.repository}${item.branch ? `/${item.branch}` : ''}` : ''}${item.commit_sha ? ` · ${item.commit_sha.slice(0, 12)}` : ''}`}</Text>}
    </Panel>) : <Panel accent>
      <Eyebrow index="01">NO SAVED SESSIONS</Eyebrow>
      <Text style={styles.proposalTitle}>Your next debug run starts the history.</Text>
      <Text style={styles.body}>Completed outcomes will appear here automatically.</Text>
    </Panel>}
    {historyError && <Text style={styles.cautionText}>{historyError}</Text>}
    <Text style={styles.fieldHint}>The laptop stores up to 25 summaries. Error logs, source code, diffs, and test output are not included.</Text>
  </>;
}

function SettingsPanel({
  connected,
  agentUrl,
  state,
  onForgetPairing,
  onOpenDeviceSettings,
}: {
  connected: boolean;
  agentUrl: string | null;
  state: AgentState | null;
  onForgetPairing: () => void;
  onOpenDeviceSettings: () => void;
}) {
  return <>
    <Eyebrow index="FIELD / 04">DEVICE & PRIVACY</Eyebrow>
    <Text style={styles.pageTitle}>Settings.</Text>
    <Text style={styles.pageSubtitle}>Check the laptop link and how PocketPilot handles your debugging data.</Text>
    <Panel accent>
      <Eyebrow index="01">LAPTOP AGENT</Eyebrow>
      <View style={styles.metricRow}>
        <Metric value={connected ? 'LINKED' : agentUrl ? 'OFFLINE' : 'NOT PAIRED'} label="CONNECTION" />
        <Metric value={state?.provider?.ready ? 'READY' : 'UNAVAILABLE'} label={state?.provider?.name === 'openrouter' ? 'OPENROUTER CLOUD' : 'OLLAMA LOCAL'} />
      </View>
      <Text style={styles.settingsLabel}>AGENT ADDRESS</Text>
      <Text selectable style={styles.settingsValue}>{agentUrl || 'Pair from the welcome screen'}</Text>
      <Text style={styles.settingsLabel}>ACTIVE PROJECT</Text>
      <Text selectable style={styles.settingsValue}>{state?.workspace?.path || 'No project selected on the laptop'}</Text>
      <Text style={styles.fieldHint}>The laptop agent inspects only the project folder selected from its dashboard.</Text>
      {agentUrl && <>
        <Text style={styles.fieldHint}>Unpairing revokes this device token on the laptop. If the laptop is offline, the token expires automatically within 36 hours.</Text>
        <Button onPress={onForgetPairing} tone="danger" icon="↗">UNPAIR THIS DEVICE</Button>
      </>}
    </Panel>
    <Panel>
      <Eyebrow index="02">AI DATA ROUTING</Eyebrow>
      <View style={styles.settingsRow}><Text style={styles.settingsRowTitle}>Image capture</Text><Text style={styles.settingsRowBody}>OCR runs on this phone. Images stay here; only reviewed text is sent when you analyze.</Text></View>
      <View style={styles.settingsRow}><Text style={styles.settingsRowTitle}>Voice notes</Text><Text style={styles.settingsRowBody}>Speech is transcribed on this device. Error notes stay in the editor until Analyze; a Pilot question is sent after you stop speaking.</Text></View>
      <View style={styles.settingsRow}><Text style={styles.settingsRowTitle}>{state?.provider?.name === 'openrouter' ? 'OpenRouter cloud is active' : 'Ollama local is active'}</Text><Text style={styles.settingsRowBody}>{state?.provider?.name === 'openrouter' ? 'All model calls send reviewed error text, a bounded matched source-file window, fix instructions, and Pilot messages from the laptop to OpenRouter. Common secret patterns are redacted, but this cannot guarantee every secret is removed. Do not send credentials or code you are not authorized to share.' : 'Analysis, fix proposals, and Pilot conversation use Ollama on the paired laptop. Those prompts stay local. Avoid including credentials in submitted text.'} Up to eight recent Pilot messages stay in laptop memory only and are cleared on request, session change, unpair, or agent restart.</Text></View>
      {state?.provider?.name === 'openrouter' && <Text style={styles.cautionText}>CLOUD AI ACTIVE · Your selected error and matched code leave this laptop for every AI request.</Text>}
      <Text style={styles.fieldHint}>The phone-to-laptop bridge uses HTTP. Pair only on a Wi-Fi network you trust and unpair when finished.</Text>
      <View style={styles.settingsRow}><Text style={styles.settingsRowTitle}>Code changes</Text><Text style={styles.settingsRowBody}>The laptop shows a bounded diff. No file changes until you approve it; undo checks that the file has not changed since.</Text></View>
      <Text style={styles.fieldHint}>Session history stores short outcomes only—not raw error text, source code, diffs, or test output.</Text>
    </Panel>
    <Panel>
      <Eyebrow index="03">DEVICE PERMISSIONS</Eyebrow>
      <Text style={styles.body}>Camera access captures an error screen. Microphone access is used for on-device dictation and Pilot voice questions; typing and screenshots remain available if permission is off.</Text>
      <View style={styles.sectionTop}><Button onPress={onOpenDeviceSettings} tone="secondary">OPEN ANDROID APP SETTINGS</Button></View>
    </Panel>
  </>;
}

export default function App() {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>('home');
  const [errorText, setErrorText] = useState('');
  const [errorSource, setErrorSource] = useState<'text' | ErrorImageSource>('text');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [composeNew, setComposeNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [chatTurns, setChatTurns] = useState<AssistantTurn[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [readAloud, setReadAloud] = useState(true);
  const [publishMessage, setPublishMessage] = useState('');
  const voiceBase = useRef('');
  const voiceTarget = useRef<'error' | 'pilot'>('error');
  const pendingChatVoice = useRef<string | null>(null);
  const chatContextId = useRef<string | null>(null);
  const chatOwnerToken = useRef<string | null>(null);
  const chatRequestGeneration = useRef(0);
  const chatInFlightGeneration = useRef<number | null>(null);
  const polling = useRef(false);

  useSpeechRecognitionEvent('start', () => {
    setVoiceListening(true);
    setVoiceStatus(voiceTarget.current === 'pilot'
      ? 'Listening on this phone. Ask Pilot a question.'
      : 'Listening on this phone. Speak your error notes, then tap stop.');
  });
  useSpeechRecognitionEvent('end', () => {
    setVoiceListening(false);
    if (voiceTarget.current === 'pilot' && pendingChatVoice.current) {
      const question = pendingChatVoice.current;
      pendingChatVoice.current = null;
      void sendChat(question);
    }
  });
  useSpeechRecognitionEvent('result', event => {
    const transcript = event.results[0]?.transcript.trim();
    if (!transcript) return;
    const base = voiceBase.current;
    if (voiceTarget.current === 'pilot') {
      const question = `${base}${base ? ' ' : ''}${transcript}`;
      setChatDraft(question);
      if (event.isFinal) {
        pendingChatVoice.current = question;
        setVoiceStatus(`Question heard. Sending it to ${state?.provider?.name === 'openrouter' ? 'OpenRouter' : 'local Ollama'}…`);
      }
    } else {
      setErrorText(`${base}${base ? '\n' : ''}${transcript}`);
      if (event.isFinal) setVoiceStatus('Transcript ready. Review or edit it before analysis.');
    }
  });
  useSpeechRecognitionEvent('error', event => {
    setVoiceListening(false);
    const message = event.error === 'no-speech' || event.error === 'speech-timeout'
      ? 'No speech detected. Tap the microphone and try again.'
      : event.error === 'not-allowed'
        ? 'Microphone access is off. Allow it in Android settings, then try again.'
        : event.error === 'service-not-allowed' || event.error === 'language-not-supported' || event.error === 'network'
          ? 'On-device speech recognition is unavailable. Check that the offline English voice model is installed.'
          : 'Voice input stopped. You can retry or type the error instead.';
    setVoiceStatus(message);
  });

  useEffect(() => {
    let active = true;
    loadPairing().then(([url, storedToken]) => {
      if (!active) return;
      if (url) setAddress(url);
      if (url && storedToken) { setAgentUrl(url); setToken(storedToken); }
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!agentUrl || !token || polling.current) return;
    polling.current = true;
    try {
      const next = await request<AgentState>(agentUrl, '/api/state', token);
      setState(next);
      setConnected(true);
      setNetworkError(null);
    } catch (error) {
      setConnected(false);
      const message = error instanceof Error ? error.message : 'Cannot reach laptop.';
      setNetworkError(message.includes('Invalid or expired device token')
        ? 'The laptop agent restarted. Tap PAIR AGAIN and enter a fresh code.'
        : message);
    } finally {
      polling.current = false;
    }
  }, [agentUrl, token]);

  useEffect(() => {
    if (!agentUrl || !token) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2300);
    return () => clearInterval(timer);
  }, [agentUrl, token, refresh]);

  useEffect(() => {
    const current = state?.session;
    if (!current) return;
    setPublishMessage(
      current.github_publish?.message
        ?? current.proposal?.title.slice(0, 72)
        ?? 'Fix verified issue',
    );
  }, [state?.session?.id]);

  useEffect(() => {
    const id = state?.session?.id ?? null;
    const phoneChanged = chatOwnerToken.current !== token;
    const sessionChanged = chatContextId.current !== id;
    if (phoneChanged || sessionChanged) {
      chatRequestGeneration.current += 1;
      chatContextId.current = id;
      chatOwnerToken.current = token;
      setChatTurns([]);
      // Do not leave a previous session's hidden short-term context attached
      // to the paired phone when the app is reopened or a new session starts.
      if (agentUrl && token) {
        void request(agentUrl, '/api/assistant/clear', token, {}).catch(() => undefined);
      }
    }
  }, [agentUrl, state?.session?.id, token]);

  async function pair() {
    setBusy(true); setNotice(null);
    try {
      const url = normalizeAgentAddress(address);
      const cleanedCode = code.trim();
      if (!cleanedCode) throw new Error('Enter the pairing code shown on the laptop.');
      const result = await request<PairResult>(url, '/api/pair', undefined, { code: cleanedCode, device_name: 'iQOO PocketPilot' });
      if (!result.token) throw new Error('The laptop did not provide a connection token.');
      await savePairing(url, result.token);
      setAgentUrl(url); setToken(result.token); setCode(''); setTab('debug');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not pair with the laptop.'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    chatRequestGeneration.current += 1;
    chatInFlightGeneration.current = null;
    setChatBusy(false);
    let revoked = false;
    if (agentUrl && token) {
      try {
        await request(agentUrl, '/api/unpair', token, {});
        revoked = true;
      } catch {
        // Local credentials are still cleared. The server token has a bounded TTL.
      }
    }
    await clearPairing();
    setToken(null); setAgentUrl(null); setState(null); setConnected(false); setTab('home'); setNetworkError(null);
    setChatTurns([]); setChatDraft('');
    void Speech.stop();
    setNotice(revoked ? 'Phone unpaired. Its laptop token has been revoked.' : 'Phone link cleared here. The laptop token will expire within 36 hours if the laptop was offline.');
  }

  async function openDeviceSettings() {
    if (Platform.OS === 'web') {
      setNotice('Open Android Settings → Apps → PocketPilot AI → Permissions to review camera or microphone access.');
      return;
    }
    try {
      await Linking.openSettings();
    } catch {
      setNotice('Open Android Settings → Apps → PocketPilot AI → Permissions to review camera or microphone access.');
    }
  }

  async function action(path: string, body: object, timeoutMs = 20000) {
    if (!agentUrl || !token) return;
    setBusy(true); setNotice(null);
    try {
      const session = await request<Session>(agentUrl, path, token, body, timeoutMs);
      setState(current => current ? { ...current, session } : { workspace: null, provider: null, session, history: [] });
      setTab('debug'); setComposeNew(false);
      void refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The action did not complete.'); }
    finally { setBusy(false); }
  }

  function confirmGitHubPublish(current: Session) {
    const target = current.github_publish;
    if (!target?.repository || !target.branch || !target.path) {
      setNotice('The laptop could not prepare a safe GitHub destination for this fix.');
      return;
    }
    const retry = target.status === 'upload_failed' || target.status === 'commit_failed';
    Alert.alert(
      retry ? 'Request a GitHub publish retry?' : 'Request desktop publish confirmation?',
      `${target.repository}  ·  ${target.branch}\n${target.path}\n\nCommit: ${publishMessage.trim()}\n\nOnly the verified file is eligible. GitHub credentials stay on the laptop. The laptop dashboard must confirm the exact target before Git runs. ${retry ? 'PocketPilot will reuse the same commit.' : 'No force-push will be used.'}`,
      [
        { text: 'CANCEL', style: 'cancel' },
        {
          text: retry ? 'REQUEST RETRY' : 'REQUEST PUBLISH',
          onPress: () => {
            void action(
              `/api/sessions/${current.id}/github/publish`,
              { revision: current.revision, message: publishMessage.trim() },
              20000,
            );
          },
        },
      ],
    );
  }

  function startAnalysis() {
    const value = errorText.trim();
    if (value.length < 12) { setNotice('Paste the error and a few stack-trace lines before analyzing.'); return; }
    void action('/api/sessions', { error_text: value, source: errorSource });
  }

  function speakReply(reply: string) {
    const spoken = reply.replace(/[`*_#]/g, '').slice(0, Math.min(Speech.maxSpeechInputLength || 1200, 1200));
    void Speech.stop().then(() => Speech.speak(spoken, { language: 'en-IN', rate: 0.96 })).catch(() => {
      setChatError('The text reply is ready, but this device could not play it aloud.');
    });
  }

  async function sendChat(message?: string) {
    const question = (message ?? chatDraft).trim();
    if (!question || !agentUrl || !token || chatBusy) return;
    const fromDraft = message === undefined;
    if (question.length > 1200) {
      setChatDraft(question.slice(0, 1200));
      setChatError('Pilot questions are limited to 1,200 characters. The transcript has been shortened for review.');
      return;
    }
    setChatBusy(true); setChatError(null);
    const requestGeneration = ++chatRequestGeneration.current;
    chatInFlightGeneration.current = requestGeneration;
    if (fromDraft) setChatDraft('');
    try {
      const answer = await request<AssistantResponse>(agentUrl, '/api/assistant/chat', token, {
        message: question,
        session_id: state?.session?.id ?? null,
      }, 190000);
      if (requestGeneration !== chatRequestGeneration.current) return;
      setChatTurns(previous => [...previous, { role: 'user', content: question }, { role: 'assistant', content: answer.reply }].slice(-8) as AssistantTurn[]);
      setChatDraft('');
      setVoiceStatus(null);
      if (readAloud) speakReply(answer.reply);
    } catch (error) {
      if (requestGeneration !== chatRequestGeneration.current) return;
      setChatError(error instanceof Error ? error.message : 'Pilot could not answer. Try again.');
      if (fromDraft) setChatDraft(question);
    } finally {
      if (chatInFlightGeneration.current === requestGeneration) {
        chatInFlightGeneration.current = null;
        setChatBusy(false);
      }
    }
  }

  async function clearChat() {
    if (!agentUrl || !token || voiceListening) return;
    chatRequestGeneration.current += 1;
    setChatError(null);
    try {
      await request<{ cleared: boolean }>(agentUrl, '/api/assistant/clear', token, {});
      setChatTurns([]);
      setChatDraft('');
      setVoiceStatus(null);
      pendingChatVoice.current = null;
      void Speech.stop();
    } catch (error) {
      setChatError(error instanceof Error
        ? `Chat could not be cleared on the laptop: ${error.message}`
        : 'Chat could not be cleared on the laptop. Check the connection and retry.');
    }
  }

  async function toggleVoiceInput(target: 'error' | 'pilot' = 'error') {
    if (voiceListening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    voiceTarget.current = target;
    pendingChatVoice.current = null;
    if (target === 'pilot') void Speech.stop();
    if (Platform.OS !== 'android') {
      setVoiceStatus('On-device voice input is available in the Android app. You can type or capture the error here.');
      return;
    }
    setVoiceStatus(null);
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setVoiceStatus('Android speech recognition is unavailable. You can type or capture the error instead.');
        return;
      }
      if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
        setVoiceStatus('This device does not offer on-device speech recognition, so voice input stays off.');
        return;
      }
      const permission = await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
      if (!permission.granted) {
        setVoiceStatus('Microphone access is needed for dictation. Allow it in Android settings, then try again.');
        return;
      }
      if (!ExpoSpeechRecognitionModule.getSpeechRecognitionServices().includes(ANDROID_SPEECH_SERVICE)) {
        setVoiceStatus('Google on-device speech service is unavailable. You can type or capture the error instead.');
        return;
      }

      const supported = await ExpoSpeechRecognitionModule.getSupportedLocales({
        androidRecognitionServicePackage: ANDROID_SPEECH_SERVICE,
      });
      const canonical = (locale: string) => locale.replace('_', '-').toLowerCase();
      const preferred = ['en-IN', 'en-US'];
      const locale = preferred.find(candidate => supported.locales.some(item => canonical(item) === candidate.toLowerCase()))
        ?? supported.locales.find(item => canonical(item).startsWith('en-'));
      if (!locale) {
        setVoiceStatus('No offline English voice model is supported on this device. You can type or capture the error instead.');
        return;
      }
      const installed = supported.installedLocales.some(item => canonical(item) === canonical(locale));
      if (!installed) {
        const download = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale });
        setVoiceStatus(download.status === 'download_success'
          ? 'Offline voice model downloaded. Tap the microphone again to dictate.'
          : 'Download the offline voice model in the Android prompt, then tap the microphone again. Speech audio will stay on this phone.');
        return;
      }

      voiceBase.current = target === 'pilot' ? chatDraft.trimEnd() : errorText.trimEnd();
      ExpoSpeechRecognitionModule.start({
        lang: locale,
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        requiresOnDeviceRecognition: true,
        addsPunctuation: true,
        androidRecognitionServicePackage: ANDROID_SPEECH_SERVICE,
        contextualStrings: ['PocketPilot', 'TypeError', 'NullPointerException', 'stack trace', 'pytest', 'Java'],
      });
    } catch (error) {
      setVoiceStatus(error instanceof Error
        ? `Voice input could not start: ${error.message}`
        : 'Voice input could not start. You can type or capture the error instead.');
    }
  }

  async function scan(source: ErrorImageSource) {
    setBusy(true); setNotice(null);
    try {
      const extracted = await extractErrorFromImage(source);
      if (!extracted) return;
      setErrorText(extracted.text);
      setErrorSource(extracted.source);
      setImageUri(extracted.imageUri);
      setComposeNew(true);
      setTab('debug');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'On-device text recognition failed. You can paste the error instead.');
    } finally { setBusy(false); }
  }

  const session = state?.session;
  const showComposer = composeNew || !session;
  const showResult = session && ['verified', 'failed', 'undone'].includes(session.stage);
  const visibleNotice = networkError || notice;

  return <View style={styles.screen}>
    <StatusBar style="dark" />
    <NavigationBar style="dark" />
    <BrandHeader connected={Boolean(token && connected)} paired={Boolean(token)} onDisconnect={() => { void disconnect(); }} />
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {visibleNotice && <View style={styles.notice}><Text style={styles.noticeHeading}>CONNECTION OR REQUEST ISSUE</Text><Text style={styles.noticeBody}>{visibleNotice}</Text>{token && <><Pressable accessibilityRole="button" onPress={() => { setNotice(null); void refresh(); }}><Text style={styles.noticeRetry}>TRY AGAIN  ↗</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { void disconnect(); }}><Text style={styles.noticeRetry}>PAIR AGAIN  ↗</Text></Pressable></>}</View>}
        {!token ? <>
          <Eyebrow index="00">THE PHONE IS YOUR CONTROL SURFACE</Eyebrow>
          <Text style={styles.heroTitle}>Hold the line.<Text style={{ color: c.signal }}> Fix the code.</Text></Text>
          <Text style={styles.heroBody}>Your phone becomes the command surface for a real project on your laptop. Connect once, then review every decision from here.</Text>
          <Panel accent>
            <Eyebrow index="01">SECURE LOCAL LINK</Eyebrow>
            <Text style={styles.fieldLabel}>LAPTOP ADDRESS</Text>
            <TextInput accessibilityLabel="Laptop address" placeholder="192.168.1.10:8000" placeholderTextColor={c.dim} autoCapitalize="none" autoCorrect={false} keyboardType="url" value={address} onChangeText={setAddress} style={styles.input} />
            <Text style={styles.fieldHint}>Use the network address on the laptop dashboard, not 127.0.0.1.</Text>
            <Text style={styles.fieldLabel}>ONE-TIME PAIRING CODE</Text>
            <TextInput accessibilityLabel="Pairing code" placeholder="Enter code" placeholderTextColor={c.dim} autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} style={styles.input} />
            <Button onPress={() => { void pair(); }} disabled={busy} icon="↗">{busy ? 'CONNECTING…' : 'CONNECT LAPTOP'}</Button>
          </Panel>
          <View style={styles.privacyLine}><View style={styles.privacyDot} /><Text style={styles.privacyText}>LOCAL-FIRST  ·  HUMAN APPROVAL BEFORE ANY WRITE</Text></View>
        </> : tab === 'home' ? <>
          <Eyebrow index="LIVE / 01">FIELD INSTRUMENT</Eyebrow>
          <Text style={styles.heroTitle}>A repair, in your hands<Text style={{ color: c.signal }}>.</Text></Text>
          <Text style={styles.heroBody}>Capture the failure. Inspect the evidence. Approve the exact change. Watch the tests run.</Text>
          <Panel accent>
            <View style={styles.splitRow}><Eyebrow index="↗">ACTIVE WORKSPACE</Eyebrow><Text style={styles.liveBadge}>{connected ? '●  LINKED' : '○  OFFLINE'}</Text></View>
            <Text style={styles.workspaceName}>{state?.workspace?.path || 'No project selected'}</Text>
            <View style={styles.metricRow}><Metric value={state?.workspace?.ready ? 'READY' : 'WAITING'} label="PROJECT" /><Metric value={state?.provider?.ready ? state.provider.name === 'openrouter' ? 'CLOUD' : 'LOCAL' : 'OFFLINE'} label="AI ROUTE" /></View>
            <Text style={styles.fieldHint}>{state?.workspace?.ready ? 'The desktop agent has a project selected and can inspect its source safely.' : 'Select a project in the laptop dashboard before analyzing an error.'}</Text>
            <Button onPress={() => setTab('debug')} icon="↗">{session ? 'CONTINUE REPAIR' : 'START A REPAIR'}</Button>
          </Panel>
          <Panel>
            <Eyebrow index="02">PILOT / CONVERSATION</Eyebrow>
            <Text style={styles.proposalTitle}>Ask the model why.</Text>
            <Text style={styles.body}>Speak or type a follow-up. Pilot uses the current session evidence to explain the failure and the safest next step; it never applies a fix for you.</Text>
            <View style={styles.sectionTop}><Button onPress={() => setTab('pilot')} tone="secondary" icon="✳">TALK TO PILOT</Button></View>
          </Panel>
          <Panel>
            <Eyebrow index="03">SEE IT / ON-DEVICE OCR</Eyebrow>
            <Text style={styles.proposalTitle}>Capture the error.</Text>
            <Text style={styles.body}>Photograph a screen or choose a screenshot. Read the extracted text on this phone before sending anything to the laptop.</Text>
            <View style={styles.sectionTop}><Button onPress={() => { void scan('camera'); }} disabled={busy} icon="▣">SCAN WITH CAMERA</Button></View>
            <Button onPress={() => { void scan('gallery'); }} disabled={busy} tone="secondary">CHOOSE SCREENSHOT</Button>
          </Panel>
          <View style={styles.sectionTop}><Eyebrow index="HOW / 02">ONE CONTROLLED LOOP</Eyebrow></View>
          <View style={styles.howRow}><Text style={styles.howNumber}>01</Text><View><Text style={styles.howTitle}>Capture the failure</Text><Text style={styles.howBody}>Paste the error on your phone.</Text></View></View>
          <View style={styles.howRow}><Text style={styles.howNumber}>02</Text><View><Text style={styles.howTitle}>Inspect the evidence</Text><Text style={styles.howBody}>The selected AI provider explains the likely source.</Text></View></View>
          <View style={styles.howRow}><Text style={styles.howNumber}>03</Text><View><Text style={styles.howTitle}>Approve, test, undo</Text><Text style={styles.howBody}>You stay in control of every write.</Text></View></View>
        </> : tab === 'pilot' ? <PilotPanel
          turns={chatTurns}
          draft={chatDraft}
          onDraft={setChatDraft}
          onSend={(message) => { void sendChat(message); }}
          onClear={() => { void clearChat(); }}
          onVoice={() => { void toggleVoiceInput('pilot'); }}
          onSpeak={speakReply}
          onToggleReadAloud={() => { setReadAloud(value => !value); void Speech.stop(); }}
          busy={chatBusy}
          connected={connected}
          listening={voiceListening}
          voiceStatus={voiceTarget.current === 'pilot' ? voiceStatus : null}
          error={chatError}
          readAloud={readAloud}
          session={state?.session ?? null}
          model={state?.provider?.ready ? state.provider.model : null}
          providerName={state?.provider?.name ?? null}
        /> : tab === 'sessions' ? <HistoryPanel items={state?.history ?? []} historyError={state?.history_error} /> : tab === 'settings' ? <SettingsPanel connected={connected} agentUrl={agentUrl} state={state} onForgetPairing={() => { void disconnect(); }} onOpenDeviceSettings={() => { void openDeviceSettings(); }} /> : <>
          <Eyebrow index="LIVE / 02">VISION DEBUGGER</Eyebrow>
          <Text style={styles.pageTitle}>{showComposer ? 'Capture the failure.' : session?.stage === 'verified' ? 'A fix, proven.' : session?.stage === 'undone' ? 'Back to the baseline.' : 'Follow the signal.'}</Text>
          <Text style={styles.pageSubtitle}>{showComposer ? 'Scan an error or paste a stack trace. Review the text before analysis.' : 'One bounded session. Every decision visible.'}</Text>
          {showComposer ? <Panel>
            <Eyebrow index="01">ERROR INPUT</Eyebrow>
            <Text style={styles.inputIntro}>What went wrong?</Text>
            <Text style={styles.inputSupport}>Point your camera at the failing terminal, choose an image, or paste the trace below.</Text>
            {state?.provider?.name === 'openrouter' && <Text style={styles.cautionText}>OPENROUTER CLOUD ACTIVE · ANALYZE sends the reviewed error and matched source context to the cloud. Remove secrets first.</Text>}
            <View style={styles.captureRow}>
              <Pressable accessibilityRole="button" disabled={busy || voiceListening} onPress={() => { void scan('camera'); }} style={styles.captureAction}><Text style={styles.captureIcon}>▣</Text><Text style={styles.captureText}>CAMERA</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={busy || voiceListening} onPress={() => { void scan('gallery'); }} style={styles.captureAction}><Text style={styles.captureIcon}>◫</Text><Text style={styles.captureText}>SCREENSHOT</Text></Pressable>
            </View>
            {imageUri && <Image source={{ uri: imageUri }} style={styles.imagePreview} resizeMode="contain" accessibilityLabel="Selected error image preview" />}
            {imageUri && <Text style={styles.fieldHint}>Image stays on this phone. Check and edit the extracted text below; only that text is sent when you tap Analyze.</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={voiceListening ? 'Stop voice dictation' : 'Dictate error notes on this device'} disabled={busy} onPress={() => { void toggleVoiceInput(); }} style={[styles.voiceAction, voiceListening && styles.voiceActionActive]}>
              <Text style={[styles.voiceActionText, voiceListening && styles.voiceActionTextActive]}>{voiceListening ? '■  STOP DICTATION' : '🎙  SPEAK ERROR NOTES'}</Text>
            </Pressable>
            <Text style={voiceStatus ? styles.voiceStatus : styles.fieldHint}>{voiceStatus || 'Optional on-device dictation. No speech audio is sent to the laptop.'}</Text>
            <TextInput accessibilityLabel="Error text" placeholder="Paste the error, stack trace, and failing test output…" placeholderTextColor={c.dim} value={errorText} onChangeText={setErrorText} multiline textAlignVertical="top" style={styles.errorInput} />
            <Text style={styles.fieldHint}>Tip: include the source file path and line number for stronger location evidence.</Text>
            <Button onPress={startAnalysis} disabled={busy || voiceListening || !state?.workspace?.ready} icon="⌁">{busy ? 'READING / SENDING…' : voiceListening ? 'STOP DICTATION TO CONTINUE' : 'ANALYZE ERROR'}</Button>
            {!state?.workspace?.ready && <Text style={styles.cautionText}>Choose a workspace in the desktop dashboard first.</Text>}
          </Panel> : session ? <>
            {workingStages.has(session.stage) && <ProcessingPanel key={session.stage} stage={session.stage} />}
            <AnalysisPanel session={session} />
            {session.stage === 'root_cause_found' && <Panel><Eyebrow index="03">NEXT DECISION</Eyebrow><Text style={styles.proposalTitle}>Ready to design a fix?</Text><Text style={styles.body}>The laptop will propose a bounded diff. You can review it before any file changes.</Text><View style={styles.sectionTop}><Button onPress={() => { void action(`/api/sessions/${session.id}/proposal`, {}); }} disabled={busy || !session.analysis?.location} icon="↗">GENERATE FIX</Button></View>{!session.analysis?.location && <Text style={styles.cautionText}>A safe repository location was not established, so a patch cannot be generated.</Text>}</Panel>}
            {session.stage === 'awaiting_approval' && <ProposalPanel session={session} busy={busy} onApprove={() => { if (session.proposal) void action(`/api/sessions/${session.id}/approve`, { proposal_id: session.proposal.id, revision: session.revision }, 300000); }} onReject={() => setComposeNew(true)} />}
            {showResult && <ResultPanel session={session} busy={busy} publishMessage={publishMessage} onPublishMessage={setPublishMessage} onPublish={() => confirmGitHubPublish(session)} onUndo={() => { void action(`/api/sessions/${session.id}/undo`, { revision: session.revision }); }} onNew={() => { setComposeNew(true); setErrorText(''); }} />}
            {session.stage === 'analysis_failed' && <Panel><Eyebrow index="!">ANALYSIS STOPPED</Eyebrow><Text style={styles.resultTitle}>No trusted location yet.</Text><Text style={styles.body}>{session.error_message || 'The error did not resolve to a safe source file. Review the text and try again.'}</Text><View style={styles.sectionTop}><Button onPress={() => { setErrorText(session.error_text); setComposeNew(true); }}>REVIEW ERROR TEXT</Button></View></Panel>}
            <Pipeline stage={session.stage} />
            {!workingStages.has(session.stage) && !showResult && <Pressable accessibilityRole="button" onPress={() => { setErrorText(session.error_text); setComposeNew(true); }} style={styles.ghostAction}><Text style={styles.ghostActionText}>REVIEW / START ANOTHER ERROR  ↗</Text></Pressable>}
          </> : null}
        </>}
        <View style={styles.bottomSpace} />
      </ScrollView>
    </KeyboardAvoidingView>
    {token && <View style={styles.tabBar}>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'home' }} onPress={() => setTab('home')} style={styles.tab}><Text style={[styles.tabIcon, tab === 'home' && styles.activeTab]}>⌂</Text><Text style={[styles.tabLabel, tab === 'home' && styles.activeTab]}>HOME</Text></Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'debug' }} onPress={() => setTab('debug')} style={styles.tab}><Text style={[styles.tabIcon, tab === 'debug' && styles.activeTab]}>⌘</Text><Text style={[styles.tabLabel, tab === 'debug' && styles.activeTab]}>DEBUG</Text></Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'pilot' }} onPress={() => setTab('pilot')} style={styles.tab}><Text style={[styles.tabIcon, tab === 'pilot' && styles.activeTab]}>✳</Text><Text style={[styles.tabLabel, tab === 'pilot' && styles.activeTab]}>PILOT</Text></Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'sessions' }} onPress={() => setTab('sessions')} style={styles.tab}><Text style={[styles.tabIcon, tab === 'sessions' && styles.activeTab]}>≡</Text><Text style={[styles.tabLabel, tab === 'sessions' && styles.activeTab]}>SESSIONS</Text></Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'settings' }} onPress={() => setTab('settings')} style={styles.tab}><Text style={[styles.tabIcon, tab === 'settings' && styles.activeTab]}>⚙</Text><Text style={[styles.tabLabel, tab === 'settings' && styles.activeTab]}>SETTINGS</Text></Pressable>
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: c.canvas, paddingTop: Platform.OS === 'android' ? NativeStatusBar.currentHeight || 24 : 0 },
  header: { minHeight: 82, backgroundColor: '#102B31', borderBottomWidth: 3, borderColor: c.lime, paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  brandWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  brandMark: { width: 40, height: 40, borderRadius: 10, backgroundColor: c.lime, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: '#102B31', fontSize: 21, fontWeight: '900', letterSpacing: -2 },
  brandName: { color: '#F4F7ED', fontSize: 14, fontWeight: '900', letterSpacing: 2 },
  brandSubtitle: { color: '#AEC0BC', fontSize: 8, fontWeight: '700', letterSpacing: 1.6, marginTop: 2 },
  connectionPill: { minHeight: 42, borderWidth: 1, borderColor: '#4D6768', borderRadius: 25, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11 },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
  connectionText: { color: '#F4F7ED', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  content: { paddingHorizontal: 20, paddingTop: 27, width: '100%', maxWidth: 700, alignSelf: 'center' },
  label: { fontSize: 10, fontWeight: '800', letterSpacing: 2.1 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  eyebrowIndex: { color: c.signal, fontSize: 10, fontWeight: '800', letterSpacing: 1, fontFamily: 'monospace' },
  heroTitle: { color: c.ink, fontSize: 40, lineHeight: 45, letterSpacing: -2, fontWeight: '900', marginTop: 17, maxWidth: 440 },
  heroBody: { color: c.quiet, fontSize: 15, lineHeight: 23, marginTop: 13, maxWidth: 460, marginBottom: 27 },
  pageTitle: { color: c.ink, fontSize: 35, lineHeight: 40, letterSpacing: -1.5, fontWeight: '900', marginTop: 13 },
  pageSubtitle: { color: c.quiet, fontSize: 14, lineHeight: 22, marginTop: 9, marginBottom: 24 },
  panel: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, borderRadius: 20, padding: 19, marginBottom: 16 },
  panelAccent: { backgroundColor: '#FBFFF0', borderColor: '#9EBD75' },
  fieldLabel: { color: c.quiet, fontSize: 10, fontWeight: '800', letterSpacing: 1.7, marginTop: 25, marginBottom: 10 },
  input: { minHeight: 56, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: '#F8F9F3', color: c.ink, paddingHorizontal: 16, fontSize: 17 },
  fieldHint: { color: c.dim, fontSize: 12, lineHeight: 18, marginTop: 10, marginBottom: 14 },
  button: { minHeight: 54, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonPrimary: { backgroundColor: c.lime },
  buttonSecondary: { backgroundColor: '#F4F7EF', borderWidth: 1, borderColor: c.line },
  buttonDanger: { backgroundColor: '#FFF2EE', borderWidth: 1, borderColor: c.coral },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: c.ink, fontSize: 12, letterSpacing: 1.2, fontWeight: '900' },
  buttonTextPrimary: { color: '#102B31' },
  buttonGap: { height: 10 },
  privacyLine: { flexDirection: 'row', gap: 9, alignItems: 'center', marginTop: 10 },
  privacyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.teal },
  privacyText: { color: c.dim, fontSize: 9, letterSpacing: 1.1, fontWeight: '700' },
  notice: { backgroundColor: '#FFF0EA', borderColor: '#DEAAA1', borderWidth: 1, borderRadius: 16, padding: 18, marginBottom: 20 },
  noticeHeading: { color: c.coral, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  noticeBody: { color: c.ink, lineHeight: 21, marginTop: 10 },
  noticeRetry: { color: c.amber, fontWeight: '800', letterSpacing: 1.2, fontSize: 11, marginTop: 16 },
  workspaceName: { color: c.ink, fontSize: 20, lineHeight: 27, fontWeight: '800', marginTop: 18, marginBottom: 16 },
  liveBadge: { color: c.signal, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  metricRow: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.line, paddingVertical: 19, flexDirection: 'row', gap: 25, marginTop: 18, marginBottom: 18 },
  metric: { flex: 1, gap: 5 },
  metricValue: { color: c.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  sectionTop: { marginTop: 24, marginBottom: 14 },
  howRow: { flexDirection: 'row', gap: 20, borderBottomWidth: 1, borderColor: c.line, paddingVertical: 17 },
  howNumber: { color: c.signal, fontFamily: 'monospace', fontWeight: '700', fontSize: 13 },
  howTitle: { color: c.ink, fontSize: 16, fontWeight: '700' },
  howBody: { color: c.dim, fontSize: 12, marginTop: 5 },
  settingsLabel: { color: c.dim, fontSize: 9, fontWeight: '800', letterSpacing: 1.4, marginTop: 17 },
  settingsValue: { color: c.ink, fontSize: 13, lineHeight: 19, marginTop: 6 },
  settingsRow: { borderTopWidth: 1, borderColor: c.line, paddingVertical: 15 },
  settingsRowTitle: { color: c.ink, fontSize: 14, fontWeight: '700' },
  settingsRowBody: { color: c.quiet, fontSize: 12, lineHeight: 19, marginTop: 6 },
  inputIntro: { color: c.ink, fontSize: 23, fontWeight: '800', letterSpacing: -0.5, marginTop: 17 },
  inputSupport: { color: c.quiet, fontSize: 13, lineHeight: 19, marginTop: 6 },
  errorInput: { minHeight: 205, backgroundColor: '#F8F9F3', color: c.ink, borderColor: c.line, borderWidth: 1, borderRadius: 12, padding: 15, fontFamily: 'monospace', fontSize: 13, lineHeight: 21, marginTop: 17 },
  captureRow: { flexDirection: 'row', gap: 10, marginTop: 17 },
  captureAction: { flex: 1, minHeight: 73, alignItems: 'flex-start', justifyContent: 'center', borderWidth: 1, borderColor: '#A6BAAA', borderRadius: 12, backgroundColor: '#F7FAF0', paddingHorizontal: 16 },
  captureIcon: { color: c.signal, fontSize: 21, marginBottom: 3 },
  captureText: { color: c.ink, fontSize: 11, fontWeight: '900', letterSpacing: 0.7 },
  voiceAction: { minHeight: 49, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#9AB28B', borderRadius: 11, backgroundColor: '#F7FAF0', marginTop: 11 },
  voiceActionActive: { backgroundColor: '#FFF0EA', borderColor: c.coral },
  voiceActionText: { color: c.signal, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  voiceActionTextActive: { color: c.coral },
  voiceStatus: { color: c.amber, fontSize: 12, lineHeight: 19, marginTop: 9 },
  imagePreview: { height: 150, width: '100%', borderRadius: 12, backgroundColor: c.canvas, marginTop: 14 },
  processingMain: { flexDirection: 'row', gap: 17, alignItems: 'center', marginTop: 22 },
  orbitBox: { width: 91, height: 91, alignItems: 'center', justifyContent: 'center' },
  orbitInner: { width: 68, height: 68, borderRadius: 34, borderWidth: 7, borderColor: c.lime, alignItems: 'center', justifyContent: 'center' },
  orbitCenter: { color: c.signal, fontSize: 18 },
  orbitTrack: { position: 'absolute', width: 91, height: 91, borderRadius: 46, borderWidth: 1, borderColor: '#7E8291', alignItems: 'center' },
  orbitSatellite: { width: 13, height: 13, borderRadius: 7, backgroundColor: c.amber, marginTop: -7 },
  processingCopy: { flex: 1 },
  processingTitle: { color: c.ink, fontSize: 20, lineHeight: 25, fontWeight: '800', letterSpacing: -0.5, marginBottom: 8 },
  body: { color: c.quiet, fontSize: 14, lineHeight: 22 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 24 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.lime },
  liveText: { color: c.quiet, fontSize: 11 },
  processDisclosure: { minHeight: 44, borderTopWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  processDisclosureText: { color: c.signal, fontWeight: '800', fontSize: 10, letterSpacing: 1.3 },
  processDetail: { color: c.quiet, fontSize: 12, lineHeight: 19, marginBottom: 6 },
  pipeline: { borderColor: c.line, borderWidth: 1, borderRadius: 18, paddingHorizontal: 19, paddingTop: 18, paddingBottom: 9, backgroundColor: c.raised, marginBottom: 16 },
  pipelineHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pipelineCount: { color: c.signal, fontFamily: 'monospace', fontWeight: '800', fontSize: 11 },
  progressTrack: { flexDirection: 'row', gap: 4, marginTop: 14 },
  progressSegment: { flex: 1, height: 5, borderRadius: 3, backgroundColor: c.raisedAlt },
  progressSegmentDone: { backgroundColor: c.lime },
  pipelineCurrent: { color: c.ink, fontSize: 11, fontWeight: '900', letterSpacing: 0.9, marginTop: 10, marginBottom: 4 },
  pipelineStep: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: '#E5E9E1' },
  stepIcon: { fontSize: 14, width: 18 },
  stepText: { color: c.ink, fontSize: 12 },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  tag: { borderRadius: 8, borderWidth: 1, borderColor: '#A78146', paddingHorizontal: 8, paddingVertical: 6 },
  tagText: { color: c.amber, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  analysisTitle: { color: c.ink, fontSize: 21, lineHeight: 27, fontWeight: '800', marginTop: 25 },
  pathText: { color: c.signal, fontFamily: 'monospace', fontSize: 15, marginTop: 12, lineHeight: 22 },
  detail: { paddingTop: 17, borderTopWidth: 1, borderColor: c.line, marginTop: 19 },
  detailBody: { color: c.quiet, fontSize: 13, lineHeight: 21, marginTop: 10 },
  cautionText: { color: c.amber, fontSize: 12, lineHeight: 19, marginTop: 14 },
  proposalTitle: { color: c.ink, fontSize: 24, lineHeight: 30, fontWeight: '800', letterSpacing: -0.7, marginTop: 19, marginBottom: 12 },
  fileWrap: { marginTop: 16 },
  fileName: { color: c.signal, fontFamily: 'monospace', fontSize: 12, marginBottom: 10 },
  diffBox: { borderWidth: 1, borderRadius: 12, borderColor: '#28424A', backgroundColor: '#102B31', overflow: 'hidden' },
  diffContent: { paddingVertical: 12, minWidth: '100%' },
  diffLine: { color: '#D1DED6', fontFamily: 'monospace', fontSize: 11, lineHeight: 19, paddingHorizontal: 14 },
  diffAdded: { backgroundColor: '#163A39', color: '#A8E9DF' },
  diffRemoved: { backgroundColor: '#402B30', color: '#F5BAB8' },
  approvalNotice: { color: c.quiet, fontSize: 12, lineHeight: 18, marginTop: 22, marginBottom: 15 },
  resultTitle: { fontSize: 31, lineHeight: 36, fontWeight: '900', letterSpacing: -1, marginTop: 22, marginBottom: 14 },
  validation: { borderTopWidth: 1, borderColor: c.line, marginTop: 22, paddingTop: 16, marginBottom: 20 },
  validationCommand: { color: c.signal, fontFamily: 'monospace', fontSize: 11, marginTop: 10 },
  validationOutput: { color: c.quiet, fontFamily: 'monospace', fontSize: 10, lineHeight: 16, marginTop: 9 },
  ghostAction: { alignItems: 'center', justifyContent: 'center', minHeight: 52, borderWidth: 1, borderColor: c.line, borderRadius: 12 },
  ghostActionText: { color: c.quiet, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  bottomSpace: { height: 35 },
  tabBar: { backgroundColor: '#102B31', borderTopWidth: 1, borderColor: '#355157', flexDirection: 'row', paddingBottom: Platform.OS === 'android' ? 56 : Platform.OS === 'ios' ? 24 : 10 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 63 },
  tabIcon: { color: '#A6B8B5', fontSize: 22, marginBottom: 3 },
  tabLabel: { color: '#A6B8B5', fontWeight: '800', fontSize: 9, letterSpacing: 1.1 },
  activeTab: { color: c.lime },
});
