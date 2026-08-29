import {
  Camera,
  ChevronLeft,
  CircleUserRound,
  Ellipsis,
  History,
  MessageCircle,
  MessageCirclePlus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { openScanEvents, startScan, type ScanEvent } from "./lib/api";

type CameraStatus = "starting" | "live" | "fallback";

type CapturedPhoto = {
  name: string;
  url: string;
};

type Phase = "compose" | "processing" | "result" | "error";

const SUGGESTIONS = [
  "Scan package label",
  "Identify loose parts",
  "Create assembly guide",
];

const STAGE_LABELS = [
  "Reading the package label",
  "Identifying the exact model",
  "Finding the official instructions",
  "Planning a clear assembly sequence",
  "Creating your video guide",
];

type GuideResult = {
  guideId: string;
  title: string;
  videoUrl: string;
  thumbnailUrl: string;
  durationSeconds: number;
  stepCount: number;
};

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function PromptBar({
  draft,
  photo,
  submitting,
  onDraftChange,
  onPhotoClick,
  onRemovePhoto,
  onSubmit,
  inputRef,
}: {
  draft: string;
  photo: CapturedPhoto | null;
  submitting: boolean;
  onDraftChange: (value: string) => void;
  onPhotoClick: () => void;
  onRemovePhoto: () => void;
  onSubmit: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (photo && !submitting) onSubmit();
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
        aria-label="Ask Monterra anything"
        placeholder={photo ? "Add a message" : "Ask anything"}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      {photo && (
        <button className="prompt-send-button" type="submit" aria-label="Create assembly guide" disabled={submitting}>
          <Send size={18} strokeWidth={2.4} />
        </button>
      )}
      <button
        className="prompt-camera-button"
        type="button"
        aria-label={photo ? "Retake photo" : "Take photo"}
        onClick={onPhotoClick}
      >
        <Camera size={22} strokeWidth={2.7} />
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

function CameraCard({
  open,
  closing,
  onClose,
  onCapture,
}: {
  open: boolean;
  closing: boolean;
  onClose: () => void;
  onCapture: (photo: CapturedPhoto) => void;
}) {
  const [status, setStatus] = useState<CameraStatus>("starting");
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
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
    setStatus("starting");

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("fallback");
      return;
    }

    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1440 },
          height: { ideal: 1920 },
        },
      })
      .then(async (stream) => {
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
      })
      .catch(() => {
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
    window.setTimeout(() => onCapture(photo), 190);
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
    commitPhoto({ name: `monterra-photo-${Date.now()}.jpg`, url });
  };

  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || captureLockRef.current) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") commitPhoto({ name: file.name, url: reader.result });
    };
    reader.readAsDataURL(file);
  };

  if (!open) return null;

  return (
    <section className={`camera-layer ${closing ? "is-closing" : ""}`} aria-label="Photo camera">
      <div className="camera-deck">
        <div ref={cardRef} className={`camera-card is-${status} ${frozenFrame ? "has-capture" : ""}`}>
          <div className="camera-scene" aria-hidden="true" />
          {!frozenFrame && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              aria-label="Live camera preview"
              onLoadedMetadata={() => setStatus("live")}
            />
          )}
          {frozenFrame && <img className="frozen-frame" src={frozenFrame} alt="Captured product" />}

          <span className="camera-vignette" aria-hidden="true" />
          <button className="camera-control camera-control--back" type="button" aria-label="Close camera" onClick={onClose}>
            <ChevronLeft size={24} strokeWidth={2.7} />
          </button>
          <button className="camera-shutter" type="button" aria-label={status === "live" ? "Take photo" : "Choose a photo"} onClick={takePhoto}>
            <span />
          </button>
          <button className="camera-control camera-control--more" type="button" aria-label="Choose photo from device" onClick={() => uploadRef.current?.click()}>
            <Ellipsis size={25} strokeWidth={3} />
          </button>
          <span className={`camera-flash ${flash ? "is-visible" : ""}`} aria-hidden="true" />
          <span className="sr-only" aria-live="polite">
            {frozenFrame ? "Photo added." : status === "live" ? "Camera ready." : status === "fallback" ? "Camera unavailable. Choose a photo from your device." : "Starting camera."}
          </span>
          <input ref={uploadRef} className="sr-only" tabIndex={-1} type="file" accept="image/*" onChange={choosePhoto} />
        </div>
      </div>
    </section>
  );
}

function ProcessingLayer({
  stageIndex,
  stageDetail,
  matchedProduct,
  onCancel,
}: {
  stageIndex: number;
  stageDetail: string | null;
  matchedProduct: { name: string; confidence: number } | null;
  onCancel: () => void;
}) {
  return (
    <section className="status-layer" aria-label="Creating your assembly guide">
      <button className="camera-control camera-control--back" type="button" aria-label="Cancel" onClick={onCancel}>
        <ChevronLeft size={24} strokeWidth={2.7} />
      </button>
      <div className="status-card">
        <Sparkles size={26} strokeWidth={2} className="status-card__icon" />
        <h2>Building your guide</h2>
        {matchedProduct && (
          <p className="status-card__match">
            Matched: {matchedProduct.name} · {Math.round(matchedProduct.confidence * 100)}%
          </p>
        )}
        <ol className="stage-list">
          {STAGE_LABELS.map((label, index) => (
            <li
              key={label}
              className={index < stageIndex ? "is-done" : index === stageIndex ? "is-active" : "is-pending"}
            >
              <span className="stage-list__marker" aria-hidden="true" />
              <span>{label}</span>
            </li>
          ))}
        </ol>
        {stageDetail && <p className="status-card__detail">{stageDetail}</p>}
      </div>
    </section>
  );
}

