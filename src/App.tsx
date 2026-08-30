import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Ellipsis,
  History,
  LoaderCircle,
  MessageCircle,
  MessageCirclePlus,
  Mic,
  MicOff,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Video,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  askQuestion,
  getGuide,
  getPublicConfig,
  logMiss,
  openScanEvents,
  startScan,
  type GuideJson,
  type ScanEvent,
} from "./lib/api";

type CameraStatus = "starting" | "live" | "fallback";
type View = "home" | "processing" | "guide" | "error";

type CapturedPhoto = {
  name: string;
  url: string;
  file: File;
  objectUrl?: boolean;
};

type TraceStep = {
  id: string;
  label: string;
  status: "waiting" | "active" | "done";
  detail?: string;
};

type ProductMatch = Extract<ScanEvent, { type: "product_match" }>;
type PublicConfig = { stripePaymentLinkUrl: string | null; guidePriceSek: number };

const SUGGESTIONS = ["Scan package label", "Identify loose parts", "Create assembly guide"];

function freshTrace(): TraceStep[] {
  return [];
}

function paymentHref(paymentLink: string | null, scanId: string | null): string | null {
  if (!paymentLink) return null;
  try {
    const url = new URL(paymentLink);
    if (scanId) url.searchParams.set("client_reference_id", `scan:${scanId}`);
    return url.toString();
  } catch {
    return null;
  }
}

function PaymentButton({ paymentLink, scanId, price, className = "payment-button" }: {
  paymentLink: string | null;
  scanId: string | null;
  price: number;
  className?: string;
}) {
  const href = paymentHref(paymentLink, scanId);
  return href
    ? <a className={className} href={href}>Betala {price} kr</a>
    : <button className={className} type="button" disabled title="Stripe Payment Link saknas">Betala {price} kr</button>;
}

