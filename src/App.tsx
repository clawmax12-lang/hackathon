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

type CameraStatus = "starting" | "live" | "fallback";

type CapturedPhoto = {
  name: string;
  url: string;
};

const SUGGESTIONS = [
  "Scan package label",
  "Identify loose parts",
  "Create assembly guide",
];

function PromptBar({
  draft,
  photo,
  onDraftChange,
  onPhotoClick,
  onRemovePhoto,
  inputRef,
}: {
  draft: string;
  photo: CapturedPhoto | null;
  onDraftChange: (value: string) => void;
  onPhotoClick: () => void;
  onRemovePhoto: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const submit = (event: FormEvent) => event.preventDefault();

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

export default function App() {
  const [cameraOpen, setCameraOpen] = useState(true);
  const [cameraClosing, setCameraClosing] = useState(false);
  const [draft, setDraft] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const closeTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const newWorkspace = () => {
    setDraft("");
    setPhoto(null);
    openCamera();
  };

  const addPhoto = (captured: CapturedPhoto) => {
    setPhoto(captured);
    closeCamera();
  };

  const orderedSuggestions = SUGGESTIONS.map((_, index) => SUGGESTIONS[(index + suggestionOffset) % SUGGESTIONS.length]);

  return (
    <main className={`mobile-app ${cameraOpen ? "is-camera-open" : ""}`}>
      <header className="app-header">
        <button className="header-action header-action--history" type="button" aria-label="Recent work">
          <History size={27} strokeWidth={2.2} />
        </button>
        <h1>New workspace</h1>
        <button className="header-action header-action--new" type="button" aria-label="Start new workspace" onClick={newWorkspace}>
          <MessageCirclePlus size={28} strokeWidth={2.15} />
        </button>
      </header>

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

        <div className="prompt-anchor">
          <PromptBar
            draft={draft}
            photo={photo}
            onDraftChange={setDraft}
            onPhotoClick={openCamera}
            onRemovePhoto={() => setPhoto(null)}
            inputRef={inputRef}
          />
        </div>
        <BottomTabs />
      </section>

      <CameraCard open={cameraOpen} closing={cameraClosing} onClose={closeCamera} onCapture={addPhoto} />
    </main>
  );
}
