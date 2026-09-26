import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AgentState, PairResult, Session, normalizeAgentAddress, request } from './api';
import { palette as c } from './theme';

const URL_KEY = 'pocketpilot.citybattle.agent-url';
const TOKEN_KEY = 'pocketpilot.citybattle.token';
type Tab = 'home' | 'debug';

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

function BrandHeader({ connected, onDisconnect }: { connected: boolean; onDisconnect?: () => void }) {
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
        accessibilityRole={connected ? 'button' : 'text'}
        accessibilityLabel={connected ? 'Disconnect laptop' : 'Not connected'}
        onPress={connected ? onDisconnect : undefined}
        style={styles.connectionPill}
      >
        <View style={[styles.connectionDot, { backgroundColor: connected ? c.lime : c.dim }]} />
        <Text style={styles.connectionText}>{connected ? 'LINKED' : 'OFFLINE'}</Text>
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
  return (
    <View style={styles.pipeline}>
      <Eyebrow index="01">SESSION PIPELINE</Eyebrow>
      {steps.map((name, index) => <View key={name} style={styles.pipelineStep}>
        <Text style={[styles.stepIcon, index < done ? { color: c.lime } : index === done ? { color: c.amber } : { color: c.dim }]}>{index < done ? '✓' : index === done ? '●' : '○'}</Text>
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
  const confidenceColor = a.confidence === 'high' ? c.lime : a.confidence === 'medium' ? c.amber : c.coral;
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

function ResultPanel({ session, onUndo, onNew, busy }: { session: Session; onUndo: () => void; onNew: () => void; busy: boolean }) {
  const verified = session.stage === 'verified';
  const undone = session.stage === 'undone';
  const patchApplied = verified || (session.stage === 'failed' && session.validation !== null);
  const patchNotGenerated = session.stage === 'failed' && !session.validation;
  return <Panel accent={verified}>
    <Eyebrow index={verified ? '✓' : undone ? '↶' : '!'}>{verified ? 'MISSION COMPLETE' : undone ? 'CHANGE REVERSED' : 'NEEDS ATTENTION'}</Eyebrow>
    <Text style={[styles.resultTitle, { color: verified ? c.lime : undone ? c.ink : c.coral }]}>{verified ? 'Fix verified.' : undone ? 'Fix undone.' : patchNotGenerated ? 'Patch not generated.' : 'Verification failed.'}</Text>
    <Text style={styles.body}>{verified ? 'The approved change passed the selected project check.' : undone ? 'The project files were restored to their pre-fix state.' : session.error_message || 'The change could not be verified. Review the test output before continuing.'}</Text>
    {session.validation && <View style={styles.validation}><View style={styles.splitRow}><Label>CHECK RUN</Label><Text style={{ color: session.validation.passed ? c.lime : c.coral }}>{session.validation.passed ? 'PASSED' : 'FAILED'}</Text></View><Text style={styles.validationCommand}>{session.validation.command}</Text><Text style={styles.validationOutput} numberOfLines={12}>{session.validation.output}</Text></View>}
    {patchApplied && <><Button onPress={onUndo} disabled={busy} tone={verified ? 'secondary' : 'danger'} icon="↶">UNDO FIX</Button><View style={styles.buttonGap} /></>}
    <Button onPress={onNew} disabled={busy || patchApplied} tone={verified ? 'secondary' : 'primary'}>START A NEW SESSION</Button>
    {patchApplied && <Text style={styles.fieldHint}>Undo the applied patch before starting another session.</Text>}
  </Panel>;
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
  const [composeNew, setComposeNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const polling = useRef(false);

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
      setNetworkError(message);
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
    await clearPairing();
    setToken(null); setAgentUrl(null); setState(null); setConnected(false); setTab('home'); setNotice(null); setNetworkError(null);
  }

  async function action(path: string, body: object, timeoutMs = 20000) {
    if (!agentUrl || !token) return;
    setBusy(true); setNotice(null);
    try {
      const session = await request<Session>(agentUrl, path, token, body, timeoutMs);
      setState(current => current ? { ...current, session } : { workspace: null, provider: null, session });
      setTab('debug'); setComposeNew(false);
      void refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The action did not complete.'); }
    finally { setBusy(false); }
  }

  function startAnalysis() {
    const value = errorText.trim();
    if (value.length < 12) { setNotice('Paste the error and a few stack-trace lines before analyzing.'); return; }
    void action('/api/sessions', { error_text: value, source: 'text' });
  }

  const session = state?.session;
  const showComposer = composeNew || !session;
  const showResult = session && ['verified', 'failed', 'undone'].includes(session.stage);
  const visibleNotice = networkError || notice;

  return <View style={styles.screen}>
    <StatusBar style="light" />
    <BrandHeader connected={Boolean(token && connected)} onDisconnect={() => { void disconnect(); }} />
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {visibleNotice && <View style={styles.notice}><Text style={styles.noticeHeading}>CONNECTION OR REQUEST ISSUE</Text><Text style={styles.noticeBody}>{visibleNotice}</Text>{token && <Pressable accessibilityRole="button" onPress={() => { setNotice(null); void refresh(); }}><Text style={styles.noticeRetry}>TRY AGAIN  ↗</Text></Pressable>}</View>}
        {!token ? <>
          <Eyebrow index="00">THE PHONE IS YOUR CONTROL SURFACE</Eyebrow>
          <Text style={styles.heroTitle}>Your next fix starts here<Text style={{ color: c.lime }}>.</Text></Text>
          <Text style={styles.heroBody}>Connect this iQOO to your laptop agent. See the evidence, approve the change, and verify the result from your hand.</Text>
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
          <Text style={styles.heroTitle}>The desk, in your hand<Text style={{ color: c.lime }}>.</Text></Text>
          <Text style={styles.heroBody}>Your phone directs the fix. Your laptop keeps the code and local model.</Text>
          <Panel accent>
            <Eyebrow index="↗">YOUR WORKSPACE</Eyebrow>
            <Text style={styles.workspaceName}>{state?.workspace?.path || 'No project selected'}</Text>
            <View style={styles.metricRow}><Metric value={state?.workspace?.ready ? 'READY' : 'WAITING'} label="PROJECT" /><Metric value={state?.provider?.ready ? 'LOCAL' : 'OFFLINE'} label="AI MODEL" /></View>
            <Text style={styles.fieldHint}>{state?.workspace?.ready ? 'The desktop agent has a project selected and can inspect its source safely.' : 'Select a project in the laptop dashboard before analyzing an error.'}</Text>
            <Button onPress={() => setTab('debug')} icon="↗">{session ? 'OPEN LIVE SESSION' : 'START DEBUGGING'}</Button>
          </Panel>
          <View style={styles.sectionTop}><Eyebrow index="HOW / 02">ONE CONTROLLED LOOP</Eyebrow></View>
          <View style={styles.howRow}><Text style={styles.howNumber}>01</Text><View><Text style={styles.howTitle}>Capture the failure</Text><Text style={styles.howBody}>Paste the error on your phone.</Text></View></View>
          <View style={styles.howRow}><Text style={styles.howNumber}>02</Text><View><Text style={styles.howTitle}>Inspect the evidence</Text><Text style={styles.howBody}>Local AI explains the likely source.</Text></View></View>
          <View style={styles.howRow}><Text style={styles.howNumber}>03</Text><View><Text style={styles.howTitle}>Approve, test, undo</Text><Text style={styles.howBody}>You stay in control of every write.</Text></View></View>
        </> : <>
          <Eyebrow index="LIVE / 02">VISION DEBUGGER</Eyebrow>
          <Text style={styles.pageTitle}>{showComposer ? 'Show us the failure.' : session?.stage === 'verified' ? 'A fix, proven.' : session?.stage === 'undone' ? 'Back to the baseline.' : 'Follow the signal.'}</Text>
          <Text style={styles.pageSubtitle}>{showComposer ? 'Paste a stack trace or failing test output below.' : 'One bounded session. Every decision visible.'}</Text>
          {showComposer ? <Panel>
            <Eyebrow index="01">ERROR INPUT</Eyebrow>
            <TextInput accessibilityLabel="Error text" placeholder="Paste the error, stack trace, and failing test output…" placeholderTextColor={c.dim} value={errorText} onChangeText={setErrorText} multiline textAlignVertical="top" style={styles.errorInput} />
            <Text style={styles.fieldHint}>Tip: include the source file path and line number for stronger location evidence.</Text>
            <Button onPress={startAnalysis} disabled={busy || !state?.workspace?.ready} icon="⌁">{busy ? 'SENDING…' : 'ANALYZE ERROR'}</Button>
            {!state?.workspace?.ready && <Text style={styles.cautionText}>Choose a workspace in the desktop dashboard first.</Text>}
          </Panel> : session ? <>
            {workingStages.has(session.stage) && <ProcessingPanel key={session.stage} stage={session.stage} />}
            <Pipeline stage={session.stage} />
            <AnalysisPanel session={session} />
            {session.stage === 'root_cause_found' && <Panel><Eyebrow index="03">NEXT DECISION</Eyebrow><Text style={styles.proposalTitle}>Ready to design a fix?</Text><Text style={styles.body}>The laptop will propose a bounded diff. You can review it before any file changes.</Text><View style={styles.sectionTop}><Button onPress={() => { void action(`/api/sessions/${session.id}/proposal`, {}); }} disabled={busy || !session.analysis?.location} icon="↗">GENERATE FIX</Button></View>{!session.analysis?.location && <Text style={styles.cautionText}>A safe repository location was not established, so a patch cannot be generated.</Text>}</Panel>}
            {session.stage === 'awaiting_approval' && <ProposalPanel session={session} busy={busy} onApprove={() => { if (session.proposal) void action(`/api/sessions/${session.id}/approve`, { proposal_id: session.proposal.id, revision: session.revision }, 300000); }} onReject={() => setComposeNew(true)} />}
            {showResult && <ResultPanel session={session} busy={busy} onUndo={() => { void action(`/api/sessions/${session.id}/undo`, { revision: session.revision }); }} onNew={() => { setComposeNew(true); setErrorText(''); }} />}
            {session.stage === 'analysis_failed' && <Panel><Eyebrow index="!">ANALYSIS STOPPED</Eyebrow><Text style={styles.resultTitle}>No trusted location yet.</Text><Text style={styles.body}>{session.error_message || 'The error did not resolve to a safe source file. Review the text and try again.'}</Text><View style={styles.sectionTop}><Button onPress={() => { setErrorText(session.error_text); setComposeNew(true); }}>REVIEW ERROR TEXT</Button></View></Panel>}
            {!workingStages.has(session.stage) && !showResult && <Pressable accessibilityRole="button" onPress={() => { setErrorText(session.error_text); setComposeNew(true); }} style={styles.ghostAction}><Text style={styles.ghostActionText}>REVIEW / START ANOTHER ERROR  ↗</Text></Pressable>}
          </> : null}
        </>}
        <View style={styles.bottomSpace} />
      </ScrollView>
    </KeyboardAvoidingView>
    {token && <View style={styles.tabBar}>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'home' }} onPress={() => setTab('home')} style={styles.tab}><Text style={[styles.tabIcon, tab === 'home' && styles.activeTab]}>⌂</Text><Text style={[styles.tabLabel, tab === 'home' && styles.activeTab]}>HOME</Text></Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'debug' }} onPress={() => setTab('debug')} style={styles.tab}><Text style={[styles.tabIcon, tab === 'debug' && styles.activeTab]}>⌘</Text><Text style={[styles.tabLabel, tab === 'debug' && styles.activeTab]}>DEBUG</Text></Pressable>
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: c.canvas, paddingTop: Platform.OS === 'android' ? NativeStatusBar.currentHeight || 24 : 0 },
  header: { minHeight: 92, borderBottomWidth: 1, borderColor: c.line, paddingHorizontal: 20, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  brandWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  brandMark: { width: 42, height: 42, borderRadius: 12, backgroundColor: c.lime, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: c.canvas, fontSize: 22, fontWeight: '900', letterSpacing: -2 },
  brandName: { color: c.ink, fontSize: 14, fontWeight: '900', letterSpacing: 2 },
  brandSubtitle: { color: c.dim, fontSize: 8, fontWeight: '700', letterSpacing: 1.6, marginTop: 2 },
  connectionPill: { minHeight: 44, borderWidth: 1, borderColor: c.line, borderRadius: 25, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10 },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
  connectionText: { color: c.quiet, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  content: { paddingHorizontal: 20, paddingTop: 28, width: '100%', maxWidth: 700, alignSelf: 'center' },
  label: { fontSize: 10, fontWeight: '800', letterSpacing: 2.1 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  eyebrowIndex: { color: c.lime, fontSize: 10, fontWeight: '800', letterSpacing: 1, fontFamily: 'monospace' },
  heroTitle: { color: c.ink, fontSize: 42, lineHeight: 46, letterSpacing: -2.2, fontWeight: '800', marginTop: 18, maxWidth: 440 },
  heroBody: { color: c.quiet, fontSize: 15, lineHeight: 24, marginTop: 15, maxWidth: 460, marginBottom: 30 },
  pageTitle: { color: c.ink, fontSize: 36, lineHeight: 41, letterSpacing: -1.5, fontWeight: '800', marginTop: 14 },
  pageSubtitle: { color: c.quiet, fontSize: 14, lineHeight: 22, marginTop: 9, marginBottom: 24 },
  panel: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, borderRadius: 24, padding: 20, marginBottom: 18 },
  panelAccent: { backgroundColor: '#111A10', borderColor: '#4D6530' },
  fieldLabel: { color: c.quiet, fontSize: 10, fontWeight: '800', letterSpacing: 1.7, marginTop: 25, marginBottom: 10 },
  input: { minHeight: 56, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.canvas, color: c.ink, paddingHorizontal: 16, fontSize: 17 },
  fieldHint: { color: c.dim, fontSize: 12, lineHeight: 18, marginTop: 10, marginBottom: 14 },
  button: { minHeight: 54, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonPrimary: { backgroundColor: c.lime },
  buttonSecondary: { backgroundColor: c.raisedAlt, borderWidth: 1, borderColor: '#49564B' },
  buttonDanger: { backgroundColor: c.raisedAlt, borderWidth: 1, borderColor: c.coral },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: c.ink, fontSize: 12, letterSpacing: 1.2, fontWeight: '900' },
  buttonTextPrimary: { color: c.canvas },
  buttonGap: { height: 10 },
  privacyLine: { flexDirection: 'row', gap: 9, alignItems: 'center', marginTop: 10 },
  privacyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.teal },
  privacyText: { color: c.dim, fontSize: 9, letterSpacing: 1.1, fontWeight: '700' },
  notice: { backgroundColor: '#2A1714', borderColor: '#754338', borderWidth: 1, borderRadius: 18, padding: 18, marginBottom: 20 },
  noticeHeading: { color: c.coral, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  noticeBody: { color: c.ink, lineHeight: 21, marginTop: 10 },
  noticeRetry: { color: c.amber, fontWeight: '800', letterSpacing: 1.2, fontSize: 11, marginTop: 16 },
  workspaceName: { color: c.ink, fontSize: 20, lineHeight: 27, fontWeight: '700', marginTop: 21, marginBottom: 18 },
  metricRow: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.line, paddingVertical: 19, flexDirection: 'row', gap: 25, marginTop: 18, marginBottom: 18 },
  metric: { flex: 1, gap: 5 },
  metricValue: { color: c.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  sectionTop: { marginTop: 24, marginBottom: 14 },
  howRow: { flexDirection: 'row', gap: 20, borderBottomWidth: 1, borderColor: c.line, paddingVertical: 17 },
  howNumber: { color: c.lime, fontFamily: 'monospace', fontWeight: '700', fontSize: 13 },
  howTitle: { color: c.ink, fontSize: 16, fontWeight: '700' },
  howBody: { color: c.dim, fontSize: 12, marginTop: 5 },
  errorInput: { minHeight: 220, backgroundColor: c.canvas, color: c.ink, borderColor: c.line, borderWidth: 1, borderRadius: 14, padding: 15, fontFamily: 'monospace', fontSize: 13, lineHeight: 21, marginTop: 18 },
  processingMain: { flexDirection: 'row', gap: 17, alignItems: 'center', marginTop: 22 },
  orbitBox: { width: 91, height: 91, alignItems: 'center', justifyContent: 'center' },
  orbitInner: { width: 68, height: 68, borderRadius: 34, borderWidth: 7, borderColor: c.lime, alignItems: 'center', justifyContent: 'center' },
  orbitCenter: { color: c.lime, fontSize: 18 },
  orbitTrack: { position: 'absolute', width: 91, height: 91, borderRadius: 46, borderWidth: 1, borderColor: '#718A39', alignItems: 'center' },
  orbitSatellite: { width: 13, height: 13, borderRadius: 7, backgroundColor: c.amber, marginTop: -7 },
  processingCopy: { flex: 1 },
  processingTitle: { color: c.ink, fontSize: 20, lineHeight: 25, fontWeight: '800', letterSpacing: -0.5, marginBottom: 8 },
  body: { color: c.quiet, fontSize: 14, lineHeight: 22 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 24 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.lime },
  liveText: { color: c.quiet, fontSize: 11 },
  processDisclosure: { minHeight: 44, borderTopWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  processDisclosureText: { color: c.lime, fontWeight: '800', fontSize: 10, letterSpacing: 1.3 },
  processDetail: { color: c.quiet, fontSize: 12, lineHeight: 19, marginBottom: 6 },
  pipeline: { borderColor: c.line, borderWidth: 1, borderRadius: 24, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 7, backgroundColor: c.raised, marginBottom: 18 },
  pipelineStep: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 17, borderBottomWidth: 1, borderColor: c.line },
  stepIcon: { fontSize: 18, width: 22 },
  stepText: { color: c.ink, fontSize: 14 },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  tag: { borderRadius: 8, borderWidth: 1, borderColor: '#5D5435', paddingHorizontal: 8, paddingVertical: 6 },
  tagText: { color: c.amber, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  analysisTitle: { color: c.ink, fontSize: 21, lineHeight: 27, fontWeight: '800', marginTop: 25 },
  pathText: { color: c.lime, fontFamily: 'monospace', fontSize: 15, marginTop: 12, lineHeight: 22 },
  detail: { paddingTop: 17, borderTopWidth: 1, borderColor: c.line, marginTop: 19 },
  detailBody: { color: c.quiet, fontSize: 13, lineHeight: 21, marginTop: 10 },
  cautionText: { color: c.amber, fontSize: 12, lineHeight: 19, marginTop: 14 },
  proposalTitle: { color: c.ink, fontSize: 24, lineHeight: 30, fontWeight: '800', letterSpacing: -0.7, marginTop: 19, marginBottom: 12 },
  fileWrap: { marginTop: 16 },
  fileName: { color: c.lime, fontFamily: 'monospace', fontSize: 12, marginBottom: 10 },
  diffBox: { borderWidth: 1, borderRadius: 12, borderColor: c.line, backgroundColor: '#070C09', overflow: 'hidden' },
  diffContent: { paddingVertical: 12, minWidth: '100%' },
  diffLine: { color: c.quiet, fontFamily: 'monospace', fontSize: 11, lineHeight: 19, paddingHorizontal: 14 },
  diffAdded: { backgroundColor: '#19331E', color: '#B9E8AD' },
  diffRemoved: { backgroundColor: '#3A201E', color: '#F0B1A9' },
  approvalNotice: { color: c.quiet, fontSize: 12, lineHeight: 18, marginTop: 22, marginBottom: 15 },
  resultTitle: { fontSize: 31, lineHeight: 36, fontWeight: '900', letterSpacing: -1, marginTop: 22, marginBottom: 14 },
  validation: { borderTopWidth: 1, borderColor: c.line, marginTop: 22, paddingTop: 16, marginBottom: 20 },
  validationCommand: { color: c.lime, fontFamily: 'monospace', fontSize: 11, marginTop: 10 },
  validationOutput: { color: c.quiet, fontFamily: 'monospace', fontSize: 10, lineHeight: 16, marginTop: 9 },
  ghostAction: { alignItems: 'center', justifyContent: 'center', minHeight: 52, borderWidth: 1, borderColor: c.line, borderRadius: 12 },
  ghostActionText: { color: c.quiet, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  bottomSpace: { height: 35 },
  tabBar: { backgroundColor: '#0B110C', borderTopWidth: 1, borderColor: c.line, flexDirection: 'row', paddingBottom: Platform.OS === 'ios' ? 24 : 10 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 63 },
  tabIcon: { color: c.dim, fontSize: 22, marginBottom: 3 },
  tabLabel: { color: c.dim, fontWeight: '800', fontSize: 9, letterSpacing: 1.2 },
  activeTab: { color: c.lime },
});