function PromptBar({
  draft,
  photo,
  busy,
  onDraftChange,
  onPhotoClick,
  onRemovePhoto,
  onSubmit,
  inputRef,
}: {
  draft: string;
  photo: CapturedPhoto | null;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onPhotoClick: () => void;
  onRemovePhoto: () => void;
  onSubmit: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (photo) onSubmit();
    else onPhotoClick();
  };

  return (
    <form className={`prompt-bar ${photo ? "has-photo" : ""}`} onSubmit={submit}>
      {photo && (
        <div className="prompt-photo">
          <button type="button" className="prompt-photo__preview" aria-label="Retake photo" onClick={onPhotoClick}>
            <img src={photo.url} alt="Product attachment" />
          </button>
          <button type="button" className="prompt-photo__remove" aria-label="Remove photo" onClick={onRemovePhoto}>
            <X size={12} strokeWidth={2.6} />
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        value={draft}
        aria-label="Add a note about the product"
        placeholder={photo ? "Add product name if you know it" : "Ask anything"}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <button className="prompt-camera-button" type="submit" disabled={busy} aria-label={photo ? "Identify product" : "Take photo"}>
        {busy ? <LoaderCircle className="spin" size={21} /> : photo ? <ArrowUp size={22} strokeWidth={2.7} /> : <Camera size={22} strokeWidth={2.7} />}
      </button>
    </form>
  );
}

function BottomTabs() {
  return (
    <nav className="bottom-tabs" aria-label="Primary">
      <span className="is-active" aria-current="page" aria-label="Chat"><MessageCircle size={27} fill="currentColor" /></span>
      <span aria-label="Video"><Video size={27} /></span>
      <span aria-label="Search"><Search size={28} /></span>
      <span aria-label="Profile"><CircleUserRound size={28} /></span>
    </nav>
  );
}

function CameraCard({ open, closing, onClose, onCapture, overlay, canRetake = false, onRetake }: {
  open: boolean;
  closing: boolean;
  onClose: () => void;
  onCapture: (photo: CapturedPhoto) => void;
  overlay?: ReactNode;
  canRetake?: boolean;
  onRetake?: () => void;
}) {
  const [status, setStatus] = useState<CameraStatus>("starting");
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureLockRef = useRef(false);
  const requestRef = useRef(0);

  const stopCamera = useCallback(() => {
    requestRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!open) {
      stopCamera();
      return;
    }
    let active = true;
    const request = requestRef.current + 1;
    requestRef.current = request;
    captureLockRef.current = false;
    setFrozenFrame(null);
    setFlash(false);
    setMoreOpen(false);
    setStatus("starting");
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("fallback");
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1440 }, height: { ideal: 1920 } },
    }).then(async (stream) => {
      if (!active || requestRef.current !== request) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
        if (videoRef.current.videoWidth) setStatus("live");
      }
    }).catch(() => {
      if (active && requestRef.current === request) setStatus("fallback");
    });
    return () => {
      active = false;
      stopCamera();
    };
  }, [open, stopCamera]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, open]);

  const commitPhoto = (photo: CapturedPhoto) => {
    if (captureLockRef.current) return;
    captureLockRef.current = true;
    setFrozenFrame(photo.url);
    setFlash(true);
    stopCamera();
    window.setTimeout(() => setFlash(false), 130);
    onCapture(photo);
  };

  const takePhoto = () => {
    const video = videoRef.current;
    const card = cardRef.current;
    if (status !== "live" || !video?.videoWidth || !card) {
      uploadRef.current?.click();
      return;
    }
    if (captureLockRef.current) return;
    const frameRatio = card.clientWidth / card.clientHeight;
    const sourceRatio = video.videoWidth / video.videoHeight;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;
    if (sourceRatio > frameRatio) {
      sourceWidth = video.videoHeight * frameRatio;
      sourceX = (video.videoWidth - sourceWidth) / 2;
    } else if (sourceRatio < frameRatio) {
      sourceHeight = video.videoWidth / frameRatio;
      sourceY = (video.videoHeight - sourceHeight) / 2;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth));
    canvas.height = Math.max(1, Math.round(sourceHeight));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.9);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const name = `monterra-photo-${Date.now()}.jpg`;
      commitPhoto({ name, url, file: new File([blob], name, { type: "image/jpeg" }) });
    }, "image/jpeg", 0.9);
  };

  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || captureLockRef.current) return;
    const url = URL.createObjectURL(file);
    commitPhoto({ name: file.name, url, file, objectUrl: true });
  };

  if (!open) return null;
  return (
    <section className={`camera-layer ${closing ? "is-closing" : ""}`} aria-label="Photo camera">
      <div className="camera-deck">
        <div ref={cardRef} className={`camera-card is-${status} ${frozenFrame ? "has-capture" : ""}`}>
          <div className="camera-scene" aria-hidden="true" />
          {!frozenFrame && <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" onLoadedMetadata={() => setStatus("live")} />}
          {frozenFrame && <img className="frozen-frame" src={frozenFrame} alt="Captured product" />}
          <span className="camera-vignette" aria-hidden="true" />
          {!overlay && <div className="camera-hint"><strong>Fill the frame with the label</strong><span>Keep the 8-digit article number sharp</span><span>Fota. Lyssna. Bygg. · 49 kr</span></div>}
          {!overlay && <button className="camera-control camera-control--back" type="button" aria-label="Close camera" onClick={onClose}><ChevronLeft size={24} strokeWidth={2.7} /></button>}
          {!overlay && <button className="camera-shutter" type="button" aria-label={status === "live" ? "Take photo" : "Choose a photo"} onClick={takePhoto}><span /></button>}
          {!overlay && <button className="camera-control camera-control--more" type="button" aria-label="More photo options" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}><Ellipsis size={25} strokeWidth={3} /></button>}
          {moreOpen && !overlay && <div className="camera-more-menu suggestion-list"><button type="button" onClick={() => uploadRef.current?.click()}>Scan package label</button><button type="button" onClick={() => uploadRef.current?.click()}>Identify loose parts</button><button type="button" onClick={() => uploadRef.current?.click()}>Create assembly guide</button></div>}
          {overlay}
          {overlay && canRetake && <button className="camera-cancel" type="button" aria-label="Retake photo" onClick={onRetake}><X size={16} strokeWidth={2.6} /></button>}
          <span className={`camera-flash ${flash ? "is-visible" : ""}`} aria-hidden="true" />
          <span className="sr-only" aria-live="polite">{frozenFrame ? "Photo added." : status === "live" ? "Camera ready." : status === "fallback" ? "Camera unavailable. Choose a photo from your device." : "Starting camera."}</span>
          <input ref={uploadRef} className="sr-only" tabIndex={-1} type="file" accept="image/*" capture="environment" onChange={choosePhoto} />
        </div>
      </div>
    </section>
  );
}

