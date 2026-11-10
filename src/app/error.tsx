"use client";
import { RefreshCw } from "lucide-react";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <main className="error-page"><span className="eyebrow">WORLDKIT</span><h1>Let’s reconnect your workbench.</h1><p>The current view could not be loaded. Your previously saved revisions are kept in the database.</p><button className="button" onClick={reset}><RefreshCw size={16}/> Try again</button></main>; }
