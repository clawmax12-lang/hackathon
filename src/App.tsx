import {
  ArrowUp,
  Camera,
  CameraOff,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileImage,
  History,
  ImagePlus,
  Images,
  Library,
  ListChecks,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageCircle,
  Mic,
  MoreHorizontal,
  PackageCheck,
  PanelLeftClose,
  Pause,
  Play,
  Plus,
  ScanLine,
  Sparkles,
  SwitchCamera,
  Upload,
  Video,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Stage = "home" | "analyzing" | "ready";

type Attachment = {
  id: string;
  name: string;
  url?: string;
  demo?: boolean;
};

type SubmittedMessage = {
  text: string;
  attachments: Attachment[];
};

type FollowUp = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
};

const TRACE_STEPS = [
  "Reading the product label",
  "Identifying the exact model",
  "Finding the correct instructions",
  "Planning a clear assembly sequence",
  "Creating your video guide",
];

const TEXT_STEPS = [
  "Unpack and sort the frame pieces",
  "Join the seat frame and side panels",
  "Fit the backrest and secure the brackets",
  "Add cushions, covers, and final checks",
];

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`} aria-label="Monterra">
      <span className="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <path d="M5 23 12.6 8.5l4.1 7.3 2.9-5.1L27 23H5Z" />
          <circle cx="24.6" cy="7.1" r="3.1" />
        </svg>
      </span>
      {!compact && <span className="brand__word">monterra</span>}
    </div>
  );
}

function DemoPackage({ small = false }: { small?: boolean }) {
  return (
    <div className={`demo-package ${small ? "demo-package--small" : ""}`} aria-label="Sample KIVIK package label">
      <svg viewBox="0 0 220 154" aria-hidden="true">
        <defs>
          <linearGradient id="cardboard" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d9bd92" />
            <stop offset="1" stopColor="#b78f61" />
          </linearGradient>
        </defs>
        <rect width="220" height="154" rx="14" fill="url(#cardboard)" />
        <path d="M0 31h220M36 0v154" stroke="#9f774e" strokeWidth="1.4" opacity=".55" />
        <path d="M178 0v154" stroke="#ead4b0" strokeWidth="2" opacity=".7" />
        <rect x="49" y="26" width="118" height="102" rx="5" fill="#f8f6f0" />
        <text x="62" y="49" fill="#1a1c20" fontFamily="Arial, sans-serif" fontSize="14" fontWeight="700">KIVIK</text>
        <text x="62" y="64" fill="#666762" fontFamily="Arial, sans-serif" fontSize="7.2">3-seat sofa · light beige</text>
        <g fill="none" stroke="#2b2c2c" strokeLinecap="round" strokeLinejoin="round">
          <path d="M67 91v-9c0-5 3-8 8-8h24c5 0 8 3 8 8v9" strokeWidth="2" />
          <path d="M61 88h52v17H61zM67 105v5M107 105v5M87 88v17" strokeWidth="2" />
        </g>
        <g fill="#242525">
          {[0, 4, 7, 12, 15, 20, 25, 28, 34, 38, 43, 47, 50, 56, 60, 64, 69, 72, 78].map((x, index) => (
            <rect key={x} x={61 + x} y="116" width={index % 3 === 0 ? 2.2 : 1.2} height="7" />
          ))}
        </g>
        <circle cx="190" cy="126" r="14" fill="#b7d85b" />
        <path d="m183 126 4.2 4.2 9-9" fill="none" stroke="#1a1c20" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
      </svg>
    </div>
  );
}

type CameraStatus = "requesting" | "live" | "unavailable";

function CameraWidget({
  open,
  onClose,
  onCapture,
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
}) {
  const [status, setStatus] = useState<CameraStatus>("requesting");
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [errorMessage, setErrorMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [flash, setFlash] = useState(false);
  const [capturedPreview, setCapturedPreview] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const captureTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const closingRef = useRef(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const clearPreviewUrl = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);

  const finishClose = useCallback(() => {
    stopCamera();
    clearPreviewUrl();
    onClose();
  }, [clearPreviewUrl, onClose, stopCamera]);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setLeaving(true);
    stopCamera();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimerRef.current = window.setTimeout(finishClose, reducedMotion ? 0 : 220);
  }, [finishClose, stopCamera]);

  const completeCapture = useCallback((file: File, preview?: string) => {
    if (captured) return;
    if (preview) setCapturedPreview(preview);
    setCaptured(true);
    setFlash(true);
    stopCamera();
    onCapture(file);

    flashTimerRef.current = window.setTimeout(() => setFlash(false), 150);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    captureTimerRef.current = window.setTimeout(requestClose, reducedMotion ? 0 : 520);
  }, [captured, onCapture, requestClose, stopCamera]);

  useEffect(() => {
    if (!open || captured) return;
    let cancelled = false;
    stopCamera();
    setStatus("requesting");
    setErrorMessage("");

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("unavailable");
      setErrorMessage("This browser can’t open a live camera here. You can still choose a photo from your device.");
      return;
    }

    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1440 }, height: { ideal: 1920 } },
      })
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setStatus("live");
      })
      .catch((error: DOMException) => {
        if (cancelled) return;
        setStatus("unavailable");
        setErrorMessage(
          error.name === "NotAllowedError"
            ? "Camera access is off. Allow it in your browser settings, or choose a photo instead."
            : "We couldn’t start your camera. You can still choose a photo from your device.",
        );
      });

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [captured, facingMode, open, stopCamera]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closingRef.current = false;
    setLeaving(false);
    setCaptured(false);
    setFlash(false);
    setCapturedPreview(null);
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }

      if (event.key !== "Tab") return;
      const dialog = document.getElementById("monterra-camera-dialog");
      const controls = Array.from(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => previouslyFocused?.focus());
    };
  }, [open, requestClose]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    if (captureTimerRef.current) window.clearTimeout(captureTimerRef.current);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    stopCamera();
    clearPreviewUrl();
  }, [clearPreviewUrl, stopCamera]);

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video || status !== "live" || !video.videoWidth || captured) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (facingMode === "user") {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL("image/jpeg", 0.82);
    canvas.toBlob((blob) => {
      if (!blob) return;
      completeCapture(
        new File([blob], `monterra-photo-${Date.now()}.jpg`, { type: "image/jpeg", lastModified: Date.now() }),
        preview,
      );
    }, "image/jpeg", 0.9);
  };

  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    clearPreviewUrl();
    const preview = URL.createObjectURL(file);
    previewUrlRef.current = preview;
    completeCapture(file, preview);
  };

  if (!open) return null;

  return (
    <div className={`camera-overlay ${leaving ? "is-leaving" : ""}`}>
      <div
        id="monterra-camera-dialog"
        className="camera-stage"
        role="dialog"
        aria-modal="true"
        aria-labelledby="camera-dialog-title"
        aria-describedby="camera-dialog-description"
      >
        <div className="camera-stage__heading">
          <span className="camera-stage__brand"><BrandMark compact /></span>
          <div>
            <h2 id="camera-dialog-title">Show Monterra what you’re building</h2>
            <p id="camera-dialog-description">Keep the product label, model number, or loose part inside the frame.</p>
          </div>
        </div>

        <div className={`camera-stack ${captured ? "is-captured" : ""}`}>
          <span className="camera-stack__card camera-stack__card--left" aria-hidden="true" />
          <span className="camera-stack__card camera-stack__card--right" aria-hidden="true" />
          <div className="camera-widget">
            {capturedPreview ? (
              <img className="camera-widget__captured" src={capturedPreview} alt="Captured product preview" />
            ) : (
              <video
                ref={videoRef}
                className={facingMode === "user" ? "is-mirrored" : ""}
                autoPlay
                playsInline
                muted
                aria-label="Live camera preview"
              />
            )}

            {status === "requesting" && !captured && (
              <div className="camera-widget__loading" role="status">
                <span className="camera-loader"><i /><i /><i /><i /></span>
                <strong>Opening your camera…</strong>
                <small>Camera access stays on this device.</small>
              </div>
            )}

            {status === "unavailable" && !captured && (
              <div className="camera-widget__fallback">
                <span><CameraOff size={24} /></span>
                <h3>Camera preview unavailable</h3>
                <p>{errorMessage}</p>
                <button type="button" onClick={() => uploadRef.current?.click()}>
                  <Images size={17} /> Choose a photo
                </button>
              </div>
            )}

            <div className="camera-widget__top">
              <button ref={closeButtonRef} type="button" aria-label="Close camera" onClick={requestClose}>
                <ChevronRight size={23} />
              </button>
              <span className="camera-mode"><i /> Product scan</span>
              <span className="camera-widget__privacy">On device</span>
            </div>

            <div className="camera-guide" aria-hidden="true">
              <i /><i /><i /><i />
              <span>Fit the label inside the frame</span>
            </div>

            <div className="camera-widget__controls">
              <button className="camera-secondary" type="button" aria-label="Choose a photo instead" onClick={() => uploadRef.current?.click()}>
                <Images size={20} />
                <span>Photos</span>
              </button>
              <button
                className="camera-shutter"
                type="button"
                aria-label="Take photo"
                disabled={status !== "live" || captured}
                onClick={takePhoto}
              >
                <span />
              </button>
              <button
                className="camera-secondary"
                type="button"
                aria-label="Switch camera"
                disabled={status !== "live" || captured}
                onClick={() => setFacingMode((mode) => (mode === "environment" ? "user" : "environment"))}
              >
                <SwitchCamera size={20} />
                <span>Flip</span>
              </button>
            </div>

            {captured && (
              <div className="camera-captured-state" role="status">
                <span><Check size={22} strokeWidth={3} /></span>
                <strong>Photo added</strong>
              </div>
            )}
            <span className={`camera-flash ${flash ? "is-visible" : ""}`} aria-hidden="true" />
            <input ref={uploadRef} className="sr-only" type="file" accept="image/*" onChange={choosePhoto} />
          </div>
        </div>
        <p className="camera-stage__tip"><ScanLine size={15} /> Good light and sharp text give the best match.</p>
      </div>
    </div>
  );
}

function Sidebar({
  stage,
  mobileOpen,
  mobileViewport,
  onClose,
  onNewGuide,
}: {
  stage: Stage;
  mobileOpen: boolean;
  mobileViewport: boolean;
  onClose: () => void;
  onNewGuide: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileViewport || !mobileOpen) return;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen, mobileViewport, onClose]);

  return (
    <>
      <button
        className={`sidebar-backdrop ${mobileOpen ? "is-visible" : ""}`}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        aria-label="Close navigation"
        onClick={onClose}
      />
      <aside
        className={`sidebar ${mobileOpen ? "is-open" : ""}`}
        aria-label="Main navigation"
        aria-hidden={mobileViewport && !mobileOpen ? "true" : undefined}
        inert={mobileViewport && !mobileOpen}
      >
        <div className="sidebar__top">
          <BrandMark />
          <button ref={closeButtonRef} className="icon-button sidebar__close" type="button" aria-label="Close navigation" onClick={onClose}>
            <PanelLeftClose size={18} />
          </button>
        </div>

        <button className="new-guide" type="button" onClick={() => { onNewGuide(); onClose(); }}>
          <Plus size={17} strokeWidth={2.2} />
          <span>New guide</span>
          <kbd>N</kbd>
        </button>

        <nav className="sidebar__nav">
          <button className="nav-row is-active" type="button" aria-current="page" onClick={() => { onNewGuide(); onClose(); }}>
            <MessageCircle size={17} />
            <span>Ask Monterra</span>
          </button>
          <button className="nav-row" type="button">
            <Library size={17} />
            <span>My guides</span>
            {stage === "ready" && <span className="nav-count">1</span>}
          </button>
          <button className="nav-row" type="button">
            <History size={17} />
            <span>History</span>
          </button>
        </nav>

        <div className="sidebar__recents">
          <p className="sidebar__label">Recent</p>
          {stage === "home" ? (
            <p className="sidebar__empty">Your generated guides will appear here.</p>
          ) : (
            <button className="recent-guide" type="button" onClick={onClose}>
              <span className="recent-guide__art" aria-hidden="true">
                <PackageCheck size={17} />
              </span>
              <span>
                <strong>KIVIK 3-seat sofa</strong>
                <small>{stage === "ready" ? "12-step video guide" : "Preparing guide…"}</small>
              </span>
              <MoreHorizontal className="recent-guide__more" size={15} />
            </button>
          )}
        </div>

        <div className="sidebar__footer">
          <button className="sidebar-help" type="button">
            <CircleHelp size={17} />
            <span>Help & feedback</span>
          </button>
          <button className="profile" type="button">
            <span className="profile__avatar">AM</span>
            <span className="profile__copy">
              <strong>Alex Morgan</strong>
              <small>Personal workspace</small>
            </span>
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
    </>
  );
}

function Composer({
  attachments,
  draft,
  compact = false,
  listening,
  onDraftChange,
  onAddFiles,
  onAddDemo,
  onOpenCamera,
  onRemoveAttachment,
  onListeningChange,
  onSubmit,
  busy = false,
}: {
  attachments: Attachment[];
  draft: string;
  compact?: boolean;
  listening: boolean;
  onDraftChange: (value: string) => void;
  onAddFiles: (files: File[]) => void;
  onAddDemo: () => void;
  onOpenCamera: () => void;
  onRemoveAttachment: (id: string) => void;
  onListeningChange: (value: boolean) => void;
  onSubmit: () => void;
  busy?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const photoButtonRef = useRef<HTMLButtonElement>(null);
  const photoMenuRef = useRef<HTMLDivElement>(null);

  const canSend = !busy && (draft.trim().length > 0 || attachments.length > 0);

  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, compact ? 24 : 52), compact ? 96 : 118)}px`;
  }, [draft, compact]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    window.requestAnimationFrame(() => photoMenuRef.current?.querySelector("button")?.focus());
  }, [menuOpen]);

  useEffect(() => {
    if (!listening) return;
    const timeout = window.setTimeout(() => {
      const currentDraft = draftRef.current.trim();
      onDraftChange(`${currentDraft}${currentDraft ? " " : ""}Which tools will I need?`);
      onListeningChange(false);
      textareaRef.current?.focus();
    }, 1450);
    return () => window.clearTimeout(timeout);
  }, [listening]); // eslint-disable-line react-hooks/exhaustive-deps

  const acceptFiles = (fileList: FileList | File[]) => {
    const images = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (images.length) onAddFiles(images);
    setMenuOpen(false);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) acceptFiles(event.target.files);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragActive(false);
    acceptFiles(event.dataTransfer.files);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
    if (event.key === "Escape") setMenuOpen(false);
  };

  return (
    <form
      ref={composerRef}
      id="composer"
      className={`composer ${compact ? "composer--compact" : ""} ${dragActive ? "is-dragging" : ""}`}
      onSubmit={handleSubmit}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!composerRef.current?.contains(event.relatedTarget as Node)) setDragActive(false);
      }}
      onDrop={handleDrop}
      aria-busy={busy}
    >
      <input ref={uploadRef} hidden type="file" accept="image/*" multiple onChange={handleFileInput} />

      <div className="composer__drop-copy" aria-hidden="true">
        <Upload size={20} />
        <span>Drop your photo here</span>
      </div>

      {attachments.length > 0 && (
        <div className="attachment-strip" aria-label="Attached photos">
          {attachments.map((attachment) => (
            <div className="attachment" key={attachment.id}>
              {attachment.demo ? (
                <DemoPackage small />
              ) : (
                <img src={attachment.url} alt="Product attachment preview" />
              )}
              <span className="attachment__name">{attachment.name}</span>
              <button
                className="attachment__remove"
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemoveAttachment(attachment.id)}
              >
                <X size={13} strokeWidth={2.4} />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        aria-label="Message Monterra"
        placeholder={compact ? "Ask about any step…" : "Describe what you're building, or add a photo…"}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className="composer__controls">
        <div className="composer__left">
          {compact ? (
            <div className="photo-menu-wrap">
              <button
                ref={photoButtonRef}
                className="add-photo add-photo--compact"
                type="button"
                aria-haspopup="dialog"
                aria-controls="photo-attachment-menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Plus size={19} />
                <span>Add</span>
              </button>

              {menuOpen && (
                <div
                  ref={photoMenuRef}
                  id="photo-attachment-menu"
                  className="photo-menu"
                  role="dialog"
                  aria-label="Add a photo"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMenuOpen(false);
                      photoButtonRef.current?.focus();
                    }
                  }}
                >
                  <p>Add to Monterra</p>
                  <button type="button" onClick={() => { setMenuOpen(false); onOpenCamera(); }}>
                    <span className="menu-icon menu-icon--camera"><Camera size={17} /></span>
                    <span><strong>Take a photo</strong><small>Open the camera widget</small></span>
                  </button>
                  <button type="button" onClick={() => uploadRef.current?.click()}>
                    <span className="menu-icon"><FileImage size={17} /></span>
                    <span><strong>Choose from device</strong><small>JPG, PNG, or HEIC</small></span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onAddDemo();
                      setMenuOpen(false);
                    }}
                  >
                    <span className="menu-icon menu-icon--sample"><Sparkles size={17} /></span>
                    <span><strong>Try a sample package</strong><small>See the complete flow</small></span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="primary-photo-actions">
              <button ref={photoButtonRef} className="take-photo-cta" type="button" aria-haspopup="dialog" onClick={onOpenCamera}>
                <span className="take-photo-cta__icon"><Camera size={20} strokeWidth={2.35} /></span>
                <span className="take-photo-cta__copy"><strong>Take a photo</strong><small>Open camera</small></span>
                <span className="take-photo-cta__signal" aria-hidden="true" />
              </button>
              <button className="upload-photo" type="button" onClick={() => uploadRef.current?.click()}>
                <Upload size={17} />
                <span>Upload</span>
              </button>
              <span className="composer__hint">or drag & drop</span>
            </div>
          )}
        </div>

        <div className="composer__actions">
          <button
            className={`round-action ${listening ? "is-listening" : ""}`}
            type="button"
            aria-label={listening ? "Stop dictation" : "Start dictation"}
            aria-pressed={listening}
            onClick={() => onListeningChange(!listening)}
          >
            {listening ? <span className="voice-bars"><i /><i /><i /></span> : <Mic size={18} />}
          </button>
          <button className="send-action" type="submit" aria-label={busy ? "Waiting for Monterra" : "Send to Monterra"} disabled={!canSend}>
            <ArrowUp size={19} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </form>
  );
}

