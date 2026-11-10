import Link from "next/link";
export default function NotFound() { return <main className="error-page"><span className="eyebrow">WORLDKIT</span><h1>This path isn’t connected.</h1><p>Return to your saved workbench to keep building.</p><Link className="button" href="/">Open the workbench</Link></main>; }