function ThinkingState({ trace, match, renderProgress, elapsedMs, error, recoveryName, onRecoveryNameChange, onRetry, onRetake, paymentLink, price, scanId }: {
  trace: TraceStep[];
  match: ProductMatch | null;
  renderProgress: { done: number; total: number; label: string } | null;
  elapsedMs: number | null;
  error: string;
  recoveryName: string;
  onRecoveryNameChange: (value: string) => void;
  onRetry: () => void;
  onRetake: () => void;
  paymentLink: string | null;
  price: number;
  scanId: string | null;
}) {
  return (
    <section className="thinking-state" aria-live="polite">
      <div className="thinking-state__content">
      {elapsedMs !== null && !error ? <div className="thinking-summary"><Check size={18} strokeWidth={3} /><strong>Hittade din möbel på {(elapsedMs / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s</strong></div> : <span className="thinking-kicker">Fota. Lyssna. Bygg.</span>}
      <ol className="trace-list">
        {trace.map((step, index) => (
          <li key={`${step.label}-${index}`} className={`is-${step.status}`}>
            <span className="trace-marker">{step.status === "done" ? <Check size={14} strokeWidth={3} /> : step.status === "active" ? <LoaderCircle className="spin" size={16} /> : index + 1}</span>
            <div><strong>{step.label}</strong>{step.detail && <small>{step.detail}</small>}{step.label === "Bygger din guide…" && step.status === "active" && renderProgress && <div className="render-meter"><span style={{ width: `${Math.max(4, Math.round((renderProgress.done / Math.max(1, renderProgress.total)) * 100))}%` }} /><small>{renderProgress.label}</small></div>}</div>
          </li>
        ))}
      </ol>
      {error && <form className="miss-recovery" onSubmit={(event) => { event.preventDefault(); onRetry(); }}><strong>Hittade inte den här — din guide är klar inom en timme</strong><small>{error}</small><input aria-label="Product name" placeholder="Add product name if you know it" value={recoveryName} onChange={(event) => onRecoveryNameChange(event.target.value)} /><PaymentButton paymentLink={paymentLink} scanId={scanId} price={price} /><button type="submit">Försök igen</button><button type="button" onClick={onRetake}>Ta en ny bild</button></form>}
      {match && !error && <span className="thinking-match">{match.name}{match.itemNumber ? ` · art.nr ${match.itemNumber}` : ""}</span>}
      </div>
    </section>
  );
}

type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function GuideView({ guide, onReset, paymentLink, price, scanId }: { guide: GuideJson; onReset: () => void; paymentLink: string | null; price: number; scanId: string | null }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const paid = new URLSearchParams(window.location.search).get("payment") === "success";
  const audioRef = useRef<HTMLAudioElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const step = guide.steps[stepIndex];

  const seekToStep = useCallback((nextIndex: number) => {
    const safe = Math.max(0, Math.min(guide.steps.length - 1, nextIndex));
    setStepIndex(safe);
  }, [guide.steps]);

  const repeatStep = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  }, []);

  const nextStep = useCallback(() => {
    if (stepIndex === 1 && !paid) {
      audioRef.current?.pause();
      setPaywallOpen(true);
      return;
    }
    seekToStep(stepIndex + 1);
  }, [paid, seekToStep, stepIndex]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !step?.audioUrl) return;
    audio.load();
    void audio.play().catch(() => undefined);
  }, [step?.audioUrl]);

  useEffect(() => {
    if (!voiceEnabled) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      return;
    }
    const SpeechRecognition = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionInstance; webkitSpeechRecognition?: new () => SpeechRecognitionInstance }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionInstance }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceSupported(false);
      setVoiceEnabled(false);
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "sv-SE";
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const transcript = result?.[0]?.transcript?.toLocaleLowerCase("sv") ?? "";
      if (/nästa|vidare|next/.test(transcript)) seekToStep(stepIndex + 1);
      if (/backa|bakåt|föregående|previous|back/.test(transcript)) seekToStep(stepIndex - 1);
      if (/repetera|igen|repeat/.test(transcript)) repeatStep();
      if (/paus|stopp|pause/.test(transcript)) audioRef.current?.pause();
      if (/spela|fortsätt|play/.test(transcript)) void audioRef.current?.play().catch(() => undefined);
    };
    recognition.onend = () => { if (recognitionRef.current === recognition) recognition.start(); };
    recognition.onerror = () => undefined;
    recognitionRef.current = recognition;
    recognition.start();
    return () => { recognitionRef.current = null; recognition.stop(); };
  }, [repeatStep, seekToStep, stepIndex, voiceEnabled]);

  const submitQuestion = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || asking) return;
    setAsking(true);
    setAnswer("");
    try { setAnswer((await askQuestion(guide.guideId, question.trim())).answer); }
    catch { setAnswer("I couldn't answer that right now. Try again in a moment."); }
    finally { setAsking(false); }
  };

  return (
    <section className="flow-view guide-view">
      <div className="guide-topbar"><button type="button" aria-label="Ny skanning" onClick={onReset}><ArrowLeft size={21} /></button><span>Monteringsguide</span><button type="button" aria-label={voiceEnabled ? "Stäng av röststyrning" : "Slå på röststyrning"} className={voiceEnabled ? "is-listening" : ""} onClick={() => setVoiceEnabled((value) => !value)}>{voiceEnabled ? <Mic size={20} /> : <MicOff size={20} />}</button></div>
      {guide.videoUrl && (
        <div className="guide-full-video">
          <video controls playsInline poster={guide.thumbnailUrl ?? undefined} src={guide.videoUrl}>
            Din webbläsare kan inte spela upp video.
          </video>
        </div>
      )}
      <div className="guide-video-shell">
        {step?.imageUrl ? <img className={`guide-step-image focus-${step.focusRegion}`} src={step.imageUrl} alt={`Manual page for step ${step.stepNumber}: ${step.title}`} /> : guide.thumbnailUrl ? <img className="guide-step-image" src={guide.thumbnailUrl} alt="Assembly guide" /> : <div className="video-missing">Manualbild saknas</div>}
        <audio ref={audioRef} src={step?.audioUrl ?? undefined} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
        <button className="video-play" type="button" aria-label={playing ? "Pausa" : "Spela"} onClick={() => playing ? audioRef.current?.pause() : repeatStep()}>{playing ? <Pause size={22} fill="currentColor" /> : <Play size={24} fill="currentColor" />}</button><span className="video-duration">{step?.estimatedSeconds ?? 0} s</span>
      </div>
      <div className="guide-title"><span className="eyebrow">{guide.productName}</span><h2>{guide.title}</h2><p>{guide.summary}</p></div>
      {paywallOpen ? <article className="step-card paywall-card"><span className="eyebrow">Fortsätt bygga</span><h3>Hela guiden · {price} kr</h3><p>Du har sett de två första stegen. Lås upp resten av den röstguidade monteringen.</p><PaymentButton paymentLink={paymentLink} scanId={scanId} price={price} className="primary-action" /><button className="secondary-action" type="button" onClick={() => setPaywallOpen(false)}>Tillbaka till steg 2</button></article> : step && <article className="step-card"><div className="step-progress"><span>Steg {step.stepNumber} av {guide.steps.length}</span><span>{step.estimatedSeconds}s</span></div><h3>{step.title}</h3>{step.safetyWarning && <div className="step-warning"><AlertTriangle size={18} /> {step.safetyWarning}</div>}<p>{step.instruction}</p>{(step.parts.length > 0 || step.tools.length > 0) && <div className="step-meta">{step.parts.length > 0 && <span><strong>Delar</strong>{step.parts.join(", ")}</span>}{step.tools.length > 0 && <span><strong>Verktyg</strong>{step.tools.join(", ")}</span>}</div>}<div className="step-controls"><button type="button" onClick={repeatStep}><RotateCcw size={18} /> Repetera</button><button type="button" disabled={stepIndex === guide.steps.length - 1} onClick={nextStep}>Nästa <ChevronRight size={21} /></button></div></article>}
      {guide.manualUrl && <a className="manual-source" href={guide.manualUrl} target="_blank" rel="noreferrer">Baserad på tillverkarens officiella manual</a>}
      <div className={`voice-status ${voiceEnabled ? "is-on" : ""}`}>{voiceEnabled ? <><span className="voice-dot" /> Lyssnar efter ”nästa”, ”repetera” och ”backa”</> : voiceSupported ? "Slå på röststyrning för att bygga med händerna fria" : "Röststyrning stöds inte i den här webbläsaren"}</div>
      <form className="question-box" onSubmit={submitQuestion}><label htmlFor="guide-question">Fråga om det här steget</label><div><input id="guide-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Vilken skruv ska jag använda?" /><button type="submit" disabled={!question.trim() || asking}>{asking ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={19} />}</button></div>{answer && <p className="guide-answer">{answer}</p>}</form>
    </section>
  );
}