function ResultLayer({ guide, onReset }: { guide: GuideResult; onReset: () => void }) {
  return (
    <section className="status-layer" aria-label="Your assembly guide is ready">
      <button className="camera-control camera-control--back" type="button" aria-label="Start new workspace" onClick={onReset}>
        <ChevronLeft size={24} strokeWidth={2.7} />
      </button>
      <div className="status-card status-card--result">
        <video className="result-video" src={guide.videoUrl} poster={guide.thumbnailUrl} controls playsInline />
        <h2>{guide.title}</h2>
        <p className="status-card__match">
          {guide.stepCount} steps · about {formatDuration(guide.durationSeconds)}
        </p>
        <button className="status-card__primary" type="button" onClick={onReset}>
          Start a new scan
        </button>
      </div>
    </section>
  );
}

function ErrorLayer({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="status-layer" aria-label="Something went wrong">
      <div className="status-card">
        <h2>Something went wrong</h2>
        <p className="status-card__detail">{message}</p>
        <button className="status-card__primary" type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    </section>
  );
}

export default function App() {
  const [cameraOpen, setCameraOpen] = useState(true);
  const [cameraClosing, setCameraClosing] = useState(false);
  const [draft, setDraft] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const [phase, setPhase] = useState<Phase>("compose");
  const [stageIndex, setStageIndex] = useState(0);
  const [stageDetail, setStageDetail] = useState<string | null>(null);
  const [matchedProduct, setMatchedProduct] = useState<{ name: string; confidence: number } | null>(null);
  const [guide, setGuide] = useState<GuideResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => unsubscribeRef.current?.(), []);

  const closeCamera = useCallback(() => {
    if (cameraClosing) return;
    setCameraClosing(true);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimerRef.current = window.setTimeout(() => {
      setCameraOpen(false);
      setCameraClosing(false);
      closeTimerRef.current = null;
    }, reduced ? 0 : 330);
  }, [cameraClosing]);

  const openCamera = useCallback(() => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setCameraClosing(false);
    setCameraOpen(true);
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const addPhoto = (captured: CapturedPhoto) => {
    setPhoto(captured);
    closeCamera();
  };

  const runScan = useCallback(async (opts: { photo?: CapturedPhoto; demo?: boolean; note?: string }) => {
    setPhase("processing");
    setStageIndex(0);
    setStageDetail(null);
    setMatchedProduct(null);
    setGuide(null);
    setErrorMessage(null);
    try {
      const file = opts.photo ? await dataUrlToFile(opts.photo.url, opts.photo.name) : undefined;
      const { scanId } = await startScan({ photo: file, demo: opts.demo, note: opts.note });
      unsubscribeRef.current?.();
      unsubscribeRef.current = openScanEvents(scanId, (event: ScanEvent) => {
        if (event.type === "stage") {
          setStageIndex(event.index);
          if (event.detail) setStageDetail(event.detail);
        } else if (event.type === "product_match") {
          setMatchedProduct({ name: event.name, confidence: event.confidence });
        } else if (event.type === "guide_ready") {
          setGuide(event);
          setPhase("result");
        } else if (event.type === "error") {
          setErrorMessage(event.message);
          setPhase("error");
        }
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("error");
    }
  }, []);

  const resetToCompose = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setPhase("compose");
    setPhoto(null);
    setDraft("");
    openCamera();
  }, [openCamera]);

  const submitting = phase === "processing";

  const orderedSuggestions = SUGGESTIONS.map((_, index) => SUGGESTIONS[(index + suggestionOffset) % SUGGESTIONS.length]);

  return (
    <main className={`mobile-app ${cameraOpen ? "is-camera-open" : ""}`}>
      <header className="app-header">
        <button className="header-action header-action--history" type="button" aria-label="Recent work">
          <History size={27} strokeWidth={2.2} />
        </button>
        <h1>New workspace</h1>
        <button className="header-action header-action--new" type="button" aria-label="Start new workspace" onClick={resetToCompose}>
          <MessageCirclePlus size={28} strokeWidth={2.15} />
        </button>
      </header>

      {phase === "compose" && (
        <section className="home-content" inert={cameraOpen} aria-hidden={cameraOpen ? "true" : undefined}>
          <div className="suggestion-stack">
            <div className="suggestion-list">
              {orderedSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setDraft(suggestion);
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <button className="refresh-suggestions" type="button" aria-label="Refresh suggestions" onClick={() => setSuggestionOffset((offset) => (offset + 1) % SUGGESTIONS.length)}>
              <RefreshCw size={21} strokeWidth={2.2} />
            </button>
          </div>

          <button className="demo-trigger" type="button" onClick={() => runScan({ demo: true })}>
            <Sparkles size={16} strokeWidth={2.3} />
            Try the demo product
          </button>

          <div className="prompt-anchor">
            <PromptBar
              draft={draft}
              photo={photo}
              submitting={submitting}
              onDraftChange={setDraft}
              onPhotoClick={openCamera}
              onRemovePhoto={() => setPhoto(null)}
              onSubmit={() => runScan({ photo: photo ?? undefined, note: draft || undefined })}
              inputRef={inputRef}
            />
          </div>
          <BottomTabs />
        </section>
      )}

      {phase === "processing" && (
        <ProcessingLayer
          stageIndex={stageIndex}
          stageDetail={stageDetail}
          matchedProduct={matchedProduct}
          onCancel={resetToCompose}
        />
      )}

      {phase === "result" && guide && <ResultLayer guide={guide} onReset={resetToCompose} />}

      {phase === "error" && <ErrorLayer message={errorMessage ?? "Please try again."} onRetry={resetToCompose} />}

      <CameraCard open={cameraOpen && phase === "compose"} closing={cameraClosing} onClose={closeCamera} onCapture={addPhoto} />
    </main>
  );
}
