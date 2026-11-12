"use client";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ImagePlus, X } from "lucide-react";
import type { InventoryPhoto } from "../../packages/inventory/contracts";
import { ModalFrame } from "./modal";
import { Busy } from "./ui";
import styles from "./inventory-photo-upload.module.css";

async function preparePhoto(file: File): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20_000_000) throw new Error("Choose a JPEG, PNG or WebP photo under 20 MB.");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    if (bitmap.width * bitmap.height > 36_000_000 || Math.min(bitmap.width, bitmap.height) < 64) throw new Error("Use a photo between 64 pixels and 36 megapixels.");
    const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale); const context = canvas.getContext("2d"); if (!context) throw new Error("This browser could not prepare the photo."); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("The photo could not be prepared.")), "image/webp", .88));
    if (blob.size > 3_500_000) throw new Error("This photo is still too large after preparation. Choose a smaller image."); return blob;
  } finally { bitmap.close(); }
}

type ImageSource = InventoryPhoto["sourceMode"];
const unknownOutcome = "The upload outcome is unknown. Inspect your saved photos before another upload.";
function acknowledgedPhoto(value: unknown, source: ImageSource): InventoryPhoto | null {
  if (!value || typeof value !== "object" || !("photo" in value)) return null;
  const photo = value.photo as Partial<InventoryPhoto> | null;
  if (!photo || typeof photo.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(photo.id) || photo.sourceMode !== source || photo.status !== "active" || photo.imageUrl !== `/api/inventory/photos/${photo.id}` || !Number.isSafeInteger(photo.width) || Number(photo.width) < 64 || !Number.isSafeInteger(photo.height) || Number(photo.height) < 64 || !Number.isSafeInteger(photo.bytes) || Number(photo.bytes) <= 0 || typeof photo.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(photo.contentHash) || typeof photo.createdAt !== "string" || !Number.isFinite(Date.parse(photo.createdAt))) return null;
  return photo as InventoryPhoto;
}

export function InventoryPhotoUpload({ actorKey, disabled, onSaved, onNotice }: { actorKey: string; disabled: boolean; onSaved: (photo: InventoryPhoto) => void; onNotice: (message: string) => void }) {
  const [pending, setPending] = useState<{ file: File; actor: string } | null>(null);
  const [source, setSource] = useState<ImageSource | null>(null);
  const [status, setStatus] = useState(""); const [error, setError] = useState(""); const [held, setHeld] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), inFlight = useRef(false);
  const context = useRef({ actor: actorKey, epoch: 0, mounted: false });
  const titleId = useId(), sourceName = useId();
  useLayoutEffect(() => {
    context.current.actor = actorKey; context.current.mounted = true; context.current.epoch++; inFlight.current = false;
    setPending(null); setSource(null); setStatus(""); setError(""); setHeld(false);
    return () => { context.current.mounted = false; context.current.epoch++; inFlight.current = false; };
  }, [actorKey]);

  function close() {
    if (inFlight.current) return;
    if (held && error && pending?.actor === actorKey) onNotice(error);
    setPending(null); setSource(null); setError(""); setHeld(false);
    if (fileInput.current) fileInput.current.value = "";
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!pending || pending.actor !== actorKey || !source || disabled || inFlight.current || held) return;
    inFlight.current = true;
    const owner = actorKey, epoch = context.current.epoch, selectedFile = pending.file, selectedSource = source;
    const current = () => context.current.mounted && context.current.actor === owner && context.current.epoch === epoch;
    let dispatched = false, confirmed = false;
    setStatus("Preparing your private image…"); setError("");
    try {
      const photo = await preparePhoto(selectedFile); if (!current()) return;
      setStatus("Saving the sanitized image in private storage…"); dispatched = true;
      const response = await fetch("/api/inventory/photos", { method: "POST", headers: { "Content-Type": photo.type, "X-WorldKit-Image-Source": selectedSource }, body: photo });
      if (!current()) return;
      const value: unknown = await response.json(); if (!current()) return;
      if (!response.ok) {
        if (response.status >= 500) throw new Error(unknownOutcome);
        const reason = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "message" in value.error && typeof value.error.message === "string" ? value.error.message : "The upload was refused.";
        setError(`${reason} Inspect your saved photos before another upload.`); setHeld(true); return;
      }
      const saved = acknowledgedPhoto(value, selectedSource); if (!saved) throw new Error(unknownOutcome);
      confirmed = true; onSaved(saved); setPending(null); setSource(null); setHeld(false);
    } catch (error) {
      if (current()) { setError(dispatched ? confirmed ? "The upload was confirmed. Inspect your saved photos before another upload." : unknownOutcome : error instanceof Error ? error.message : "The image could not be prepared."); setHeld(dispatched); }
    } finally {
      if (current()) { inFlight.current = false; setStatus(""); }
    }
  }
  const busy = Boolean(status), open = pending?.actor === actorKey;
  return <>
    <button ref={trigger} disabled={disabled || busy} onClick={() => { if (!inFlight.current) fileInput.current?.click(); }}><span><ImagePlus size={22}/></span><b>Start with a photo</b><small>Choose source · private upload</small><ArrowRight size={16}/></button>
    <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Upload a private equipment photo" disabled={disabled || busy} onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (!file || disabled || inFlight.current) return; setPending({ file, actor: actorKey }); setSource(null); setError(""); setHeld(false); }}/>
    {open && <ModalFrame onClose={close} labelledBy={titleId} className={`equipment-dialog ${styles.dialog}`} returnFocusRef={trigger}>
      <header><span className="eyebrow">IMAGE SOURCE</span><button type="button" className="icon-button" disabled={busy} onClick={close} aria-label="Close image source"><X size={19}/></button></header>
      <h2 id={titleId}>What kind of image is this?</h2>
      <p>Choose the source for this upload. It stays with the saved image.</p>
      <form onSubmit={event => void upload(event)} aria-busy={busy}>
        <fieldset className={styles.choices} disabled={busy || held}><legend>Image source</legend>
          <label className={styles.choice}><input type="radio" name={sourceName} value="live" required checked={source === "live"} onChange={() => setSource("live")}/><span><strong>Photograph</strong><p>An image captured with a camera.</p></span></label>
          <label className={styles.choice}><input type="radio" name={sourceName} value="sample" required checked={source === "sample"} onChange={() => setSource("sample")}/><span><strong>Sample illustration or generated image</strong><p>Saved with a Sample label.</p></span></label>
        </fieldset>
        <p className="fine-print">Later model suggestions and catalog searches keep this input label.</p>
        <div className={styles.actions}><button type="button" className="text-button" disabled={busy} onClick={close}>{held ? "Close and inspect saved photos" : "Cancel"}</button><button type="submit" className="button" disabled={!source || busy || held}>Upload image <ArrowRight size={15}/></button></div>
      </form>
      {busy && <div className={styles.progress} role="status"><Busy text={status}/></div>}{error && <p className="inline-error" role="alert">{error}</p>}
    </ModalFrame>}
  </>;
}