function ThinkingTrace({
  currentStep,
  done,
  expanded,
  onToggle,
}: {
  currentStep: number;
  done: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`thinking ${done ? "is-done" : ""}`}>
      <button className="thinking__header" type="button" aria-expanded={expanded} onClick={onToggle}>
        <span className="thinking__spark"><Sparkles size={15} /></span>
        <span>{done ? "Prepared your setup guide" : "Preparing your setup guide"}</span>
        {!done && <span className="thinking__pulse" aria-hidden="true" />}
        <ChevronDown className="thinking__chevron" size={15} />
      </button>
      <div className="thinking__body" aria-hidden={!expanded}>
        <div className="thinking__body-inner">
          <ol>
            {TRACE_STEPS.map((step, index) => {
              const complete = done || index < currentStep;
              const active = !done && index === currentStep;
              return (
                <li className={complete ? "is-complete" : active ? "is-active" : ""} key={step}>
                  <span className="thinking__node">
                    {complete ? <Check size={11} strokeWidth={3} /> : active ? <LoaderCircle size={12} /> : null}
                  </span>
                  <span>{step}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function SofaIllustration() {
  return (
    <svg className="sofa-illustration" viewBox="0 0 760 390" aria-hidden="true">
      <defs>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="18" stdDeviation="15" floodColor="#3f372f" floodOpacity=".14" />
        </filter>
      </defs>
      <ellipse cx="380" cy="333" rx="260" ry="22" fill="#866b56" opacity=".12" />
      <g filter="url(#softShadow)" stroke="#5f584f" strokeLinejoin="round">
        <path d="M180 167c0-22 18-40 40-40h145c14 0 27 7 35 18 8-11 21-18 35-18h129c22 0 40 18 40 40v83H180v-83Z" fill="#e7ded2" strokeWidth="2" />
        <path d="M151 197c0-14 11-25 25-25h34c14 0 25 11 25 25v102h-84V197ZM525 197c0-14 11-25 25-25h34c14 0 25 11 25 25v102h-84V197Z" fill="#d6c8b8" strokeWidth="2" />
        <path d="M208 230h344v83H208z" fill="#cfc0af" strokeWidth="2" />
        <path d="M219 210c0-12 10-22 22-22h135c12 0 22 10 22 22v58H219v-58ZM398 210c0-12 10-22 22-22h99c12 0 22 10 22 22v58H398v-58Z" fill="#f0e9df" strokeWidth="2" />
        <path d="M179 299h405v25H179z" fill="#b9a590" strokeWidth="2" />
        <path d="M190 324v15M570 324v15" strokeWidth="8" strokeLinecap="round" />
      </g>
      <g className="sofa-annotation" fill="none" stroke="#9adf12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3">
        <path d="M101 126v-29h51" />
        <path d="m143 88 9 9-9 9" />
        <path d="M645 150v-28h-43" />
        <path d="m611 113-9 9 9 9" />
      </g>
      <g className="sofa-annotation" fill="#6a625a" fontFamily="Manrope, sans-serif" fontSize="12" fontWeight="650">
        <text x="101" y="77">Fit the backrest</text>
        <text x="589" y="102">Secure bracket B</text>
      </g>
    </svg>
  );
}

function GuideCard() {
  const [playing, setPlaying] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);

  return (
    <section className="guide-card" aria-label="Generated setup guide">
      <div className="guide-card__topline">
        <span className="guide-card__eyebrow"><Video size={14} /> Video guide</span>
        <button className="icon-button" type="button" aria-label="More guide options"><MoreHorizontal size={18} /></button>
      </div>

      <button
        type="button"
        className={`video-poster ${playing ? "is-playing" : ""}`}
        aria-label={playing ? "Pause setup guide preview" : "Play setup guide preview"}
        onClick={() => setPlaying((value) => !value)}
      >
        <div className="video-poster__label">
          <span>STEP 4 OF 12</span>
          <strong>Attach the backrest</strong>
        </div>
        <SofaIllustration />
        <span className="video-poster__play">
          {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
        </span>
        <div className="video-poster__controls" aria-hidden="true">
          <span>{playing ? "04:18" : "00:00"}</span>
          <span className="video-progress"><i /></span>
          <span>18:24</span>
          <Captions size={15} />
          <Maximize2 size={15} />
        </div>
      </button>

      <div className="guide-card__content">
        <div>
          <p className="guide-card__kicker">IKEA · Living room</p>
          <h2>KIVIK 3-seat sofa</h2>
          <p>12 guided steps, with safety checks and tool callouts along the way.</p>
        </div>
        <div className="guide-meta" aria-label="Guide details">
          <span><Clock3 size={14} /> 18 min</span>
          <span><ListChecks size={14} /> 12 steps</span>
          <span><Captions size={14} /> Captions</span>
        </div>

        <button
          className="step-toggle"
          type="button"
          aria-expanded={stepsOpen}
          aria-controls="written-guide-steps"
          onClick={() => setStepsOpen((open) => !open)}
        >
          <span>View written steps</span>
          <ChevronDown size={16} />
        </button>
        <div id="written-guide-steps" className={`written-steps ${stepsOpen ? "is-open" : ""}`} aria-hidden={!stepsOpen}>
          <ol>
            {TEXT_STEPS.map((step, index) => (
              <li key={step}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function HomeHero({
  composer,
  onSample,
  onSetPrompt,
}: {
  composer: React.ReactNode;
  onSample: () => void;
  onSetPrompt: (prompt: string) => void;
}) {
  return (
    <section className="hero">
      <div className="hero__camera-badge" aria-hidden="true">
        <span><Camera size={27} strokeWidth={2.2} /></span>
        <i />
      </div>
      <p className="eyebrow">Photo in. Video guide out.</p>
      <h1>Take a photo.<br /><span>Build it right.</span></h1>
      <p className="hero__lede">
        Point your camera at the box, label, or loose parts. Monterra finds the right instructions
        and turns them into a clear, step-by-step video.
      </p>

      <div className="hero__composer">{composer}</div>
      <p className="photo-tip"><ScanLine size={15} /> Keep the product name and model number in frame.</p>

      <div className="quick-actions" aria-label="Things to try">
        <button type="button" onClick={onSample}>
          <span className="quick-actions__icon quick-actions__icon--terracotta"><ImagePlus size={18} /></span>
          <span><strong>Try a sample photo</strong><small>Preview the complete flow</small></span>
          <ChevronRight size={16} />
        </button>
        <button type="button" onClick={() => onSetPrompt("Can you identify this loose part?")}>
          <span className="quick-actions__icon quick-actions__icon--sage"><ScanLine size={18} /></span>
          <span><strong>Identify a part</strong><small>Find where it belongs</small></span>
          <ChevronRight size={16} />
        </button>
        <button type="button" onClick={() => onSetPrompt("What should I know before I start?")}>
          <span className="quick-actions__icon quick-actions__icon--sand"><MessageCircle size={18} /></span>
          <span><strong>Ask before you start</strong><small>Tools, time, and tips</small></span>
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

function Conversation({
  stage,
  message,
  traceStep,
  traceExpanded,
  followUps,
  pendingAnswer,
  composerReserve,
  onTraceToggle,
  onChangeProduct,
}: {
  stage: Stage;
  message: SubmittedMessage;
  traceStep: number;
  traceExpanded: boolean;
  followUps: FollowUp[];
  pendingAnswer: boolean;
  composerReserve: number;
  onTraceToggle: () => void;
  onChangeProduct: () => void;
}) {
  const ready = stage === "ready";

  return (
    <div className="conversation" aria-label="Conversation with Monterra" style={{ paddingBottom: composerReserve }}>
      <header className="conversation__title">
        <div>
          <p>{ready ? "Setup guide" : "New guide"}</p>
          <h1>{ready ? "KIVIK 3-seat sofa" : "Identifying your product"}</h1>
        </div>
        <span className={`conversation__status ${ready ? "is-ready" : ""}`}>
          {ready ? <Check size={13} /> : <LoaderCircle size={13} />}
          {ready ? "Guide ready" : "Working"}
        </span>
      </header>

      <div className="message message--user">
        <div className="user-attachments">
          {message.attachments.map((attachment) => (
            <div className="submitted-photo" key={attachment.id}>
              {attachment.demo ? <DemoPackage /> : <img src={attachment.url} alt="Submitted product" />}
            </div>
          ))}
        </div>
        <p>{message.text}</p>
      </div>

      <div className="message message--assistant">
        <div className="assistant-avatar"><BrandMark compact /></div>
        <div className="assistant-content">
          <p className="assistant-intro">
            {ready
              ? "I found a match and built a guide from the correct assembly sequence."
              : "On it. I’m matching your photo to the right product and planning the clearest way through the build."}
          </p>
          <ThinkingTrace
            currentStep={traceStep}
            done={ready}
            expanded={traceExpanded}
            onToggle={onTraceToggle}
          />

          {ready && (
            <div className="ready-content">
              <div className="match-line">
                <span className="match-line__icon"><PackageCheck size={18} /></span>
                <span><small>Matched product</small><strong>KIVIK 3-seat sofa · light beige</strong></span>
                <button type="button" onClick={onChangeProduct}>Change</button>
              </div>
              <p>Your video is ready. I’ve highlighted the tricky joins and marked the step where a second person helps.</p>
              <GuideCard />
              <p className="followup-prompt">Need help with a step? Ask Monterra below.</p>
            </div>
          )}
        </div>
      </div>

      {followUps.map((followUp) => (
        <div className={`message message--followup message--${followUp.role}`} key={followUp.id}>
          {followUp.role === "assistant" && <div className="assistant-avatar"><BrandMark compact /></div>}
          {followUp.role === "user" && followUp.attachments && followUp.attachments.length > 0 && (
            <div className="followup-attachments">
              {followUp.attachments.map((attachment) => (
                <div className="followup-photo" key={attachment.id}>
                  {attachment.demo ? <DemoPackage /> : <img src={attachment.url} alt="Follow-up product detail" />}
                </div>
              ))}
            </div>
          )}
          <p>{followUp.text}</p>
        </div>
      ))}

      {pendingAnswer && (
        <div className="message message--assistant message--typing" aria-label="Monterra is typing">
          <div className="assistant-avatar"><BrandMark compact /></div>
          <span><i /><i /><i /></span>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [stage, setStage] = useState<Stage>("home");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [submitted, setSubmitted] = useState<SubmittedMessage | null>(null);
  const [traceStep, setTraceStep] = useState(0);
  const [traceExpanded, setTraceExpanded] = useState(true);
  const [listening, setListening] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia("(max-width: 880px)").matches);
  const [howOpen, setHowOpen] = useState(false);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [pendingAnswer, setPendingAnswer] = useState(false);
  const [composerReserve, setComposerReserve] = useState(210);
  const [cameraOpen, setCameraOpen] = useState(false);
  const responseTimer = useRef<number | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const howButtonRef = useRef<HTMLButtonElement>(null);
  const howWrapRef = useRef<HTMLDivElement>(null);
  const stickyComposerRef = useRef<HTMLDivElement>(null);

  const closeMobileNav = useCallback(() => {
    setMobileNavOpen(false);
    if (mobileViewport) window.setTimeout(() => mobileMenuButtonRef.current?.focus(), 0);
  }, [mobileViewport]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 880px)");
    const updateViewport = () => setMobileViewport(media.matches);
    updateViewport();
    media.addEventListener("change", updateViewport);
    return () => media.removeEventListener("change", updateViewport);
  }, []);

  useLayoutEffect(() => {
    if (stage === "home" || !stickyComposerRef.current) return;
    const element = stickyComposerRef.current;
    const updateReserve = () => setComposerReserve(Math.ceil(element.getBoundingClientRect().height + 28));
    updateReserve();
    const observer = new ResizeObserver(updateReserve);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage]);

  useEffect(() => {
    if (!howOpen) return;
    const closeHow = (event: PointerEvent | globalThis.KeyboardEvent) => {
      if (event instanceof globalThis.KeyboardEvent && event.key === "Escape") {
        setHowOpen(false);
        howButtonRef.current?.focus();
        return;
      }
      if (event instanceof PointerEvent && !howWrapRef.current?.contains(event.target as Node)) setHowOpen(false);
    };
    document.addEventListener("pointerdown", closeHow);
    document.addEventListener("keydown", closeHow);
    return () => {
      document.removeEventListener("pointerdown", closeHow);
      document.removeEventListener("keydown", closeHow);
    };
  }, [howOpen]);

  useEffect(() => {
    if (stage !== "analyzing") return;
    const stepTimers = TRACE_STEPS.slice(1).map((_, index) =>
      window.setTimeout(() => setTraceStep(index + 1), (index + 1) * 920),
    );
    const completeTimer = window.setTimeout(() => {
      setStage("ready");
      setTraceExpanded(false);
    }, TRACE_STEPS.length * 920 + 520);

    return () => {
      stepTimers.forEach(window.clearTimeout);
      window.clearTimeout(completeTimer);
    };
  }, [stage]);

  useEffect(() => {
    const keyboardShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        resetGuide();
      }
    };
    window.addEventListener("keydown", keyboardShortcut);
    return () => window.removeEventListener("keydown", keyboardShortcut);
  });

  useEffect(() => {
    return () => {
      if (responseTimer.current) window.clearTimeout(responseTimer.current);
    };
  }, []);

  useEffect(() => {
    if (stage === "home" || (followUps.length === 0 && !pendingAnswer)) return;
    const timeout = window.setTimeout(() => {
      const messages = document.querySelectorAll<HTMLElement>(".conversation > .message");
      messages.item(messages.length - 1)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    return () => window.clearTimeout(timeout);
  }, [followUps.length, pendingAnswer, stage]);

  const addFiles = useCallback((files: File[]) => {
    setAttachments((current) => {
      const next = files.slice(0, Math.max(0, 3 - current.length)).map((file) => ({
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        name: file.name,
        url: URL.createObjectURL(file),
      }));
      return [...current, ...next].slice(0, 3);
    });
  }, []);

  const openCamera = useCallback(() => setCameraOpen(true), []);
  const closeCamera = useCallback(() => setCameraOpen(false), []);
  const captureFromCamera = useCallback((file: File) => addFiles([file]), [addFiles]);

  const addDemo = () => {
    setAttachments((current) => {
      if (current.some((attachment) => attachment.demo)) return current;
      return [...current, { id: `demo-${crypto.randomUUID()}`, name: "KIVIK package label", demo: true }].slice(0, 3);
    });
    if (!draft.trim()) setDraft("Turn this into a setup guide.");
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return current.filter((attachment) => attachment.id !== id);
    });
  };

  const resetGuide = () => {
    attachments.forEach((attachment) => attachment.url && URL.revokeObjectURL(attachment.url));
    submitted?.attachments.forEach((attachment) => attachment.url && URL.revokeObjectURL(attachment.url));
    followUps.forEach((followUp) => followUp.attachments?.forEach((attachment) => attachment.url && URL.revokeObjectURL(attachment.url)));
    if (responseTimer.current) window.clearTimeout(responseTimer.current);
    responseTimer.current = null;
    setStage("home");
    setDraft("");
    setAttachments([]);
    setSubmitted(null);
    setTraceStep(0);
    setTraceExpanded(true);
    setListening(false);
    setFollowUps([]);
    setPendingAnswer(false);
    setMobileNavOpen(false);
    setCameraOpen(false);
  };

  const submit = () => {
    if (!draft.trim() && attachments.length === 0) return;
    if (stage !== "home" && pendingAnswer) return;

    if (stage === "home") {
      setSubmitted({
        text: draft.trim() || "Create a setup guide from this photo.",
        attachments: [...attachments],
      });
      setDraft("");
      setAttachments([]);
      setTraceStep(0);
      setTraceExpanded(true);
      setStage("analyzing");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const text = draft.trim() || "Can you check this photo too?";
    const followUpAttachments = [...attachments];
    setFollowUps((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", text, attachments: followUpAttachments },
    ]);
    setDraft("");
    setAttachments([]);
    setPendingAnswer(true);
    if (responseTimer.current) window.clearTimeout(responseTimer.current);
    responseTimer.current = window.setTimeout(() => {
      setFollowUps((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Absolutely — send a close-up of the part or the step you’re on and I’ll match it to the guide.",
        },
      ]);
      setPendingAnswer(false);
      responseTimer.current = null;
    }, 850);
  };

  const changeProduct = () => {
    if (!submitted) return;
    if (responseTimer.current) window.clearTimeout(responseTimer.current);
    followUps.forEach((followUp) => followUp.attachments?.forEach((attachment) => attachment.url && URL.revokeObjectURL(attachment.url)));
    responseTimer.current = null;
    setAttachments(submitted.attachments);
    setDraft("This isn’t the right match. The product is ");
    setSubmitted(null);
    setStage("home");
    setTraceStep(0);
    setTraceExpanded(true);
    setFollowUps([]);
    setPendingAnswer(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const composer = (
    <Composer
      attachments={attachments}
      draft={draft}
      compact={stage !== "home"}
      listening={listening}
      onDraftChange={setDraft}
      onAddFiles={addFiles}
      onAddDemo={addDemo}
      onOpenCamera={openCamera}
      onRemoveAttachment={removeAttachment}
      onListeningChange={setListening}
      onSubmit={submit}
      busy={stage !== "home" && pendingAnswer}
    />
  );

  return (
    <div className="app-shell">
      <CameraWidget
        open={cameraOpen}
        onClose={closeCamera}
        onCapture={captureFromCamera}
      />
      <div className="app-content" inert={cameraOpen} aria-hidden={cameraOpen ? "true" : undefined}>
        <Sidebar
          stage={stage}
          mobileOpen={mobileNavOpen}
          mobileViewport={mobileViewport}
          onClose={closeMobileNav}
          onNewGuide={resetGuide}
        />

        <main className={`main ${stage !== "home" ? "main--conversation" : ""}`}>
        <header className="topbar">
          <button
            ref={mobileMenuButtonRef}
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="mobile-brand"><BrandMark /></div>
          <div className="topbar__right">
            <div ref={howWrapRef} className="how-wrap">
              <button
                ref={howButtonRef}
                className="how-button"
                type="button"
                aria-expanded={howOpen}
                aria-controls="how-monterra-works"
                onClick={() => setHowOpen((open) => !open)}
              >
                <CircleHelp size={16} />
                <span>How it works</span>
              </button>
              {howOpen && (
                <div id="how-monterra-works" className="how-popover">
                  <p>From photo to clear instructions</p>
                  <ol>
                    <li><span>1</span><div><strong>Show the product</strong><small>Capture the box, label, or parts.</small></div></li>
                    <li><span>2</span><div><strong>Confirm the match</strong><small>Monterra finds the right model.</small></div></li>
                    <li><span>3</span><div><strong>Follow your guide</strong><small>Watch the video or read each step.</small></div></li>
                  </ol>
                </div>
              )}
            </div>
            <button className="topbar-avatar" type="button" aria-label="Open account menu">AM</button>
          </div>
        </header>

        {stage === "home" ? (
          <HomeHero
            composer={composer}
            onSample={addDemo}
            onSetPrompt={(prompt) => {
              setDraft(prompt);
              document.getElementById("composer")?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          />
        ) : submitted ? (
          <>
            <Conversation
              stage={stage}
              message={submitted}
              traceStep={traceStep}
              traceExpanded={traceExpanded}
              followUps={followUps}
              pendingAnswer={pendingAnswer}
              composerReserve={composerReserve}
              onTraceToggle={() => setTraceExpanded((expanded) => !expanded)}
              onChangeProduct={changeProduct}
            />
            <div ref={stickyComposerRef} className="sticky-composer">
              <div className="sticky-composer__inner">{composer}</div>
              <p>Monterra can make mistakes. Check critical steps before building.</p>
            </div>
          </>
        ) : null}

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {stage === "analyzing" ? TRACE_STEPS[traceStep] : stage === "ready" ? "Your setup guide is ready." : ""}
        </div>
        </main>
      </div>
    </div>
  );
}