export default function App() {
  const [cameraOpen, setCameraOpen] = useState(true);
  const [cameraClosing, setCameraClosing] = useState(false);
  const [view, setView] = useState<View>("home");
  const [draft, setDraft] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const [trace, setTrace] = useState<TraceStep[]>(freshTrace);
  const [match, setMatch] = useState<ProductMatch | null>(null);
  const [renderProgress, setRenderProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [guide, setGuide] = useState<GuideJson | null>(null);
  const [error, setError] = useState("");
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [retakeAllowed, setRetakeAllowed] = useState(false);
  const [cameraSession, setCameraSession] = useState(0);
  const [scanId, setScanId] = useState<string | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicConfig>({ stripePaymentLinkUrl: null, guidePriceSek: 49 });
  const closeTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeEventsRef = useRef<(() => void) | null>(null);
  const retakeTimerRef = useRef<number | null>(null);
  const scanTimeoutRef = useRef<number | null>(null);
  const scanStartedAtRef = useRef(0);
  const currentScanIdRef = useRef<string | null>(null);
  const missQueryRef = useRef("Foto utan angivet produktnamn");
  const missLoggedRef = useRef(false);
  const sharedGuideLoadedRef = useRef(false);

  const releasePhoto = useCallback((captured: CapturedPhoto | null) => { if (captured?.objectUrl) URL.revokeObjectURL(captured.url); }, []);
  const closeCamera = useCallback(() => {
    if (cameraClosing) return;
    setCameraClosing(true);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimerRef.current = window.setTimeout(() => { setCameraOpen(false); setCameraClosing(false); closeTimerRef.current = null; }, reduced ? 0 : 330);
  }, [cameraClosing]);
  const openCamera = useCallback(() => { if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; setCameraClosing(false); setCameraOpen(true); }, []);

  const clearScanTimers = useCallback(() => {
    if (retakeTimerRef.current) window.clearTimeout(retakeTimerRef.current);
    if (scanTimeoutRef.current) window.clearTimeout(scanTimeoutRef.current);
    retakeTimerRef.current = null;
    scanTimeoutRef.current = null;
  }, []);

  useEffect(() => () => { if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current); clearScanTimers(); closeEventsRef.current?.(); }, [clearScanTimers]);
  useEffect(() => {
    if (sharedGuideLoadedRef.current) return;
    sharedGuideLoadedRef.current = true;
    const guideId = new URLSearchParams(window.location.search).get("guide");
    if (!guideId) return;
    setCameraOpen(false);
    setView("processing");
    void getGuide(guideId).then((result) => { setGuide(result); setView("guide"); }).catch(() => { setError("This guide link is no longer available."); setView("error"); });
  }, []);
  useEffect(() => { void getPublicConfig().then(setPublicConfig).catch(() => undefined); }, []);

  const recordMiss = useCallback(() => {
    if (missLoggedRef.current) return;
    missLoggedRef.current = true;
    void logMiss(currentScanIdRef.current, missQueryRef.current).catch(() => undefined);
  }, []);

  // 15s of silence (no stage/product_match progress) means honestly stalled;
  // real backend progress re-arms the window instead of a single fixed
  // deadline from scan start, which fired well before a real (non-cached)
  // scan — routinely 1.5-3 minutes end to end — could ever finish.
  const armScanTimeout = useCallback(() => {
    if (scanTimeoutRef.current) window.clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = window.setTimeout(() => {
      closeEventsRef.current?.(); closeEventsRef.current = null; setRetakeAllowed(false); setTrace((current) => current.map((step) => ({ ...step, status: "done" }))); recordMiss(); setError("Bearbetningen tog längre än 15 sekunder."); setView("processing");
    }, 15_000);
  }, [recordMiss]);

  const reset = useCallback(() => {
    closeEventsRef.current?.(); closeEventsRef.current = null; clearScanTimers(); releasePhoto(photo); setPhoto(null); setDraft(""); setTrace(freshTrace()); setMatch(null); setRenderProgress(null); setGuide(null); setError(""); setElapsedMs(null); setRetakeAllowed(false); setScanId(null); currentScanIdRef.current = null; setView("home"); setCameraSession((value) => value + 1); window.history.replaceState({}, "", window.location.pathname); openCamera();
  }, [clearScanTimers, openCamera, photo, releasePhoto]);
  const removePhoto = () => { setPhoto((previous) => { releasePhoto(previous); return null; }); };

  const handleEvent = useCallback((event: ScanEvent) => {
    setRetakeAllowed(false);
    if (retakeTimerRef.current) window.clearTimeout(retakeTimerRef.current);
    retakeTimerRef.current = null;
    armScanTimeout();
    if (event.type === "stage") {
      const labels = ["Läser bilden…", "Söker i katalogen…", "Söker efter manualen…", "Bygger din guide…", "Skapar rösten…"] as const;
      const id = `stage-${event.index}`;
      setTrace((current) => {
        const previousDone = current.map((step) => step.status === "active" ? { ...step, status: "done" as const } : step);
        const existing = previousDone.findIndex((step) => step.id === id);
        const next: TraceStep = { id, label: labels[event.index], status: event.status === "done" ? "done" : "active", detail: event.detail };
        if (existing < 0) return [...previousDone, next];
        return previousDone.map((step, index) => index === existing ? { ...step, ...next, detail: event.detail ?? step.detail } : step);
      });
    }
    else if (event.type === "product_match") {
      if (scanTimeoutRef.current) window.clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
      setMatch(event);
      setTrace((current) => [...current.map((step) => step.status === "active" ? { ...step, status: "done" as const } : step), { id: "identified", label: event.name, detail: event.itemNumber ? `art.nr ${event.itemNumber}` : undefined, status: "active" }]);
    }
    else if (event.type === "render_progress") setRenderProgress(event);
    else if (event.type === "guide_ready") {
      clearScanTimers();
      setTrace((current) => [...current.map((step) => ({ ...step, status: "done" as const })), { id: "ready", label: "Din guide är klar", status: "done" }]);
      setElapsedMs(Math.max(0, performance.now() - scanStartedAtRef.current));
      void getGuide(event.guideId).then((result) => { setGuide(result); setCameraOpen(false); setView("guide"); }).catch(() => { setError("Guiden skapades men kunde inte öppnas. Försök igen."); setView("error"); setCameraOpen(false); });
    }
    else if (event.type === "error") { clearScanTimers(); setTrace((current) => current.map((step) => ({ ...step, status: "done" }))); recordMiss(); setError(event.message); setView("processing"); }
  }, [armScanTimeout, clearScanTimers, recordMiss]);

  const runScan = useCallback(async (captured: CapturedPhoto, note?: string) => {
    closeEventsRef.current?.();
    clearScanTimers();
    scanStartedAtRef.current = performance.now();
    missLoggedRef.current = false;
    missQueryRef.current = note?.trim() || "Foto utan angivet produktnamn";
    currentScanIdRef.current = null;
    setScanId(null);
    setView("processing"); setTrace([{ id: "upload", label: "Skickar bilden…", status: "active" }]); setMatch(null); setRenderProgress(null); setGuide(null); setError(""); setElapsedMs(null); setRetakeAllowed(true);
    retakeTimerRef.current = window.setTimeout(() => { setRetakeAllowed(false); retakeTimerRef.current = null; }, 1000);
    armScanTimeout();
    try { const { scanId: nextScanId } = await startScan({ photo: captured.file, note: note?.trim() || undefined }); currentScanIdRef.current = nextScanId; setScanId(nextScanId); closeEventsRef.current = openScanEvents(nextScanId, handleEvent); }
    catch { clearScanTimers(); setRetakeAllowed(false); setError("Bilden kunde inte skickas. Kontrollera anslutningen och försök igen."); setView("processing"); }
  }, [armScanTimeout, clearScanTimers, handleEvent]);

  const beginScan = useCallback(() => {
    if (!photo) { openCamera(); return; }
    void runScan(photo, draft);
  }, [draft, openCamera, photo, runScan]);

  const addPhoto = useCallback((captured: CapturedPhoto) => {
    setPhoto((previous) => { releasePhoto(previous); return captured; });
    void runScan(captured, draft);
  }, [draft, releasePhoto, runScan]);

  const retake = useCallback(() => { closeEventsRef.current?.(); closeEventsRef.current = null; clearScanTimers(); releasePhoto(photo); setPhoto(null); setView("home"); setTrace(freshTrace()); setMatch(null); setRenderProgress(null); setError(""); setElapsedMs(null); setRetakeAllowed(false); setScanId(null); currentScanIdRef.current = null; setCameraSession((value) => value + 1); openCamera(); }, [clearScanTimers, openCamera, photo, releasePhoto]);
  const orderedSuggestions = useMemo(() => SUGGESTIONS.map((_, index) => SUGGESTIONS[(index + suggestionOffset) % SUGGESTIONS.length]), [suggestionOffset]);

  return (
    <main className={`mobile-app ${cameraOpen ? "is-camera-open" : ""} view-${view}`}>
      {view === "home" && <><header className="app-header"><button className="header-action header-action--history" type="button" aria-label="Recent work"><History size={27} strokeWidth={2.2} /></button><h1>New workspace</h1><button className="header-action header-action--new" type="button" aria-label="Start new workspace" onClick={reset}><MessageCirclePlus size={28} strokeWidth={2.15} /></button></header><section className="home-content" inert={cameraOpen} aria-hidden={cameraOpen ? "true" : undefined}><div className="suggestion-stack"><div className="suggestion-list">{orderedSuggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setDraft(suggestion); if (!photo) openCamera(); else window.setTimeout(() => inputRef.current?.focus(), 0); }}>{suggestion}</button>)}</div><button className="refresh-suggestions" type="button" aria-label="Refresh suggestions" onClick={() => setSuggestionOffset((offset) => (offset + 1) % SUGGESTIONS.length)}><RefreshCw size={21} strokeWidth={2.2} /></button></div><div className="prompt-anchor"><PromptBar draft={draft} photo={photo} busy={false} onDraftChange={setDraft} onPhotoClick={openCamera} onRemovePhoto={removePhoto} onSubmit={beginScan} inputRef={inputRef} /></div><BottomTabs /></section></>}
      {view === "guide" && guide && <GuideView guide={guide} onReset={reset} paymentLink={publicConfig.stripePaymentLinkUrl} price={publicConfig.guidePriceSek} scanId={scanId} />}
      {view === "error" && <section className="flow-view error-view"><span className="error-icon"><AlertTriangle size={28} /></span><span className="eyebrow">The scan stopped</span><h2>We couldn't finish this guide</h2><p>{error}</p><button type="button" className="primary-action" onClick={beginScan}><RotateCcw size={18} /> Try again</button><button type="button" className="secondary-action" onClick={retake}><Camera size={18} /> Take a clearer photo</button></section>}
      <CameraCard key={cameraSession} open={cameraOpen} closing={cameraClosing} onClose={closeCamera} onCapture={addPhoto} canRetake={retakeAllowed} onRetake={retake} overlay={view === "processing" ? <ThinkingState trace={trace} match={match} renderProgress={renderProgress} elapsedMs={elapsedMs} error={error} recoveryName={draft} onRecoveryNameChange={setDraft} onRetry={beginScan} onRetake={retake} paymentLink={publicConfig.stripePaymentLinkUrl} price={publicConfig.guidePriceSek} scanId={scanId} /> : undefined} />
    </main>
  );
}
