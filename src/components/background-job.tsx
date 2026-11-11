"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Clock3, RefreshCw, X } from "lucide-react";
import type { Job } from "@/server/jobs";
import { api, Busy } from "./ui";

export function BackgroundJob({ initial, onComplete, onChange, onUpdate }: { initial: Job; onComplete?: (job: Job) => void; onChange?: () => void; onUpdate?: (job: Job) => void }) {
  const [job, setJob] = useState(initial); const [error, setError] = useState(""); const [epoch, setEpoch] = useState(0); const complete = useRef(onComplete); complete.current = onComplete; const delivered = useRef<string | null>(null); const updated = useRef(onUpdate); updated.current = onUpdate;
  useEffect(() => {
    let stopped = false; let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<{ job: Job }>(`/api/jobs?id=${encodeURIComponent(initial.id)}`);
        if (stopped) return; setJob(result.job); updated.current?.(result.job); setError("");
        if (result.job.status === "succeeded" && delivered.current !== result.job.id) { delivered.current = result.job.id; complete.current?.(result.job); }
        if (["queued", "running", "retry_wait"].includes(result.job.status)) timeout = setTimeout(poll, result.job.status === "retry_wait" ? 5000 : 2500);
      } catch (error) { if (!stopped) { setError(error instanceof Error ? error.message : "Reconnect to check this saved task."); timeout = setTimeout(poll, 6000); } }
    }
    void poll(); return () => { stopped = true; clearTimeout(timeout); };
  }, [initial.id, initial.status, epoch]);
  async function act(action: "cancel" | "retry") {
    try { const result = await api<{ job: Job }>("/api/jobs", "POST", { action, id: job.id }); setJob(result.job); updated.current?.(result.job); setEpoch(value => value + 1); onChange?.(); }
    catch (error) { setError(error instanceof Error ? error.message : "The task could not be updated."); }
  }
  const running = ["queued", "running", "retry_wait"].includes(job.status);
  return <article className={`background-job ${job.status}`} aria-live="polite"><div className="job-glyph">{job.status === "succeeded" ? <Check size={19}/> : <Clock3 size={19}/>}</div><div><b>{job.kind === "inventory_regions" ? "Equipment suggestions" : job.kind === "inventory_crop_search" ? "Your confirmed crop" : job.kind === "inventory_photo_delete" ? "Private photo removal" : job.kind === "source_extract" ? "Source extraction" : "Your structured goal"}</b>{running ? <Busy text={job.progress}/> : <p>{job.progress}</p>}{(error || job.error) && <p className="job-error">{error || job.error}</p>}<small>{running ? "Saved in the background. You can leave this view." : `Attempt ${job.attempts} · saved result`}</small></div><div className="job-actions">{running && job.kind !== "inventory_photo_delete" && <button className="icon-button" aria-label="Cancel background task" onClick={() => void act("cancel")}><X size={17}/></button>}{job.status === "failed" && <button className="text-button" onClick={() => void act("retry")}><RefreshCw size={14}/> Retry</button>}</div></article>;
}
